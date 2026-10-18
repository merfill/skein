import { describe, expect, it } from "vitest";

import type { Event } from "../src/ir/events";
import { fold, type State } from "../src/ir/graph";
import { project, type TapeMessage } from "../src/ir/project";
import { focusEvents } from "../src/ir/traversal";
import type { Edge, EdgeKind, Node, NodeKind, Provenance } from "../src/ir/types";

// A low-level tape test builds a tree by hand; the loop applies the deterministic focus
// normalization (`focusEvents`) before projecting, so these tests do the same.
function focused(state: State): State {
  const drift = focusEvents(state);
  return drift.length > 0 ? fold(drift, state) : state;
}

// The context the model sees is a tape of messages, rebuilt from the tree every turn
// (docs/ir_semantics.md §7). These tests pin every construction situation: roles and order
// per move, the state/command pairing, the alternative marker, the compaction of a
// finished state, decline, the transient retrieval, ids exposed for addressability, and
// determinism.

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

// A declared state (`move` mId): the state IS its goal, so `what` rides the move.
function moved(mId: string, state: string, what: string, seq: number): Event[] {
  return [
    { type: "add_node", node: workNode(mId, "move", state, seq, { state, what }) },
    { type: "add_edge", edge: edge(`em:${mId}`, "r1", mId, "move", llm) },
  ];
}

function stopNode(id: string, why: string, seq: number, onId: string): Event[] {
  return [
    { type: "add_node", node: workNode(id, "stop", why, seq, { why }) },
    { type: "add_edge", edge: edge(`es:${id}`, onId, id, "stop", llm) },
  ];
}

