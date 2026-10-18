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

function request(id: string, text: string, seq: number): Event {
  return { type: "add_node", node: workNode(id, "request", text, seq, { text }) };
}

function move(id: string, state: string, what: string, seq: number): Event {
  return { type: "add_node", node: workNode(id, "move", state, seq, { state, what }) };
}

// A plan (`plan` relation from its state) with the given item ids, in order (`items`).
function plan(id: string, moveId: string, itemIds: string[], seq: number): Event[] {
  const events: Event[] = [
    { type: "add_node", node: workNode(id, "plan", `plan for ${moveId}`, seq) },
    { type: "add_edge", edge: edge(`hp:${id}`, moveId, id, "plan", llm) },
  ];
  itemIds.forEach((item, index) => {
    events.push({ type: "add_edge", edge: edge(`it:${id}:${index}`, id, item, "items", llm) });
  });
  return events;
}

// A plan item (`item` node) whose ordered alternatives (actions) hang off it via `alts`.
function item(id: string, moveId: string, seq: number, alts: string[]): Event[] {
  const events: Event[] = [
    { type: "add_node", node: workNode(id, "item", `item for ${moveId}`, seq) },
  ];
  alts.forEach((alt, index) => {
    events.push({ type: "add_edge", edge: edge(`al:${id}:${index}`, id, alt, "alts", llm) });
  });
  return events;
}

