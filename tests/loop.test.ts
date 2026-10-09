import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadSettings } from "../src/config/settings";
import type { Event } from "../src/ir/events";
import { childrenOf, currentVersion, fold } from "../src/ir/graph";
import { cursorOf, itemFulfilled } from "../src/ir/traversal";
import { project, type Context } from "../src/ir/project";
import { reasoningBody, reasoningOffBody } from "../src/llm/client";
import type { Action, Proposal } from "../src/llm/schemas";
import { classify } from "../src/loop/classify";
import { runAgent } from "../src/loop/graph";
import { executeAction } from "../src/tools";
import { fsWorkspace } from "../src/tools/workspace";
import { achievedWithoutCheck, structuralCycle, unboundGoals } from "./invariants";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "bugfix");

const tempDirs: string[] = [];

function setup(fixture: string): string {
  const root = mkdtempSync(join(tmpdir(), `skein-${fixture}-`));
  cpSync(join(FIXTURES, fixture), root, { recursive: true });
  tempDirs.push(root);
  return root;
}

function fixed(action: Action) {
  return async (_context: Context): Promise<Proposal> => ({ thought: "loop", action });
}

function proposal(action: Action): Proposal {
  return { thought: "", action };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("reasoning budget", () => {
  it("disables thinking for effort none, and enables reasoning otherwise", () => {
    expect(reasoningOffBody("none")).toEqual({
      thinking: { type: "disabled" },
      reasoning: { effort: "none" },
    });
    expect(reasoningBody("none")).toEqual({
      thinking: { type: "disabled" },
      reasoning: { effort: "none" },
    });
    expect(reasoningBody("high")).toEqual({ reasoning: { effort: "high" } });
  });

  it("loads settings from env with defaults", () => {
    const settings = loadSettings({ SKEIN_TEMPERATURE: "0.5" } as NodeJS.ProcessEnv);
    expect(settings.temperature).toBe(0.5);
    expect(settings.reasoningEffort).toBe("low");
    expect(loadSettings({ SKEIN_REASONING_EFFORT: "high" } as NodeJS.ProcessEnv).reasoningEffort).toBe("high");
    expect(settings.live).toBe(false);
  });
});

describe("classify", () => {
  const goal = {
    type: "add_node" as const,
    node: { id: "g1", space: "work" as const, kind: "goal" as const, label: "green", seq: 0, payload: { what: "green", sketch: "done" } },
  };

  it("rejects an edit forbidden by a constraint", () => {
    const state = fold([
      goal,
      {
        type: "add_node",
        node: {
          id: "k1",
          space: "work",
          kind: "constraint",
          label: "do not edit tests",
          payload: { forbid: ["\\.test\\.mjs$"] },
          seq: 1,
        },
      },
    ]);
    const verdict = classify(
      proposal({
        operator: "apply",
        action: { tool: "edit", path: "test/sum.test.mjs", find: "a", replace: "b" },
      }),
      state,
    );
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toContain("constraint_violation");
  });

  it("refuses an edit on a stale read basis", () => {
    const state = fold([
      goal,
      { type: "add_node", node: { id: "file:src/a.ts", space: "artifact", kind: "file", label: "src/a.ts", seq: 1 } },
      {
        type: "add_node",
        node: { id: "o1", space: "work", kind: "observation", label: "read src/a.ts", payload: { ref: "file:src/a.ts", version: "v1" }, seq: 2 },
      },
      { type: "mutate", ref: "file:src/a.ts", version: "v2", actionId: "a1" },
    ]);
    const verdict = classify(
      proposal({ operator: "apply", action: { tool: "edit", path: "src/a.ts", find: "a", replace: "b" } }),
      state,
    );
    expect(verdict).toEqual({ accept: false, reason: "stale_base" });
  });

  it("refuses a repeated run with no change since it ran", () => {
    const state = fold([
      goal,
      { type: "add_node", node: { id: "a1", space: "work", kind: "action", label: "run build", payload: { command: "run build", signature: "run build\u0000" }, seq: 1 } },
      { type: "add_node", node: { id: "o1", space: "work", kind: "observation", label: "run build", payload: { command: "run build", exitCode: 0 }, seq: 2 } },
      { type: "add_edge", edge: { id: "e1", from: "a1", to: "o1", kind: "produces", provenance: { kind: "grep", pattern: "x" } } },
    ]);
    const verdict = classify(
      proposal({ operator: "apply", action: { tool: "run", command: "run build" } }),
      state,
    );
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toContain("repeated_action");
    expect(verdict.reason).toContain("o1");
  });

  it("refuses an identical re-read and names the stored result", () => {
    const root = mkdtempSync(join(tmpdir(), "skein-read-"));
    tempDirs.push(root);
    writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n");
    const workspace = fsWorkspace(root);
    const state0 = fold([goal]);
    const first = executeAction(
      { operator: "apply", action: { tool: "read", path: "a.txt" } },
      state0,
      workspace,
      0,
    );
    const state = fold(first.events, state0);
    const obs = [...state.nodes.values()].find((node) => node.kind === "observation");

    const same = classify(
      proposal({ operator: "apply", action: { tool: "read", path: "a.txt" } }),
      state,
    );
    expect(same.accept).toBe(false);
    expect(same.reason).toContain(obs?.id ?? "?");

    // A different window is a new action.
    expect(
      classify(
        proposal({ operator: "apply", action: { tool: "read", path: "a.txt", start: 2, end: 3 } }),
        state,
      ),
    ).toEqual({ accept: true });

    // After a change to the world, re-reading is allowed.
    const afterMutation = fold(
      [...first.events, { type: "mutate", ref: "file:a.txt", version: "v2", actionId: "a1" }],
      state0,
    );
    expect(
      classify(
        proposal({ operator: "apply", action: { tool: "read", path: "a.txt" } }),
        afterMutation,
      ),
    ).toEqual({ accept: true });
  });

  it("points a repeated read at `shown` when the body is already held, else at query", () => {
    const root = mkdtempSync(join(tmpdir(), "skein-read-held-"));
    tempDirs.push(root);
    writeFileSync(join(root, "a.txt"), "one\ntwo\n");
    const workspace = fsWorkspace(root);
    const state0 = fold([goal]);
    const first = executeAction(
      { operator: "apply", action: { tool: "read", path: "a.txt" } },
      state0,
      workspace,
      0,
    );
    const state = fold(first.events, state0);
    const obsId = [...state.nodes.values()].find((node) => node.kind === "observation")?.id ?? "?";

    const held = classify(
      proposal({ operator: "apply", action: { tool: "read", path: "a.txt" } }),
      state,
      [obsId],
    );
    expect(held.accept).toBe(false);
    expect(held.reason).toContain("shown");

    const notHeld = classify(
      proposal({ operator: "apply", action: { tool: "read", path: "a.txt" } }),
      state,
      [],
    );
    expect(notHeld.accept).toBe(false);
    expect(notHeld.reason).toContain("query");
  });

  it("points a repeated query at `shown` when the body is already held", () => {
    const state = fold([
      goal,
      {
        type: "add_node",
        node: { id: "o1", space: "work", kind: "observation", label: "run", payload: { output: "x" }, seq: 1 },
      },
    ]);
    const verdict = classify(proposal({ operator: "query", id: "o1" }), state, ["o1"]);
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toContain("shown");
  });

  it("refuses an identical re-search and names the stored result", () => {
    const root = mkdtempSync(join(tmpdir(), "skein-research-"));
    tempDirs.push(root);
    writeFileSync(join(root, "code.txt"), "MATCH one\nMATCH two\n");
    const workspace = fsWorkspace(root);
    const state0 = fold([goal]);
    const first = executeAction(
      { operator: "apply", action: { tool: "grep", pattern: "MATCH" } },
      state0,
      workspace,
      0,
    );
    const state = fold(first.events, state0);
    const obs = [...state.nodes.values()].find((node) => node.kind === "observation");

    const same = classify(
      proposal({ operator: "apply", action: { tool: "grep", pattern: "MATCH" } }),
      state,
    );
    expect(same.accept).toBe(false);
    expect(same.reason).toContain(obs?.id ?? "?");

    expect(
      classify(
        proposal({ operator: "apply", action: { tool: "grep", pattern: "MATCH", from: 2 } }),
        state,
      ),
    ).toEqual({ accept: true });
  });

  it("accepts a create_goal with a sketch and a command, and rejects empty content", () => {
    const state = fold([goal]);
    expect(
      classify(
        proposal({ operator: "create_goal", what: "locate", sketch: "locate: a sketch", command: "node --test" }),
        state,
      ),
    ).toEqual({ accept: true });
    expect(
      classify(proposal({ operator: "create_goal", what: "", sketch: "p", command: "true" }), state).reason,
    ).toBe("empty_what");
    expect(
      classify(proposal({ operator: "create_goal", what: "x", sketch: "", command: "true" }), state).reason,
    ).toBe("empty_sketch");
    expect(
      classify(proposal({ operator: "create_goal", what: "x", sketch: "p", command: "" }), state).reason,
    ).toBe("empty_command");
    expect(
      classify(
        proposal({ operator: "create_goal", what: "x", sketch: "p", command: "node --test" }),
        fold([]),
      ).reason,
    ).toContain("no_current_goal");
  });

  it("guards run: it needs a command", () => {
    const state = fold([
      {
        type: "add_node",
        node: {
          id: "g2",
          space: "work",
          kind: "goal",
          label: "crit",
          payload: { what: "crit", sketch: "run npm test" },
          seq: 1,
        },
      },
    ]);
    expect(classify(proposal({ operator: "apply", action: { tool: "run" } }), state).reason).toContain(
      "run needs a command",
    );
    expect(
      classify(proposal({ operator: "apply", action: { tool: "run", command: "npm test" } }), state),
    ).toEqual({ accept: true });
  });

  it("allows a repeated run after a timeout (no exit code), refuses a deterministic one", () => {
    const runAction = { operator: "apply" as const, action: { tool: "run" as const, command: "true" } };
    const ranWith = (payload: { command: string; exitCode?: number }): Event[] => [
      goal,
      { type: "add_node", node: { id: "a1", space: "work", kind: "action", label: "true", payload: { command: "true", signature: "true\u0000" }, seq: 1 } },
      { type: "add_node", node: { id: "o1", space: "work", kind: "observation", label: "true", payload, seq: 2 } },
      { type: "add_edge", edge: { id: "e1", from: "a1", to: "o1", kind: "produces", provenance: { kind: "llm" } } },
    ];
    // A timeout brought no knowledge: the same command may be retried.
    expect(classify(proposal(runAction), fold(ranWith({ command: "true" })))).toEqual({ accept: true });
    // A deterministic exit is a repeat: retrieve the body instead.
    expect(classify(proposal(runAction), fold(ranWith({ command: "true", exitCode: 1 }))).reason).toMatch(
      /repeated_action/,
    );
  });
});

describe("executeAction", () => {
  it("create_goal builds a goal, its plan and descends into it", () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    const root = fold([
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green", sketch: "done" }, seq: 0 } },
      { type: "add_node", node: { id: "p1", space: "work", kind: "plan", label: "plan for g1", seq: 1 } },
      { type: "add_edge", edge: { id: "e1", from: "g1", to: "p1", kind: "has_plan", provenance: { kind: "llm" } } },
      { type: "add_node", node: { id: "a1", space: "work", kind: "action", label: "make test", payload: { command: "make test" }, seq: 2 } },
      { type: "add_edge", edge: { id: "e2", from: "p1", to: "a1", kind: "item", provenance: { kind: "llm" } } },
      { type: "descend", node: "g1" },
    ]);
    const outcome = executeAction(
      {
        operator: "create_goal",
        what: "locate",
        sketch: "locate: a sketch",
        command: "node --test",
      },
      root,
      workspace,
      0,
    );
    const state = fold(outcome.events, root);
    const goals = [...state.nodes.values()].filter((node) => node.kind === "goal" && node.id !== "g1");
    expect(goals).toHaveLength(1);
    expect(state.branch[state.branch.length - 1]).toBe(goals[0]?.id);
    const childGoal = goals[0];
    expect(childGoal).toBeDefined();
    const planEdges = [...state.edges.values()].filter(
      (edge) => edge.kind === "has_plan" && edge.from === childGoal?.id,
    );
    expect(planEdges).toHaveLength(1);
    expect(childrenOf(state, planEdges[0]?.to as string)).toHaveLength(1);
  });

  it("refuses to decompose an open goal with no current plan item", () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    const root = fold([
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green", sketch: "done" }, seq: 0 } },
      { type: "add_node", node: { id: "p1", space: "work", kind: "plan", label: "plan", seq: 1 } },
      { type: "add_edge", edge: { id: "e1", from: "g1", to: "p1", kind: "has_plan", provenance: { kind: "llm" } } },
      { type: "descend", node: "g1" },
    ]);
    const outcome = executeAction(
      { operator: "create_goal", what: "sub", sketch: "sub: a sketch", command: "true" },
      root,
      workspace,
      0,
    );
    const failure = outcome.events.find(
      (event) =>
        event.type === "add_node" &&
        (event.node.payload as { failed?: boolean } | undefined)?.failed === true,
    );
    expect(failure?.type === "add_node" ? failure.node.label : "").toMatch(/no current plan item/);
  });

  it("edit mutates the file and records the new version", () => {
    const root = setup("off-by-one");
    const workspace = fsWorkspace(root);
    const before = fold([
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green", sketch: "done" }, seq: 0 } },
    ]);
    const outcome = executeAction(
      { operator: "apply", action: { tool: "edit", path: "src/sum.mjs", find: "i < n", replace: "i <= n" } },
      before,
      workspace,
      1,
    );
    const state = fold(outcome.events, before);
    expect(readFileSync(join(root, "src/sum.mjs"), "utf8")).toContain("i <= n");
    expect(currentVersion(state, "file:src/sum.mjs")).toBe(workspace.version("src/sum.mjs"));
  });

  it("refuses to create a file with edit (it only rewrites existing files)", () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    const state = fold([
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green", sketch: "done" }, seq: 0 } },
    ]);
    const outcome = executeAction(
      { operator: "apply", action: { tool: "edit", path: "package.json", find: "", replace: "{}" } },
      state,
      workspace,
      1,
    );
    expect(outcome.events.some((event) => event.type === "mutate")).toBe(false);
    const failure = outcome.events.find(
      (event) =>
        event.type === "add_node" &&
        (event.node.payload as { failed?: boolean } | undefined)?.failed === true,
    );
    expect(failure).toBeDefined();
  });

  it("records the crash signal of a run and surfaces it in the projection", () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    const state = fold([
      { type: "add_node", node: { id: "r1", space: "work", kind: "request", label: "task", payload: { text: "go" }, seq: 0 } },
    ]);
    const outcome = executeAction(
      { operator: "apply", action: { tool: "run", command: "kill -SEGV $$" } },
      state,
      workspace,
      1,
    );
    const observed = fold(outcome.events, state);
    const node = [...observed.nodes.values()].find(
      (candidate) =>
        (candidate.payload as { signal?: string } | undefined)?.signal === "SIGSEGV",
    );
    expect(node).toBeDefined();
    expect(project(observed).lastResult?.signal).toBe("SIGSEGV");
  });

  it("keeps find/replace of an edit in the calls diff", () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    const state = fold([
      { type: "add_node", node: { id: "r1", space: "work", kind: "request", label: "task", payload: { text: "go" }, seq: 0 } },
    ]);
    const outcome = executeAction(
      { operator: "apply", action: { tool: "edit", path: "src/sum.mjs", find: "i < n", replace: "i <= n" } },
      state,
      workspace,
      1,
    );
    const call = project(fold(outcome.events, state)).calls.find(
      (entry) => entry.action === "edit src/sum.mjs",
    );
    expect(call?.note).toContain("i < n");
    expect(call?.note).toContain("i <= n");
  });

  it("shows the attempted find of a failed edit", () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    const state = fold([
      { type: "add_node", node: { id: "r1", space: "work", kind: "request", label: "task", payload: { text: "go" }, seq: 0 } },
    ]);
    const outcome = executeAction(
      { operator: "apply", action: { tool: "edit", path: "src/sum.mjs", find: "NOT PRESENT", replace: "x" } },
      state,
      workspace,
      1,
    );
    const call = project(fold(outcome.events, state)).calls.find(
      (entry) => entry.action === "edit src/sum.mjs",
    );
    expect(call?.status).toBe("fail");
    expect(call?.note).toContain("NOT PRESENT");
  });

  it("reads a bounded window and says where to continue", () => {
    const root = mkdtempSync(join(tmpdir(), "skein-read-"));
    tempDirs.push(root);
    const lines = Array.from({ length: 600 }, (_, index) => `line ${index + 1}`).join("\n");
    writeFileSync(join(root, "big.txt"), lines);
    const workspace = fsWorkspace(root);
    const state = fold([
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green", sketch: "done" }, seq: 0 } },
    ]);
    const first = executeAction(
      { operator: "apply", action: { tool: "read", path: "big.txt" } },
      state,
      workspace,
      0,
    );
    expect(first.turn.text).toContain("line 1\n");
    expect(first.turn.text).toContain("line 400");
    expect(first.turn.text).toContain("[lines 1–400 of 600; continue from 401]");
    const next = executeAction(
      { operator: "apply", action: { tool: "read", path: "big.txt", start: 401, end: 600 } },
      state,
      workspace,
      1,
    );
    expect(next.turn.text).toContain("line 600");
    expect(next.turn.text).not.toContain("continue from");
  });

  it("branches the current plan item when the action differs, so the plan never blocks", () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    const root = fold([
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green", sketch: "done" }, seq: 0 } },
      { type: "add_node", node: { id: "p1", space: "work", kind: "plan", label: "plan", seq: 1 } },
      { type: "add_edge", edge: { id: "hp", from: "g1", to: "p1", kind: "has_plan", provenance: { kind: "llm" } } },
      { type: "add_node", node: { id: "a1", space: "work", kind: "action", label: "cat HACKING.adoc", payload: { command: "cat HACKING.adoc" }, seq: 2 } },
      { type: "add_edge", edge: { id: "it", from: "p1", to: "a1", kind: "item", provenance: { kind: "llm" } } },
    ]);
    expect(itemFulfilled(root, "a1")).toBe(false);
    const outcome = executeAction(
      { operator: "apply", action: { tool: "run", command: "ls" } },
      root,
      workspace,
      0,
    );
    const state = fold(outcome.events, root);
    expect(itemFulfilled(state, "a1")).toBe(true);
    expect(cursorOf(state, "g1")).toBe(1);
  });

  it("grep returns a JSON window with context", () => {
    const root = mkdtempSync(join(tmpdir(), "skein-grep-"));
    tempDirs.push(root);
    writeFileSync(join(root, "code.txt"), "alpha\nbeta\nMATCH\ngamma\ndelta\n");
    const workspace = fsWorkspace(root);
    const state = fold([
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green", sketch: "done" }, seq: 0 } },
    ]);
    const outcome = executeAction(
      { operator: "apply", action: { tool: "grep", pattern: "MATCH" } },
      state,
      workspace,
      0,
    );
    const result = JSON.parse(outcome.turn.text) as {
      total: number;
      returned: number;
      results: { path: string; line: number; match: string; before: string[]; after: string[] }[];
    };
    expect(result.total).toBe(1);
    expect(result.returned).toBe(1);
    expect(result.results[0]).toMatchObject({
      path: "code.txt",
      line: 3,
      match: "MATCH",
      before: ["alpha", "beta"],
      after: ["gamma", "delta", ""],
    });
  });

  it("grep pages over matches by from/count and reports next", () => {
    const root = mkdtempSync(join(tmpdir(), "skein-grep-"));
    tempDirs.push(root);
    writeFileSync(join(root, "code.txt"), "MATCH one\nMATCH two\nMATCH three\n");
    const workspace = fsWorkspace(root);
    const state = fold([
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green", sketch: "done" }, seq: 0 } },
    ]);
    const first = executeAction(
      { operator: "apply", action: { tool: "grep", pattern: "MATCH", count: 2 } },
      state,
      workspace,
      0,
    );
    const page1 = JSON.parse(first.turn.text) as {
      total: number;
      from: number;
      returned: number;
      next?: number;
      results: { line: number }[];
    };
    expect(page1).toMatchObject({ total: 3, from: 1, returned: 2, next: 3 });
    expect(page1.results.map((r) => r.line)).toEqual([1, 2]);

    const state2 = fold(first.events, state);
    const second = executeAction(
      { operator: "apply", action: { tool: "grep", pattern: "MATCH", count: 2, from: 3 } },
      state2,
      workspace,
      1,
    );
    const page2 = JSON.parse(second.turn.text) as { from: number; returned: number; next?: number };
    expect(page2).toMatchObject({ from: 3, returned: 1 });
    expect(page2.next).toBeUndefined();
  });

  it("list returns files as JSON and can be scoped by include", () => {
    const root = mkdtempSync(join(tmpdir(), "skein-list-"));
    tempDirs.push(root);
    mkdirSync(join(root, "runtime"), { recursive: true });
    writeFileSync(join(root, "runtime", "gc.c"), "int x;\n");
    writeFileSync(join(root, "runtime", "gc.h"), "int x;\n");
    writeFileSync(join(root, "README.md"), "# hi\n");
    writeFileSync(join(root, ".depend"), "hidden\n");
    const workspace = fsWorkspace(root);
    const state = fold([
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green", sketch: "done" }, seq: 0 } },
    ]);
    const outcome = executeAction(
      { operator: "apply", action: { tool: "list", include: "**/*.c" } },
      state,
      workspace,
      0,
    );
    const result = JSON.parse(outcome.turn.text) as { total: number; files: string[] };
    expect(result.total).toBe(1);
    expect(result.files).toEqual(["runtime/gc.c"]);
  });

  it("run that violates a constraint is reverted and records no result", () => {
    const root = setup("off-by-one");
    const workspace = fsWorkspace(root);
    const original = workspace.read("test/sum.test.mjs");
    const before = fold([
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green", sketch: "node --test" }, seq: 0 } },
      {
        type: "add_node",
        node: { id: "k1", space: "work", kind: "constraint", label: "no tests", payload: { forbid: ["\\.test\\.mjs$"] }, seq: 1 },
      },
    ]);
    const outcome = executeAction(
      {
        operator: "apply",
        action: { tool: "run", command: "printf '// x\\n' > test/sum.test.mjs" },
      },
      before,
      workspace,
      0,
    );
    const state = fold(outcome.events, before);
    expect(workspace.read("test/sum.test.mjs")).toBe(original);
    expect(
      [...state.nodes.values()].some(
        (node) => node.kind === "observation" && node.label.startsWith("constraint violation"),
      ),
    ).toBe(true);
  });
});

