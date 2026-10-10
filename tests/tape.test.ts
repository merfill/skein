import { describe, expect, it } from "vitest";

import type { Event } from "../src/ir/events";
import { fold } from "../src/ir/graph";
import { project, type TapeMessage } from "../src/ir/project";
import type { Edge, EdgeKind, Node, NodeKind, Provenance } from "../src/ir/types";

// The context the model sees is a tape of messages, rebuilt from the tree every turn
// (docs/ir_revision.md §5). These tests pin every construction situation: roles and order
// per move, the goal/command pairing, the alternative marker, the non-monotone cut at
// closure (nested), decline, the transient `query` result, ids exposed for addressability,
// and determinism.

function workNode(id: string, kind: NodeKind, label: string, seq: number, payload?: unknown): Node {
  return { id, space: "work", kind, label, ...(payload !== undefined ? { payload } : {}), seq };
}

function edge(id: string, from: string, to: string, kind: EdgeKind, provenance: Provenance): Edge {
  return { id, from, to, kind, provenance };
}

const llm: Provenance = { kind: "llm" };

function request(text: string, seq = 0): Event {
  return {
    type: "add_node",
    node: { id: "r1", space: "work", kind: "request", label: text, payload: { text }, seq },
  };
}

function goal(id: string, what: string, seq: number): Event {
  return {
    type: "add_node",
    node: workNode(id, "goal", what, seq, { what }),
  };
}

function plan(id: string, goalId: string, itemIds: string[], seq: number): Event[] {
  return [
    { type: "add_node", node: workNode(id, "plan", `plan for ${goalId}`, seq) },
    { type: "add_edge", edge: edge(`hp:${id}`, goalId, id, "plan", llm) },
    ...itemIds.map(
      (itemId, index): Event => ({
        type: "add_edge",
        edge: edge(`it:${id}:${index}`, id, itemId, "items", llm),
      }),
    ),
  ];
}

function item(id: string, seq: number, alts: string[]): Event[] {
  return [
    { type: "add_node", node: workNode(id, "item", "step", seq) },
    ...alts.map(
      (alt, index): Event => ({
        type: "add_edge",
        edge: edge(`al:${id}:${index}`, id, alt, "alts", llm),
      }),
    ),
  ];
}

function action(id: string, command: string, seq: number): Event {
  return { type: "add_node", node: workNode(id, "action", command, seq, { command }) };
}

function observation(
  id: string,
  seq: number,
  payload: Record<string, unknown>,
  label = "result",
): Event {
  return { type: "add_node", node: workNode(id, "observation", label, seq, payload) };
}

function result(edgeId: string, actionId: string, observationId: string): Event {
  return { type: "add_edge", edge: edge(edgeId, actionId, observationId, "result", llm) };
}

function roles(history: readonly TapeMessage[]): string[] {
  return history.map((message) => message.role);
}

function texts(history: readonly TapeMessage[]): string {
  return history.map((message) => message.text).join("\n");
}

describe("the tape: request and interpretation", () => {
  it("a fresh request is a single user turn, situation request", () => {
    const context = project(fold([request("solve it")]));
    expect(roles(context.history)).toEqual(["user"]);
    expect(context.history[0]?.text).toBe("solve it");
    expect(context.situation).toBe("request");
  });

  it("create_goal renders the goal, then the first command as a call/observation pair", () => {
    const state = fold([
      request("do it", 0),
      goal("g1", "green", 1),
      { type: "add_edge", edge: edge("eg", "r1", "g1", "goal", llm) },
      action("a1", "make test", 2),
      observation("o1", 3, { command: "make test", exitCode: 1, output: "boom" }, "make test"),
      result("eo", "a1", "o1"),
      ...plan("p1", "g1", ["i1"], 4),
      ...item("i1", 5, ["a1"]),
    ]);
    const context = project(state);
    expect(context.situation).toBe("goal");
    expect(roles(context.history)).toEqual(["user", "assistant", "assistant", "tool"]);
    expect(context.history[1]?.text).toContain("[g1] create_goal:");
    expect(context.history[1]?.text).toContain("what: green");
    expect(context.history[2]?.text).toBe("[a1] make test");
    expect(context.history[3]?.text).toBe("[o1] exit 1\nboom");
  });

  it("decline renders a single assistant refusal", () => {
    const state = fold([
      request("привет", 0),
      { type: "add_node", node: workNode("u1", "unactionable", "not actionable", 1, { why: "chit-chat" }) },
      { type: "add_edge", edge: edge("eu", "r1", "u1", "unactionable", llm) },
    ]);
    const context = project(state);
    expect(roles(context.history)).toEqual(["user", "assistant"]);
    expect(context.history[1]?.text).toBe("declined: chit-chat");
  });
});

