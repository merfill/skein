import { describe, expect, it } from "vitest";

import type { Event } from "../src/ir/events";
import { fold } from "../src/ir/graph";
import {
  buildObserverMessages,
  projectObserver,
  runRequestObserver,
  seedObserverUnit,
  type RequestObserver,
} from "../src/session/observer";
import type { Trigger } from "../src/session/types";

const trigger: Trigger = {
  id: "r1:budget:4:1",
  kind: "budget",
  anchor: "m1",
  evidence: ["o1", "o2"],
  epoch: 1,
};

const request: Event = {
  type: "add_node",
  node: { id: "r1", space: "work", kind: "request", label: "task", seq: 0 },
};

describe("observer: the seeded journal", () => {
  it("records the state tape as an action/observation pair", () => {
    const state = fold([request]);
    const events = seedObserverUnit(trigger, state);

    expect(events).toHaveLength(2);
    const nodes = events.flatMap((event) => (event.type === "add_node" ? [event.node] : []));
    expect(nodes.map((node) => node.kind)).toEqual(["action", "observation"]);
    expect(nodes.map((node) => node.seq)).toEqual([0, 1]);
    expect(nodes[0]?.payload).toMatchObject({
      origin: "engine",
      tool: "state",
      callId: "observer:state:0",
      args: { id: "m1" },
    });
    expect(nodes[1]?.payload).toMatchObject({
      origin: "engine",
      tool: "state",
      callId: "observer:state:0",
    });
  });

  it("carries the request text in the seed", () => {
    const state = fold([request]);
    const events = seedObserverUnit(trigger, state);
    const body = events.flatMap((event) =>
      event.type === "add_node" && typeof (event.node.payload as { result?: unknown }).result === "string"
        ? [(event.node.payload as { result: string }).result]
        : [],
    );
    expect(body).toHaveLength(1);
    expect(body[0]).toContain("task");
  });

  it("does not mutate the task state or the task journal", () => {
    const state = fold([request]);
    const before = state.nodes.size;
    const events = seedObserverUnit(trigger, state);
    expect(state.nodes.size).toBe(before);
    expect(events.every((event) => event.type === "add_node")).toBe(true);
    expect([...state.nodes.keys()]).toEqual(["r1"]);
  });
});

describe("observer: the single call", () => {
  it("returns a decision without touching the task journal", async () => {
    const state = fold([request]);
    const agent: RequestObserver = async () => ({
      decision: { kind: "hint", text: "reuse o1", evidence: ["o1"] },
    });
    const result = await runRequestObserver({ trigger, state, agent });
    expect(result.turns).toBe(1);
    // The state is stamped by the engine from the trigger, not named by the model.
    expect(result.decision).toEqual({
      kind: "hint",
      text: "reuse o1",
      evidence: ["o1"],
      state: "m1",
    });
    expect(result.journal).toHaveLength(2);
    expect([...state.nodes.keys()]).toEqual(["r1"]);
  });

  it("calls the model exactly once", async () => {
    const state = fold([request]);
    let calls = 0;
    const agent: RequestObserver = async () => {
      calls += 1;
      return { decision: { kind: "memo", text: "keep in mind", evidence: ["r1"] } };
    };
    await runRequestObserver({ trigger, state, agent });
    expect(calls).toBe(1);
  });

  it("finishes on an empty reply", async () => {
    const state = fold([request]);
    const agent: RequestObserver = async () => ({});
    const result = await runRequestObserver({ trigger, state, agent });
    expect(result.turns).toBe(1);
    expect(result.decision).toBeUndefined();
    expect(result.noDecision).toBe("empty_reply");
    expect(result.journal).toHaveLength(2);
  });

  it("is deterministic for the same proposer", async () => {
    const state = fold([request]);
    const agent: RequestObserver = async () => ({
      decision: { kind: "halt", reason: "hopeless" },
    });
    const first = await runRequestObserver({ trigger, state, agent });
    const second = await runRequestObserver({ trigger, state, agent });
    expect(first).toEqual(second);
  });
});

describe("observer: projection", () => {
  it("renders the journal as an assistant call and a tool result", () => {
    const state = fold([request]);
    const context = projectObserver(trigger, seedObserverUnit(trigger, state));
    expect(context.history.map((message) => message.role)).toEqual(["assistant", "tool"]);
    expect(context.history[0]).toMatchObject({
      call: { id: "observer:state:0", name: "state", args: { id: "m1" } },
    });
    expect(context.history[1]).toMatchObject({
      role: "tool",
      callId: "observer:state:0",
    });
  });

  it("ignores events that are not observer calls or results", () => {
    const state = fold([request]);
    const journal = [
      ...seedObserverUnit(trigger, state),
      {
        type: "record_rejection" as const,
        tool: "apply",
        target: "echo hi",
        reason: "refused",
        turn: 1,
      },
    ];
    expect(projectObserver(trigger, journal).history).toHaveLength(2);
  });

  it("is deterministic", () => {
    const state = fold([request]);
    const journal = seedObserverUnit(trigger, state);
    expect(projectObserver(trigger, journal)).toEqual(projectObserver(trigger, journal));
  });

  it("builds a system prompt and the trigger before the history", () => {
    const state = fold([request]);
    const context = projectObserver(trigger, seedObserverUnit(trigger, state));
    const messages = buildObserverMessages(context);
    expect(messages).toHaveLength(4);
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.role).toBe("system");
    expect(messages[1]?.content).toContain("budget");
    expect(messages[1]?.content).toContain("m1");
    expect(messages[1]?.content).toContain("o1, o2");
    expect(messages.slice(2).map((message) => message.role)).toEqual(["assistant", "tool"]);
  });
});
