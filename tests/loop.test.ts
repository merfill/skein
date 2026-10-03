import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadSettings } from "../src/config/settings";
import { childrenOf, currentVersion, fold, predicateOf } from "../src/ir/graph";
import { cursorOf, itemFulfilled } from "../src/ir/traversal";
import { project, type Context } from "../src/ir/project";
import { reasoningOffBody } from "../src/llm/client";
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

function scripted(actions: Action[]) {
  let index = 0;
  return async (_context: Context): Promise<Proposal> => {
    const action = actions[index];
    index += 1;
    if (!action) throw new Error("script exhausted");
    return { thought: `step ${index}`, action };
  };
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

describe("reasoning is disabled", () => {
  it("puts DeepSeek thinking and RouterAI reasoning in the request body", () => {
    expect(reasoningOffBody("none")).toEqual({
      thinking: { type: "disabled" },
      reasoning: { effort: "none" },
    });
  });

  it("loads settings from env with defaults", () => {
    const settings = loadSettings({ SKEIN_TEMPERATURE: "0.5" } as NodeJS.ProcessEnv);
    expect(settings.temperature).toBe(0.5);
    expect(settings.reasoningEffort).toBe("none");
    expect(settings.live).toBe(false);
  });
});

describe("classify", () => {
  const goal = {
    type: "add_node" as const,
    node: { id: "g1", space: "work" as const, kind: "goal" as const, label: "green", seq: 0, payload: { what: "green", done_when: { kind: "subjective" as const, text: "done" } } },
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
      { type: "add_node", node: { id: "o1", space: "work", kind: "observation", label: "run build", seq: 2 } },
      { type: "add_edge", edge: { id: "e1", from: "a1", to: "o1", kind: "produces", provenance: { kind: "grep", pattern: "x" } } },
    ]);
    const verdict = classify(
      proposal({ operator: "apply", action: { tool: "run", command: "run build" } }),
      state,
    );
    expect(verdict).toEqual({ accept: false, reason: "repeated_action" });
  });

  it("allows re-reading a file, even the same window", () => {
    const state = fold([
      goal,
      { type: "add_node", node: { id: "a1", space: "work", kind: "action", label: "read src/a.ts [1-120]", payload: { command: "read src/a.ts [1-120]" }, seq: 1 } },
      { type: "add_node", node: { id: "o1", space: "work", kind: "observation", label: "read src/a.ts [1-120]", seq: 2 } },
      { type: "add_edge", edge: { id: "e1", from: "a1", to: "o1", kind: "produces", provenance: { kind: "read", ref: "file:src/a.ts", version: "v1" } } },
    ]);
    expect(
      classify(
        proposal({ operator: "apply", action: { tool: "read", path: "src/a.ts", start: 121, end: 240 } }),
        state,
      ),
    ).toEqual({ accept: true });
    expect(
      classify(
        proposal({ operator: "apply", action: { tool: "read", path: "src/a.ts", start: 1, end: 120 } }),
        state,
      ),
    ).toEqual({ accept: true });
  });

  it("allows re-searching (grep is idempotent too)", () => {
    const state = fold([
      goal,
      { type: "add_node", node: { id: "a1", space: "work", kind: "action", label: "grep sweep 5/5", payload: { command: "grep sweep 5/5" }, seq: 1 } },
      { type: "add_node", node: { id: "o1", space: "work", kind: "observation", label: "grep sweep 5/5", seq: 2 } },
      { type: "add_edge", edge: { id: "e1", from: "a1", to: "o1", kind: "produces", provenance: { kind: "grep", pattern: "sweep" } } },
    ]);
    expect(
      classify(
        proposal({ operator: "apply", action: { tool: "grep", pattern: "sweep" } }),
        state,
      ),
    ).toEqual({ accept: true });
  });

  it("accepts a create_goal with a plan and rejects empty content", () => {
    const state = fold([goal]);
    expect(
      classify(
        proposal({
          operator: "create_goal",
          what: "locate",
          done_when: { kind: "subjective", text: "found it" },
          plan: [{ kind: "action", command: "node --test" }],
        }),
        state,
      ),
    ).toEqual({ accept: true });
    expect(
      classify(
        proposal({ operator: "create_goal", what: "", done_when: { kind: "subjective", text: "x" } }),
        state,
      ).reason,
    ).toBe("empty_what");
    expect(
      classify(
        proposal({ operator: "create_goal", what: "x", done_when: { kind: "objective", command: "" } }),
        state,
      ).reason,
    ).toBe("empty_done_when");
    expect(
      classify(
        proposal({ operator: "create_goal", what: "x", done_when: { kind: "subjective", text: "y" }, plan: [] }),
        state,
      ).reason,
    ).toBe("empty_plan");
  });

  it("refuses complete on the root and on an objective goal", () => {
    const root = fold([goal]);
    expect(classify(proposal({ operator: "complete" }), root).reason).toBe("root_not_completable");

    const state = fold([
      {
        type: "add_node",
        node: {
          id: "g1",
          space: "work",
          kind: "goal",
          label: "green",
          payload: { what: "green", done_when: { kind: "objective", command: "node --test" } },
          seq: 0,
        },
      },
      { type: "add_node", node: { id: "g2", space: "work", kind: "goal", label: "sub", payload: { what: "sub", done_when: { kind: "objective", command: "node --test" } }, seq: 1 } },
      { type: "add_edge", edge: { id: "e1", from: "g2", to: "g1", kind: "item", provenance: { kind: "llm" } } },
      { type: "descend", node: "g2" },
    ]);
    expect(classify(proposal({ operator: "complete" }), state).reason).toBe(
      "objective_goal_needs_check",
    );
  });
});