describe("query by id (history index)", () => {
  const goal = {
    type: "add_node" as const,
    node: { id: "g1", space: "work" as const, kind: "goal" as const, label: "green", seq: 0, payload: { what: "green", sketch: "done" } },
  };

  it("returns a stored body by id and windows a large one", () => {
    const root = mkdtempSync(join(tmpdir(), "skein-query-"));
    tempDirs.push(root);
    const workspace = fsWorkspace(root);
    const big = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    workspace.write(".skein/observations/o2.txt", big);
    const state = fold([
      goal,
      { type: "add_node", node: { id: "o1", space: "work", kind: "observation", label: "small", payload: { output: "hello" }, seq: 1 } },
      { type: "add_node", node: { id: "o2", space: "work", kind: "observation", label: "big", payload: { outputRef: ".skein/observations/o2.txt" }, seq: 2 } },
    ]);

    const small = executeAction({ operator: "query", id: "o1" }, state, workspace, 0);
    const smallJson = JSON.parse(small.turn.text) as { id: string; output: string; total: number };
    expect(smallJson.id).toBe("o1");
    expect(smallJson.output).toContain("hello");

    const windowed = executeAction(
      { operator: "query", id: "o2", start: 2, end: 4 },
      state,
      workspace,
      1,
    );
    const bigJson = JSON.parse(windowed.turn.text) as {
      start: number;
      end: number;
      total: number;
      output: string;
    };
    expect(bigJson).toMatchObject({ start: 2, end: 4, total: 50 });
    expect(bigJson.output).toContain("line 2");
    expect(bigJson.output).not.toContain("line 5");
  });

  it("refuses a query for a result already in the working set", () => {
    const state = fold([goal]);
    const held = ["obs:30"];

    const repeat = classify(proposal({ operator: "query", id: "obs:30" }), state, held);
    expect(repeat.accept).toBe(false);
    expect(repeat.reason).toContain("obs:30");
    expect(repeat.reason).toContain("repeated_action");

    // Another id, or a state query, is fine.
    expect(classify(proposal({ operator: "query", id: "obs:31" }), state, held)).toEqual({
      accept: true,
    });
    expect(classify(proposal({ operator: "query", kind: "goal" }), state, held)).toEqual({
      accept: true,
    });
  });

  it("refuses a re-query of a non-result id (e.g. an action node)", () => {
    const state = fold([goal]);
    const verdict = classify(proposal({ operator: "query", id: "w:action:77" }), state, [
      "w:action:77",
    ]);
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toContain("w:action:77");
    expect(verdict.reason).toContain("repeated_action");
  });
});