describe("the tape: commands and their outcomes", () => {
  it("a successful continuation appends a new call/observation pair", () => {
    const state = fold([
      request("do it", 0),
      goal("g1", "green", 1),
      { type: "add_edge", edge: edge("eg", "r1", "g1", "goal", llm) },
      action("a1", "make test", 2),
      observation("o1", 3, { command: "make test", exitCode: 0 }, "make test"),
      result("e1", "a1", "o1"),
      action("a2", "read src/a.ts", 4),
      observation("o2", 5, { ref: "file:src/a.ts", version: "v1", output: "source", start: 1, end: 1, total: 1 }, "read src/a.ts"),
      result("e2", "a2", "o2"),
      ...plan("p1", "g1", ["i1", "i2"], 6),
      ...item("i1", 7, ["a1"]),
      ...item("i2", 8, ["a2"]),
    ]);
    const context = project(state);
    expect(roles(context.history)).toEqual(["user", "assistant", "assistant", "tool", "assistant", "tool"]);
    expect(context.history[5]?.text).toBe("[o2] src/a.ts lines 1-1 of 1\nsource");
  });

  it("renders an edit's mutate (no observation) as a mutated file", () => {
    const state = fold([
      request("do it", 0),
      goal("g1", "green", 1),
      { type: "add_edge", edge: edge("eg", "r1", "g1", "goal", llm) },
      action("a1", "edit src/a.ts", 2),
      { type: "add_edge", edge: edge("em", "a1", "file:src/a.ts", "mutates", llm) },
      { type: "mutate", ref: "file:src/a.ts", version: "v2", actionId: "a1" },
      ...plan("p1", "g1", ["i1"], 3),
      ...item("i1", 4, ["a1"]),
    ]);
    const context = project(state);
    expect(context.history[3]?.text).toBe("[a1] mutated src/a.ts");
  });

  it("renders a refused command as an observation with the reason", () => {
    const state = fold([
      request("do it", 0),
      goal("g1", "green", 1),
      { type: "add_edge", edge: edge("eg", "r1", "g1", "goal", llm) },
      action("a1", "read src/a.ts", 2),
      observation("o1", 3, { failed: true, refused: true, output: "repeated_action: o0 already has it" }),
      result("e1", "a1", "o1"),
      ...plan("p1", "g1", ["i1"], 4),
      ...item("i1", 5, ["a1"]),
    ]);
    const context = project(state);
    expect(context.history[3]?.text).toBe("[o1] repeated_action: o0 already has it");
  });

  it("marks an alternative with its previous attempt and reason", () => {
    const state = fold([
      request("do it", 0),
      goal("g1", "green", 1),
      { type: "add_edge", edge: edge("eg", "r1", "g1", "goal", llm) },
      action("a1", "run one", 2),
      observation("o1", 3, { command: "run one", exitCode: 1 }, "run one"),
      result("e1", "a1", "o1"),
      action("a2", "run two", 4),
      observation("o2", 5, { command: "run two", exitCode: 0 }, "run two"),
      result("e2", "a2", "o2"),
      ...plan("p1", "g1", ["i1"], 6),
      ...item("i1", 7, ["a1", "a2"]),
    ]);
    const context = project(state);
    const marker = context.history[4]?.text ?? "";
    expect(marker).toContain('alternative to step "step"');
    expect(marker).toContain('previous attempt: "run one"');
    expect(marker).toContain("exit 1");
    expect(marker).toContain("[a2] run two");
  });
});

