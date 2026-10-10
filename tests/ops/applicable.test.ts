import { afterEach, describe, expect, it } from "vitest";

import type { Event } from "../../src/ir/events";
import { fold } from "../../src/ir/graph";
import { applicable } from "../../src/ir/traversal";
import {
  classification,
  cleanupWorkspaces,
  exec,
  interpretation,
  makeWorkspace,
  request,
} from "./helpers";

afterEach(cleanupWorkspaces);

function goalNode(id: string, what: string, seq: number): Event {
  return {
    type: "add_node",
    node: { id, space: "work", kind: "goal", label: what, payload: { what }, seq },
  };
}

// A request already interpreted: it has a goal via a `goal` relation.
function addressedRequest(): Event[] {
  return [
    request(),
    goalNode("g1", "approach", 1),
    {
      type: "add_edge",
      edge: { id: "eg", from: "r1", to: "g1", kind: "goal", provenance: { kind: "llm" } },
    },
  ];
}

describe("frontier (applicable)", () => {
  it("TR-8 a fresh request offers create_goal and decline (OP-DC-1)", () => {
    const open = applicable(fold([request()]), "r1");
    expect(open).toEqual({
      goalId: "r1",
      createGoal: true,
      apply: false,
      return: false,
      stop: false,
      decline: true,
    });
  });

  it("TR-8 once interpreted, the request offers nothing (the goal is the focus)", () => {
    const done = applicable(fold(addressedRequest()), "r1");
    expect(done).toEqual({
      goalId: "r1",
      createGoal: false,
      apply: false,
      return: false,
      stop: false,
      decline: false,
    });
  });

  it("REF-INTERPRETED refuses a second interpretation of the request", () => {
    const events = addressedRequest();
    expect(classification(interpretation("another"), events).reason).toContain("interpreted");
  });

  it("TR-8 an open goal offers apply, create_goal and stop (no criterion gate)", () => {
    const { ws } = makeWorkspace({});
    const { events } = exec(interpretation("fix", "true"), [request()], ws);
    const state = fold(events);
    const goal = state.branch[state.branch.length - 1]!;
    expect(applicable(state, goal)).toMatchObject({
      createGoal: true,
      apply: true,
      stop: true,
      decline: false,
    });
  });
});