describe("working set (shown) with TTL", () => {
  it("retains the current level's results beyond the old TTL", async () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    const shown: string[][] = [];
    let id: string | undefined;
    let index = 0;
    const propose = async (context: Context): Promise<Proposal> => {
      shown.push(
        context.shown.map((view) => view.id).filter((value): value is string => value !== undefined),
      );
      index += 1;
      if (index === 1) {
        return proposal({ operator: "apply", action: { tool: "read", path: "src/sum.mjs" } });
      }
      if (index === 2) {
        id = context.lastResult?.id;
        return proposal({ operator: "apply", action: { tool: "run", command: "echo one" } });
      }
      return proposal({ operator: "apply", action: { tool: "run", command: `echo step${index}` } });
    };
    await runAgent(
      { propose, workspace, maxTurns: 9, noProgress: 10, held: { turns: 3 } },
      { request: { id: "r1", text: "green" } },
    );

    expect(id).toBeDefined();
    // The read belongs to the current level (the request), so it is not evicted by TTL.
    expect(shown[2]).toContain(id);
    expect(shown[4]).toContain(id);
    expect(shown[5]).toContain(id);
  });

  it("drops a retained read once its file changes", async () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    const shown: string[][] = [];
    let id: string | undefined;
    let index = 0;
    const propose = async (context: Context): Promise<Proposal> => {
      shown.push(
        context.shown.map((view) => view.id).filter((value): value is string => value !== undefined),
      );
      index += 1;
      if (index === 1) {
        return proposal({ operator: "apply", action: { tool: "read", path: "src/sum.mjs" } });
      }
      if (index === 2) {
        id = context.lastResult?.id;
        return proposal({ operator: "apply", action: { tool: "run", command: "echo one" } });
      }
      if (index === 3) {
        return proposal({
          operator: "apply",
          action: { tool: "edit", path: "src/sum.mjs", find: "i < n", replace: "i <= n" },
        });
      }
      return proposal({ operator: "apply", action: { tool: "run", command: `echo step${index}` } });
    };
    await runAgent(
      { propose, workspace, maxTurns: 9, noProgress: 10 },
      { request: { id: "r1", text: "green" } },
    );

    expect(shown[2]).toContain(id); // before the edit
    expect(shown[3]).not.toContain(id); // the edit at turn 2 makes the read stale
  });

  it("caps the current level's retained results", async () => {
    const root = mkdtempSync(join(tmpdir(), "skein-held-"));
    tempDirs.push(root);
    for (let i = 0; i < 10; i += 1) writeFileSync(join(root, `f${i}.txt`), `body ${i}\n`);
    const workspace = fsWorkspace(root);
    const ids = new Set<string>();
    let shownCount = -1;
    let index = 0;
    const propose = async (context: Context): Promise<Proposal> => {
      if (context.lastResult?.id) ids.add(context.lastResult.id);
      index += 1;
      if (index <= 10) {
        return proposal({ operator: "apply", action: { tool: "read", path: `f${index - 1}.txt` } });
      }
      shownCount = Math.max(shownCount, context.shown.length);
      return proposal({ operator: "apply", action: { tool: "run", command: `echo step${index}` } });
    };
    await runAgent(
      { propose, workspace, maxTurns: 14, noProgress: 10 },
      { request: { id: "r1", text: "green" } },
    );

    expect(ids.size).toBeGreaterThan(8);
    expect(shownCount).toBeGreaterThan(0);
    expect(shownCount).toBeLessThanOrEqual(8);
  });
});

