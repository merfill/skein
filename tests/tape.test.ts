import { describe, expect, it } from "vitest";

import type { Event } from "../src/ir/events";
import { fold, type State } from "../src/ir/graph";
import { ISLANDS } from "../src/ir/islands";
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
// (docs/en/ir.md §7). These tests pin every construction situation: roles and order
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

function turns(id: string, moveId: string, actionIds: string[], seq: number): Event[] {
  return [
    { type: "add_node", node: workNode(id, "turns", `turns for ${moveId}`, seq) },
    { type: "add_edge", edge: edge(`ht:${id}`, moveId, id, "turns", llm) },
    ...actionIds.map(
      (actionId, index): Event => ({
        type: "add_edge",
        edge: edge(`tr:${id}:${index}`, id, actionId, "turn", llm),
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
      ...moved("m1", "patch", "green", 1),
      action("a1", "make test", 3),
      observation("o1", 4, { command: "make test", exitCode: 1, output: "boom" }, "make test"),
      result("eo", "a1", "o1"),
      ...turns("p1", "m1", ["a1"], 5),
    ]);
    const context = project(focused(state));
    expect(context.situation).toBe("working");
    // The request leads the tape; then the state's `Start state` marker and each plan item as
    // a native call + tool result. The goal/criterion/plan are appended by `buildMessages`.
    expect(roles(context.history)).toEqual([
      "user",
      "system",
      "assistant",
      "tool",
    ]);
    expect(context.history[1]?.text).toBe("Start state Patch");
    expect(context.what).toBe("green");
    expect(context.history[2]?.text).toBe("[a1] make test");
    expect(context.history[3]?.text).toBe("[o1] exit 1\nboom");
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
      ...moved("m1", "patch", "green", 1),
      action("a1", "make test", 3),
      observation("o1", 4, { command: "make test", exitCode: 0 }, "make test"),
      result("e1", "a1", "o1"),
      action("a2", "read src/a.ts", 5),
      observation("o2", 6, { ref: "file:src/a.ts", version: "v1", output: "source", start: 1, end: 1, total: 1 }, "read src/a.ts"),
      result("e2", "a2", "o2"),
      ...turns("p1", "m1", ["a1", "a2"], 7),
    ]);
    const context = project(focused(state));
    expect(roles(context.history)).toEqual([
      "user",
      "system",
      "assistant",
      "tool",
      "assistant",
      "tool",
    ]);
    expect(context.history[5]?.text).toBe("[o2] src/a.ts lines 1-1 of 1\nsource");
  });

  it("renders an edit's mutate (no observation) as a mutated file", () => {
    const state = fold([
      request("do it", 0),
      ...moved("m1", "patch", "green", 1),
      action("a1", "edit src/a.ts", 3),
      { type: "add_edge", edge: edge("em", "a1", "file:src/a.ts", "mutates", llm) },
      { type: "mutate", ref: "file:src/a.ts", version: "v2", actionId: "a1" },
      ...turns("p1", "m1", ["a1"], 4),
    ]);
    const context = project(focused(state));
    expect(context.history[3]?.text).toBe("[a1] mutated src/a.ts");
  });

  it("renders a refused command as an observation with the reason", () => {
    const state = fold([
      request("do it", 0),
      ...moved("m1", "patch", "green", 1),
      action("a1", "read src/a.ts", 3),
      observation("o1", 4, { failed: true, refused: true, output: "repeated_action: o0 already has it" }),
      result("e1", "a1", "o1"),
      ...turns("p1", "m1", ["a1"], 5),
    ]);
    const context = project(focused(state));
    expect(context.history[3]?.text).toBe("[o1] repeated_action: o0 already has it");
  });

  it("renders each turn in order without an alternative marker", () => {
    const state = fold([
      request("do it", 0),
      ...moved("m1", "patch", "green", 1),
      action("a1", "run one", 3),
      observation("o1", 4, { command: "run one", exitCode: 1 }, "run one"),
      result("e1", "a1", "o1"),
      action("a2", "run two", 5),
      observation("o2", 6, { command: "run two", exitCode: 0 }, "run two"),
      result("e2", "a2", "o2"),
      ...turns("p1", "m1", ["a1", "a2"], 7),
    ]);
    const context = project(focused(state));
    const assistant = context.history
      .filter((message) => message.role === "assistant")
      .map((message) => message.text);
    expect(assistant).toEqual(["[a1] run one", "[a2] run two"]);
    expect(context.history.map((message) => message.text).join("\n")).not.toContain("alternative");
  });
});

