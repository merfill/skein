import { afterEach, describe, expect, it } from "vitest";

import type { Event } from "../../src/ir/events";
import { actionExecuted, criterionFailed, criterionPass, fold, requestSettled, stateOf, unselectedVariant, witnessOf } from "../../src/ir/graph";
import {
  DEFAULT_FILES,
  check,
  cleanupWorkspaces,
  exec,
  interpretation,
  makeWorkspace,
  request,
} from "./helpers";

afterEach(cleanupWorkspaces);

function goalNode(id: string, what: string, done_when: string, seq: number): Event {
  return {
    type: "add_node",
    node: { id, space: "work", kind: "goal", label: what, payload: { what, done_when }, seq },
  };
}

function checkEvent(
  seq: number,
  targets: string[],
  verdict: "pass" | "fail" | "inconclusive",
  command = "make test",
): Event {
  const target = targets[0] as string;
  return {
    type: "add_node",
    node: {
      id: `obs:${seq}`,
      space: "work",
      kind: "observation",
      label: command,
      payload: {
        command,
        target,
        ...(verdict === "inconclusive" ? {} : { exitCode: verdict === "pass" ? 0 : 1 }),
      },
      seq,
    },
  };
}

const ARBITER = "done";
const OBJECTIVE = "make test";

describe("derived predicates", () => {
  it("DER-REQ-1 marks the request addressed only when the chosen interpretation settles", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = exec(interpretation("fix the bug", "true"), [request()], ws);
    const goalId = [...opened.state.nodes.keys()].find((id) => id.startsWith("w:goal:"));
    expect(goalId).toBeDefined();
    expect(stateOf(opened.state, "r1")).toBe("open");

    const closed = exec(check(goalId!), opened.events, ws);
    expect(criterionPass(closed.state, goalId!)).toBe(true);
    expect(requestSettled(closed.state, "r1")).toBe(true);
  });

  it("DER-GOAL-1 reaches achieved via a passing check with no assumptions", () => {
    const events: Event[] = [request(), goalNode("g1", "fix it", OBJECTIVE, 1), checkEvent(2, ["g1"], "pass")];
    expect(criterionPass(fold(events), "g1")).toBe(true);
  });

  it("DER-GOAL-3 refutes on a failing check", () => {
    const events: Event[] = [request(), goalNode("g1", "fix it", OBJECTIVE, 1), checkEvent(2, ["g1"], "fail")];
    expect(criterionFailed(fold(events), "g1")).toBe(true);
  });

  it("DER-GOAL-4 stays open on an inconclusive check", () => {
    const events: Event[] = [request(), goalNode("g1", "fix it", OBJECTIVE, 1), checkEvent(2, ["g1"], "inconclusive")];
    expect(stateOf(fold(events), "g1")).toBe("open");
  });

  it("DER-GOAL-5 abandons an unselected variant once a sibling is chosen", () => {
    const events: Event[] = [
      request(),
      { type: "add_node", node: { id: "alt", space: "work", kind: "alternatives", label: "opts", seq: 1 } },
      goalNode("g1", "first try", ARBITER, 2),
      goalNode("g2", "second try", ARBITER, 3),
      { type: "add_edge", edge: { id: "e1", from: "r1", to: "alt", kind: "has_alternatives", provenance: { kind: "llm" } } },
      { type: "add_edge", edge: { id: "e2", from: "alt", to: "g1", kind: "item", provenance: { kind: "llm" } } },
      { type: "add_edge", edge: { id: "e3", from: "alt", to: "g2", kind: "item", provenance: { kind: "llm" } } },
    ];
    expect(unselectedVariant(fold(events), "g1")).toBe(true);
    expect(stateOf(fold(events), "g2")).toBe("open");
  });

  it("DER-GOAL-6 lets the newer check win across checks", () => {
    const base: Event[] = [request(), goalNode("g1", "fix it", OBJECTIVE, 1)];
    const failThenPass: Event[] = [...base, checkEvent(2, ["g1"], "fail"), checkEvent(3, ["g1"], "pass")];
    // the pass (seq 3) is newer than the fail (seq 2) -> achieved.
    expect(criterionPass(fold(failThenPass), "g1")).toBe(true);

    const passThenFail: Event[] = [...base, checkEvent(2, ["g1"], "pass"), checkEvent(3, ["g1"], "fail")];
    // the fail (seq 3) is newer than the pass (seq 2) -> refuted.
    expect(criterionFailed(fold(passThenFail), "g1")).toBe(true);
  });

  it("DER-ACT-1 marks an action executed once it produces or mutates", () => {
    const produced: Event[] = [
      request(),
      { type: "add_node", node: { id: "a1", space: "work", kind: "action", label: "read", seq: 1 } },
      { type: "add_node", node: { id: "o1", space: "work", kind: "observation", label: "body", seq: 2 } },
      { type: "add_edge", edge: { id: "e1", from: "a1", to: "o1", kind: "produces", provenance: { kind: "read", ref: "file:x", version: "v" } } },
    ];
    expect(actionExecuted(fold(produced), "a1")).toBe(true);
  });

  it("DER-ACT-2 abandons an action superseded by a chosen sibling", () => {
    const events: Event[] = [
      request(),
      { type: "add_node", node: { id: "a1", space: "work", kind: "action", label: "old", seq: 1 } },
      { type: "add_node", node: { id: "alt", space: "work", kind: "alternatives", label: "opts", seq: 2 } },
      { type: "add_node", node: { id: "a2", space: "work", kind: "action", label: "new", seq: 3 } },
      { type: "add_edge", edge: { id: "e1", from: "a1", to: "alt", kind: "has_alternatives", provenance: { kind: "llm" } } },
      { type: "add_edge", edge: { id: "e2", from: "alt", to: "a1", kind: "item", provenance: { kind: "llm" } } },
      { type: "add_edge", edge: { id: "e3", from: "alt", to: "a2", kind: "item", provenance: { kind: "llm" } } },
    ];
    expect(unselectedVariant(fold(events), "a1")).toBe(true);
    expect(stateOf(fold(events), "a2")).toBe("open");
  });

  it("DER-STALE-1 records a run's witness (the basis for staleness)", () => {
    const events: Event[] = [
      request(),
      goalNode("g1", "fix it", OBJECTIVE, 1),
      { type: "add_node", node: { id: "f:src/x", space: "artifact", kind: "file", label: "src/x", seq: 2 } },
      {
        type: "add_node",
        node: {
          id: "obs:3",
          space: "work",
          kind: "observation",
          label: "make test",
          payload: {
            command: "make test",
            target: "g1",
            exitCode: 0,
            witness: [{ ref: "file:src/x", version: "v1" }],
          },
          seq: 3,
        },
      },
      { type: "mutate", ref: "file:src/x", version: "v2", actionId: "a1" },
    ];
    expect(witnessOf(fold(events), "obs:3")).toEqual([{ ref: "file:src/x", version: "v1" }]);
  });
});


