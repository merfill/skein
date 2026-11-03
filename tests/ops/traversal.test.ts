import { afterEach, describe, expect, it } from "vitest";

import type { Event } from "../../src/ir/events";
import { childrenOf, currentFocus, fold, turnsOf } from "../../src/ir/graph";
import { currentMove, focusEvents, applicable } from "../../src/ir/traversal";
import { project, situationOf } from "../../src/ir/project";
import { classify } from "../../src/loop/classify";
import {
  DEFAULT_FILES,
  cleanupWorkspaces,
  exec,
  execAll,
  makeWorkspace,
  request,
  run,
  withGoal,
} from "./helpers";

afterEach(cleanupWorkspaces);

function moveNode(id: string, state: string, seq: number): Event {
  return {
    type: "add_node",
    node: {
      id,
      space: "work",
      kind: "move",
      label: state,
      payload: { state, what: state },
      seq,
    },
  };
}

const edge = (id: string, from: string, to: string, kind: string): Event => ({
  type: "add_edge",
  edge: { id, from, to, kind: kind as never, provenance: { kind: "llm" } },
});

describe("traversal and containers", () => {
  it("TR-1 the focus is the branch top, else the root", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const empty = fold([request()]);
    expect(currentFocus(empty)).toBe("r1");
    const opened = execAll(withGoal("do it"), [request()], ws);
    expect(currentFocus(opened.state)).toBe(currentMove(opened.state));
    expect(currentFocus(opened.state)).not.toBe("r1");
  });

  it("TR-2 focusEvents descends into the current state", () => {
    const events: Event[] = [
      request(),
      moveNode("m1", "orientation", 1),
      edge("em", "r1", "m1", "move"),
    ];
    expect(focusEvents(fold(events))).toEqual([{ type: "descend", node: "m1" }]);
  });

  it("TR-3 a finished state keeps the focus on its move", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = execAll(withGoal("do it", "true"), [request()], ws);
    const stopped = exec({ operator: "stop", why: "done" }, opened.events, ws);
    const move = currentMove(stopped.state)!;
    expect(currentFocus(stopped.state)).toBe(move);
    // focusEvents is a no-op: the stack already sits on the state.
    expect(focusEvents(stopped.state)).toEqual([]);
    expect(situationOf(stopped.state)).toBe("transition");
  });

  // The suspected engine bug: after `stop` the focus must sit on the `move` (the transition),
  // and only `move` is admissible — `apply` must be refused.
  it("TR-3b after stop the focus is the move (transition), not a closed goal", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = execAll(withGoal("do it", "true"), [request()], ws);
    const stopped = exec({ operator: "stop", why: "done" }, opened.events, ws);

    // Apply the loop's deterministic focus normalization (projectNode folds `focusEvents`).
    const focused = fold(focusEvents(stopped.state), stopped.state);
    const moveId = currentMove(focused)!;
    expect(moveId.startsWith("w:move:")).toBe(true);
    expect(currentFocus(focused)).toBe(moveId);
    expect(focused.nodes.get(moveId)?.kind).toBe("move");

    // The situation is the forced transition, and only `move` is admissible.
    expect(situationOf(focused)).toBe("transition");
    expect(applicable(focused, moveId)).toMatchObject({
      move: true,
      apply: false,
      stop: false,
    });
    // apply at the finished state is refused, naming `move`.
    expect(classify(run("ls"), focused).reason).toContain("no_state");
  });

  it("TR-4 flat states: the focus returns to the request and descends into the new state", () => {
    const events: Event[] = [
      request(),
      moveNode("m1", "localization", 1),
      { type: "add_node", node: { id: "s1", space: "work", kind: "stop", label: "done", seq: 2 } },
      moveNode("m2", "patch", 3),
      edge("em", "r1", "m1", "move"),
      edge("es", "m1", "s1", "stop"),
      edge("em2", "r1", "m2", "move"),
      { type: "descend", node: "m1" },
    ];
    // The current state is m2; the focus leaves the finished state and descends into m2.
    expect(focusEvents(fold(events))).toEqual([
      { type: "return" },
      { type: "descend", node: "m2" },
    ]);
  });

  it("TR-5 chooses the container by node: request -> move, move -> turns", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = execAll(withGoal("do it", "true"), [request()], ws);
    const moveId = currentMove(opened.state)!;
    expect(turnsOf(opened.state, moveId)).toBeDefined();
  });

  it("TR-6 keeps turns in append order", () => {
    const events: Event[] = [
      request(),
      moveNode("m", "patch", 1),
      { type: "add_node", node: { id: "p", space: "work", kind: "turns", label: "turns", seq: 2 } },
      { type: "add_node", node: { id: "a1", space: "work", kind: "action", label: "make test", payload: { command: "make test" }, seq: 3 } },
      { type: "add_node", node: { id: "a2", space: "work", kind: "action", label: "echo done", payload: { command: "echo done" }, seq: 4 } },
      edge("em", "r1", "m", "move"),
      edge("e1", "m", "p", "turns"),
      edge("e2", "p", "a1", "turn"),
      edge("e3", "p", "a2", "turn"),
    ];
    const state = fold(events);
    expect(childrenOf(state, "p")).toEqual(["a1", "a2"]);
  });

  // A state whose turns already hold one command.
  function moveWithTurns(command: string): Event[] {
    return [
      request(),
      moveNode("m1", "patch", 1),
      { type: "add_node", node: { id: "p", space: "work", kind: "turns", label: "turns", seq: 2 } },
      { type: "add_node", node: { id: "a1", space: "work", kind: "action", label: command, payload: { command }, seq: 3 } },
      edge("em", "r1", "m1", "move"),
      edge("e1", "m1", "p", "turns"),
      edge("e2", "p", "a1", "turn"),
      { type: "descend", node: "m1" },
    ];
  }

  it("OP-AP-PLACE-1 appends the command as the next turn", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const ran = exec(run("echo other"), moveWithTurns("echo hi"), ws);
    const turns = turnsOf(ran.state, "m1")!;
    const actions = childrenOf(ran.state, turns);
    expect(actions).toHaveLength(2); // the planned turn + the executed one
    expect(actions[0]).toBe("a1");
  });

  it("OP-AP-PLACE-2 keeps appending after a carried-out turn", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const first = exec(run("echo hi"), moveWithTurns("echo hi"), ws);
    const next = exec(run("echo next"), first.events, ws);
    const turns = turnsOf(next.state, "m1")!;
    expect(childrenOf(next.state, turns)).toHaveLength(3);
  });

  it("TR-9 renders a command as its own native call/result pair", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const ran = exec(run("echo other"), moveWithTurns("echo hi"), ws);
    const context = project(ran.state);
    const call = context.history.find(
      (message) => message.call?.name === "bash" && (message.call.args as { command?: string }).command === "echo other",
    );
    expect(call?.role).toBe("assistant");
    expect(context.history.some((message) => message.role === "tool" && message.callId === call?.call?.id)).toBe(true);
  });
});