describe("executeAction", () => {
  it("create_goal builds a goal, its plan and descends into it", () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    const root = fold([
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green", done_when: { kind: "subjective", text: "done" } }, seq: 0 } },
    ]);
    const outcome = executeAction(
      {
        operator: "create_goal",
        what: "locate",
        done_when: { kind: "subjective", text: "found" },
        plan: [{ kind: "action", command: "node --test" }],
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

  it("edit mutates the file and records the new version", () => {
    const root = setup("off-by-one");
    const workspace = fsWorkspace(root);
    const before = fold([
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green", done_when: { kind: "subjective", text: "done" } }, seq: 0 } },
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

  it("reads a bounded window and says where to continue", () => {
    const root = mkdtempSync(join(tmpdir(), "skein-read-"));
    tempDirs.push(root);
    const lines = Array.from({ length: 600 }, (_, index) => `line ${index + 1}`).join("\n");
    writeFileSync(join(root, "big.txt"), lines);
    const workspace = fsWorkspace(root);
    const state = fold([
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green", done_when: { kind: "subjective", text: "done" } }, seq: 0 } },
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
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green", done_when: { kind: "subjective", text: "done" } }, seq: 0 } },
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

  it("grep shows context around matches", () => {
    const root = mkdtempSync(join(tmpdir(), "skein-grep-"));
    tempDirs.push(root);
    writeFileSync(join(root, "code.txt"), "alpha\nbeta\nMATCH\ngamma\ndelta\n");
    const workspace = fsWorkspace(root);
    const state = fold([
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green", done_when: { kind: "subjective", text: "done" } }, seq: 0 } },
    ]);
    const outcome = executeAction(
      { operator: "apply", action: { tool: "grep", pattern: "MATCH" } },
      state,
      workspace,
      0,
    );
    expect(outcome.turn.text).toContain("code.txt:3: MATCH");
    expect(outcome.turn.text).toContain("code.txt:2: beta");
    expect(outcome.turn.text).toContain("code.txt:4: gamma");
  });

  it("run with a target records a check that achieves the goal", () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    const root = fold([
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green", done_when: { kind: "objective", command: "true" } }, seq: 0 } },
    ]);
    const outcome = executeAction(
      { operator: "apply", action: { tool: "run", command: "true", target: "g1" } },
      root,
      workspace,
      0,
    );
    const state = fold(outcome.events, root);
    expect(predicateOf(state, "g1")).toBe("achieved");
  });

  it("run that violates a constraint is reverted and records no check", () => {
    const root = setup("off-by-one");
    const workspace = fsWorkspace(root);
    const original = workspace.read("test/sum.test.mjs");
    const before = fold([
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green", done_when: { kind: "objective", command: "node --test" } }, seq: 0 } },
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
    expect([...state.nodes.values()].some((node) => node.kind === "check")).toBe(false);
    expect(
      [...state.nodes.values()].some(
        (node) => node.kind === "observation" && node.label.startsWith("constraint violation"),
      ),
    ).toBe(true);
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
});

describe("runAgent", () => {
  it("carries a plan through edit and check to a closed root", async () => {
    const root = setup("off-by-one");
    const workspace = fsWorkspace(root);
    const result = await runAgent(
      {
        propose: scripted([
          {
            operator: "create_goal",
            what: "fix the off-by-one",
            why: "the loop stops one short",
            done_when: { kind: "objective", command: "node --test" },
            plan: [{ kind: "action", command: "node --test" }],
          },
          { operator: "apply", action: { tool: "edit", path: "src/sum.mjs", find: "i < n", replace: "i <= n" } },
          { operator: "apply", action: { tool: "run", command: "node --test" } },
          { operator: "apply", action: { tool: "run", command: "node --test" } },
        ]),
        workspace,
        maxTurns: 10,
      },
      { request: { id: "r1", text: "make the suite pass" } },
    );

    expect(workspace.run("node --test").code).toBe(0);
    expect(achievedWithoutCheck(result.events)).toEqual([]);
    expect(unboundGoals(result.events)).toEqual([]);
    expect(structuralCycle(result.events)).toBe(false);
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
          done_when: { kind: "objective", command: "node --test" },
          plan: [{ kind: "action", command: "echo hi" }],
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

  it("shows the results the model asked to keep (need)", async () => {
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
        const id = contexts[1]?.lastResult?.id;
        return {
          ...proposal({ operator: "apply", action: { tool: "run", command: "true" } }),
          ...(id !== undefined ? { need: [id] } : {}),
        };
      }
      return proposal({ operator: "query", id: "r1" });
    };
    await runAgent(
      { propose, workspace, maxTurns: 4 },
      { request: { id: "r1", text: "green" } },
    );
    const readId = contexts[1]?.lastResult?.id;
    const shown = contexts[2]?.shown ?? [];
    expect(shown.map((view) => view.id)).toContain(readId);
    expect(shown[0]?.kind).toBe("observation");
    expect(shown[0]?.output).toContain("sumTo");
  });

  it("reports the focus plan and applicable operators in the projection", () => {
    const state = fold([
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green", done_when: { kind: "objective", command: "node --test" } }, seq: 0 } },
      { type: "add_node", node: { id: "p1", space: "work", kind: "plan", label: "plan", seq: 1 } },
      { type: "add_edge", edge: { id: "e1", from: "g1", to: "p1", kind: "has_plan", provenance: { kind: "llm" } } },
      { type: "add_node", node: { id: "a1", space: "work", kind: "action", label: "run build", seq: 2 } },
      { type: "add_edge", edge: { id: "e2", from: "p1", to: "a1", kind: "item", provenance: { kind: "llm" } } },
    ]);
    const context = project(state);
    expect(context.path[0]?.plan?.items.map((item) => item.id)).toEqual(["a1"]);
    expect(context.applicable).toContain("apply");
  });
});

describe("request, revisions and check soundness", () => {
  const request = {
    type: "add_node" as const,
    node: { id: "r1", space: "work" as const, kind: "request" as const, label: "task", payload: { text: "do it" }, seq: 0 },
  };
  const base = [
    request,
    {
      type: "add_node" as const,
      node: {
        id: "g1",
        space: "work" as const,
        kind: "goal" as const,
        label: "approach one",
        payload: { what: "approach one", done_when: { kind: "subjective" as const, text: "ok" } },
        seq: 1,
      },
    },
    { type: "add_node" as const, node: { id: "a1", space: "work" as const, kind: "alternatives" as const, label: "alt", seq: 2 } },
    { type: "add_edge" as const, edge: { id: "e1", from: "r1", to: "a1", kind: "has_alternatives" as const, provenance: { kind: "llm" as const } } },
    { type: "add_edge" as const, edge: { id: "e2", from: "a1", to: "g1", kind: "item" as const, provenance: { kind: "llm" as const } } },
    { type: "add_edge" as const, edge: { id: "e3", from: "a1", to: "g1", kind: "chosen" as const, provenance: { kind: "llm" as const } } },
    { type: "record_check" as const, command: "node --test", verdict: "fail" as const, output: "no", targets: ["g1"] },
  ];

  it("requires revises to list the failed interpretation", () => {
    const state = fold(base);
    expect(predicateOf(state, "g1")).toBe("refuted");
    expect(
      classify(
        proposal({ operator: "create_goal", what: "approach two", done_when: { kind: "subjective", text: "ok" } }),
        state,
      ),
    ).toEqual({ accept: false, reason: "missing_revision" });
    expect(
      classify(
        proposal({
          operator: "create_goal",
          what: "approach two",
          done_when: { kind: "subjective", text: "ok" },
          revises: ["g1"],
        }),
        state,
      ),
    ).toEqual({ accept: true });
    expect(
      classify(
        proposal({
          operator: "create_goal",
          what: "approach one",
          done_when: { kind: "subjective", text: "ok" },
          revises: ["g1"],
        }),
        state,
      ),
    ).toEqual({ accept: false, reason: "repeat_hypothesis" });
  });

  it("refuses to check a subjective goal", () => {
    const state = fold([
      request,
      {
        type: "add_node",
        node: { id: "g2", space: "work", kind: "goal", label: "sub", payload: { what: "sub", done_when: { kind: "subjective", text: "ok" } }, seq: 1 },
      },
    ]);
    expect(
      classify(proposal({ operator: "apply", action: { tool: "run", command: "x", target: "g2" } }), state),
    ).toEqual({ accept: false, reason: "subjective_goal_needs_complete" });
  });

  it("runs the goal's done_when command for a check, ignoring the proposed one", () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    const state = fold([
      request,
      {
        type: "add_node",
        node: { id: "g2", space: "work", kind: "goal", label: "crit", payload: { what: "crit", done_when: { kind: "objective", command: "true" } }, seq: 1 },
      },
    ]);
    const outcome = executeAction(
      { operator: "apply", action: { tool: "run", command: "false", target: "g2" } },
      state,
      workspace,
      0,
    );
    const after = fold(outcome.events, state);
    expect(predicateOf(after, "g2")).toBe("achieved");
    const check = [...after.nodes.values()].find((node) => node.kind === "check");
    expect((check?.payload as { command?: string } | undefined)?.command).toBe("true");
  });
});