describe("the tape: sub-goals and the non-monotone cut", () => {
  function parentWithSubGoal(subClosed: boolean): Event[] {
    const events: Event[] = [
      request("do it", 0),
      goal("g1", "parent", 1),
      { type: "add_edge", edge: edge("eg", "r1", "g1", "goal", llm) },
      action("a1", "make test", 2),
      observation("o1", 3, { command: "make test", exitCode: 1 }, "make test"),
      result("e1", "a1", "o1"),
      goal("g2", "sub goal", 4),
      action("a2", "read src/a.ts", 5),
      observation("o2", 6, { ref: "file:src/a.ts", version: "v1", output: "SUB-BODY" }, "read src/a.ts"),
      result("e2", "a2", "o2"),
      ...plan("p2", "g2", ["i2"], 7),
      ...item("i2", 8, ["a2"]),
      ...plan("p1", "g1", ["i1"], 9),
      ...item("i1", 10, ["a1", "g2"]),
    ];
    if (subClosed) {
      events.push(
        { type: "add_node", node: workNode("s2", "stop", "done", 11, { why: "sub done" }) },
        { type: "add_edge", edge: edge("es", "g2", "s2", "stop", llm) },
      );
    }
    return events;
  }

  it("renders an open sub-goal inline, after a marker", () => {
    const context = project(fold(parentWithSubGoal(false)));
    const body = texts(context.history);
    expect(body).toContain("[g2] create_goal:");
    expect(body).toContain("what: sub goal");
    expect(body).toContain("SUB-BODY");
    // The sub-goal is the current alternative of the step, so it carries a marker.
    expect(body).toContain("alternative to step");
  });

  it("collapses a closed sub-goal to a single closure message and removes its internals", () => {
    const context = project(fold(parentWithSubGoal(true)));
    const body = texts(context.history);
    expect(body).toContain("stopped: sub done");
    expect(body).not.toContain("what: sub goal");
    expect(body).not.toContain("SUB-BODY");
    // The parent's own messages remain.
    expect(body).toContain("what: parent");
    expect(body).toContain("[a1] make test");
  });

  it("cuts a middle goal while keeping the outer arm", () => {
    const state = fold([
      request("do it", 0),
      goal("g1", "outer", 1),
      { type: "add_edge", edge: edge("eg", "r1", "g1", "goal", llm) },
      goal("g2", "middle", 2),
      { type: "add_node", node: workNode("s2", "stop", "done", 3, { why: "middle done" }) },
      { type: "add_edge", edge: edge("es", "g2", "s2", "stop", llm) },
      action("a1", "run after", 4),
      observation("o1", 5, { command: "run after", exitCode: 0 }, "run after"),
      result("e1", "a1", "o1"),
      ...plan("p1", "g1", ["i1"], 6),
      ...item("i1", 7, ["g2", "a1"]),
    ]);
    const context = project(state);
    const body = texts(context.history);
    expect(body).toContain("stopped: middle done");
    expect(body).not.toContain("what: middle");
    // The command after the closed sub-goal is a newer alternative of the same step: marked.
    expect(body).toContain("alternative to step");
    expect(body).toContain("[a1] run after");
  });
});

describe("the tape: edge cases", () => {
  it("a stopped root goal leaves only the closure message (the run ends there)", () => {
    const state = fold([
      request("do it", 0),
      goal("g1", "green", 1),
      { type: "add_edge", edge: edge("eg", "r1", "g1", "goal", llm) },
      action("a1", "make test", 2),
      observation("o1", 3, { command: "make test", exitCode: 0 }, "make test"),
      result("e1", "a1", "o1"),
      ...plan("p1", "g1", ["i1"], 4),
      ...item("i1", 5, ["a1"]),
      { type: "add_node", node: workNode("s1", "stop", "done", 6, { why: "all green" }) },
      { type: "add_edge", edge: edge("es", "g1", "s1", "stop", llm) },
    ]);
    const context = project(state);
    expect(roles(context.history)).toEqual(["user", "assistant"]);
    expect(context.history[1]?.text).toBe("stopped: all green");
    expect(texts(context.history)).not.toContain("what: green");
    expect(texts(context.history)).not.toContain("[a1] make test");
  });

  it("a goal without a plan still renders its create_goal message", () => {
    const state = fold([
      request("do it", 0),
      goal("g1", "green", 1),
      { type: "add_edge", edge: edge("eg", "r1", "g1", "goal", llm) },
    ]);
    const context = project(state);
    expect(context.situation).toBe("goal");
    expect(roles(context.history)).toEqual(["user", "assistant"]);
    expect(context.history[1]?.text).toContain("[g1] create_goal:");
    expect(context.history[1]?.text).toContain("what: green");
  });
});

describe("the tape: transient retrieval and determinism", () => {
  it("appends a recall result as a transient assistant/tool pair", () => {
    const state = fold([request("do it"), goal("g1", "green", 1), { type: "add_edge", edge: edge("eg", "r1", "g1", "goal", llm) }]);
    const context = project(state, {
      retrieval: { call: "recall { id: obs:5 }", output: "the stored body" },
    });
    expect(roles(context.history)).toEqual(["user", "assistant", "assistant", "tool"]);
    expect(context.history[2]?.text).toBe("recall { id: obs:5 }");
    expect(context.history[3]?.text).toBe("the stored body");
  });

  it("is deterministic: same events, same tape", () => {
    const events = parentEvents();
    expect(JSON.stringify(project(fold(events)))).toBe(JSON.stringify(project(fold(events))));
  });
});

function parentEvents(): Event[] {
  return [
    request("do it", 0),
    goal("g1", "green", 1),
    { type: "add_edge", edge: edge("eg", "r1", "g1", "goal", llm) },
    action("a1", "make test", 2),
    observation("o1", 3, { command: "make test", exitCode: 0 }, "make test"),
    result("e1", "a1", "o1"),
    ...plan("p1", "g1", ["i1"], 4),
    ...item("i1", 5, ["a1"]),
  ];
}
