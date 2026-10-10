import { afterEach, describe, expect, it } from "vitest";

import type { Event } from "../../src/ir/events";
import {
  actionSuperseded,
  childrenOf,
  currentFocus,
  fold,
  goalOf,
  lastChild,
  planOf,
} from "../../src/ir/graph";
import { currentGoalId, cursorOf, focusEvents, itemFulfilled } from "../../src/ir/traversal";
import { project } from "../../src/ir/project";
import {
  DEFAULT_FILES,
  cleanupWorkspaces,
  exec,
  interpretation,
  makeWorkspace,
  request,
  run,
} from "./helpers";

afterEach(cleanupWorkspaces);

function goalNode(id: string, what: string, seq: number): Event {
  return { type: "add_node", node: { id, space: "work", kind: "goal", label: what, payload: { what }, seq } };
}

describe("traversal and containers", () => {
  it("TR-1 the focus is the branch top, else the root", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const empty = fold([request()]);
    expect(currentFocus(empty)).toBe("r1");
    const opened = exec(interpretation("do it"), [request()], ws);
    expect(currentFocus(opened.state)).toBe(currentGoalId(opened.state));
    expect(currentGoalId(opened.state)).not.toBe("r1");
  });

  it("TR-2 focusEvents descends into the request's goal", () => {
    const events: Event[] = [
      request(),
      goalNode("g1", "try", 2),
      { type: "add_edge", edge: { id: "e1", from: "r1", to: "g1", kind: "goal", provenance: { kind: "llm" } } },
    ];
    const drift = focusEvents(fold(events));
    expect(drift).toEqual([{ type: "descend", node: "g1" }]);
  });

  it("TR-3 focusEvents returns out of a stopped top", () => {
    const events: Event[] = [
      request(),
      goalNode("g1", "done", 1),
      { type: "add_node", node: { id: "s1", space: "work", kind: "stop", label: "done", seq: 2 } },
      { type: "add_edge", edge: { id: "es", from: "g1", to: "s1", kind: "stop", provenance: { kind: "llm" } } },
      { type: "descend", node: "g1" },
    ];
    expect(focusEvents(fold(events))).toEqual([{ type: "return" }]);
  });

  it("TR-4 trims the branch under a stopped ancestor, not only at a stopped top", () => {
    const events: Event[] = [
      request(),
      goalNode("g1", "stopped ancestor", 1),
      goalNode("g2", "open child", 3),
      { type: "add_node", node: { id: "s1", space: "work", kind: "stop", label: "done", seq: 2 } },
      { type: "add_edge", edge: { id: "es", from: "g1", to: "s1", kind: "stop", provenance: { kind: "llm" } } },
      { type: "descend", node: "g1" },
      { type: "descend", node: "g2" },
    ];
    // Both the open child (under the stopped ancestor) and the stopped ancestor return.
    expect(focusEvents(fold(events))).toEqual([{ type: "return" }, { type: "return" }]);
  });

  it("TR-5 chooses the container by node: request -> goal, goal -> plan", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = exec(interpretation("do it"), [request()], ws);
    const goal = currentGoalId(opened.state)!;
    expect(goalOf(opened.state, "r1")).toBe(goal);
    expect(planOf(opened.state, goal)).toBeDefined();
  });

  it("TR-6 tracks item order and the cursor over items", () => {
    const events: Event[] = [
      request(),
      goalNode("g", "parent", 1),
      { type: "add_node", node: { id: "p", space: "work", kind: "plan", label: "plan", seq: 2 } },
      { type: "add_node", node: { id: "i1", space: "work", kind: "item", label: "step one", seq: 3 } },
      { type: "add_node", node: { id: "i2", space: "work", kind: "item", label: "step two", seq: 4 } },
      { type: "add_node", node: { id: "a1", space: "work", kind: "action", label: "make test", payload: { command: "make test" }, seq: 5 } },
      { type: "add_node", node: { id: "a2", space: "work", kind: "action", label: "echo done", payload: { command: "echo done" }, seq: 6 } },
      { type: "add_edge", edge: { id: "e1", from: "g", to: "p", kind: "plan", provenance: { kind: "llm" } } },
      { type: "add_edge", edge: { id: "e2", from: "p", to: "i1", kind: "items", provenance: { kind: "llm" } } },
      { type: "add_edge", edge: { id: "e3", from: "p", to: "i2", kind: "items", provenance: { kind: "llm" } } },
      { type: "add_edge", edge: { id: "e4", from: "i1", to: "a1", kind: "alts", provenance: { kind: "llm" } } },
      { type: "add_edge", edge: { id: "e5", from: "i2", to: "a2", kind: "alts", provenance: { kind: "llm" } } },
    ];
    const state = fold(events);
    expect(childrenOf(state, "p")).toEqual(["i1", "i2"]);
    expect(cursorOf(state, "g")).toBe(0);

    // Executing the first item's current action advances the cursor.
    const executed = fold([
      ...events,
      { type: "add_node", node: { id: "o1", space: "work", kind: "observation", label: "make test", payload: { command: "make test", exitCode: 0 }, seq: 7 } },
      { type: "add_edge", edge: { id: "e6", from: "a1", to: "o1", kind: "result", provenance: { kind: "llm" } } },
    ]);
    expect(itemFulfilled(executed, "i1")).toBe(true);
    expect(cursorOf(executed, "g")).toBe(1);
  });

  it("TR-6 a step whose current sub-goal alternative is stopped is fulfilled", () => {
    const events: Event[] = [
      request(),
      goalNode("g", "parent", 1),
      { type: "add_node", node: { id: "p", space: "work", kind: "plan", label: "plan", seq: 2 } },
      { type: "add_node", node: { id: "i1", space: "work", kind: "item", label: "step", seq: 3 } },
      { type: "add_node", node: { id: "a1", space: "work", kind: "action", label: "make test", payload: { command: "make test" }, seq: 4 } },
      goalNode("sub", "risky stage", 5),
      { type: "add_edge", edge: { id: "e1", from: "g", to: "p", kind: "plan", provenance: { kind: "llm" } } },
      { type: "add_edge", edge: { id: "e2", from: "p", to: "i1", kind: "items", provenance: { kind: "llm" } } },
      { type: "add_edge", edge: { id: "e3", from: "i1", to: "a1", kind: "alts", provenance: { kind: "llm" } } },
      { type: "add_edge", edge: { id: "e4", from: "i1", to: "sub", kind: "alts", provenance: { kind: "llm" } } },
    ];
    // An open sub-goal leaves the step unfulfilled.
    const open = fold(events);
    expect(itemFulfilled(open, "i1")).toBe(false);
    expect(cursorOf(open, "g")).toBe(0);

    // Closing the sub-goal with stop fulfills the step.
    const stopped = fold([
      ...events,
      { type: "add_node", node: { id: "s1", space: "work", kind: "stop", label: "done", seq: 98 } },
      { type: "add_edge", edge: { id: "es", from: "sub", to: "s1", kind: "stop", provenance: { kind: "llm" } } },
    ]);
    expect(itemFulfilled(stopped, "i1")).toBe(true);
    expect(cursorOf(stopped, "g")).toBe(1);
  });

  // A goal whose current item is a command, unexecuted, so placement appends to it.
  function goalWithItem(command: string): Event[] {
    return [
      request(),
      goalNode("g1", "fix", 1),
      { type: "add_node", node: { id: "p", space: "work", kind: "plan", label: "plan", seq: 2 } },
      { type: "add_node", node: { id: "i1", space: "work", kind: "item", label: "step", seq: 3 } },
      { type: "add_node", node: { id: "a1", space: "work", kind: "action", label: command, payload: { command }, seq: 4 } },
      { type: "add_edge", edge: { id: "eg", from: "r1", to: "g1", kind: "goal", provenance: { kind: "llm" } } },
      { type: "add_edge", edge: { id: "e1", from: "g1", to: "p", kind: "plan", provenance: { kind: "llm" } } },
      { type: "add_edge", edge: { id: "e2", from: "p", to: "i1", kind: "items", provenance: { kind: "llm" } } },
      { type: "add_edge", edge: { id: "e3", from: "i1", to: "a1", kind: "alts", provenance: { kind: "llm" } } },
      { type: "descend", node: "g1" },
    ];
  }

  it("OP-AP-PLACE-1 places a command as a new alternative of the current item", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const ran = exec(run("echo other"), goalWithItem("echo hi"), ws);
    const alts = childrenOf(ran.state, "i1");
    expect(alts).toHaveLength(2); // the planned action + the executed one
    expect(alts[0]).toBe("a1");
    expect(actionSuperseded(ran.state, "a1")).toBe(true);
    // `echo` succeeded, so the item is fulfilled and the cursor advances.
    expect(itemFulfilled(ran.state, "i1")).toBe(true);
    expect(cursorOf(ran.state, "g1")).toBe(1);
  });

  it("OP-AP-PLACE-2 appends a new plan item when the plan is already carried out", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const first = exec(run("echo hi"), goalWithItem("echo hi"), ws);
    expect(cursorOf(first.state, "g1")).toBe(1);
    const next = exec(run("echo next"), first.events, ws);
    const plan = planOf(next.state, "g1")!;
    expect(childrenOf(next.state, plan)).toHaveLength(2);
  });

  it("TR-9 marks the alternative command in the tape with its previous attempt", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const ran = exec(run("echo other"), goalWithItem("echo hi"), ws);
    const context = project(ran.state);
    const call = context.history.find((message) => message.text.includes("echo other"));
    expect(call?.role).toBe("assistant");
    expect(call?.text).toContain("alternative to step");
    expect(call?.text).toContain("echo hi");
    expect(context.history.some((message) => message.role === "tool")).toBe(true);
  });
});
