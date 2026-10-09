import { describe, expect, it } from "vitest";

import { eventSchema, type Event } from "../src/ir/events";
import { actionExecuted, childrenOf, criterionFailed, criterionPass, criterionResult, emptyState, fold, stateOf, unselectedVariant } from "../src/ir/graph";
import { knowledgeKey } from "../src/ir/progress";
import { project } from "../src/ir/project";
import { applicable, focusEvents } from "../src/ir/traversal";
import type {
  ArtifactKind,
  Edge,
  EdgeKind,
  GoalPayload,
  Node,
  NodeKind,
  Provenance,
} from "../src/ir/types";

function workNode(
  id: string,
  kind: NodeKind,
  label: string,
  seq: number,
  payload?: unknown,
): Node {
  return { id, space: "work", kind, label, ...(payload !== undefined ? { payload } : {}), seq };
}

function artifactNode(id: string, kind: ArtifactKind, label: string, seq: number): Node {
  return { id, space: "artifact", kind, label, seq };
}

function edge(id: string, from: string, to: string, kind: EdgeKind, provenance: Provenance): Edge {
  return { id, from, to, kind, provenance };
}

const llm: Provenance = { kind: "llm" };
const objective = (command: string): string => command;
const arbiter = (text: string): string => text;

function goal(
  id: string,
  what: string,
  seq: number,
  done_when: string = arbiter(what),
  why?: string,
  plan?: string,
): Event {
  const payload: GoalPayload = {
    what,
    done_when,
    ...(why !== undefined ? { why } : {}),
    ...(plan !== undefined ? { plan } : {}),
  };
  return { type: "add_node", node: workNode(id, "goal", what, seq, payload) };
}

function plan(id: string, goalId: string, items: string[], seq: number): Event[] {
  const events: Event[] = [
    { type: "add_node", node: workNode(id, "plan", `plan for ${goalId}`, seq) },
    { type: "add_edge", edge: edge(`hp:${id}`, goalId, id, "has_plan", llm) },
  ];
  items.forEach((item, index) => {
    events.push({
      type: "add_edge",
      edge: edge(`it:${id}:${index}`, id, item, "item", llm),
    });
  });
  return events;
}

