import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadSettings } from "../src/config/settings";
import type { Event } from "../src/ir/events";
import { childrenOf, currentVersion, fold, predicateOf } from "../src/ir/graph";
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
    node: { id: "g1", space: "work" as const, kind: "goal" as const, label: "green", seq: 0, payload: { what: "green", done_when: { kind: "arbiter" as const, text: "done" } } },
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

  it("accepts a create_goal with a plan and rejects empty content", () => {
    const state = fold([goal]);
    expect(
      classify(
        proposal({
          operator: "create_goal",
          what: "locate",
          done_when: { kind: "arbiter", text: "found it" },
          plan: [{ kind: "action", command: "node --test" }],
        }),
        state,
      ),
    ).toEqual({ accept: true });
    expect(
      classify(
        proposal({ operator: "create_goal", what: "", done_when: { kind: "arbiter", text: "x" } }),
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
        proposal({ operator: "create_goal", what: "x", done_when: { kind: "arbiter", text: "y" }, plan: [] }),
        state,
      ).reason,
    ).toBe("empty_plan");
    expect(
      classify(
        proposal({
          operator: "create_goal",
          what: "x",
          done_when: { kind: "arbiter", text: "y" },
          plan: [{ kind: "goal", what: "", done_when: { kind: "arbiter", text: "z" } }],
        }),
        state,
      ).reason,
    ).toBe("empty_item");
    expect(
      classify(
        proposal({
          operator: "create_goal",
          what: "x",
          done_when: { kind: "arbiter", text: "y" },
          plan: [{ kind: "action", command: "node --test" }],
        }),
        fold([]),
      ).reason,
    ).toContain("no_current_goal");
    const unknown = classify(
      proposal({
        operator: "create_goal",
        what: "x",
        done_when: { kind: "arbiter", text: "y" },
        revises: ["g1"],
      }),
      state,
    );
    expect(unknown.reason).toContain("unknown_revision");
    expect(unknown.reason).toContain("g1");
  });

  it("guards run: needs a command, and a check may not substitute the goal's command", () => {
    const state = fold([
      {
        type: "add_node",
        node: {
          id: "g2",
          space: "work",
          kind: "goal",
          label: "crit",
          payload: { what: "crit", done_when: { kind: "objective", command: "npm test" } },
          seq: 1,
        },
      },
    ]);
    expect(classify(proposal({ operator: "apply", action: { tool: "run" } }), state).reason).toContain(
      "run needs a command",
    );
    // target-only is the expected way to check an objective goal.
    expect(
      classify(proposal({ operator: "apply", action: { tool: "run", target: "g2" } }), state),
    ).toEqual({ accept: true });
    // Passing the goal's own command verbatim is also fine.
    expect(
      classify(
        proposal({ operator: "apply", action: { tool: "run", command: "npm test", target: "g2" } }),
        state,
      ),
    ).toEqual({ accept: true });
    // A different command is refused: the goal's command is not substitutable.
    const mismatch = classify(
      proposal({ operator: "apply", action: { tool: "run", command: "npm run lint", target: "g2" } }),
      state,
    );
    expect(mismatch.accept).toBe(false);
    expect(mismatch.reason).toContain("its own command");
  });

  it("refuses run of a non-goal target", () => {
    const state = fold([goal]);
    expect(
      classify(
        proposal({ operator: "apply", action: { tool: "run", command: "x", target: "missing" } }),
        state,
      ).reason,
    ).toBe("invalid_target");
  });

  it("refuses a check that targets a non-current goal", () => {
    const state = fold([
      { type: "add_node", node: { id: "r1", space: "work", kind: "request", label: "task", payload: { text: "go" }, seq: 0 } },
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "interp", payload: { what: "interp", done_when: { kind: "objective", command: "node --test" } }, seq: 1 } },
      { type: "add_node", node: { id: "alt", space: "work", kind: "alternatives", label: "alt", seq: 2 } },
      { type: "add_edge", edge: { id: "ea", from: "r1", to: "alt", kind: "has_alternatives", provenance: { kind: "llm" } } },
      { type: "add_edge", edge: { id: "ei", from: "alt", to: "g1", kind: "item", provenance: { kind: "llm" } } },
      { type: "add_edge", edge: { id: "ec", from: "alt", to: "g1", kind: "chosen", provenance: { kind: "llm" } } },
      { type: "add_node", node: { id: "p1", space: "work", kind: "plan", label: "plan", seq: 3 } },
      { type: "add_edge", edge: { id: "ep", from: "g1", to: "p1", kind: "has_plan", provenance: { kind: "llm" } } },
      { type: "add_node", node: { id: "g2", space: "work", kind: "goal", label: "stage", payload: { what: "stage", done_when: { kind: "objective", command: "node --test" } }, seq: 4 } },
      { type: "add_edge", edge: { id: "e2", from: "p1", to: "g2", kind: "item", provenance: { kind: "llm" } } },
      { type: "descend", node: "g1" },
      { type: "descend", node: "g2" },
    ]);
    const check = classify(
      proposal({ operator: "apply", action: { tool: "run", target: "g1" } }),
      state,
    );
    expect(check.accept).toBe(false);
    expect(check.reason).toContain("not_current_goal");
    expect(check.reason).toContain("g2");
    // The refusal names the concrete move at the focus (P5): g2 is objective, so check it.
    expect(check.reason).toContain('apply run {target: "g2"}');
  });

  it("allows an identical re-check after an inconclusive verdict", () => {
    const checked = (verdict: "inconclusive" | "fail"): Event[] => [
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "crit", payload: { what: "crit", done_when: { kind: "objective", command: "true" } }, seq: 0 } },
      { type: "add_node", node: { id: "a1", space: "work", kind: "action", label: "true", payload: { signature: "true\u0000g1", command: "true" }, seq: 1 } },
      { type: "record_check", id: "chk:1", command: "true", verdict, output: "", targets: ["g1"] },
      { type: "add_edge", edge: { id: "ep", from: "a1", to: "chk:1", kind: "produces", provenance: { kind: "check", command: "true", verdict } } },
    ];
    const retry = proposal({ operator: "apply", action: { tool: "run", target: "g1" } });
    expect(classify(retry, fold(checked("inconclusive")))).toEqual({ accept: true });
    // A deterministic failure is still a repeat: retrieve the body instead.
    expect(classify(retry, fold(checked("fail"))).accept).toBe(false);
  });

  it("allows a poll of a background job and refuses a malformed one", () => {
    const state = fold([
      { type: "add_node", node: { id: "r1", space: "work", kind: "request", label: "task", payload: { text: "go" }, seq: 0 } },
    ]);
    expect(
      classify(proposal({ operator: "apply", action: { tool: "run", job: "job-1" } }), state),
    ).toEqual({ accept: true });
    const extra = classify(
      proposal({ operator: "apply", action: { tool: "run", job: "job-1", command: "make" } }),
      state,
    );
    expect(extra.accept).toBe(false);
    expect(extra.reason).toContain("job_poll");
  });

  it("accepts a background run but refuses one without a command or with a target", () => {
    const state = fold([
      { type: "add_node", node: { id: "r1", space: "work", kind: "request", label: "task", payload: { text: "go" }, seq: 0 } },
    ]);
    expect(
      classify(
        proposal({ operator: "apply", action: { tool: "run", command: "make", background: true } }),
        state,
      ),
    ).toEqual({ accept: true });
    const noCommand = classify(
      proposal({ operator: "apply", action: { tool: "run", background: true } }),
      state,
    );
    expect(noCommand.accept).toBe(false);
    expect(noCommand.reason).toContain("background_run");
    const withTarget = classify(
      proposal({ operator: "apply", action: { tool: "run", background: true, target: "r1" } }),
      state,
    );
    expect(withTarget.accept).toBe(false);
    expect(withTarget.reason).toContain("background_target");
  });

  it("allows growing an objective goal's plan when a stage was refuted, not achieved", () => {
    const state = fold([
      {
        type: "add_node",
        node: { id: "g1", space: "work", kind: "goal", label: "root", payload: { what: "root", done_when: { kind: "objective", command: "node --test" } }, seq: 0 },
      },
      {
        type: "add_node",
        node: { id: "g2", space: "work", kind: "goal", label: "stage", payload: { what: "stage", done_when: { kind: "objective", command: "node --test" } }, seq: 1 },
      },
      { type: "add_node", node: { id: "p1", space: "work", kind: "plan", label: "plan", seq: 2 } },
      { type: "add_edge", edge: { id: "e1", from: "g1", to: "p1", kind: "has_plan", provenance: { kind: "llm" } } },
      { type: "add_edge", edge: { id: "e2", from: "p1", to: "g2", kind: "item", provenance: { kind: "llm" } } },
      { type: "record_check", command: "node --test", verdict: "fail", output: "no", targets: ["g2"] },
    ]);
    expect(predicateOf(state, "g2")).toBe("refuted");
    expect(
      classify(
        proposal({
          operator: "create_goal",
          what: "add a stage the refuted one did not cover",
          done_when: { kind: "objective", command: "node --test" },
        }),
        state,
      ),
    ).toEqual({ accept: true });
  });

  it("allows growing a plan whose only stages are fulfilled epistemic goals", () => {
    // g1 objective, plan = [g2 subjective] completed; the fix stage is still to come.
    const state = fold([
      {
        type: "add_node",
        node: { id: "g1", space: "work", kind: "goal", label: "root", payload: { what: "root", done_when: { kind: "objective", command: "node --test" } }, seq: 0 },
      },
      {
        type: "add_node",
        node: { id: "g2", space: "work", kind: "goal", label: "locate", payload: { what: "locate", done_when: { kind: "arbiter", text: "named" } }, seq: 1 },
      },
      { type: "add_node", node: { id: "p1", space: "work", kind: "plan", label: "plan", seq: 2 } },
      { type: "add_edge", edge: { id: "e1", from: "g1", to: "p1", kind: "has_plan", provenance: { kind: "llm" } } },
      { type: "add_edge", edge: { id: "e2", from: "p1", to: "g2", kind: "item", provenance: { kind: "llm" } } },
      { type: "record_check", id: "chk:3", command: "user acceptance", verdict: "pass", output: "", actor: "user", targets: ["g2"] },
    ]);
    expect(predicateOf(state, "g2")).toBe("achieved");
    expect(
      classify(
        proposal({
          operator: "create_goal",
          what: "fix the cause",
          why: "hypothesis",
          done_when: { kind: "objective", command: "node --test" },
        }),
        state,
      ),
    ).toEqual({ accept: true });
  });
});

