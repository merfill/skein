import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadSettings } from "../src/config/settings";
import type { Event } from "../src/ir/events";
import { childrenOf, currentVersion, fold, lastChild } from "../src/ir/graph";
import { currentGoalId, cursorOf, itemFulfilled } from "../src/ir/traversal";
import { project, type Context } from "../src/ir/project";
import { reasoningBody, reasoningOffBody } from "../src/llm/client";
import type { Action, Proposals } from "../src/llm/schemas";
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
  return async (_context: Context): Promise<Proposals> => ({ thought: "loop", actions: [action] });
}

function proposal(action: Action): Proposals {
  return { thought: "", actions: [action] };
}

// The tape exposes node ids as a leading `[id]` on each assistant/tool message, so the model
// can address a result by id (`recall`). These read them back for the tests.
function idFrom(text: string | undefined): string | undefined {
  return text?.match(/^\[([^\]]+)\]/)?.[1];
}

function lastToolId(context: Context | undefined): string | undefined {
  const tool = [...(context?.history ?? [])].reverse().find((message) => message.role === "tool");
  return idFrom(tool?.text);
}

function goalIdOf(context: Context | undefined): string | undefined {
  const goal = context?.history.find(
    (message) => message.role === "assistant" && message.text.includes("create_goal"),
  );
  return idFrom(goal?.text);
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
    node: { id: "g1", space: "work" as const, kind: "goal" as const, label: "green", seq: 0, payload: { what: "green" } },
  };

  const cmdDir = mkdtempSync(join(tmpdir(), "skein-cmd-"));
  tempDirs.push(cmdDir);
  const cmdWs = fsWorkspace(cmdDir);

  // A command's non-execution is an observation with a reason (docs/ir_revision.md §3.3,
  // §4): run it and report the failed observation's reason.
  function runApply(action: Action, events: readonly Event[], workspace = cmdWs) {
    const outcome = executeAction(action, fold(events), workspace, 0);
    const all = [...events, ...outcome.events];
    const state = fold(all);
    const node = outcome.turn.nodeId ? state.nodes.get(outcome.turn.nodeId) : undefined;
    const failed = (node?.payload as { failed?: boolean } | undefined)?.failed === true;
    return { failed, reason: failed ? node?.label : undefined, state, events: all };
  }

  it("rejects an edit forbidden by a constraint (as a failed observation)", () => {
    const events: Event[] = [
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
    ];
    const verdict = runApply(
      { operator: "apply", action: { tool: "edit", path: "test/sum.test.mjs", find: "a", replace: "b" } },
      events,
    );
    expect(verdict.failed).toBe(true);
    expect(verdict.reason).toContain("constraint_violation");
  });

  it("refuses an edit on a stale read basis", () => {
    const events: Event[] = [
      goal,
      { type: "add_node", node: { id: "file:src/a.ts", space: "artifact", kind: "file", label: "src/a.ts", seq: 1 } },
      {
        type: "add_node",
        node: { id: "o1", space: "work", kind: "observation", label: "read src/a.ts", payload: { ref: "file:src/a.ts", version: "v1" }, seq: 2 },
      },
      { type: "mutate", ref: "file:src/a.ts", version: "v2", actionId: "a1" },
    ];
    const verdict = runApply(
      { operator: "apply", action: { tool: "edit", path: "src/a.ts", find: "a", replace: "b" } },
      events,
    );
    expect(verdict.reason).toBe("stale_base");
  });

  it("refuses a repeated run with no change since it ran", () => {
    const events: Event[] = [
      goal,
      { type: "add_node", node: { id: "a1", space: "work", kind: "action", label: "run build", payload: { command: "run build", signature: "run build\u0000" }, seq: 1 } },
      { type: "add_node", node: { id: "o1", space: "work", kind: "observation", label: "run build", payload: { command: "run build", exitCode: 0 }, seq: 2 } },
      { type: "add_edge", edge: { id: "e1", from: "a1", to: "o1", kind: "result", provenance: { kind: "grep", pattern: "x" } } },
    ];
    const verdict = runApply({ operator: "apply", action: { tool: "bash", command: "run build" } }, events);
    expect(verdict.failed).toBe(true);
    expect(verdict.reason).toContain("repeated_action");
    expect(verdict.reason).toContain("o1");
  });

  it("refuses an identical re-read and names the stored result", () => {
    const root = mkdtempSync(join(tmpdir(), "skein-read-"));
    tempDirs.push(root);
    writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\n");
    const workspace = fsWorkspace(root);
    const first = runApply({ operator: "apply", action: { tool: "read", path: "a.txt" } }, [goal], workspace);
    const obsId = [...first.state.nodes.values()].find((node) => node.kind === "observation")?.id ?? "?";

    const same = runApply({ operator: "apply", action: { tool: "read", path: "a.txt" } }, first.events, workspace);
    expect(same.failed).toBe(true);
    expect(same.reason).toContain(obsId);

    // A different window is a new action.
    expect(
      runApply({ operator: "apply", action: { tool: "read", path: "a.txt", start: 2, end: 3 } }, first.events, workspace)
        .failed,
    ).toBe(false);

    // After a change to the world, re-reading is allowed.
    const afterMutation = [...first.events, { type: "mutate", ref: "file:a.txt", version: "v2", actionId: "a1" } as Event];
    expect(
      runApply({ operator: "apply", action: { tool: "read", path: "a.txt" } }, afterMutation, workspace).failed,
    ).toBe(false);
  });

  it("points a repeated recall at the result already held", () => {
    const state = fold([
      goal,
      {
        type: "add_node",
        node: { id: "o1", space: "work", kind: "observation", label: "run", payload: { output: "x" }, seq: 1 },
      },
    ]);
    const verdict = classify({ operator: "recall", id: "o1" }, state, ["o1"]);
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toContain("recalled");
  });

  it("refuses an identical re-search and names the stored result", () => {
    const root = mkdtempSync(join(tmpdir(), "skein-research-"));
    tempDirs.push(root);
    writeFileSync(join(root, "code.txt"), "MATCH one\nMATCH two\n");
    const workspace = fsWorkspace(root);
    const first = runApply({ operator: "apply", action: { tool: "grep", pattern: "MATCH" } }, [goal], workspace);
    const obsId = [...first.state.nodes.values()].find((node) => node.kind === "observation")?.id ?? "?";

    const same = runApply({ operator: "apply", action: { tool: "grep", pattern: "MATCH" } }, first.events, workspace);
    expect(same.failed).toBe(true);
    expect(same.reason).toContain(obsId);

    expect(
      runApply({ operator: "apply", action: { tool: "grep", pattern: "MATCH", from: 2 } }, first.events, workspace)
        .failed,
    ).toBe(false);
  });

  it("accepts a create_goal on a fresh request, and rejects empty content", () => {
    const req: Event = {
      type: "add_node",
      node: { id: "r1", space: "work", kind: "request", label: "t", payload: { text: "t" }, seq: 0 },
    };
    const state = fold([req]);
    expect(
      classify({ operator: "create_goal", what: "locate", state: "reconnaissance", action: { tool: "bash", command: "node --test" } },
        state,
      ),
    ).toEqual({ accept: true });
    expect(
      classify({ operator: "create_goal", what: "", state: "reconnaissance", action: { tool: "bash", command: "true" } }, state).reason,
    ).toBe("empty_what");
    expect(
      classify({ operator: "create_goal", what: "x", state: "reconnaissance", action: { tool: "bash", command: "" } }, state).reason,
    ).toBe("empty_command");
    expect(
      classify({ operator: "create_goal", what: "x", state: "reconnaissance", action: { tool: "bash", command: "node --test" } },
        fold([]),
      ).reason,
    ).toContain("no_current_goal");
  });

  it("guards run: it needs a command", () => {
    const events: Event[] = [
      {
        type: "add_node",
        node: {
          id: "g2",
          space: "work",
          kind: "goal",
          label: "crit",
          payload: { what: "crit" },
          seq: 1,
        },
      },
    ];
    expect(runApply({ operator: "apply", action: { tool: "bash" } }, events).reason).toContain(
      "bash needs a command",
    );
    expect(runApply({ operator: "apply", action: { tool: "bash", command: "npm test" } }, events).failed).toBe(
      false,
    );
  });

  it("allows a repeated run after a timeout (no exit code), refuses a deterministic one", () => {
    const runAction = { operator: "apply" as const, action: { tool: "bash" as const, command: "true" } };
    const ranWith = (payload: { command: string; exitCode?: number }): Event[] => [
      goal,
      { type: "add_node", node: { id: "a1", space: "work", kind: "action", label: "true", payload: { command: "true", signature: "true\u0000" }, seq: 1 } },
      { type: "add_node", node: { id: "o1", space: "work", kind: "observation", label: "true", payload, seq: 2 } },
      { type: "add_edge", edge: { id: "e1", from: "a1", to: "o1", kind: "result", provenance: { kind: "llm" } } },
    ];
    // A timeout brought no knowledge: the same command may be retried.
    expect(runApply(runAction, ranWith({ command: "true" })).failed).toBe(false);
    // A deterministic exit is a repeat: retrieve the body instead.
    expect(runApply(runAction, ranWith({ command: "true", exitCode: 1 })).reason).toMatch(
      /repeated_action/,
    );
  });
});