describe("events", () => {
  it("accepts a valid goal node", () => {
    const event = goal("g1", "make test green", 0);
    expect(eventSchema.safeParse(event).success).toBe(true);
  });

  it("rejects an unknown node kind", () => {
    const bad = {
      type: "add_node",
      node: { id: "x", space: "work", kind: "bogus", label: "x", seq: 0 },
    };
    expect(eventSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects the removed set_status event", () => {
    expect(eventSchema.safeParse({ type: "set_status", id: "g1", status: "open" }).success).toBe(
      false,
    );
  });

  it("accepts a rejection event", () => {
    const event: Event = {
      type: "record_rejection",
      tool: "edit",
      target: "test/sum.test.mjs",
      reason: "constraint_violation:\\.test\\.mjs$",
      constraintId: "k1",
      turn: 3,
    };
    expect(eventSchema.safeParse(event).success).toBe(true);
  });
});

describe("fold", () => {
  const events: Event[] = [
    goal("g1", "make test green", 0),
    { type: "add_node", node: workNode("a1", "action", "read src/a.ts", 1) },
    { type: "add_node", node: artifactNode("file:src/a.ts", "file", "src/a.ts", 2) },
  ];

  it("is deterministic: same events, same state", () => {
    expect(fold(events)).toEqual(fold(events));
  });

  it("is pure: does not mutate the base state", () => {
    const base = emptyState();
    const next = fold(events, base);
    expect(base.nodes.size).toBe(0);
    expect(next.nodes.size).toBe(3);
  });

  it("records the root goal and derives an open predicate", () => {
    const state = fold(events);
    expect(state.rootId).toBe("g1");
    expect(stateOf(state, "g1")).toBe("open");
    expect(stateOf(state, "a1")).toBe("open");
  });

  it("derives executed for an action with a produced child", () => {
    const state = fold([
      goal("g1", "make test green", 0),
      { type: "add_node", node: workNode("a1", "action", "read", 1) },
      { type: "add_node", node: workNode("o1", "observation", "read", 2) },
      { type: "add_edge", edge: edge("e1", "a1", "o1", "produces", { kind: "read", ref: "file:x", version: "v1" }) },
    ]);
    expect(actionExecuted(state, "a1")).toBe(true);
  });

  it("keeps plan item order from the item edge order", () => {
    const state = fold([
      goal("g1", "green", 0),
      { type: "add_node", node: workNode("a1", "action", "one", 1) },
      { type: "add_node", node: workNode("a2", "action", "two", 2) },
      ...plan("p1", "g1", ["a2", "a1"], 3),
    ]);
    expect(childrenOf(state, "p1")).toEqual(["a2", "a1"]);
  });
});

describe("criterion runs", () => {
  it("achieves a goal on an exit 0", () => {
    const state = fold([
      goal("g1", "make test green", 0, objective("node --test")),
      { type: "add_node", node: { id: "obs:1", space: "work", kind: "observation", label: "node --test", payload: { command: "node --test", target: "g1", exitCode: 0 }, seq: 1 } },
    ]);
    expect(criterionPass(state, "g1")).toBe(true);
  });

  it("refutes on a non-zero exit and leaves open on a timeout", () => {
    const failed = fold([
      goal("g1", "green", 0, objective("node --test")),
      { type: "add_node", node: { id: "obs:99", space: "work", kind: "observation", label: "node --test", payload: { command: "node --test", target: "g1", exitCode: 1, }, seq: 99 } },
    ]);
    expect(criterionFailed(failed, "g1")).toBe(true);
    const timedOut = fold([
      goal("g1", "green", 0, objective("node --test")),
      { type: "add_node", node: { id: "obs:99", space: "work", kind: "observation", label: "node --test", payload: { command: "node --test", target: "g1", }, seq: 99 } },
    ]);
    expect(stateOf(timedOut, "g1")).toBe("open");
  });

  it("reads the criterion from the latest observation targeting the goal", () => {
    const state = fold([
      goal("g1", "green", 0, objective("node --test")),
      { type: "add_node", node: { id: "obs:1", space: "work", kind: "observation", label: "node --test", payload: { command: "node --test", target: "g1", exitCode: 0 }, seq: 1 } },
    ]);
    expect(criterionResult(state, "g1")?.id).toBe("obs:1");
    expect(criterionPass(state, "g1")).toBe(true);
  });
});



describe("alternatives", () => {
  it("marks unselected variants abandoned when a sibling is chosen", () => {
    const state = fold([
      goal("g1", "green", 0, objective("node --test")),
      { type: "add_node", node: { id: "obs:99", space: "work", kind: "observation", label: "node --test", payload: { command: "node --test", target: "g1", exitCode: 1, }, seq: 99 } },
      { type: "add_node", node: workNode("a1", "alternatives", "approaches", 1) },
      { type: "add_edge", edge: edge("e0", "g1", "a1", "has_alternatives", llm) },
      goal("g2", "approach one", 2),
      goal("g3", "approach two", 3),
      { type: "add_edge", edge: edge("e1", "a1", "g2", "item", llm) },
      { type: "add_edge", edge: edge("e2", "a1", "g3", "item", llm) },
    ]);
    expect(criterionFailed(state, "g1")).toBe(true);
    expect(unselectedVariant(state, "g2")).toBe(true);
    expect(stateOf(state, "g3")).toBe("open");
  });
});

describe("projection", () => {
  it("is the traversal path; the focus carries its plan and cursor", () => {
    const state = fold([
      goal("g1", "green", 0, objective("node --test")),
      { type: "add_node", node: workNode("a1", "action", "run build", 1) },
      { type: "add_node", node: workNode("a2", "action", "locate", 2) },
      ...plan("p1", "g1", ["a1", "a2"], 3),
    ]);
    const context = project(state, { budget: { turn: 2, maxTurns: 10 } });
    expect(context.path.map((node) => node.id)).toEqual(["g1"]);
    expect(context.path[0]?.plan?.items.map((item) => item.id)).toEqual(["a1", "a2"]);
    expect(context.path[0]?.plan?.cursor).toBe(0);
    expect(context.budget).toEqual({ turn: 2, maxTurns: 10, remaining: 8 });
  });

  it("surfaces the goal's plan hint (the initial string sketch, I3)", () => {
    const state = fold([
      goal("g1", "green", 0, objective("node --test"), undefined, "reproduce, then fix"),
    ]);
    const context = project(state);
    expect(context.path[0]?.planHint).toBe("reproduce, then fix");
  });

  it("starts at the request and descends into its goal", () => {
    const state = fold([
      {
        type: "add_node",
        node: { id: "r1", space: "work", kind: "request", label: "task", payload: { text: "do it" }, seq: 0 },
      },
      goal("g1", "approach one", 1),
      { type: "add_edge", edge: edge("e1", "r1", "g1", "has_goal", llm) },
      { type: "descend", node: "g1" },
    ]);
    const context = project(state);
    expect(context.path[0]?.kind).toBe("request");
    expect(context.path[0]?.text).toBe("do it");
    expect(context.path[1]?.kind).toBe("goal");
    expect(context.path[1]?.id).toBe("g1");
  });

  it("renders the latest result in full, without files or versions", () => {
    const state = fold([
      goal("g1", "green", 0),
      { type: "add_node", node: artifactNode("file:src/a.ts", "file", "src/a.ts", 1) },
      {
        type: "add_node",
        node: workNode("o1", "observation", "read src/a.ts", 2, { ref: "file:src/a.ts", version: "v1" }),
      },
    ]);
    const context = project(state, { lastOutput: "x".repeat(1000), lastOutputId: "o1" });
    expect(context.lastResult?.kind).toBe("observation");
    expect(context.lastResult?.id).toBe("o1");
    expect(context.lastResult?.ref).toBe("src/a.ts");
    expect(context.lastResult?.output).toBe("x".repeat(1000));
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain("artifacts");
    expect(serialized).not.toContain("version");

    // A tool turn that produced no result node (query/complete) is shown without an
    // id, so the model cannot address a stale body by a mismatched id.
    const nodeLess = project(state, { lastOutput: "completed: g1" });
    expect(nodeLess.lastResult?.id).toBeUndefined();
    expect(nodeLess.lastResult?.output).toBe("completed: g1");
  });

  it("lists constraints and exposes the applicable operators", () => {
    const state = fold([
      goal("g1", "green", 0, objective("node --test")),
      { type: "add_node", node: workNode("k1", "constraint", "do not edit tests", 1, { forbid: ["\\.test\\.mjs$"] }) },
      { type: "add_node", node: workNode("a1", "action", "run build", 2) },
      { type: "add_node", node: workNode("o1", "observation", "done", 3) },
      { type: "add_edge", edge: edge("e1", "a1", "o1", "produces", { kind: "grep", pattern: "x" }) },
      ...plan("p1", "g1", ["a1"], 4),
    ]);
    const context = project(state);
    expect(context.constraints).toEqual([{ id: "k1", forbid: ["\\.test\\.mjs$"] }]);
    expect(context.applicable).toContain("apply");
    // The plan is done: the objective goal must be checked, not grown (no create_goal).
    expect(context.applicable).not.toContain("create_goal");
    expect(context.checkReady).toBe(true);
  });

  it("distinguishes a bare run from a ready check (checkReady / nextAction)", () => {
    const state = fold([
      goal("g1", "green", 0, objective("node --test")),
      { type: "add_node", node: workNode("a1", "action", "run build", 1) },
      ...plan("p1", "g1", ["a1"], 2),
    ]);
    const context = project(state);
    expect(context.checkReady).toBe(false);
    expect(context.nextAction).toBe("a1");
  });

  it("exposes a step alternative's hypothesis (why) so a refuted attempt is not repeated", () => {
    const state = fold([
      goal("g1", "green", 0, objective("node --test")),
      { type: "add_node", node: workNode("a1", "action", "fix", 1) },
      ...plan("p1", "g1", ["a1"], 2),
      { type: "add_node", node: workNode("alt", "alternatives", "opts", 3) },
      { type: "add_edge", edge: edge("ha", "a1", "alt", "has_alternatives", llm) },
      goal("g2", "fix the loop bound", 4, objective("node --test"), "the loop excludes n"),
      { type: "add_edge", edge: edge("ei", "alt", "g2", "item", llm) },
    ]);
    const context = project(state);
    const item = context.path[0]?.plan?.items.find((entry) => entry.id === "a1");
    const option = item?.alternatives?.items.find((entry) => entry.id === "g2");
    expect(option?.state).toBe("open");
    expect(option?.why).toBe("the loop excludes n");
  });

  it("keeps the full latest result and has no context budget", () => {
    const state = fold([
      goal("g1", "green", 0, objective("node --test")),
      {
        type: "add_node",
        node: workNode("o1", "observation", "run build", 1, { command: "run build", output: "stored" }),
      },
    ]);
    const output = "y".repeat(4000);
    const context = project(state, { lastOutput: output });
    expect(context.lastResult?.output).toBe(output);
    expect(context).not.toHaveProperty("truncated");
  });

  it("reports the applicable operators at the current point", () => {
    const state = fold([
      goal("g1", "green", 0, objective("node --test")),
      { type: "add_node", node: workNode("a1", "action", "run build", 1) },
      { type: "add_node", node: workNode("o1", "observation", "done", 2) },
      { type: "add_edge", edge: edge("e1", "a1", "o1", "produces", { kind: "grep", pattern: "x" }) },
      ...plan("p1", "g1", ["a1"], 3),
    ]);
    const app = applicable(state, "g1");
    // The only plan item is executed: there is no current step to decompose, so
    // create_goal is not applicable; the objective goal must be checked.
    expect(app.createGoal).toBe(false);
    expect(app.checkReady).toBe(true);
    expect(app.apply).toBe(true);
  });
});

describe("record_rejection", () => {
  const base: Event[] = [
    goal("g1", "green", 0),
    { type: "add_node", node: workNode("k1", "constraint", "do not edit tests", 1) },
  ];
  const refusal = (turn: number): Event => ({
    type: "record_rejection",
    tool: "edit",
    target: "test/sum.test.mjs",
    reason: "constraint_violation:\\.test\\.mjs$",
    constraintId: "k1",
    turn,
  });

  it("collapses repeated refusals without dropping distinct ones", () => {
    const state = fold([
      ...base,
      refusal(3),
      refusal(5),
      {
        type: "record_rejection",
        tool: "create_goal",
        target: "goal",
        reason: "empty_what",
        turn: 6,
      },
    ]);
    expect(state.rejections).toHaveLength(3);
  });
});

describe("call summary", () => {
  it("aggregates refusals by signature and keeps distinct ones", () => {
    const state = fold([
      goal("g1", "green", 0),
      { type: "record_rejection", tool: "read", target: "/app/a.txt", reason: "repeated_action", turn: 3 },
      { type: "record_rejection", tool: "read", target: "/app/a.txt", reason: "repeated_action", turn: 4 },
      { type: "record_rejection", tool: "query", target: "x", reason: "unknown_revision", turn: 5 },
    ]);
    const calls = project(state).calls;
    const repeated = calls.find((entry) => entry.action === "read /app/a.txt");
    expect(repeated).toMatchObject({ status: "refused", note: "repeated_action", count: 2 });
    expect(calls.some((entry) => entry.note === "unknown_revision")).toBe(true);
  });

  it("summarizes an executed action with its outcome", () => {
    const state = fold([
      goal("g1", "green", 0),
      { type: "add_node", node: workNode("a1", "action", "git status", 1, { command: "git status" }) },
      {
        type: "add_node",
        node: workNode("o1", "observation", "git status", 2, {
          command: "git status",
          exitCode: 1,
          output: "hint: something\nfatal: not a git repository\n",
        }),
      },
      { type: "add_edge", edge: edge("e1", "a1", "o1", "produces", { kind: "read", ref: "file:a", version: "v1" }) },
    ]);
    const calls = project(state).calls;
    expect(calls).toEqual([
      { id: "o1", action: "git status", status: "fail", note: "fatal: not a git repository", count: 1 },
    ]);
  });

  it("surfaces the crash line when a piped build exits 0", () => {
    const state = fold([
      goal("g1", "green", 0),
      { type: "add_node", node: workNode("a1", "action", "make | tail", 1, { command: "make | tail" }) },
      {
        type: "add_node",
        node: workNode("o1", "observation", "make | tail", 2, {
          command: "make | tail",
          exitCode: 0,
          output: "  OCAMLC a.cmi\nmake: *** Segmentation fault (core dumped)\nmake: *** Error 2\n",
        }),
      },
      {
        type: "add_edge",
        edge: edge("e1", "a1", "o1", "produces", { kind: "llm" }),
      },
    ]);
    const entry = project(state).calls.find((call) => call.action === "make | tail");
    expect(entry?.status).toBe("ok");
    expect(entry?.note).toContain("Segmentation fault");
  });

  it("keeps stderr separate and names its failure line, not a stdout false positive", () => {
    const state = fold([
      goal("g1", "green", 0),
      { type: "add_node", node: workNode("a1", "action", "make", 1, { command: "make" }) },
      {
        type: "add_node",
        node: workNode("o1", "observation", "make", 2, {
          command: "make",
          exitCode: 1,
          // stdout: a configure line that only looks like an error (`-fno-exceptions`).
          output: "checking if gcc supports -fno-rtti -fno-exceptions... no\n  CC runtime/shared_heap.b.o",
          // stderr: the real failure.
          error:
            "make[2]: *** [Makefile:147: caml.cmi] Segmentation fault (core dumped)\nmake: *** [Makefile:855: world.opt] Error 2",
        }),
      },
      {
        type: "add_edge",
        edge: edge("e1", "a1", "o1", "produces", { kind: "llm" }),
      },
    ]);
    const shown = "checking if gcc supports -fno-rtti -fno-exceptions... no";
    const context = project(state, {
      lastOutput: shown,
      lastOutputId: "o1",
      lastError: "make[2]: *** [Makefile:147: caml.cmi] Segmentation fault (core dumped)",
    });
    // stderr is a separate field, not glued onto stdout.
    expect(context.lastResult?.output).toBe(shown);
    expect(context.lastResult?.error).toContain("Segmentation fault");
    const entry = context.calls.find((call) => call.action === "make");
    expect(entry?.note).toContain("Segmentation fault");
    expect(entry?.note).not.toContain("fno-rtti");
  });

  it("shows a refusal at the request point, which lies outside the interpretation subtree", () => {
    const state = fold([
      { type: "add_node", node: workNode("r1", "request", "task", 0, { text: "do it" }) },
      goal("g1", "approach one", 1, objective("make test")),
      { type: "add_edge", edge: edge("e1", "r1", "g1", "has_goal", llm) },
      { type: "add_node", node: { id: "obs:99", space: "work", kind: "observation", label: "make test", payload: { command: "make test", target: "g1", exitCode: 1, }, seq: 99 } },
      // Recorded while the focus is the request r1: its goal g1 is not settled, so the
      // focus stays at the root and the request is not in g1's subtree.
      { type: "record_rejection", tool: "create_goal", target: "goal:approach one", reason: "repeat_hypothesis", turn: 0 },
    ]);
    const calls = project(state).calls;
    expect(calls.some((entry) => entry.status === "refused" && entry.note === "repeat_hypothesis")).toBe(true);
  });

  it("includes a materialized action failure that has no action node", () => {
    const state = fold([
      goal("g1", "green", 0),
      {
        type: "add_node",
        node: workNode("o1", "observation", "read failed: a does not exist", 1, {
          failed: true,
          output: "read failed: a does not exist",
        }),
      },
    ]);
    expect(project(state).calls).toEqual([
      { id: "o1", action: "read failed: a does not exist", status: "fail", note: "read failed: a does not exist", count: 1 },
    ]);
  });

  it("keeps a failure after a mutation, alongside successes and refusals", () => {
    const failure: Event = {
      type: "add_node",
      node: workNode("o1", "observation", "make", 1, { failed: true, output: "boom" }),
    };
    const success: Event[] = [
      { type: "add_node", node: workNode("a2", "action", "read a", 2, { command: "read a" }) },
      { type: "add_node", node: workNode("o2", "observation", "read a", 3, { ref: "file:a", version: "v1" }) },
      { type: "add_edge", edge: edge("e2", "a2", "o2", "produces", { kind: "read", ref: "file:a", version: "v1" }) },
    ];
    const constraint: Event = {
      type: "record_rejection",
      tool: "edit",
      target: "test/x",
      reason: "constraint_violation",
      constraintId: "k1",
      turn: 4,
    };
    const before = fold([goal("g1", "green", 0), failure, ...success, constraint]);
    expect(project(before).calls).toHaveLength(3);
    const after = fold([
      goal("g1", "green", 0),
      failure,
      ...success,
      constraint,
      { type: "mutate", ref: "file:a", version: "v2", actionId: "a1" },
    ]);
    const calls = project(after).calls;
    // The failed attempt stays in the log after the edit (a person remembers it).
    expect(calls).toHaveLength(3);
    expect(calls.some((entry) => entry.status === "fail")).toBe(true);
    expect(calls.some((entry) => entry.status === "ok")).toBe(true);
    expect(calls.some((entry) => entry.note === "constraint_violation")).toBe(true);
  });

  it("keeps the whole interpretation history, not just the focus path", () => {
    const state = fold([
      {
        type: "add_node",
        node: { id: "r1", space: "work", kind: "request", label: "task", payload: { text: "go" }, seq: 0 },
      },
      goal("g1", "interp", 2),
      { type: "add_edge", edge: edge("ei", "r1", "g1", "has_goal", { kind: "llm" }) },
      { type: "add_node", node: { id: "p1", space: "work", kind: "plan", label: "plan", seq: 3 } },
      { type: "add_edge", edge: edge("ep", "g1", "p1", "has_plan", { kind: "llm" }) },
      { type: "add_node", node: workNode("a1", "action", "run", 4, { command: "run" }) },
      { type: "add_edge", edge: edge("e2", "p1", "a1", "item", { kind: "llm" }) },
      { type: "add_node", node: { id: "alt2", space: "work", kind: "alternatives", label: "opts", seq: 5 } },
      { type: "add_edge", edge: edge("e3", "a1", "alt2", "has_alternatives", { kind: "llm" }) },
      goal("g2", "stage one", 6),
      { type: "add_edge", edge: edge("e4", "alt2", "g2", "item", { kind: "llm" }) },
      { type: "descend", node: "g1" },
      { type: "descend", node: "g2" },
      { type: "add_node", node: workNode("a2", "action", "read a", 7, { command: "read a" }) },
      { type: "add_node", node: workNode("o1", "observation", "read a", 8, { ref: "file:a", version: "v1" }) },
      { type: "add_edge", edge: edge("e6", "a2", "o1", "produces", { kind: "read", ref: "file:a", version: "v1" }) },
      { type: "return" },
      { type: "return" },
    ]);
    // Focus is back on the interpretation, off the stage g2 — but the stage is part of
    // the interpretation's subtree, so its result stays in the index (semantics §2.8).
    expect(state.branch).toEqual(["r1"]);
    expect(project(state).calls.some((entry) => entry.action === "read a")).toBe(true);
  });

  it("changes the projection on a refusal (feedback invariant)", () => {
    const state = fold([goal("g1", "green", 0)]);
    const refused = fold([
      goal("g1", "green", 0),
      { type: "record_rejection", tool: "query", target: "x", reason: "repeated_action", turn: 1 },
    ]);
    expect(JSON.stringify(project(refused))).not.toBe(JSON.stringify(project(state)));
  });
});

describe("progress key", () => {
  it("changes when a goal is added and when its predicate changes", () => {
    const base = fold([goal("g1", "green", 0, objective("node --test"))]);
    const withPlan = fold([goal("g1", "green", 0, objective("node --test")), goal("g2", "locate", 1)]);
    expect(knowledgeKey(withPlan)).not.toBe(knowledgeKey(base));

    const achieved = fold([
      goal("g1", "green", 0, objective("node --test")),
      { type: "add_node", node: { id: "obs:99", space: "work", kind: "observation", label: "node --test", payload: { command: "node --test", target: "g1", exitCode: 0, }, seq: 99 } },
    ]);
    expect(knowledgeKey(achieved)).not.toBe(knowledgeKey(base));
  });

  it("does not change on a repeated failure, but does on a distinct one", () => {
    const failure = (command: string, output: string, seq: number): Event => ({
      type: "add_node",
      node: workNode(`o${seq}`, "observation", command, seq, { command, verdict: "fail", output }),
    });
    const once = fold([goal("g1", "green", 0), failure("git status", "fatal: no repo", 1)]);
    const twice = fold([
      goal("g1", "green", 0),
      failure("git status", "fatal: no repo", 1),
      failure("git status", "fatal: no repo", 2),
    ]);
    expect(knowledgeKey(twice)).toBe(knowledgeKey(once));
    const other = fold([
      goal("g1", "green", 0),
      failure("git status", "fatal: no repo", 1),
      failure("git log", "fatal: no repo", 2),
    ]);
    expect(knowledgeKey(other)).not.toBe(knowledgeKey(once));
  });

  it("does not change on a repeated refusal, but does on a distinct one", () => {
    const refusal = (target: string, seq: number, turn: number): Event => ({
      type: "record_rejection",
      tool: "read",
      target,
      reason: "repeated_action",
      turn,
    });
    const once = fold([goal("g1", "green", 0), refusal("/app/a", 1, 1)]);
    const twice = fold([goal("g1", "green", 0), refusal("/app/a", 1, 1), refusal("/app/a", 2, 2)]);
    expect(knowledgeKey(twice)).toBe(knowledgeKey(once));
    const other = fold([goal("g1", "green", 0), refusal("/app/a", 1, 1), refusal("/app/b", 2, 2)]);
    expect(knowledgeKey(other)).not.toBe(knowledgeKey(once));
  });
});

describe("traversal focus", () => {
  const interpreted = (check?: Event[]): Event[] => [
    { type: "add_node", node: workNode("r1", "request", "task", 0, { text: "go" }) },
    goal("g1", "interp", 1, objective("make test")),
    { type: "add_edge", edge: edge("ea", "r1", "g1", "has_goal", llm) },
    ...plan("p1", "g1", ["a1"], 3),
    { type: "add_node", node: workNode("a1", "action", "run", 4, { command: "run" }) },
    { type: "add_node", node: workNode("alt2", "alternatives", "opts", 5) },
    { type: "add_edge", edge: edge("ha", "a1", "alt2", "has_alternatives", llm) },
    goal("g2", "stage", 6, objective("make test")),
    { type: "add_edge", edge: edge("i2", "alt2", "g2", "item", llm) },
    { type: "descend", node: "g1" },
    { type: "descend", node: "g2" },
    ...(check ?? []),
  ];

  it("trims the branch under a stopped ancestor, not only when the top stops", () => {
    const state = fold(
      interpreted([
        { type: "add_node", node: workNode("s1", "stop", "done", 99) },
        { type: "add_edge", edge: edge("es", "g1", "s1", "has_stopped", llm) },
      ]),
    );
    expect(state.branch).toEqual(["r1", "g1", "g2"]);
    const trimmed = fold(focusEvents(state), state);
    expect(trimmed.branch).toEqual(["r1"]);
    // The request's goal exists (and is stopped), so the request offers no new operator;
    // the run ends (the loop detects the stopped goal).
    expect(applicable(trimmed, "r1")).toMatchObject({ createGoal: false, return: false });
  });

  it("does not trim while every ancestor is still open", () => {
    const state = fold(interpreted());
    expect(stateOf(state, "g1")).toBe("open");
    expect(focusEvents(state)).toEqual([]);
  });
});