describe("events", () => {
  it("accepts a valid move node", () => {
    const event = move("m1", "orientation", "make test green", 0);
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
    expect(eventSchema.safeParse({ type: "set_status", id: "m1", status: "open" }).success).toBe(
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
    request("r1", "do it", 0),
    move("m1", "orientation", "make test green", 1),
    { type: "add_node", node: workNode("a1", "action", "read src/a.ts", 2) },
    { type: "add_node", node: artifactNode("file:src/a.ts", "file", "src/a.ts", 3) },
  ];

  it("is deterministic: same events, same state", () => {
    expect(fold(events)).toEqual(fold(events));
  });

  it("is pure: does not mutate the base state", () => {
    const base = emptyState();
    const next = fold(events, base);
    expect(base.nodes.size).toBe(0);
    expect(next.nodes.size).toBe(4);
  });

  it("records the root request; the state is open until stopped", () => {
    const state = fold(events);
    expect(state.rootId).toBe("r1");
    expect(hasStopped(state, "m1")).toBe(false);
    expect(actionExecuted(state, "a1")).toBe(false);
  });

  it("derives executed for an action with a produced child", () => {
    const state = fold([
      request("r1", "do it", 0),
      move("m1", "orientation", "make test green", 1),
      { type: "add_node", node: workNode("a1", "action", "read", 2) },
      { type: "add_node", node: workNode("o1", "observation", "read", 3) },
      { type: "add_edge", edge: edge("e1", "a1", "o1", "result", { kind: "read", ref: "file:x", version: "v1" }) },
    ]);
    expect(actionExecuted(state, "a1")).toBe(true);
  });

  it("keeps plan item order from the items edge order", () => {
    const state = fold([
      request("r1", "do it", 0),
      move("m1", "orientation", "green", 1),
      { type: "add_node", node: workNode("i1", "item", "one", 2) },
      { type: "add_node", node: workNode("i2", "item", "two", 3) },
      ...plan("p1", "m1", ["i2", "i1"], 4),
    ]);
    expect(childrenOf(state, "p1")).toEqual(["i2", "i1"]);
  });
});

describe("closure", () => {
  it("a state is closed by a stop: a `stop` relation to the stop node", () => {
    const base: Event[] = [request("r1", "do it", 0), move("m1", "orientation", "green", 1)];
    expect(hasStopped(fold(base), "m1")).toBe(false);
    const stopped = fold([
      ...base,
      { type: "add_node", node: workNode("s1", "stop", "done", 2) },
      { type: "add_edge", edge: edge("es", "m1", "s1", "stop", llm) },
    ]);
    expect(hasStopped(stopped, "m1")).toBe(true);
  });
});

describe("projection (the message tape)", () => {
  it("renders the state and the first command as a tape (the request is dropped)", () => {
    const state = fold([
      request("r1", "do it", 0),
      move("m1", "orientation", "green", 1),
      { type: "add_edge", edge: edge("em", "r1", "m1", "move", llm) },
      { type: "add_node", node: workNode("a1", "action", "make test", 3, { command: "make test" }) },
      { type: "add_node", node: workNode("o1", "observation", "make test", 4, { command: "make test", exitCode: 1, output: "boom" }) },
      { type: "add_edge", edge: edge("eo", "a1", "o1", "result", { kind: "llm" }) },
      ...plan("p1", "m1", ["i1"], 5),
      ...item("i1", "m1", 6, ["a1"]),
    ]);
    const context = project(fold(focusEvents(state), state));
    expect(context.situation).toBe("working");
    expect(context.history.map((message) => message.role)).toEqual([
      "user",
      "system",
      "system",
      "user",
      "assistant",
      "tool",
    ]);
    expect(context.history[1]?.text).toBe("Start state Orientation");
    const texts = context.history.map((message) => message.text);
    expect(texts.some((text) => text.includes("make test"))).toBe(true);
    expect(texts.some((text) => text.includes("exit 1") && text.includes("boom"))).toBe(true);
  });

  it("reports the request situation and the constraints before a move", () => {
    const state = fold([
      request("r1", "do it", 0),
      { type: "add_node", node: workNode("k1", "constraint", "no tests", 1, { forbid: ["\\.test\\.mjs$"] }) },
    ]);
    const context = project(fold(focusEvents(state), state));
    expect(context.situation).toBe("request");
    expect(context.constraints).toEqual([{ id: "k1", forbid: ["\\.test\\.mjs$"] }]);
  });

  it("elides a finished state's turns and carries its compaction line on the next move", () => {
    const state = fold([
      request("r1", "do it", 0),
      move("m1", "localization", "find the cause", 1),
      { type: "add_edge", edge: edge("em1", "r1", "m1", "move", llm) },
      { type: "add_node", node: workNode("a1", "action", "grep p", 3, { command: "grep p" }) },
      { type: "add_node", node: workNode("o1", "observation", "p at line 3", 4, { command: "grep p", output: "p at line 3" }) },
      { type: "add_edge", edge: edge("eo", "a1", "o1", "result", { kind: "llm" }) },
      ...plan("p1", "m1", ["i1"], 5),
      ...item("i1", "m1", 6, ["a1"]),
      { type: "add_node", node: workNode("s1", "stop", "named the line", 7, { why: "named the line" }) },
      { type: "add_edge", edge: edge("es", "m1", "s1", "stop", llm) },
      move("m2", "patch", "apply the fix", 8),
      { type: "add_edge", edge: edge("em2", "r1", "m2", "move", llm) },
    ]);
    const context = project(fold(focusEvents(state), state));
    const texts = context.history.map((message) => message.text);
    // The finished state's internals leave the tape...
    expect(texts.some((text) => text.includes("p at line 3"))).toBe(false);
    expect(texts.some((text) => text.includes("grep p"))).toBe(false);
    // ...only its closure marker remains, in the finished state's triple.
    expect(texts.some((text) => text.includes("Finish state Localization"))).toBe(true);
    expect(context.situation).toBe("plan");
  });

  it("marks an alternative command with its previous attempt", () => {
    const state = fold([
      request("r1", "do it", 0),
      move("m1", "orientation", "green", 1),
      { type: "add_edge", edge: edge("em", "r1", "m1", "move", llm) },
      { type: "add_node", node: workNode("a1", "action", "run one", 3, { command: "run one" }) },
      { type: "add_node", node: workNode("o1", "observation", "run one", 4, { command: "run one", exitCode: 1 }) },
      { type: "add_edge", edge: edge("e1", "a1", "o1", "result", { kind: "llm" }) },
      { type: "add_node", node: workNode("a2", "action", "run two", 5, { command: "run two" }) },
      { type: "add_node", node: workNode("o2", "observation", "run two", 6, { command: "run two", exitCode: 0 }) },
      { type: "add_edge", edge: edge("e2", "a2", "o2", "result", { kind: "llm" }) },
      ...plan("p1", "m1", ["i1"], 7),
      ...item("i1", "m1", 8, ["a1", "a2"]),
    ]);
    const context = project(fold(focusEvents(state), state));
    const call = context.history.find((message) => message.text.includes("run two"));
    expect(call?.text).toContain("alternative to step");
    expect(call?.text).toContain("previous attempt");
    expect(call?.text).toContain("run one");
  });

  it("reports the frontier at the current point", () => {
    const state = fold([
      request("r1", "do it", 0),
      move("m1", "orientation", "green", 1),
      { type: "add_edge", edge: edge("em", "r1", "m1", "move", llm) },
      { type: "add_node", node: workNode("a1", "action", "run build", 2) },
      { type: "add_node", node: workNode("o1", "observation", "done", 3) },
      { type: "add_edge", edge: edge("e1", "a1", "o1", "result", { kind: "grep", pattern: "x" }) },
      ...plan("p1", "m1", ["i1"], 4),
      ...item("i1", "m1", 5, ["a1"]),
    ]);
    const app = applicable(state, "m1");
    // An open state always offers apply and stop (no criterion gate).
    expect(app.apply).toBe(true);
    expect(app.stop).toBe(true);
    expect(app.move).toBe(false);
  });
});

describe("record_rejection", () => {
  const base: Event[] = [
    request("r1", "do it", 0),
    move("m1", "orientation", "green", 1),
    { type: "add_node", node: workNode("k1", "constraint", "do not edit tests", 2) },
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
        tool: "move",
        target: "state:patch",
        reason: "state_open",
        turn: 6,
      },
    ]);
    expect(state.rejections).toHaveLength(3);
  });
});

