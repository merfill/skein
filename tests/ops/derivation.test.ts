import { afterEach, describe, expect, it } from "vitest";

import type { Event } from "../../src/ir/events";
import { actionExecuted, fold, hasStopped, witnessOf } from "../../src/ir/graph";
import { cleanupWorkspaces, request } from "./helpers";

afterEach(cleanupWorkspaces);

function goalNode(id: string, what: string, seq: number): Event {
  return {
    type: "add_node",
    node: { id, space: "work", kind: "goal", label: what, payload: { what }, seq },
  };
}

describe("derived predicates", () => {
  it("DER-ACT-1 marks an action executed once it produces a result", () => {
    const produced: Event[] = [
      request(),
      { type: "add_node", node: { id: "a1", space: "work", kind: "action", label: "read", seq: 1 } },
      { type: "add_node", node: { id: "o1", space: "work", kind: "observation", label: "body", seq: 2 } },
      {
        type: "add_edge",
        edge: {
          id: "e1",
          from: "a1",
          to: "o1",
          kind: "result",
          provenance: { kind: "read", ref: "file:x", version: "v" },
        },
      },
    ];
    expect(actionExecuted(fold(produced), "a1")).toBe(true);
  });

  it("DER-GOAL-1 a goal is closed iff it has a stop relation", () => {
    const base: Event[] = [request(), goalNode("g1", "fix it", 1)];
    expect(hasStopped(fold(base), "g1")).toBe(false);
    const stopped: Event[] = [
      ...base,
      { type: "add_node", node: { id: "s1", space: "work", kind: "stop", label: "done", seq: 2 } },
      {
        type: "add_edge",
        edge: { id: "e1", from: "g1", to: "s1", kind: "stop", provenance: { kind: "llm" } },
      },
    ];
    expect(hasStopped(fold(stopped), "g1")).toBe(true);
  });

  it("DER-STALE-1 records a run's witness (the basis for staleness)", () => {
    const events: Event[] = [
      request(),
      goalNode("g1", "fix it", 1),
      {
        type: "add_node",
        node: { id: "f:src/x", space: "artifact", kind: "file", label: "src/x", seq: 2 },
      },
      {
        type: "add_node",
        node: {
          id: "obs:3",
          space: "work",
          kind: "observation",
          label: "make test",
          payload: {
            command: "make test",
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