describe("the tape: the compaction of a finished state", () => {
  it("a finished state leaves one line, carried by the next move", () => {
    const state = fold([
      request("do it", 0),
      ...moved("m1", "patch", "find it", 1),
      action("a1", "grep x", 3),
      observation("o1", 4, { ref: "file:src/a.ts", version: "v1", output: "FOUND-BODY" }, "grep x"),
      result("e1", "a1", "o1"),
      ...turns("p1", "m1", ["a1"], 5),
      ...stopNode("s1", "named the line", 7, "m1"),
      ...moved("m2", "patch", "fix it", 8),
    ]);
    const context = project(focused(state));
    const body = texts(context.history);
    // The finished state's command has left the tape...
    expect(body).not.toContain("FOUND-BODY");
    // ...only its closure marker remains, in the finished state's triple.
    expect(body).toContain("Finish state Patch — named the line");
    expect(context.situation).toBe("working");
  });
});

describe("the tape: edge cases", () => {
  it("a stopped state without a successor leaves only the move and its closure", () => {
    const state = fold([
      request("do it", 0),
      ...moved("m1", "patch", "gone", 1),
      action("a1", "make test", 3),
      observation("o1", 4, { command: "make test", exitCode: 0 }, "make test"),
      result("e1", "a1", "o1"),
      ...turns("p1", "m1", ["a1"], 5),
      ...stopNode("s1", "all green", 7, "m1"),
    ]);
    const context = project(focused(state));
    expect(roles(context.history)).toEqual(["user", "system", "system"]);
    expect(context.situation).toBe("transition");
    expect(texts(context.history)).not.toContain("[a1] make test");
    expect(texts(context.history)).toContain("Finish state Patch — all green");
  });

  it("a declared state without a plan renders move + confirmation", () => {
    const state = fold([
      request("do it", 0),
      ...moved("m1", "patch", "map", 1),
    ]);
    const context = project(focused(state));
    expect(context.situation).toBe("working");
    expect(roles(context.history)).toEqual(["user", "system"]);
    expect(context.history[1]?.text).toBe("Start state Patch");
  });
});

describe("the tape: recall and determinism", () => {
  it("renders a recall as an action + observation under the state's plan (a node, not transient)", () => {
    const state = fold([
      request("do it", 0),
      ...moved("m1", "patch", "green", 1),
      {
        type: "add_node",
        node: workNode("a1", "action", "recall { id: obs:5 }", 3, {
          command: "recall { id: obs:5 }",
          call: { name: "recall", args: { id: "obs:5" } },
        }),
      },
      observation("o1", 4, { output: "the stored body" }, "recall"),
      result("e1", "a1", "o1"),
      ...turns("p1", "m1", ["a1"], 5),
    ]);
    const context = project(focused(state));
    expect(roles(context.history)).toEqual([
      "user",
      "system",
      "assistant",
      "tool",
    ]);
    expect(context.history[2]?.call).toEqual({ id: "a1", name: "recall", args: { id: "obs:5" } });
    expect(context.history[3]?.text).toBe("[o1] the stored body");
  });

  it("is deterministic: same events, same tape", () => {
    const events = parentEvents();
    expect(JSON.stringify(project(focused(fold(events))))).toBe(JSON.stringify(project(focused(fold(events)))));
  });
});

function parentEvents(): Event[] {
  return [
    request("do it", 0),
    ...moved("m1", "patch", "green", 1),
    action("a1", "make test", 3),
    observation("o1", 4, { command: "make test", exitCode: 0 }, "make test"),
    result("e1", "a1", "o1"),
    ...turns("p1", "m1", ["a1"], 5),
  ];
}