describe("workspace run", () => {
  it("reports a pipeline's failing stage (pipefail), not the last stage's exit", () => {
    const root = mkdtempSync(join(tmpdir(), "skein-run-"));
    tempDirs.push(root);
    // `false | true` exits 0 without pipefail; with it the failure of `false` surfaces.
    const result = fsWorkspace(root).run("false | true");
    expect(result.code).toBe(1);
  });
});

describe("workspace grep", () => {
  it("scans source files by content, not by extension", () => {
    const root = mkdtempSync(join(tmpdir(), "skein-grep-"));
    tempDirs.push(root);
    mkdirSync(join(root, "runtime"), { recursive: true });
    writeFileSync(join(root, "runtime", "gc.c"), "int sweep(void) {}\n");
    writeFileSync(join(root, "bin.dat"), "sweep\u0000binary\n");
    const matches = fsWorkspace(root).grep("sweep");
    expect(matches).toEqual([{ path: "runtime/gc.c", line: 1, text: "int sweep(void) {}" }]);
  });

  it("skips dot files and directories by default", () => {
    const root = mkdtempSync(join(tmpdir(), "skein-grep-"));
    tempDirs.push(root);
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".depend"), "sweep\n");
    writeFileSync(join(root, ".git", "config"), "sweep\n");
    writeFileSync(join(root, "real.c"), "sweep\n");
    const matches = fsWorkspace(root).grep("sweep");
    expect(matches.map((m) => m.path)).toEqual(["real.c"]);
  });

  it("scopes by path and filters with include/exclude globs", () => {
    const root = mkdtempSync(join(tmpdir(), "skein-grep-"));
    tempDirs.push(root);
    mkdirSync(join(root, "runtime"), { recursive: true });
    mkdirSync(join(root, "other"), { recursive: true });
    writeFileSync(join(root, "runtime", "gc.c"), "sweep\n");
    writeFileSync(join(root, "runtime", "gc.h"), "sweep\n");
    writeFileSync(join(root, "other", "notes.txt"), "sweep\n");
    const workspace = fsWorkspace(root);
    expect(workspace.grep("sweep", { path: "runtime" }).map((m) => m.path).sort()).toEqual([
      "runtime/gc.c",
      "runtime/gc.h",
    ]);
    expect(workspace.grep("sweep", { include: "**/*.c" }).map((m) => m.path)).toEqual([
      "runtime/gc.c",
    ]);
    expect(workspace.grep("sweep", { exclude: "**/*.c" }).map((m) => m.path)).toEqual([
      "other/notes.txt",
      "runtime/gc.h",
    ]);
    expect(workspace.grep("sweep", { path: "runtime/gc.c" }).map((m) => m.path)).toEqual([
      "runtime/gc.c",
    ]);
  });

  it("throws on a missing path", () => {
    const root = mkdtempSync(join(tmpdir(), "skein-grep-"));
    tempDirs.push(root);
    expect(() => fsWorkspace(root).grep("x", { path: "nope" })).toThrow(/path not found/);
  });
});