function plan(id: string, moveId: string, itemIds: string[], seq: number): Event[] {
  return [
    { type: "add_node", node: workNode(id, "plan", `plan for ${moveId}`, seq) },
    { type: "add_edge", edge: edge(`hp:${id}`, moveId, id, "plan", llm) },
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

describe("the tape: request and state", () => {
  it("a fresh request is a single user turn, situation request", () => {
    const context = project(focused(fold([request("solve it")])));
    expect(roles(context.history)).toEqual(["user"]);
    expect(context.history[0]?.text).toBe("solve it");
    expect(context.situation).toBe("request");
  });

  it("move renders the state, then the first plan item as a call/result pair", () => {
    const state = fold([
      request("do it", 0),
      ...moved("m1", "orientation", "green", 1),
      action("a1", "make test", 3),
      observation("o1", 4, { command: "make test", exitCode: 1, output: "boom" }, "make test"),
      result("eo", "a1", "o1"),
      ...plan("p1", "m1", ["i1"], 5),
      ...item("i1", 6, ["a1"]),
    ]);
    const context = project(focused(state));
    expect(context.situation).toBe("working");
    // The request leads the tape; then the state's entry (Start marker + instruction + goal),
    // then each plan item as a native call + tool result.
    expect(roles(context.history)).toEqual([
      "user",
      "system",
      "system",
      "user",
      "assistant",
      "tool",
    ]);
    expect(context.history[1]?.text).toBe("Start state Orientation");
    expect(context.history[3]?.text).toContain("map the material");
    expect(context.history[4]?.text).toBe("[a1] make test");
    expect(context.history[5]?.text).toBe("[o1] exit 1\nboom");
  });

  it("decline renders a single assistant refusal", () => {
    const state = fold([
      request("привет", 0),
      { type: "add_node", node: workNode("u1", "unactionable", "not actionable", 1, { why: "chit-chat" }) },
      { type: "add_edge", edge: edge("eu", "r1", "u1", "unactionable", llm) },
    ]);
    const context = project(focused(state));
    expect(roles(context.history)).toEqual(["user", "assistant"]);
    expect(context.history[1]?.text).toBe("declined: chit-chat");
  });
});

describe("the tape: commands and their outcomes", () => {
  it("a successful continuation appends a new call/observation pair", () => {
    const state = fold([
      request("do it", 0),
      ...moved("m1", "orientation", "green", 1),
      action("a1", "make test", 3),
      observation("o1", 4, { command: "make test", exitCode: 0 }, "make test"),
      result("e1", "a1", "o1"),
      action("a2", "read src/a.ts", 5),
      observation("o2", 6, { ref: "file:src/a.ts", version: "v1", output: "source", start: 1, end: 1, total: 1 }, "read src/a.ts"),
      result("e2", "a2", "o2"),
      ...plan("p1", "m1", ["i1", "i2"], 7),
      ...item("i1", 8, ["a1"]),
      ...item("i2", 9, ["a2"]),
    ]);
    const context = project(focused(state));
    expect(roles(context.history)).toEqual([
      "user",
      "system",
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
    ]);
    expect(context.history[7]?.text).toBe("[o2] src/a.ts lines 1-1 of 1\nsource");
  });

  it("renders an edit's mutate (no observation) as a mutated file", () => {
    const state = fold([
      request("do it", 0),
      ...moved("m1", "orientation", "green", 1),
      action("a1", "edit src/a.ts", 3),
      { type: "add_edge", edge: edge("em", "a1", "file:src/a.ts", "mutates", llm) },
      { type: "mutate", ref: "file:src/a.ts", version: "v2", actionId: "a1" },
      ...plan("p1", "m1", ["i1"], 4),
      ...item("i1", 5, ["a1"]),
    ]);
    const context = project(focused(state));
    expect(context.history[5]?.text).toBe("[a1] mutated src/a.ts");
  });

  it("renders a refused command as an observation with the reason", () => {
    const state = fold([
      request("do it", 0),
      ...moved("m1", "orientation", "green", 1),
      action("a1", "read src/a.ts", 3),
      observation("o1", 4, { failed: true, refused: true, output: "repeated_action: o0 already has it" }),
      result("e1", "a1", "o1"),
      ...plan("p1", "m1", ["i1"], 5),
      ...item("i1", 6, ["a1"]),
    ]);
    const context = project(focused(state));
    expect(context.history[5]?.text).toBe("[o1] repeated_action: o0 already has it");
  });

  it("marks an alternative with its previous attempt and reason", () => {
    const state = fold([
      request("do it", 0),
      ...moved("m1", "orientation", "green", 1),
      action("a1", "run one", 3),
      observation("o1", 4, { command: "run one", exitCode: 1 }, "run one"),
      result("e1", "a1", "o1"),
      action("a2", "run two", 5),
      observation("o2", 6, { command: "run two", exitCode: 0 }, "run two"),
      result("e2", "a2", "o2"),
      ...plan("p1", "m1", ["i1"], 7),
      ...item("i1", 8, ["a1", "a2"]),
    ]);
    const context = project(focused(state));
    const marker = context.history[6]?.text ?? "";
    expect(marker).toContain('alternative to step "step"');
    expect(marker).toContain('previous attempt: "run one"');
    expect(marker).toContain("exit 1");
    expect(marker).toContain("[a2] run two");
  });
});

describe("the tape: the compaction of a finished state", () => {
  it("a finished state leaves one line, carried by the next move", () => {
    const state = fold([
      request("do it", 0),
      ...moved("m1", "localization", "find it", 1),
      action("a1", "grep x", 3),
      observation("o1", 4, { ref: "file:src/a.ts", version: "v1", output: "FOUND-BODY" }, "grep x"),
      result("e1", "a1", "o1"),
      ...plan("p1", "m1", ["i1"], 5),
      ...item("i1", 6, ["a1"]),
      ...stopNode("s1", "named the line", 7, "m1"),
      ...moved("m2", "patch", "fix it", 8),
    ]);
    const context = project(focused(state));
    const body = texts(context.history);
    // The finished state's command has left the tape...
    expect(body).not.toContain("FOUND-BODY");
    // ...only its closure marker remains, in the finished state's triple.
    expect(body).toContain("Finish state Localization — your stop reason: named the line");
    expect(context.situation).toBe("plan");
  });
});

describe("the tape: edge cases", () => {
  it("a stopped state without a successor leaves only the move and its closure", () => {
    const state = fold([
      request("do it", 0),
      ...moved("m1", "localization", "gone", 1),
      action("a1", "make test", 3),
      observation("o1", 4, { command: "make test", exitCode: 0 }, "make test"),
      result("e1", "a1", "o1"),
      ...plan("p1", "m1", ["i1"], 5),
      ...item("i1", 6, ["a1"]),
      ...stopNode("s1", "all green", 7, "m1"),
    ]);
    const context = project(focused(state));
    expect(roles(context.history)).toEqual(["user", "system", "system", "user", "system"]);
    expect(context.situation).toBe("transition");
    expect(texts(context.history)).not.toContain("[a1] make test");
    expect(texts(context.history)).toContain("Finish state Localization — your stop reason: all green");
  });

  it("a declared state without a plan renders move + confirmation", () => {
    const state = fold([
      request("do it", 0),
      ...moved("m1", "orientation", "map", 1),
    ]);
    const context = project(focused(state));
    expect(context.situation).toBe("plan");
    expect(roles(context.history)).toEqual(["user", "system", "system", "user"]);
    expect(context.history[1]?.text).toBe("Start state Orientation");
  });
});

describe("the tape: recall and determinism", () => {
  it("renders a recall as an action + observation under the state's plan (a node, not transient)", () => {
    const state = fold([
      request("do it", 0),
      ...moved("m1", "orientation", "green", 1),
      {
        type: "add_node",
        node: workNode("a1", "action", "recall { id: obs:5 }", 3, {
          command: "recall { id: obs:5 }",
          call: { name: "recall", args: { id: "obs:5" } },
        }),
      },
      observation("o1", 4, { output: "the stored body" }, "recall"),
      result("e1", "a1", "o1"),
      ...plan("p1", "m1", ["i1"], 5),
      ...item("i1", 6, ["a1"]),
    ]);
    const context = project(focused(state));
    expect(roles(context.history)).toEqual(["user", "system", "system", "user", "assistant", "tool"]);
    expect(context.history[4]?.call).toEqual({ id: "a1", name: "recall", args: { id: "obs:5" } });
    expect(context.history[5]?.text).toBe("[o1] the stored body");
  });

  it("is deterministic: same events, same tape", () => {
    const events = parentEvents();
    expect(JSON.stringify(project(focused(fold(events))))).toBe(JSON.stringify(project(focused(fold(events)))));
  });
});

function parentEvents(): Event[] {
  return [
    request("do it", 0),
    ...moved("m1", "orientation", "green", 1),
    action("a1", "make test", 3),
    observation("o1", 4, { command: "make test", exitCode: 0 }, "make test"),
    result("e1", "a1", "o1"),
    ...plan("p1", "m1", ["i1"], 5),
    ...item("i1", 6, ["a1"]),
  ];
}