describe("executeAction", () => {
  it("create_goal builds a goal, its plan and descends into it", () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    const root = fold([
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green" }, seq: 0 } },
      { type: "add_node", node: { id: "p1", space: "work", kind: "plan", label: "plan for g1", seq: 1 } },
      { type: "add_edge", edge: { id: "e1", from: "g1", to: "p1", kind: "plan", provenance: { kind: "llm" } } },
      { type: "add_node", node: { id: "a1", space: "work", kind: "action", label: "make test", payload: { command: "make test" }, seq: 2 } },
      { type: "add_edge", edge: { id: "e2", from: "p1", to: "a1", kind: "items", provenance: { kind: "llm" } } },
      { type: "descend", node: "g1" },
    ]);
    const outcome = executeAction(
      {
        operator: "create_goal",
        what: "locate",
        state: "reconnaissance", action: { tool: "bash", command: "node --test" },
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
      (edge) => edge.kind === "plan" && edge.from === childGoal?.id,
    );
    expect(planEdges).toHaveLength(1);
    expect(childrenOf(state, planEdges[0]?.to as string)).toHaveLength(1);
  });

  it("create_goal on an open goal with an exhausted plan starts a new plan item", () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    const root = fold([
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green" }, seq: 0 } },
      { type: "add_node", node: { id: "p1", space: "work", kind: "plan", label: "plan", seq: 1 } },
      { type: "add_edge", edge: { id: "e1", from: "g1", to: "p1", kind: "plan", provenance: { kind: "llm" } } },
      { type: "descend", node: "g1" },
    ]);
    const outcome = executeAction(
      { operator: "create_goal", what: "sub", state: "localization", action: { tool: "bash", command: "true" } },
      root,
      workspace,
      0,
    );
    const state = fold(outcome.events, root);
    const sub = [...state.nodes.values()].find((node) => node.kind === "goal" && node.id !== "g1");
    expect(sub).toBeDefined();
    expect(currentGoalId(state)).toBe(sub?.id);
    // The exhausted plan gains a new item whose newest alternative is the sub-goal.
    const item = childrenOf(state, "p1").at(-1);
    expect(item).toBeDefined();
    expect(lastChild(state, item as string)).toBe(sub?.id);
    // No refusal: the move is accepted.
    const failure = outcome.events.find(
      (event) =>
        event.type === "add_node" &&
        (event.node.payload as { failed?: boolean } | undefined)?.failed === true,
    );
    expect(failure).toBeUndefined();
  });

  it("edit mutates the file and records the new version", () => {
    const root = setup("off-by-one");
    const workspace = fsWorkspace(root);
    const before = fold([
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green" }, seq: 0 } },
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
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green" }, seq: 0 } },
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
      { operator: "apply", action: { tool: "bash", command: "kill -SEGV $$" } },
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
    // The crash summary is part of the observation payload the tape renders.
    expect((node?.payload as { signal?: string } | undefined)?.signal).toBe("SIGSEGV");
  });

  it("keeps find/replace of an edit on the action payload", () => {
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
    const action = [...fold(outcome.events, state).nodes.values()].find((n) => n.kind === "action");
    expect((action?.payload as { find?: string } | undefined)?.find).toBe("i < n");
    expect((action?.payload as { replace?: string } | undefined)?.replace).toBe("i <= n");
  });

  it("records the attempted find of a failed edit", () => {
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
    const observed = fold(outcome.events, state);
    expect(
      [...observed.nodes.values()].some(
        (n) => n.kind === "observation" && (n.payload as { failed?: boolean } | undefined)?.failed === true,
      ),
    ).toBe(true);
    const action = [...observed.nodes.values()].find((n) => n.kind === "action");
    expect((action?.payload as { find?: string } | undefined)?.find).toBe("NOT PRESENT");
  });

  it("reads a byte-bounded window and says where to continue", () => {
    const root = mkdtempSync(join(tmpdir(), "skein-read-"));
    tempDirs.push(root);
    // Long lines so the whole file far exceeds 8K: the first read is a byte-bounded prefix
    // and reports where to continue (there is no line cap).
    const lines = Array.from(
      { length: 400 },
      (_, index) => `line ${index + 1} ${"x".repeat(200)}`,
    ).join("\n");
    writeFileSync(join(root, "big.txt"), lines);
    const workspace = fsWorkspace(root);
    const state = fold([
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green" }, seq: 0 } },
    ]);
    const first = executeAction(
      { operator: "apply", action: { tool: "read", path: "big.txt" } },
      state,
      workspace,
      0,
    );
    expect(first.turn.text).toContain("line 1 ");
    const match = first.turn.text.match(/continue from (\d+)/);
    expect(match).not.toBeNull();
    const resume = Number(match?.[1]);
    expect(resume).toBeGreaterThan(1);
    expect(resume).toBeLessThanOrEqual(400);
    const next = executeAction(
      { operator: "apply", action: { tool: "read", path: "big.txt", start: resume, end: 400 } },
      state,
      workspace,
      1,
    );
    // The window advances and stays byte-bounded, so a far tail still pages on.
    expect(next.turn.text).toContain(`line ${resume} `);
    expect(next.turn.text).toMatch(/continue from \d+/);
  });

  it("branches the current plan item when the action differs, so the plan never blocks", () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    const root = fold([
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green" }, seq: 0 } },
      { type: "add_node", node: { id: "p1", space: "work", kind: "plan", label: "plan", seq: 1 } },
      { type: "add_edge", edge: { id: "hp", from: "g1", to: "p1", kind: "plan", provenance: { kind: "llm" } } },
      { type: "add_node", node: { id: "a1", space: "work", kind: "action", label: "cat HACKING.adoc", payload: { command: "cat HACKING.adoc" }, seq: 2 } },
      { type: "add_edge", edge: { id: "it", from: "p1", to: "a1", kind: "items", provenance: { kind: "llm" } } },
    ]);
    expect(itemFulfilled(root, "a1")).toBe(false);
    const outcome = executeAction(
      { operator: "apply", action: { tool: "bash", command: "ls" } },
      root,
      workspace,
      0,
    );
    const state = fold(outcome.events, root);
    expect(itemFulfilled(state, "a1")).toBe(true);
    expect(cursorOf(state, "g1")).toBe(1);
  });

  it("grep returns a plain-text window with context", () => {
    const root = mkdtempSync(join(tmpdir(), "skein-grep-"));
    tempDirs.push(root);
    writeFileSync(join(root, "code.txt"), "alpha\nbeta\nMATCH\ngamma\ndelta\n");
    const workspace = fsWorkspace(root);
    const state = fold([
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green" }, seq: 0 } },
    ]);
    const outcome = executeAction(
      { operator: "apply", action: { tool: "grep", pattern: "MATCH" } },
      state,
      workspace,
      0,
    );
    expect(outcome.turn.text).toBe(
      [
        "code.txt-1-alpha",
        "code.txt-2-beta",
        "code.txt:3:MATCH",
        "code.txt-4-gamma",
        "code.txt-5-delta",
        "code.txt-6-",
      ].join("\n"),
    );
  });

  it("grep pages over matches by from/count and reports the continuation", () => {
    const root = mkdtempSync(join(tmpdir(), "skein-grep-"));
    tempDirs.push(root);
    writeFileSync(join(root, "code.txt"), "MATCH one\nMATCH two\nMATCH three\n");
    const workspace = fsWorkspace(root);
    const state = fold([
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green" }, seq: 0 } },
    ]);
    const first = executeAction(
      { operator: "apply", action: { tool: "grep", pattern: "MATCH", count: 2 } },
      state,
      workspace,
      0,
    );
    expect(first.turn.text).toContain("code.txt:1:MATCH one");
    expect(first.turn.text).toContain("code.txt:2:MATCH two");
    expect(first.turn.text).toContain("[showing 2 of 3 matches; continue from 3]");

    const state2 = fold(first.events, state);
    const second = executeAction(
      { operator: "apply", action: { tool: "grep", pattern: "MATCH", count: 2, from: 3 } },
      state2,
      workspace,
      1,
    );
    expect(second.turn.text).toContain("code.txt:3:MATCH three");
    expect(second.turn.text).not.toContain("continue from");
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
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green" }, seq: 0 } },
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
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green" }, seq: 0 } },
      {
        type: "add_node",
        node: { id: "k1", space: "work", kind: "constraint", label: "no tests", payload: { forbid: ["\\.test\\.mjs$"] }, seq: 1 },
      },
    ]);
    const outcome = executeAction(
      {
        operator: "apply",
        action: { tool: "bash", command: "printf '// x\\n' > test/sum.test.mjs" },
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

describe("recall by id (history index)", () => {
  const goal = {
    type: "add_node" as const,
    node: { id: "g1", space: "work" as const, kind: "goal" as const, label: "green", seq: 0, payload: { what: "green" } },
  };

  it("returns a stored body by id and windows a large one", () => {
    const root = mkdtempSync(join(tmpdir(), "skein-recall-"));
    tempDirs.push(root);
    const workspace = fsWorkspace(root);
    const big = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    workspace.write(".skein/observations/o2.txt", big);
    const state = fold([
      goal,
      { type: "add_node", node: { id: "o1", space: "work", kind: "observation", label: "small", payload: { output: "hello" }, seq: 1 } },
      { type: "add_node", node: { id: "o2", space: "work", kind: "observation", label: "big", payload: { outputRef: ".skein/observations/o2.txt" }, seq: 2 } },
    ]);

    const small = executeAction({ operator: "recall", id: "o1" }, state, workspace, 0);
    const smallJson = JSON.parse(small.turn.text) as { id: string; output: string; total: number };
    expect(smallJson.id).toBe("o1");
    expect(smallJson.output).toContain("hello");

    const windowed = executeAction(
      { operator: "recall", id: "o2", start: 2, end: 4 },
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

  it("refuses a recall for a result already in the working set", () => {
    const state = fold([goal]);
    const held = ["obs:30"];

    const repeat = classify({ operator: "recall", id: "obs:30" }, state, held);
    expect(repeat.accept).toBe(false);
    expect(repeat.reason).toContain("obs:30");
    expect(repeat.reason).toContain("repeated_action");

    // Another id is fine.
    expect(classify({ operator: "recall", id: "obs:31" }, state, held)).toEqual({
      accept: true,
    });
  });

  it("refuses a re-recall of a non-result id (e.g. an action node)", () => {
    const state = fold([goal]);
    const verdict = classify({ operator: "recall", id: "w:action:77" }, state, [
      "w:action:77",
    ]);
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toContain("w:action:77");
    expect(verdict.reason).toContain("repeated_action");
  });
});

describe("the message tape", () => {
  it("grows with each move and keeps the open goal's history", async () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    const roles: string[][] = [];
    let index = 0;
    const propose = async (context: Context): Promise<Proposals> => {
      roles.push(context.history.map((message) => message.role));
      index += 1;
      if (index === 1) {
        return proposal({
          operator: "create_goal",
          what: "green",
          state: "reconnaissance", action: { tool: "bash", command: "echo start" },
        });
      }
      if (index === 2) {
        return proposal({ operator: "apply", action: { tool: "read", path: "src/sum.mjs" } });
      }
      return proposal({ operator: "apply", action: { tool: "bash", command: `echo step${index}` } });
    };
    await runAgent(
      { propose, workspace, maxTurns: 6, noProgress: 10 },
      { request: { id: "r1", text: "green" } },
    );

    // A fresh request is a single user turn; create_goal is its own call + result, and the
    // seeded first command is a separate run call + result.
    expect(roles[0]).toEqual(["user"]);
    expect(roles[1]).toEqual(["user", "assistant", "tool", "assistant", "tool"]);
    // A command appends an assistant/tool pair.
    expect(roles[2]).toEqual(["user", "assistant", "tool", "assistant", "tool", "assistant", "tool"]);
  });

  it("executes a batch in one turn and cuts it after a terminal move", async () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    const contexts: Context[] = [];
    let index = 0;
    const propose = async (context: Context): Promise<Proposals> => {
      contexts.push(context);
      index += 1;
      if (index === 1) return proposal({ operator: "create_goal", what: "green", state: "reconnaissance", action: { tool: "bash", command: "echo start" } });
      if (index === 2) {
        // One doxa move, two independent probes (a batch).
        return {
          thought: "probe",
          actions: [
            { operator: "apply", action: { tool: "read", path: "src/sum.mjs" } },
            { operator: "apply", action: { tool: "bash", command: "echo one" } },
          ],
        };
      }
      // A terminal move ends the batch: the trailing apply is dropped.
      return {
        thought: "done",
        actions: [
          { operator: "stop", why: "done" },
          { operator: "apply", action: { tool: "bash", command: "echo never" } },
        ],
      };
    };
    const result = await runAgent(
      { propose, workspace, maxTurns: 6, noProgress: 10 },
      { request: { id: "r1", text: "green" } },
    );

    const commands = result.events
      .filter((event) => event.type === "add_node" && event.node.kind === "action")
      .map((event) => (event as { node: { payload: { command: string } } }).node.payload.command);
    expect(commands).toEqual(["echo start", "read src/sum.mjs", "echo one"]);
    expect(commands).not.toContain("echo never");
    expect(result.stopReason).toBe("request_addressed");
    // The batch renders as ONE assistant message with both calls, then two results.
    const batch = contexts[2]?.history.find((message) => message.calls !== undefined);
    expect(batch?.calls?.map((call) => call.name)).toEqual(["read", "bash"]);
  });

  it("carries the read's body as a tool message", async () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    const contexts: Context[] = [];
    let index = 0;
    const propose = async (context: Context): Promise<Proposals> => {
      contexts.push(context);
      index += 1;
      if (index === 1) {
        return proposal({ operator: "create_goal", what: "green", state: "reconnaissance", action: { tool: "bash", command: "echo start" } });
      }
      if (index === 2) {
        return proposal({ operator: "apply", action: { tool: "read", path: "src/sum.mjs" } });
      }
      return proposal({ operator: "apply", action: { tool: "bash", command: "echo one" } });
    };
    await runAgent({ propose, workspace, maxTurns: 5, noProgress: 10 }, { request: { id: "r1", text: "green" } });
    // After the later run, the read's tool message is still in the tape (the tape is the
    // tree's history, not a bounded working set).
    const tape = contexts[3]?.history.map((message) => message.text).join("\n") ?? "";
    expect(tape).toContain("sumTo");
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
    const propose = async (_context: Context): Promise<Proposals> => {
      index += 1;
      if (index === 1) {
        return proposal({
          operator: "create_goal",
          what: "fix the off-by-one",
          state: "reconnaissance", action: { tool: "bash", command: "echo start" },
        });
      }
      if (index === 2) {
        return proposal({ operator: "apply", action: { tool: "edit", path: "src/sum.mjs", find: "i < n", replace: "i <= n" } });
      }
      if (index === 3) {
        return proposal({ operator: "apply", action: { tool: "bash", command: "node --test" } });
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
    const propose = async (_context: Context): Promise<Proposals> => {
      index += 1;
      if (index === 1) {
        return proposal({
          operator: "create_goal",
          what: "make the suite pass",
          state: "reconnaissance", action: { tool: "bash", command: "true" },
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
      { propose: fixed({ operator: "recall", id: "r1" }), workspace, maxTurns: 10, noProgress: 2 },
      { request: { id: "r1", text: "green" } },
    );
    expect(result.stopReason).toBe("no_progress");
  });

  it("stops with no_progress on a repeatedly refused command", async () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    let index = 0;
    const propose = async (): Promise<Proposals> => {
      index += 1;
      if (index === 1) {
        return proposal({
          operator: "create_goal",
          what: "interpret the request",
          state: "reconnaissance", action: { tool: "bash", command: "echo hi" },
        });
      }
      return proposal({ operator: "apply", action: { tool: "bash", command: "echo hi" } });
    };
    const result = await runAgent(
      { propose, workspace, maxTurns: 12, noProgress: 2 },
      { request: { id: "r1", text: "green" } },
    );
    expect(result.stopReason).toBe("no_progress");
    // A repeated command is a failed observation with a reason, not a node-less refusal.
    expect(
      [...fold(result.events).nodes.values()].some(
        (node) => node.kind === "observation" && node.label.startsWith("repeated_action"),
      ),
    ).toBe(true);
  });

  it("keeps the read's body in the tape after a later call", async () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    const contexts: Context[] = [];
    let index = 0;
    const propose = async (context: Context): Promise<Proposals> => {
      contexts.push(context);
      index += 1;
      if (index === 1) {
        return proposal({ operator: "create_goal", what: "green", state: "reconnaissance", action: { tool: "bash", command: "echo start" } });
      }
      if (index === 2) {
        return proposal({ operator: "apply", action: { tool: "read", path: "src/sum.mjs" } });
      }
      return proposal({ operator: "apply", action: { tool: "bash", command: "true" } });
    };
    await runAgent({ propose, workspace, maxTurns: 5 }, { request: { id: "r1", text: "green" } });
    // After the later run, the read's tool message is still in the tape.
    const tape = contexts[3]?.history.map((message) => message.text).join("\n") ?? "";
    expect(tape).toContain("sumTo");
  });

  it("shows a refused structural move to the model on the next turn", async () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    const contexts: Context[] = [];
    let index = 0;
    const propose = async (context: Context): Promise<Proposals> => {
      contexts.push(context);
      index += 1;
      if (index === 1) {
        return proposal({ operator: "create_goal", what: "green", state: "reconnaissance", action: { tool: "bash", command: "echo start" } });
      }
      // `decline` is valid only at the request; at the open goal it is a structural refusal.
      return proposal({ operator: "decline", why: "nothing to do" });
    };
    await runAgent(
      { propose, workspace, maxTurns: 6, noProgress: 3 },
      { request: { id: "r1", text: "green" } },
    );
    // The refusal reason is on the tape the model sees next, so the loop is never blind.
    const later = contexts[2]?.history.map((message) => message.text).join("\n") ?? "";
    expect(later).toContain("rejected");
    expect(later).toContain("not_request");
  });

  it("pages a large stored body by a recall window (a windowed recall is not refused)", async () => {
    const root = mkdtempSync(join(tmpdir(), "skein-page-"));
    tempDirs.push(root);
    const lines = Array.from({ length: 120 }, (_, i) => `line ${i + 1} ${"x".repeat(40)}`);
    writeFileSync(join(root, "big.txt"), `${lines.join("\n")}\n`);
    const workspace = fsWorkspace(root);
    const contexts: Context[] = [];
    let id: string | undefined;
    let index = 0;
    const propose = async (context: Context): Promise<Proposals> => {
      contexts.push(context);
      index += 1;
      if (index === 1) {
        return proposal({ operator: "create_goal", what: "read the long file", state: "reconnaissance", action: { tool: "bash", command: "echo start" } });
      }
      if (index === 2) {
        return proposal({ operator: "apply", action: { tool: "read", path: "big.txt" } });
      }
      id = id ?? lastToolId(context);
      if (index === 3) {
        return proposal({ operator: "recall", id: id ?? "missing", start: 55, end: 65 });
      }
      return proposal({ operator: "stop", why: "seen enough" });
    };
    const result = await runAgent(
      { propose, workspace, maxTurns: 6, noProgress: 3 },
      { request: { id: "r1", text: "read the long file" } },
    );
    // The windowed recall returned the middle fragment (line 60), not a refusal.
    const after = contexts[3]?.history.map((message) => message.text).join("\n") ?? "";
    expect(after).toContain("line 60");
    // The assistant's own history shows the call's arguments, not a bare `recall`.
    expect(after).toMatch(/recall \{ id: obs:\d+, start: 55, end: 65 \}/);
    expect(result.events.some((event) => event.type === "record_rejection")).toBe(false);
  });

  it("renders the request's goal as a tape", () => {
    const state = fold([
      { type: "add_node", node: { id: "r1", space: "work", kind: "request", label: "task", payload: { text: "green" }, seq: 0 } },
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green" }, seq: 1 } },
      { type: "add_edge", edge: { id: "eg", from: "r1", to: "g1", kind: "goal", provenance: { kind: "llm" } } },
      { type: "add_node", node: { id: "p1", space: "work", kind: "plan", label: "plan", seq: 2 } },
      { type: "add_edge", edge: { id: "e1", from: "g1", to: "p1", kind: "plan", provenance: { kind: "llm" } } },
      { type: "add_node", node: { id: "i1", space: "work", kind: "item", label: "step", seq: 3 } },
      { type: "add_edge", edge: { id: "e2", from: "p1", to: "i1", kind: "items", provenance: { kind: "llm" } } },
      { type: "add_node", node: { id: "a1", space: "work", kind: "action", label: "run build", payload: { command: "run build" }, seq: 4 } },
      { type: "add_edge", edge: { id: "e3", from: "i1", to: "a1", kind: "alts", provenance: { kind: "llm" } } },
    ]);
    const context = project(state);
    expect(context.situation).toBe("goal");
    expect(context.history[0]?.role).toBe("user");
    expect(context.history[0]?.text).toBe("green");
    expect(context.history[1]?.text).toContain("create_goal");
    expect(context.history[2]?.text).toContain("run build");
  });

  it("refuses a repeated read and names the stored result", async () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    let index = 0;
    const propose = async (): Promise<Proposals> => {
      index += 1;
      if (index === 1) {
        return proposal({ operator: "create_goal", what: "green", state: "reconnaissance", action: { tool: "bash", command: "echo start" } });
      }
      if (index === 2 || index === 3) {
        return proposal({ operator: "apply", action: { tool: "read", path: "src/sum.mjs" } });
      }
      return proposal({ operator: "apply", action: { tool: "bash", command: "true" } });
    };
    const result = await runAgent(
      { propose, workspace, maxTurns: 5, noProgress: 2 },
      { request: { id: "r1", text: "green" } },
    );

    const state = fold(result.events);
    const reads = [...state.nodes.values()].filter(
      (node) =>
        node.kind === "action" &&
        (node.payload as { command?: string } | undefined)?.command === "read src/sum.mjs",
    );
    // Each attempt leaves an action node (docs/ir_revision.md §4): the read and its refused
    // repeat.
    expect(reads).toHaveLength(2);
    const firstRead = [...state.nodes.values()].find(
      (node) => node.kind === "observation" && (node.payload as { ref?: string } | undefined)?.ref === "file:src/sum.mjs",
    );
    const refusal = [...state.nodes.values()].find(
      (node) => node.kind === "observation" && node.label.startsWith("repeated_action"),
    );
    expect(refusal?.label).toContain(firstRead?.id ?? "?");
  });

  it("refuses an identical re-recall by id instead of re-retrieving", async () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    let readId: string | undefined;
    let index = 0;
    const propose = async (context: Context): Promise<Proposals> => {
      index += 1;
      if (index === 1) {
        return proposal({ operator: "create_goal", what: "green", state: "reconnaissance", action: { tool: "bash", command: "echo start" } });
      }
      if (index === 2) {
        return proposal({ operator: "apply", action: { tool: "read", path: "src/sum.mjs" } });
      }
      // The read's result id is exposed on the tape's tool message; reuse it on every recall.
      readId = readId ?? lastToolId(context);
      return proposal({ operator: "recall", id: readId ?? "missing" });
    };
    const result = await runAgent(
      { propose, workspace, maxTurns: 8, noProgress: 2 },
      { request: { id: "r1", text: "green" } },
    );

    const rejection = result.events.find((event) => event.type === "record_rejection");
    const reason = rejection?.type === "record_rejection" ? rejection.reason : "";
    expect(reason).toContain("repeated_action");
    expect(result.stopReason).toBe("no_progress");
  });

  it("refuses a repeated recall of a non-result node", async () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    let index = 0;
    const propose = async (context: Context): Promise<Proposals> => {
      index += 1;
      if (index === 1) {
        return proposal({
          operator: "create_goal",
          what: "green",
          state: "reconnaissance", action: { tool: "bash", command: "echo hi" },
        });
      }
      // The goal id is exposed on the tape's create_goal message.
      return proposal({ operator: "recall", id: goalIdOf(context) ?? "missing" });
    };
    const result = await runAgent(
      { propose, workspace, maxTurns: 6, noProgress: 2 },
      { request: { id: "r1", text: "green" } },
    );

    const rejection = result.events.find((event) => event.type === "record_rejection");
    const reason = rejection?.type === "record_rejection" ? rejection.reason : "";
    expect(reason).toContain("repeated_action");
  });
});

describe("failed edit materializes the file content", () => {
  it("shows the current content and keeps it in view instead of a re-read", async () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    const contexts: Context[] = [];
    let index = 0;
    const propose = async (context: Context): Promise<Proposals> => {
      contexts.push(context);
      index += 1;
      if (index === 1) {
        return proposal({
          operator: "create_goal",
          what: "green",
          state: "reconnaissance", action: { tool: "bash", command: "echo done" },
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
      return proposal({ operator: "apply", action: { tool: "bash", command: "echo done" } });
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

    // The failed-edit observation is a tool message in the tape; its body is in view.
    const tape = contexts[3]?.history.map((message) => message.text).join("\n") ?? "";
    expect(tape).toContain("current content");
  });
});
