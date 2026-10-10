import { describe, expect, it } from "vitest";

import { eventSchema, type Event } from "../src/ir/events";
import { actionExecuted, childrenOf, emptyState, fold, hasStopped } from "../src/ir/graph";
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

function goal(id: string, what: string, seq: number): Event {
  const payload: GoalPayload = { what };
  return { type: "add_node", node: workNode(id, "goal", what, seq, payload) };
}

// A plan (`plan` relation from its goal) with the given item ids, in order (`items`).
function plan(id: string, goalId: string, itemIds: string[], seq: number): Event[] {
  const events: Event[] = [
    { type: "add_node", node: workNode(id, "plan", `plan for ${goalId}`, seq) },
    { type: "add_edge", edge: edge(`hp:${id}`, goalId, id, "plan", llm) },
  ];
  itemIds.forEach((item, index) => {
    events.push({ type: "add_edge", edge: edge(`it:${id}:${index}`, id, item, "items", llm) });
  });
  return events;
}

// A plan item (`item` node) whose ordered alternatives (action/goal) hang off it via `alts`.
function item(id: string, goalId: string, seq: number, alts: string[]): Event[] {
  const events: Event[] = [
    { type: "add_node", node: workNode(id, "item", `item for ${goalId}`, seq) },
  ];
  alts.forEach((alt, index) => {
    events.push({ type: "add_edge", edge: edge(`al:${id}:${index}`, id, alt, "alts", llm) });
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

  it("records the root goal; it is open until stopped", () => {
    const state = fold(events);
    expect(state.rootId).toBe("g1");
    expect(hasStopped(state, "g1")).toBe(false);
    expect(actionExecuted(state, "a1")).toBe(false);
  });

  it("derives executed for an action with a produced child", () => {
    const state = fold([
      goal("g1", "make test green", 0),
      { type: "add_node", node: workNode("a1", "action", "read", 1) },
      { type: "add_node", node: workNode("o1", "observation", "read", 2) },
      { type: "add_edge", edge: edge("e1", "a1", "o1", "result", { kind: "read", ref: "file:x", version: "v1" }) },
    ]);
    expect(actionExecuted(state, "a1")).toBe(true);
  });

  it("keeps plan item order from the items edge order", () => {
    const state = fold([
      goal("g1", "green", 0),
      { type: "add_node", node: workNode("i1", "item", "one", 1) },
      { type: "add_node", node: workNode("i2", "item", "two", 2) },
      ...plan("p1", "g1", ["i2", "i1"], 3),
    ]);
    expect(childrenOf(state, "p1")).toEqual(["i2", "i1"]);
  });
});

describe("closure", () => {
  it("a goal is closed by a stop: a `stop` relation to the stop node", () => {
    const base: Event[] = [goal("g1", "make test green", 0)];
    expect(hasStopped(fold(base), "g1")).toBe(false);
    const stopped = fold([
      ...base,
      { type: "add_node", node: workNode("s1", "stop", "done", 1) },
      { type: "add_edge", edge: edge("es", "g1", "s1", "stop", llm) },
    ]);
    expect(hasStopped(stopped, "g1")).toBe(true);
  });
});

describe("projection (the message tape)", () => {
  const requestNode = (seq: number): Event => ({
    type: "add_node",
    node: { id: "r1", space: "work", kind: "request", label: "task", payload: { text: "do it" }, seq },
  });

  it("renders the request, the goal and the first command as a tape", () => {
    const state = fold([
      requestNode(0),
      goal("g1", "green", 1),
      { type: "add_edge", edge: edge("eg", "r1", "g1", "goal", llm) },
      { type: "add_node", node: workNode("a1", "action", "make test", 2, { command: "make test" }) },
      { type: "add_node", node: workNode("o1", "observation", "make test", 3, { command: "make test", exitCode: 1, output: "boom" }) },
      { type: "add_edge", edge: edge("eo", "a1", "o1", "result", { kind: "llm" }) },
      ...plan("p1", "g1", ["i1"], 4),
      ...item("i1", "g1", 5, ["a1"]),
    ]);
    const context = project(state);
    expect(context.situation).toBe("goal");
    expect(context.history.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "tool",
    ]);
    expect(context.history[0]?.text).toBe("do it");
    expect(context.history[1]?.text).toContain("what: green");
    expect(context.history[2]?.text).toContain("make test");
    expect(context.history[3]?.text).toContain("exit 1");
    expect(context.history[3]?.text).toContain("boom");
  });

  it("reports the request situation and the constraints before interpretation", () => {
    const state = fold([
      requestNode(0),
      { type: "add_node", node: workNode("k1", "constraint", "no tests", 1, { forbid: ["\\.test\\.mjs$"] }) },
    ]);
    const context = project(state);
    expect(context.situation).toBe("request");
    expect(context.constraints).toEqual([{ id: "k1", forbid: ["\\.test\\.mjs$"] }]);
  });

  it("cuts a closed goal's internals to a single closure message", () => {
    const state = fold([
      requestNode(0),
      goal("g1", "green", 1),
      { type: "add_edge", edge: edge("eg", "r1", "g1", "goal", llm) },
      { type: "add_node", node: workNode("a1", "action", "make test", 2, { command: "make test" }) },
      { type: "add_node", node: workNode("o1", "observation", "make test", 3, { command: "make test", exitCode: 1 }) },
      { type: "add_edge", edge: edge("eo", "a1", "o1", "result", { kind: "llm" }) },
      goal("g2", "sub", 4),
      ...plan("p1", "g1", ["i1"], 5),
      ...item("i1", "g1", 6, ["a1", "g2"]),
      { type: "add_node", node: workNode("s1", "stop", "done", 7, { why: "the sub-goal is done" }) },
      { type: "add_edge", edge: edge("es", "g2", "s1", "stop", llm) },
    ]);
    const context = project(state);
    const texts = context.history.map((message) => message.text);
    expect(texts.some((text) => text.includes("what: sub"))).toBe(false);
    expect(texts[texts.length - 1]).toBe("stopped: the sub-goal is done");
  });

  it("marks an alternative command with its previous attempt", () => {
    const state = fold([
      requestNode(0),
      goal("g1", "green", 1),
      { type: "add_edge", edge: edge("eg", "r1", "g1", "goal", llm) },
      { type: "add_node", node: workNode("a1", "action", "run one", 2, { command: "run one" }) },
      { type: "add_node", node: workNode("o1", "observation", "run one", 3, { command: "run one", exitCode: 1 }) },
      { type: "add_edge", edge: edge("e1", "a1", "o1", "result", { kind: "llm" }) },
      { type: "add_node", node: workNode("a2", "action", "run two", 4, { command: "run two" }) },
      { type: "add_node", node: workNode("o2", "observation", "run two", 5, { command: "run two", exitCode: 0 }) },
      { type: "add_edge", edge: edge("e2", "a2", "o2", "result", { kind: "llm" }) },
      ...plan("p1", "g1", ["i1"], 6),
      ...item("i1", "g1", 7, ["a1", "a2"]),
    ]);
    const context = project(state);
    const call = context.history.find((message) => message.text.includes("run two"));
    expect(call?.text).toContain("alternative to step");
    expect(call?.text).toContain("previous attempt");
    expect(call?.text).toContain("run one");
  });

  it("reports the applicable operators at the current point", () => {
    const state = fold([
      goal("g1", "green", 0),
      { type: "add_node", node: workNode("a1", "action", "run build", 1) },
      { type: "add_node", node: workNode("o1", "observation", "done", 2) },
      { type: "add_edge", edge: edge("e1", "a1", "o1", "result", { kind: "grep", pattern: "x" }) },
      ...plan("p1", "g1", ["i1"], 3),
      ...item("i1", "g1", 4, ["a1"]),
    ]);
    const app = applicable(state, "g1");
    // An open goal always offers apply, create_goal and stop (no criterion gate).
    expect(app.createGoal).toBe(true);
    expect(app.apply).toBe(true);
    expect(app.stop).toBe(true);
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

describe("progress key", () => {
  it("changes when a goal is added and when a goal is stopped", () => {
    const base = fold([goal("g1", "green", 0)]);
    const withGoal = fold([goal("g1", "green", 0), goal("g2", "locate", 1)]);
    expect(knowledgeKey(withGoal)).not.toBe(knowledgeKey(base));

    const stopped = fold([
      goal("g1", "green", 0),
      { type: "add_node", node: workNode("s1", "stop", "done", 1) },
      { type: "add_edge", edge: edge("es", "g1", "s1", "stop", llm) },
    ]);
    expect(knowledgeKey(stopped)).not.toBe(knowledgeKey(base));
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
  const interpreted = (extra?: Event[]): Event[] => [
    { type: "add_node", node: workNode("r1", "request", "task", 0, { text: "go" }) },
    goal("g1", "interp", 1),
    { type: "add_edge", edge: edge("ea", "r1", "g1", "goal", llm) },
    ...plan("p1", "g1", ["i1"], 3),
    { type: "add_node", node: workNode("a1", "action", "run", 4, { command: "run" }) },
    goal("g2", "stage", 5),
    ...item("i1", "g1", 6, ["a1", "g2"]),
    { type: "descend", node: "g1" },
    { type: "descend", node: "g2" },
    ...(extra ?? []),
  ];

  it("trims the branch under a stopped ancestor, not only when the top stops", () => {
    const state = fold(
      interpreted([
        { type: "add_node", node: workNode("s1", "stop", "done", 99) },
        { type: "add_edge", edge: edge("es", "g1", "s1", "stop", llm) },
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
    expect(hasStopped(state, "g1")).toBe(false);
    expect(focusEvents(state)).toEqual([]);
  });
});
