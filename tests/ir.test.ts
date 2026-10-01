import { describe, expect, it } from "vitest";

import { userAcceptance } from "../src/ir/approval";
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

  it("accepts a check event from the user", () => {
    const event = eventSchema.parse({
      type: "record_check",
      command: "user acceptance",
      verdict: "pass",
      output: "",
      actor: "user",
      claimIds: ["c1"],
    });
    expect(event.type === "record_check" && event.actor).toBe("user");
  });

  it("accepts a rejection event", () => {
    const event: Event = {
      type: "record_rejection",
      tool: "edit",
      target: "test/sum.test.mjs",
      reason: "constraint_violation:\\.test\\.mjs$",
      constraintId: "k1",
      turn: 3,
    };
    expect(eventSchema.safeParse(event).success).toBe(true);
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
    expect(project(state).frontier.verified).toEqual(["c1: off-by-one in loop"]);
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

describe("user acceptance", () => {
  const base: Event[] = [
    { type: "add_node", node: workNode("g1", "goal", "write the design note", 0) },
    { type: "add_node", node: workNode("c1", "claim", "the note covers the API", 1) },
  ];

  it("verifies a claim through a user check and records the actor", () => {
    const state = fold([...base, userAcceptance(["c1"], "pass", "looks good")]);
    expect(state.statuses.get("c1")).toBe("verified");
    expect(state.checks[0]).toMatchObject({ actor: "user", command: "looks good" });
    expect(project(state).frontier.verified).toEqual(["c1: the note covers the API"]);
  });

  it("defaults the actor to the arbiter", () => {
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
    expect(state.checks[0]?.actor).toBe("arbiter");
  });
});

describe("record_rejection", () => {
  const base: Event[] = [
    { type: "add_node", node: workNode("g1", "goal", "make test green", 0) },
    {
      type: "add_node",
      node: workNode("k1", "constraint", "do not edit tests", 1),
    },
  ];
  const refusal = (turn: number): Event => ({
    type: "record_rejection",
    tool: "edit",
    target: "test/sum.test.mjs",
    reason: "constraint_violation:\\.test\\.mjs$",
    constraintId: "k1",
    turn,
  });

  it("records the refusal in derived state", () => {
    const state = fold([...base, refusal(3)]);
    expect(state.rejections).toHaveLength(1);
    expect(state.rejections[0]).toMatchObject({
      tool: "edit",
      target: "test/sum.test.mjs",
      reason: "constraint_violation:\\.test\\.mjs$",
      constraintId: "k1",
      turn: 3,
    });
  });

  it("shows a refusal as one line under frontier.refusals", () => {
    const context = project(fold([...base, refusal(3)]));
    expect(context.frontier.refusals).toEqual([
      "edit test/sum.test.mjs — constraint_violation:\\.test\\.mjs$ (k1)",
    ]);
  });

  it("collapses repeated refusals and bounds the section by tail", () => {
    const state = fold([
      ...base,
      refusal(3),
      refusal(5),
      {
        type: "record_rejection",
        tool: "track",
        target: "claim",
        reason: "empty_label",
        turn: 6,
      },
    ]);
    expect(state.rejections).toHaveLength(3);
    expect(project(state, { tail: 10 }).frontier.refusals).toEqual([
      "track claim — empty_label",
      "edit test/sum.test.mjs — constraint_violation:\\.test\\.mjs$ (k1) ×2",
    ]);
    expect(project(state, { tail: 1 }).frontier.refusals).toHaveLength(1);
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

describe("check invalidation by version", () => {
  const events: Event[] = [
    { type: "add_node", node: workNode("g1", "goal", "make test green", 0) },
    { type: "add_node", node: workNode("c1", "claim", "off-by-one in loop", 1) },
    {
      type: "add_node",
      node: {
        id: "o1",
        space: "work",
        kind: "observation",
        label: "run npm test",
        payload: { witness: [{ ref: "file:src/a.ts", version: "v2" }] },
        seq: 2,
      },
    },
    {
      type: "add_edge",
      edge: edge(
        "e1",
        "o1",
        "c1",
        "verifies",
        { kind: "check", command: "npm test", verdict: "pass" },
        "open",
      ),
    },
    {
      type: "record_check",
      command: "npm test",
      verdict: "pass",
      output: "ok",
      claimIds: ["c1"],
    },
  ];

  it("invalidates a verification when a witnessed file changes", () => {
    const state = fold([
      ...events,
      { type: "mutate", ref: "file:src/a.ts", version: "v3", actionId: "a1" },
    ]);
    expect(state.edgeStatuses.get("e1")).toBe("stale");
    const { verified, invalidated } = project(state).frontier;
    expect(verified).toEqual([]);
    expect(invalidated).toEqual(["c1: off-by-one in loop"]);
  });

  it("keeps a verification live when the version matches", () => {
    const state = fold([
      ...events,
      { type: "mutate", ref: "file:src/a.ts", version: "v2", actionId: "a1" },
    ]);
    expect(state.edgeStatuses.get("e1")).toBe("open");
    expect(project(state).frontier.verified).toEqual(["c1: off-by-one in loop"]);
    expect(project(state).frontier.invalidated).toEqual([]);
  });

  it("re-verifies after a fresh passing check", () => {
    const state = fold([
      ...events,
      { type: "mutate", ref: "file:src/a.ts", version: "v3", actionId: "a1" },
      {
        type: "add_node",
        node: {
          id: "o2",
          space: "work",
          kind: "observation",
          label: "run npm test",
          payload: { witness: [{ ref: "file:src/a.ts", version: "v3" }] },
          seq: 3,
        },
      },
      {
        type: "add_edge",
        edge: edge(
          "e2",
          "o2",
          "c1",
          "verifies",
          { kind: "check", command: "npm test", verdict: "pass" },
          "open",
        ),
      },
      {
        type: "record_check",
        command: "npm test",
        verdict: "pass",
        output: "ok",
        claimIds: ["c1"],
      },
    ]);
    expect(project(state).frontier.verified).toEqual(["c1: off-by-one in loop"]);
    expect(project(state).frontier.invalidated).toEqual([]);
  });
});

describe("project", () => {
  it("summarizes nodes in index and slices the recent tail", () => {
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
    expect(context.index.counts).toEqual({
      goal: 1,
      claim: 1,
      observation: 1,
      constraint: 1,
    });
    expect(context.index.recent.map((entry) => entry.id)).toEqual(["o1", "c1"]);
    expect(context.recent.map((turn) => turn.seq)).toEqual([1, 2]);
  });

  it("exposes the turn budget in the header when provided", () => {
    const state = fold([
      { type: "add_node", node: workNode("g1", "goal", "make test green", 0) },
    ]);

    expect(project(state).header.budget).toBeUndefined();
    expect(project(state, { budget: { turn: 3, maxTurns: 10 } }).header.budget).toEqual({
      turn: 3,
      maxTurns: 10,
      remaining: 7,
    });
    expect(project(state, { budget: { turn: 12, maxTurns: 10 } }).header.budget).toMatchObject({
      remaining: 0,
    });
  });

  it("lists verified claims newest first, bounded by tail", () => {
    const state = fold([
      { type: "add_node", node: workNode("g1", "goal", "make test green", 0) },
      { type: "add_node", node: workNode("c1", "claim", "first", 1) },
      { type: "add_node", node: workNode("c2", "claim", "second", 2) },
      { type: "add_node", node: workNode("c3", "claim", "third", 3) },
      {
        type: "record_check",
        command: "npm test",
        verdict: "pass",
        output: "ok",
        claimIds: ["c1", "c2", "c3"],
      },
    ]);

    expect(project(state, { tail: 2 }).frontier.verified).toEqual([
      "c3: third",
      "c2: second",
    ]);
  });
});

describe("derived statuses (Tier 1.1)", () => {
  it("marks a chosen-over decision superseded and hides it from the frontier", () => {
    const state = fold([
      { type: "add_node", node: workNode("d1", "decision", "cache in the data layer", 0) },
      { type: "add_node", node: workNode("d2", "decision", "cache via middleware", 1) },
      {
        type: "add_edge",
        edge: edge("e1", "d1", "d2", "chosen_over", { kind: "llm" }, "open"),
      },
    ]);
    expect(state.statuses.get("d1")).toBe("active");
    expect(state.statuses.get("d2")).toBe("superseded");
    const frontier = project(state).frontier;
    expect(frontier.decisions).toEqual([{ id: "d1", label: "cache in the data layer", over: ["d2"] }]);
    expect(frontier.rejected).toContain("d2: cache via middleware");
  });

  it("derives achieved for a subgoal with a confirmed claim and no unfinished work", () => {
    const state = fold([
      { type: "add_node", node: workNode("sg1", "subgoal", "cache the read path", 0) },
      { type: "add_node", node: workNode("c1", "claim", "hits are served from memory", 1) },
      {
        type: "add_edge",
        edge: edge("e1", "c1", "sg1", "supports", { kind: "llm" }, "open"),
      },
      {
        type: "record_check",
        command: "node --test",
        verdict: "pass",
        output: "ok",
        claimIds: ["c1"],
      },
    ]);
    expect(state.statuses.get("sg1")).toBe("achieved");
    expect(project(state).frontier.achievedSubgoals).toEqual(["sg1: cache the read path"]);
    expect(project(state).frontier.subgoals).toEqual([]);
  });

  it("keeps a subgoal open while any attached claim is open", () => {
    const state = fold([
      { type: "add_node", node: workNode("sg1", "subgoal", "cache the read path", 0) },
      { type: "add_node", node: workNode("c1", "claim", "hits are served from memory", 1) },
      { type: "add_node", node: workNode("c2", "claim", "misses are computed", 2) },
      {
        type: "add_edge",
        edge: edge("e1", "c1", "sg1", "supports", { kind: "llm" }, "open"),
      },
      {
        type: "add_edge",
        edge: edge("e2", "c2", "sg1", "supports", { kind: "llm" }, "open"),
      },
      {
        type: "record_check",
        command: "node --test",
        verdict: "pass",
        output: "ok",
        claimIds: ["c1"],
      },
    ]);
    expect(state.statuses.get("sg1")).toBe("open");
    expect(project(state).frontier.subgoals).toEqual([
      { id: "sg1", label: "cache the read path" },
    ]);
  });

  it("returns a subgoal to open when its only confirmed claim is invalidated", () => {
    const events: Event[] = [
      { type: "add_node", node: workNode("sg1", "subgoal", "cache the read path", 0) },
      { type: "add_node", node: workNode("c1", "claim", "hits are served from memory", 1) },
      {
        type: "add_node",
        node: {
          id: "o1",
          space: "work",
          kind: "observation",
          label: "run node --test",
          payload: { witness: [{ ref: "file:src/cache.mjs", version: "v2" }] },
          seq: 2,
        },
      },
      {
        type: "add_edge",
        edge: edge("e1", "c1", "sg1", "supports", { kind: "llm" }, "open"),
      },
      {
        type: "add_edge",
        edge: edge(
          "e2",
          "o1",
          "c1",
          "verifies",
          { kind: "check", command: "node --test", verdict: "pass" },
          "open",
        ),
      },
      {
        type: "record_check",
        command: "node --test",
        verdict: "pass",
        output: "ok",
        claimIds: ["c1"],
      },
    ];
    expect(fold(events).statuses.get("sg1")).toBe("achieved");
    const invalidated = fold([
      ...events,
      { type: "mutate", ref: "file:src/cache.mjs", version: "v3", actionId: "a1" },
    ]);
    expect(invalidated.statuses.get("sg1")).toBe("open");
  });

  it("exposes subgoals, claim parents, and rejected alternatives in the frontier", () => {
    const state = fold([
      { type: "add_node", node: workNode("g1", "goal", "add caching", 0) },
      { type: "add_node", node: workNode("sg1", "subgoal", "cache the read path", 1) },
      {
        type: "add_edge",
        edge: edge("e1", "g1", "sg1", "decomposes", { kind: "llm" }, "open"),
      },
      { type: "add_node", node: workNode("c1", "claim", "hits are served from memory", 2) },
      {
        type: "add_edge",
        edge: edge("e2", "c1", "sg1", "supports", { kind: "llm" }, "open"),
      },
      { type: "add_node", node: workNode("d1", "decision", "cache in the data layer", 3) },
      { type: "add_node", node: workNode("d2", "decision", "cache via middleware", 4) },
      {
        type: "add_edge",
        edge: edge("e3", "d1", "d2", "chosen_over", { kind: "llm" }, "open"),
      },
    ]);
    const frontier = project(state).frontier;
    expect(frontier.subgoals).toEqual([{ id: "sg1", label: "cache the read path" }]);
    expect(frontier.claims).toEqual([
      { id: "c1", label: "hits are served from memory", supports: "sg1" },
    ]);
    expect(frontier.decisions).toEqual([
      { id: "d1", label: "cache in the data layer", over: ["d2"] },
    ]);
  });
});