describe("runAgent", () => {
  it("carries a plan through edit and stop to a closed root", async () => {
    const root = setup("off-by-one");
    const workspace = fsWorkspace(root);
    let index = 0;
    const propose = async (_context: Context): Promise<Proposal> => {
      index += 1;
      if (index === 1) {
        return proposal({
          operator: "create_goal",
          what: "fix the off-by-one",
          why: "the loop stops one short",
          sketch: "reproduce, fix, re-run, stop",
          command: "echo start",
        });
      }
      if (index === 2) {
        return proposal({ operator: "apply", action: { tool: "edit", path: "src/sum.mjs", find: "i < n", replace: "i <= n" } });
      }
      if (index === 3) {
        return proposal({ operator: "apply", action: { tool: "run", command: "node --test" } });
      }
      return proposal({ operator: "stop", why: "node --test passes" });
    };
    const result = await runAgent(
      { propose, workspace, maxTurns: 10 },
      { request: { id: "r1", text: "make the suite pass" } },
    );

    expect(workspace.run("node --test").code).toBe(0);
    expect(achievedWithoutCheck(result.events)).toEqual([]);
    expect(unboundGoals(result.events)).toEqual([]);
    expect(structuralCycle(result.events)).toBe(false);
    expect(result.stopReason).toBe("request_addressed");
  });

  it("reports request_addressed, not max_turns, when the final allowed turn stops the goal", async () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    let index = 0;
    const propose = async (_context: Context): Promise<Proposal> => {
      index += 1;
      if (index === 1) {
        return proposal({
          operator: "create_goal",
          what: "make the suite pass",
          sketch: "make the suite pass",
          command: "true",
        });
      }
      return proposal({ operator: "stop", why: "done" });
    };
    const result = await runAgent(
      { propose, workspace, maxTurns: 2 },
      { request: { id: "r1", text: "green" } },
    );
    expect(result.turns).toBe(2);
    expect(result.stopReason).toBe("request_addressed");
  });

  it("stops with no_progress when nothing changes", async () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    const result = await runAgent(
      { propose: fixed({ operator: "query", id: "r1" }), workspace, maxTurns: 10, noProgress: 2 },
      { request: { id: "r1", text: "green" } },
    );
    expect(result.stopReason).toBe("no_progress");
  });

  it("stops with no_progress on a repeatedly refused command", async () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    let index = 0;
    const propose = async (): Promise<Proposal> => {
      index += 1;
      if (index === 1) {
        return proposal({
          operator: "create_goal",
          what: "interpret the request",
          sketch: "interpret the request",
          command: "echo hi",
        });
      }
      return proposal({ operator: "apply", action: { tool: "run", command: "echo hi" } });
    };
    const result = await runAgent(
      { propose, workspace, maxTurns: 12, noProgress: 2 },
      { request: { id: "r1", text: "green" } },
    );
    expect(result.stopReason).toBe("no_progress");
    expect(result.events.some((event) => event.type === "record_rejection")).toBe(true);
  });

  it("keeps the current level's read in shown after a later call", async () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    const contexts: Context[] = [];
    let index = 0;
    const propose = async (context: Context): Promise<Proposal> => {
      contexts.push(context);
      index += 1;
      if (index === 1) {
        return proposal({ operator: "apply", action: { tool: "read", path: "src/sum.mjs" } });
      }
      if (index === 2) {
        return proposal({ operator: "apply", action: { tool: "run", command: "true" } });
      }
      return proposal({ operator: "query", id: "r1" });
    };
    await runAgent(
      { propose, workspace, maxTurns: 4 },
      { request: { id: "r1", text: "green" } },
    );
    const readId = contexts[1]?.lastResult?.id;
    const shown = contexts[2]?.shown ?? [];
    const readView = shown.find((view) => view.id === readId);
    expect(readView?.output).toContain("sumTo");
  });

  it("reports the focus plan and applicable operators in the projection", () => {
    const state = fold([
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green", sketch: "node --test" }, seq: 0 } },
      { type: "add_node", node: { id: "p1", space: "work", kind: "plan", label: "plan", seq: 1 } },
      { type: "add_edge", edge: { id: "e1", from: "g1", to: "p1", kind: "has_plan", provenance: { kind: "llm" } } },
      { type: "add_node", node: { id: "a1", space: "work", kind: "action", label: "run build", seq: 2 } },
      { type: "add_edge", edge: { id: "e2", from: "p1", to: "a1", kind: "item", provenance: { kind: "llm" } } },
    ]);
    const context = project(state);
    expect(context.path[0]?.plan?.items.map((item) => item.id)).toEqual(["a1"]);
    expect(context.applicable).toContain("apply");
  });

  it("refuses a repeated read, names the stored id, and can be retrieved by query", async () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    const ids: (string | undefined)[] = [];
    let index = 0;
    const propose = async (context: Context): Promise<Proposal> => {
      ids.push(context.lastResult?.id);
      index += 1;
      if (index === 1) {
        return proposal({ operator: "apply", action: { tool: "read", path: "src/sum.mjs" } });
      }
      if (index === 2) {
        return proposal({ operator: "apply", action: { tool: "read", path: "src/sum.mjs" } });
      }
      if (index === 3) {
        return proposal({ operator: "query", id: ids[1] ?? "missing" });
      }
      return proposal({ operator: "query", id: "r1" });
    };
    const result = await runAgent(
      { propose, workspace, maxTurns: 6, noProgress: 2 },
      { request: { id: "r1", text: "green" } },
    );

    const reads = [...fold(result.events).nodes.values()].filter(
      (node) =>
        node.kind === "action" &&
        (node.payload as { command?: string } | undefined)?.command === "read src/sum.mjs",
    );
    expect(reads).toHaveLength(1);
    const rejection = result.events.find((event) => event.type === "record_rejection");
    const reason =
      rejection?.type === "record_rejection" ? rejection.reason : "";
    expect(reason).toContain(ids[1] ?? "?");
  });

  it("refuses an identical re-query by id instead of re-retrieving", async () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    let readId: string | undefined;
    let index = 0;
    const propose = async (context: Context): Promise<Proposal> => {
      index += 1;
      if (index === 1) {
        return proposal({ operator: "apply", action: { tool: "read", path: "src/sum.mjs" } });
      }
      if (index === 2) {
        readId = context.lastResult?.id;
        return proposal({ operator: "query", id: readId ?? "missing" });
      }
      return proposal({ operator: "query", id: readId ?? "missing" });
    };
    const result = await runAgent(
      { propose, workspace, maxTurns: 8, noProgress: 2 },
      { request: { id: "r1", text: "green" } },
    );

    const rejection = result.events.find((event) => event.type === "record_rejection");
    const reason = rejection?.type === "record_rejection" ? rejection.reason : "";
    expect(reason).toContain("repeated_action");
    expect(reason).toContain(readId ?? "?");
    expect(result.stopReason).toBe("no_progress");
  });

  it("refuses a repeated query of a non-result node", async () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    let goalId: string | undefined;
    let index = 0;
    const propose = async (context: Context): Promise<Proposal> => {
      index += 1;
      if (index === 1) {
        return proposal({
          operator: "create_goal",
          what: "green",
          sketch: "green: a sketch",
          command: "echo hi",
        });
      }
      goalId = context.path[context.path.length - 1]?.id;
      return proposal({ operator: "query", id: goalId ?? "missing" });
    };
    const result = await runAgent(
      { propose, workspace, maxTurns: 6, noProgress: 2 },
      { request: { id: "r1", text: "green" } },
    );

    const rejection = result.events.find((event) => event.type === "record_rejection");
    const reason = rejection?.type === "record_rejection" ? rejection.reason : "";
    expect(reason).toContain("repeated_action");
    expect(reason).toContain(goalId ?? "?");
  });
});