describe("executeAction", () => {
  it("create_goal builds a goal, its plan and descends into it", () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    const root = fold([
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green", done_when: { kind: "arbiter", text: "done" } }, seq: 0 } },
    ]);
    const outcome = executeAction(
      {
        operator: "create_goal",
        what: "locate",
        done_when: { kind: "arbiter", text: "found" },
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
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green", done_when: { kind: "arbiter", text: "done" } }, seq: 0 } },
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
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green", done_when: { kind: "arbiter", text: "done" } }, seq: 0 } },
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
        (event.node.payload as { verdict?: string } | undefined)?.verdict === "fail",
    );
    expect(failure).toBeDefined();
  });

  it("runs a command in the background and materializes its result on a poll", async () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    const state = fold([
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green", done_when: { kind: "arbiter", text: "done" } }, seq: 0 } },
    ]);
    const start = executeAction(
      { operator: "apply", action: { tool: "run", command: "echo bg-ok", background: true } },
      state,
      workspace,
      1,
    );
    const started = fold(start.events, state);
    const handle = [...started.nodes.values()]
      .map((node) => (node.payload as { job?: string } | undefined)?.job)
      .find((id): id is string => typeof id === "string");
    expect(handle).toBeDefined();
    for (let i = 0; i < 100 && workspace.pollJob(handle as string)?.state !== "done"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const outcome = executeAction(
      { operator: "apply", action: { tool: "run", job: handle as string } },
      started,
      workspace,
      2,
    );
    expect(outcome.turn.text).toContain("bg-ok");
    const polled = fold(outcome.events, started);
    const poll = [...polled.nodes.values()].find((node) => {
      const payload = node.payload as { job?: string; state?: string } | undefined;
      return payload?.job === handle && payload?.state === "done";
    });
    expect((poll?.payload as { verdict?: string } | undefined)?.verdict).toBe("pass");
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
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green", done_when: { kind: "arbiter", text: "done" } }, seq: 0 } },
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
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green", done_when: { kind: "arbiter", text: "done" } }, seq: 0 } },
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
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green", done_when: { kind: "arbiter", text: "done" } }, seq: 0 } },
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
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green", done_when: { kind: "arbiter", text: "done" } }, seq: 0 } },
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
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green", done_when: { kind: "arbiter", text: "done" } }, seq: 0 } },
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

describe("query by id (history index)", () => {
  const goal = {
    type: "add_node" as const,
    node: { id: "g1", space: "work" as const, kind: "goal" as const, label: "green", seq: 0, payload: { what: "green", done_when: { kind: "arbiter" as const, text: "done" } } },
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
    expect(classify(proposal({ operator: "query", predicate: "refuted" }), state, held)).toEqual({
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
  it("carries a plan through edit and check to a closed root", async () => {
    const root = setup("off-by-one");
    const workspace = fsWorkspace(root);
    let index = 0;
    const propose = async (context: Context): Promise<Proposal> => {
      index += 1;
      if (index === 1) {
        // The plan's leading action (reproduce) is run by the engine in this same turn.
        return proposal({
          operator: "create_goal",
          what: "fix the off-by-one",
          why: "the loop stops one short",
          done_when: { kind: "objective", command: "node --test" },
          plan: [{ kind: "action", command: "echo start" }],
        });
      }
      if (index === 2) {
        return proposal({ operator: "apply", action: { tool: "edit", path: "src/sum.mjs", find: "i < n", replace: "i <= n" } });
      }
      const goal = context.path[1]?.id;
      return proposal({ operator: "apply", action: { tool: "run", target: goal } });
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

  it("reports request_addressed, not max_turns, when the final allowed turn closes it", async () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    let index = 0;
    const propose = async (context: Context): Promise<Proposal> => {
      index += 1;
      if (index === 1) {
        return proposal({
          operator: "create_goal",
          what: "make the suite pass",
          done_when: { kind: "objective", command: "true" },
        });
      }
      const goal = context.path[context.path.length - 1]?.id;
      return proposal({ operator: "apply", action: { tool: "run", target: goal } });
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
          done_when: { kind: "arbiter", text: "done" },
          plan: [{ kind: "action", command: "echo hi" }],
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

  it("refuses to grow an objective goal whose plan is fulfilled; check it instead", () => {
    const state = fold([
      { type: "add_node", node: { id: "r1", space: "work", kind: "request", label: "task", payload: { text: "go" }, seq: 0 } },
      {
        type: "add_node",
        node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green", done_when: { kind: "objective", command: "node --test" } }, seq: 1 },
      },
      { type: "add_node", node: { id: "p1", space: "work", kind: "plan", label: "plan", seq: 2 } },
      { type: "add_edge", edge: { id: "e1", from: "g1", to: "p1", kind: "has_plan", provenance: { kind: "llm" } } },
      { type: "add_node", node: { id: "a1", space: "work", kind: "action", label: "echo hi", payload: { command: "echo hi" }, seq: 3 } },
      { type: "add_edge", edge: { id: "e2", from: "p1", to: "a1", kind: "item", provenance: { kind: "llm" } } },
      { type: "add_node", node: { id: "o1", space: "work", kind: "observation", label: "hi", seq: 4 } },
      { type: "add_edge", edge: { id: "e3", from: "a1", to: "o1", kind: "produces", provenance: { kind: "llm" } } },
      { type: "descend", node: "g1" },
    ]);
    const reason = classify(
      proposal({ operator: "create_goal", what: "add another stage", done_when: { kind: "objective", command: "node --test" } }),
      state,
    ).reason;
    expect(reason).toContain("all plan items are fulfilled");
    expect(reason).toContain("target");
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
        payload: { what: "approach one", done_when: { kind: "arbiter" as const, text: "ok" } },
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
    const missing = classify(
      proposal({ operator: "create_goal", what: "approach two", done_when: { kind: "arbiter", text: "ok" } }),
      state,
    );
    expect(missing.accept).toBe(false);
    expect(missing.reason).toContain("missing_revision");
    expect(missing.reason).toContain("g1");
    expect(
      classify(
        proposal({
          operator: "create_goal",
          what: "approach two",
          done_when: { kind: "arbiter", text: "ok" },
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
          done_when: { kind: "arbiter", text: "ok" },
          revises: ["g1"],
        }),
        state,
      ),
    ).toEqual({ accept: false, reason: "repeat_hypothesis" });
  });

  it("refuses to check an arbiter goal", () => {
    const state = fold([
      request,
      {
        type: "add_node",
        node: { id: "g2", space: "work", kind: "goal", label: "sub", payload: { what: "sub", done_when: { kind: "arbiter", text: "ok" } }, seq: 1 },
      },
    ]);
    const verdict = classify(
      proposal({ operator: "apply", action: { tool: "run", command: "x", target: "g2" } }),
      state,
    );
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toContain("arbiter_goal_needs_acceptance");
    expect(verdict.reason).toContain("g2");
  });

  it("runs the goal's own done_when command for a target-only check", () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    const state = fold([
      request,
      {
        type: "add_node",
        node: { id: "g2", space: "work", kind: "goal", label: "crit", payload: { what: "crit", done_when: { kind: "objective", command: "true" } }, seq: 1 },
      },
    ]);
    // A check omits the command; the engine runs the goal's own.
    const outcome = executeAction(
      { operator: "apply", action: { tool: "run", target: "g2" } },
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

describe("revise after a refuted fix", () => {
  it("does not give up: two refuted fixes, a third attempt, then the check passes", async () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    let index = 0;
    const propose = async (context: Context): Promise<Proposal> => {
      index += 1;
      const focus = context.path[context.path.length - 1]?.id;
      const root = context.path[1]?.id;
      if (index === 1) {
        return proposal({
          operator: "create_goal",
          what: "make the suite pass",
          done_when: { kind: "objective", command: "node --test" },
          plan: [
            { kind: "goal", what: "fix the cause", done_when: { kind: "objective", command: "node --test" } },
          ],
        });
      }
      if (index === 2) {
        // A plausible but wrong fix: `i <= n - 1` is still the off-by-one.
        return proposal({
          operator: "apply",
          action: { tool: "edit", path: "src/sum.mjs", find: "i < n", replace: "i <= n - 1" },
        });
      }
      if (index === 3) {
        return proposal({ operator: "apply", action: { tool: "run", command: "node --test", target: focus } });
      }
      if (index === 4) {
        // After the refutation the plan may grow (the failed item does not count).
        return proposal({
          operator: "create_goal",
          what: "fix the cause, second attempt",
          done_when: { kind: "objective", command: "node --test" },
        });
      }
      if (index === 5) {
        // A second wrong guess: now the loop is too tight.
        return proposal({
          operator: "apply",
          action: { tool: "edit", path: "src/sum.mjs", find: "i <= n - 1", replace: "i <= n - 2" },
        });
      }
      if (index === 6) {
        return proposal({ operator: "apply", action: { tool: "run", command: "node --test", target: focus } });
      }
      if (index === 7) {
        return proposal({
          operator: "create_goal",
          what: "fix the cause, third attempt",
          done_when: { kind: "objective", command: "node --test" },
        });
      }
      if (index === 8) {
        return proposal({
          operator: "apply",
          action: { tool: "edit", path: "src/sum.mjs", find: "i <= n - 2", replace: "i <= n" },
        });
      }
      if (index === 9) {
        return proposal({ operator: "apply", action: { tool: "run", command: "node --test", target: focus } });
      }
      if (index === 10) {
        return proposal({ operator: "apply", action: { tool: "run", command: "node --test", target: root } });
      }
      return proposal({ operator: "query", predicate: "refuted" });
    };
    const result = await runAgent(
      { propose, workspace, maxTurns: 16, noProgress: 10 },
      { request: { id: "r1", text: "green" } },
    );

    const state = fold(result.events);
    const checks = result.events.filter(
      (event): event is Extract<typeof event, { type: "record_check" }> =>
        event.type === "record_check",
    );
    expect(checks.filter((check) => check.verdict === "fail")).toHaveLength(2);
    expect(checks.filter((check) => check.verdict === "pass").length).toBeGreaterThanOrEqual(2);
    // Three fix goals: two refuted, one achieved — no two-attempt cap.
    const goals = [...state.nodes.values()].filter((node) => node.kind === "goal");
    expect(goals.filter((node) => predicateOf(state, node.id) === "refuted").length).toBe(2);
    expect(predicateOf(state, "r1")).toBe("addressed");
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
          done_when: { kind: "arbiter", text: "done" },
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
