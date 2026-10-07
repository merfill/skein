import { afterEach, describe, expect, it } from "vitest";

import type { Event } from "../../src/ir/events";
import { alternativesOf, childrenOf, currentFocus, fold, latestChosen, planOf, predicateOf } from "../../src/ir/graph";
import { currentGoalId, cursorOf, focusEvents, itemFulfilled, itemSucceeded } from "../../src/ir/traversal";
import type { DoneWhen } from "../../src/ir/types";
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

const SUBJECTIVE: DoneWhen = { kind: "arbiter", text: "done" };
const OBJECTIVE: DoneWhen = { kind: "objective", command: "make test" };

function goalNode(id: string, what: string, done_when: DoneWhen, seq: number): Event {
  return { type: "add_node", node: { id, space: "work", kind: "goal", label: what, payload: { what, done_when }, seq } };
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

  it("TR-2 focusEvents descends into the chosen interpretation", () => {
    const events: Event[] = [
      request(),
      { type: "add_node", node: { id: "alt", space: "work", kind: "alternatives", label: "opts", seq: 1 } },
      goalNode("g1", "try", SUBJECTIVE, 2),
      { type: "add_edge", edge: { id: "e1", from: "r1", to: "alt", kind: "has_alternatives", provenance: { kind: "llm" } } },
      { type: "add_edge", edge: { id: "e2", from: "alt", to: "g1", kind: "item", provenance: { kind: "llm" } } },
      { type: "add_edge", edge: { id: "e3", from: "alt", to: "g1", kind: "chosen", provenance: { kind: "llm" } } },
    ];
    const drift = focusEvents(fold(events));
    expect(drift).toEqual([{ type: "descend", node: "g1" }]);
  });

  it("TR-3 focusEvents returns out of a closed top", () => {
    const events: Event[] = [
      request(),
      goalNode("g1", "done", SUBJECTIVE, 1),
      { type: "record_check", id: "chk:2", command: "user acceptance", verdict: "pass", output: "", actor: "user", targets: ["g1"] },
      { type: "descend", node: "g1" },
    ];
    expect(predicateOf(fold(events), "g1")).toBe("achieved");
    expect(focusEvents(fold(events))).toEqual([{ type: "return" }]);
  });

  it("TR-4 trims the branch under a closed ancestor, not only at a closed top", () => {
    const events: Event[] = [
      request(),
      goalNode("g1", "refuted", OBJECTIVE, 1),
      goalNode("g2", "open child", SUBJECTIVE, 3),
      { type: "record_check", command: "make test", verdict: "fail", output: "", targets: ["g1"] },
      { type: "descend", node: "g1" },
      { type: "descend", node: "g2" },
    ];
    const state = fold(events);
    expect(predicateOf(state, "g1")).toBe("refuted");
    expect(predicateOf(state, "g2")).toBe("open");
    // Both the open child (under the refuted ancestor) and the refuted ancestor return.
    expect(focusEvents(state)).toEqual([{ type: "return" }, { type: "return" }]);
  });

  it("TR-5 chooses the container by node: goal -> plan, request/refuted -> alternatives", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = exec(interpretation("do it"), [request()], ws);
    const goal = currentGoalId(opened.state)!;
    expect(alternativesOf(opened.state, "r1")).toBeDefined();

    const staged = exec(interpretation("stage"), opened.events, ws);
    expect(planOf(staged.state, goal)).toBeDefined();
    expect(alternativesOf(staged.state, goal)).toBeUndefined();
  });

  it("TR-6 tracks item order, the cursor, and fulfilled vs succeeded", () => {
    const events: Event[] = [
      request(),
      goalNode("g", "parent", SUBJECTIVE, 1),
      { type: "add_node", node: { id: "p", space: "work", kind: "plan", label: "plan", seq: 2 } },
      goalNode("it", "A", SUBJECTIVE, 3),
      { type: "add_node", node: { id: "a1", space: "work", kind: "action", label: "make test", payload: { command: "make test" }, seq: 4 } },
      { type: "add_edge", edge: { id: "e1", from: "g", to: "p", kind: "has_plan", provenance: { kind: "llm" } } },
      { type: "add_edge", edge: { id: "e2", from: "p", to: "it", kind: "item", provenance: { kind: "llm" } } },
      { type: "add_edge", edge: { id: "e3", from: "p", to: "a1", kind: "item", provenance: { kind: "llm" } } },
    ];
    const state = fold(events);
    const items = childrenOf(state, "p");
    expect(items).toHaveLength(2);
    expect(cursorOf(state, "g")).toBe(0);

    // Close the goal item by external acceptance -> cursor advances to the action item.
    const closed = fold([
      ...events,
      { type: "record_check", id: "chk:9", command: "user acceptance", verdict: "pass", output: "", actor: "user", targets: ["it"] },
    ]);
    expect(itemFulfilled(closed, "it")).toBe(true);
    expect(itemSucceeded(closed, "it")).toBe(true);
    expect(cursorOf(closed, "g")).toBe(1);
  });

  it("TR-6 a refuted item is fulfilled (resolves the cursor) but not succeeded", () => {
    const events: Event[] = [
      request(),
      goalNode("g", "parent", SUBJECTIVE, 1),
      { type: "add_node", node: { id: "p", space: "work", kind: "plan", label: "plan", seq: 2 } },
      goalNode("it", "risky stage", OBJECTIVE, 3),
      { type: "record_check", command: "make test", verdict: "fail", output: "", targets: ["it"] },
      { type: "add_edge", edge: { id: "e1", from: "g", to: "p", kind: "has_plan", provenance: { kind: "llm" } } },
      { type: "add_edge", edge: { id: "e2", from: "p", to: "it", kind: "item", provenance: { kind: "llm" } } },
    ];
    const state = fold(events);
    expect(itemFulfilled(state, "it")).toBe(true);
    expect(itemSucceeded(state, "it")).toBe(false);
  });

  // A planned action item is executed on the model's own turn (no auto-run). These two
  // tests build the goal + plan directly, with an unexecuted item, to exercise
  // `ensureAction`'s reuse/branching on its own.
  function goalWithActionItem(command: string): Event[] {
    return [
      request(),
      goalNode("g1", "fix", OBJECTIVE, 1),
      { type: "add_node", node: { id: "p", space: "work", kind: "plan", label: "plan", seq: 2 } },
      { type: "add_edge", edge: { id: "e1", from: "g1", to: "p", kind: "has_plan", provenance: { kind: "llm" } } },
      { type: "add_node", node: { id: "a1", space: "work", kind: "action", label: command, payload: { command }, seq: 3 } },
      { type: "add_edge", edge: { id: "e2", from: "p", to: "a1", kind: "item", provenance: { kind: "llm" } } },
      { type: "descend", node: "g1" },
    ];
  }

  it("TR-7 reuses an unexecuted matching action item", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const ran = exec(run("echo hi"), goalWithActionItem("echo hi"), ws);
    const actions = [...ran.state.nodes.values()].filter((n) => n.kind === "action");
    expect(actions).toHaveLength(1); // reused, not duplicated
    expect(actions[0]!.id).toBe("a1");
  });

  it("TR-7 branches a bypassed item: the new action becomes the chosen variant", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    // A different command does not match the planned item, so the logos branches it.
    const ran = exec(run("echo other"), goalWithActionItem("echo hi"), ws);
    const alt = alternativesOf(ran.state, "a1")!;
    expect(alt).toBeDefined();
    const chosen = latestChosen(ran.state, alt)!;
    expect(chosen).not.toBe("a1");
    expect(predicateOf(ran.state, "a1")).toBe("abandoned");
    expect(itemFulfilled(ran.state, "a1")).toBe(true);
    expect(cursorOf(ran.state, "g1")).toBe(1);
  });
});