describe("failed edit materializes the file content", () => {
  it("shows the current content and keeps it in view instead of a re-read", async () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    const contexts: Context[] = [];
    let index = 0;
    const propose = async (context: Context): Promise<Proposal> => {
      contexts.push(context);
      index += 1;
      if (index === 1) {
        return proposal({
          operator: "create_goal",
          what: "green",
          sketch: "green: a sketch",
          command: "echo done",
        });
      }
      if (index === 2) {
        return proposal({ operator: "apply", action: { tool: "read", path: "src/sum.mjs" } });
      }
      if (index === 3) {
        return proposal({
          operator: "apply",
          action: { tool: "edit", path: "src/sum.mjs", find: "NONEXISTENT_PATTERN_XYZ", replace: "x" },
        });
      }
      return proposal({ operator: "apply", action: { tool: "run", command: "echo done" } });
    };
    const result = await runAgent(
      { propose, workspace, maxTurns: 8, noProgress: 100 },
      { request: { id: "r1", text: "green" } },
    );

    const failure = [...fold(result.events).nodes.values()].find(
      (node) => node.kind === "observation" && node.label.startsWith("edit failed"),
    );
    const output = (failure?.payload as { output?: string } | undefined)?.output ?? "";
    expect(output).toContain("current content");
    expect(output).toContain("sumTo");

    // The failed-edit body is pinned, so it is already in `shown` the next turn.
    const afterEdit = contexts[3];
    const shown = (afterEdit?.shown ?? []).map((view) => view.output ?? "").join("\n");
    expect(shown).toContain("current content");
  });
});