describe("progress key", () => {
  it("changes when a state is added and when it is stopped", () => {
    const base = fold([request("r1", "do it", 0), move("m1", "orientation", "green", 1)]);
    const withState = fold([
      request("r1", "do it", 0),
      move("m1", "orientation", "green", 1),
      move("m2", "localization", "locate", 2),
    ]);
    expect(knowledgeKey(withState)).not.toBe(knowledgeKey(base));

    const stopped = fold([
      request("r1", "do it", 0),
      move("m1", "orientation", "green", 1),
      { type: "add_node", node: workNode("s1", "stop", "done", 2) },
      { type: "add_edge", edge: edge("es", "m1", "s1", "stop", llm) },
    ]);
    expect(knowledgeKey(stopped)).not.toBe(knowledgeKey(base));
  });

  it("does not change on a repeated failure, but does on a distinct one", () => {
    const failure = (command: string, output: string, seq: number): Event => ({
      type: "add_node",
      node: workNode(`o${seq}`, "observation", command, seq, { command, verdict: "fail", output }),
    });
    const once = fold([request("r1", "do it", 0), move("m1", "orientation", "green", 1), failure("git status", "fatal: no repo", 2)]);
    const twice = fold([
      request("r1", "do it", 0),
      move("m1", "orientation", "green", 1),
      failure("git status", "fatal: no repo", 2),
      failure("git status", "fatal: no repo", 3),
    ]);
    expect(knowledgeKey(twice)).toBe(knowledgeKey(once));
    const other = fold([
      request("r1", "do it", 0),
      move("m1", "orientation", "green", 1),
      failure("git status", "fatal: no repo", 2),
      failure("git log", "fatal: no repo", 3),
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
    const base = [request("r1", "do it", 0), move("m1", "orientation", "green", 1)];
    const once = fold([...base, refusal("/app/a", 1, 1)]);
    const twice = fold([...base, refusal("/app/a", 1, 1), refusal("/app/a", 2, 2)]);
    expect(knowledgeKey(twice)).toBe(knowledgeKey(once));
    const other = fold([...base, refusal("/app/a", 1, 1), refusal("/app/b", 2, 2)]);
    expect(knowledgeKey(other)).not.toBe(knowledgeKey(once));
  });
});

describe("traversal focus", () => {
  const stateWith = (extra: Event[] = []): Event[] => [
    request("r1", "go", 0),
    move("m1", "orientation", "interp", 1),
    { type: "add_edge", edge: edge("em", "r1", "m1", "move", llm) },
    { type: "descend", node: "m1" },
    ...extra,
  ];

  it("stays on the move while the state is open", () => {
    const state = fold(stateWith());
    expect(hasStopped(state, "m1")).toBe(false);
    expect(state.branch).toEqual(["r1", "m1"]);
    expect(focusEvents(state)).toEqual([]);
  });

  it("returns out of a finished state and offers the transition move", () => {
    const state = fold(
      stateWith([
        { type: "add_node", node: workNode("s1", "stop", "done", 99) },
        { type: "add_edge", edge: edge("es", "m1", "s1", "stop", llm) },
      ]),
    );
    expect(state.branch).toEqual(["r1", "m1"]);
    const trimmed = fold(focusEvents(state), state);
    expect(trimmed.branch).toEqual(["r1", "m1"]);
    // The finished state offers the transition move.
    expect(applicable(trimmed, "m1")).toMatchObject({ move: true, apply: false, stop: false });
  });
});
