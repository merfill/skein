import { describe, expect, it } from "vitest";

import { eventSchema, type Event } from "../src/ir/events";
import { emptyState, fold } from "../src/ir/graph";
import { project } from "../src/ir/project";
import type {
  ArtifactKind,
  Edge,
  EdgeKind,
  Node,
  NodeKind,
  Provenance,
  Status,
} from "../src/ir/types";

function workNode(id: string, kind: NodeKind, label: string, seq: number): Node {
  return { id, space: "work", kind, label, seq };
}

function artifactNode(id: string, kind: ArtifactKind, label: string, seq: number): Node {
  return { id, space: "artifact", kind, label, seq };
}

function edge(
  id: string,
  from: string,
  to: string,
  kind: EdgeKind,
  provenance: Provenance,
  status: Status,
): Edge {
  return { id, from, to, kind, provenance, status };
}

describe("events", () => {
  it("accepts a valid event", () => {
    const event: Event = {
      type: "add_node",
      node: workNode("g1", "goal", "make test green", 0),
    };
    expect(eventSchema.safeParse(event).success).toBe(true);
  });

  it("rejects an unknown node kind", () => {
    const bad = {
      type: "add_node",
      node: { id: "x", space: "work", kind: "bogus", label: "x", seq: 0 },
    };
    expect(eventSchema.safeParse(bad).success).toBe(false);
  });
});

describe("fold", () => {
  const events: Event[] = [
    { type: "add_node", node: workNode("g1", "goal", "make test green", 0) },
    { type: "add_node", node: workNode("c1", "claim", "off-by-one in loop", 1) },
    {
      type: "add_node",
      node: artifactNode("file:src/a.ts", "file", "src/a.ts", 2),
    },
  ];

  it("is deterministic: same events, same state", () => {
    expect(fold(events)).toEqual(fold(events));
  });

  it("is pure: does not mutate the base state", () => {
    const base = emptyState();
    const next = fold(events, base);
    expect(base.nodes.size).toBe(0);
    expect(next.nodes.size).toBe(3);
  });

  it("assigns default statuses and records the goal", () => {
    const state = fold(events);
    expect(state.goalId).toBe("g1");
    expect(state.statuses.get("g1")).toBe("open");
    expect(state.statuses.get("c1")).toBe("open");
    expect(state.statuses.get("file:src/a.ts")).toBe("believed");
  });
});

describe("record_check", () => {
  const base: Event[] = [
    { type: "add_node", node: workNode("g1", "goal", "make test green", 0) },
    { type: "add_node", node: workNode("c1", "claim", "off-by-one in loop", 1) },
  ];

  it("does not verify a claim without a check", () => {
    const context = project(fold(base));
    expect(context.frontier.claims.map((node) => node.id)).toEqual(["c1"]);
  });

  it("verifies a claim on a passing check and drops it from the frontier", () => {
    const state = fold([
      ...base,
      {
        type: "record_check",
        command: "npm test",
        verdict: "pass",
        output: "ok",
        claimIds: ["c1"],
      },
    ]);
    expect(state.statuses.get("c1")).toBe("verified");
    expect(project(state).frontier.claims).toEqual([]);
  });

  it("refutes a claim on a failing check and reports it as one line", () => {
    const state = fold([
      ...base,
      {
        type: "record_check",
        command: "npm test",
        verdict: "fail",
        output: "boom",
        claimIds: ["c1"],
      },
    ]);
    expect(state.statuses.get("c1")).toBe("refuted");
    expect(project(state).frontier.rejected).toEqual(["c1: off-by-one in loop"]);
  });
});

describe("staleness by version", () => {
  const readFact = edge(
    "e1",
    "file:src/a.ts",
    "sym:src/a.ts#loop",
    "defines",
    { kind: "read", ref: "file:src/a.ts", version: "v1" },
    "believed",
  );

  const events: Event[] = [
    { type: "add_node", node: artifactNode("file:src/a.ts", "file", "src/a.ts", 0) },
    {
      type: "add_node",
      node: artifactNode("sym:src/a.ts#loop", "symbol", "loop", 1),
    },
    { type: "add_edge", edge: readFact },
  ];

  it("marks facts from an older version stale after a mutation", () => {
    const state = fold([
      ...events,
      { type: "mutate", ref: "file:src/a.ts", version: "v2", actionId: "a1" },
    ]);
    expect(state.edgeStatuses.get("e1")).toBe("stale");
    const context = project(state);
    expect(context.artifacts.find((item) => item.id === "file:src/a.ts")?.stale).toBe(
      true,
    );
  });

  it("keeps facts fresh when the version matches", () => {
    const state = fold([
      ...events,
      { type: "mutate", ref: "file:src/a.ts", version: "v1", actionId: "a1" },
    ]);
    expect(state.edgeStatuses.get("e1")).toBe("believed");
    expect(project(state).artifacts.every((item) => !item.stale)).toBe(true);
  });
});

describe("project", () => {
  it("indexes every node and slices the recent tail", () => {
    const state = fold([
      { type: "add_node", node: workNode("g1", "goal", "make test green", 0) },
      { type: "add_node", node: workNode("k1", "constraint", "do not edit tests", 1) },
      { type: "add_node", node: workNode("c1", "claim", "off-by-one", 2) },
      { type: "add_node", node: workNode("o1", "observation", "test output", 3) },
    ]);
    const context = project(state, {
      tail: 2,
      recent: [
        { seq: 0, kind: "proposal", text: "read a.ts" },
        { seq: 1, kind: "tool", text: "a.ts contents" },
        { seq: 2, kind: "proposal", text: "edit a.ts" },
      ],
    });

    expect(context.header.goal?.id).toBe("g1");
    expect(context.header.constraints.map((node) => node.id)).toEqual(["k1"]);
    expect(context.index).toHaveLength(4);
    expect(context.recent.map((turn) => turn.seq)).toEqual([1, 2]);
  });
});
