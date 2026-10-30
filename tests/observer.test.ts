import { describe, expect, it } from "vitest";

import type { Event } from "../src/ir/events";
import { fold } from "../src/ir/graph";
import {
  buildObserverMessages,
  projectObserver,
  runRequestObserver,
  seedObserverUnit,
  type RequestObserver,
  type ObserverTools,
} from "../src/session/observer";
import type { Trigger } from "../src/session/types";

const trigger: Trigger = {
  id: "r1:budget:4:1",
  kind: "budget",
  anchor: "m1",
  evidence: ["o1", "o2"],
  epoch: 1,
};

const survey: ObserverTools = {
  outline: () => "outline body",
  state: (_state, anchor) => `state ${anchor}`,
};

const request: Event = {
  type: "add_node",
  node: { id: "r1", space: "work", kind: "request", label: "task", seq: 0 },
};

describe("observer: the seeded journal", () => {
  it("records outline and state as an action/observation pair each", () => {
    const state = fold([request]);
    const events = seedObserverUnit(trigger, state, survey);

    expect(events).toHaveLength(4);
    expect(events.map((event) => event.type)).toEqual([
      "add_node",
      "add_node",
      "add_node",
      "add_node",
    ]);

    const nodes = events.flatMap((event) => (event.type === "add_node" ? [event.node] : []));
    expect(nodes.map((node) => node.kind)).toEqual([
      "action",
      "observation",
      "action",
      "observation",
    ]);
    expect(nodes.map((node) => node.seq)).toEqual([0, 1, 2, 3]);
    expect(nodes[0]?.payload).toMatchObject({
      origin: "engine",
      tool: "outline",
      callId: "observer:outline:0",
      args: {},
    });
    expect(nodes[1]?.payload).toMatchObject({
      origin: "engine",
      tool: "outline",
      callId: "observer:outline:0",
      result: "outline body",
    });
    expect(nodes[2]?.payload).toMatchObject({
      origin: "engine",
      tool: "state",
      callId: "observer:state:2",
      args: { id: "m1" },
    });
    expect(nodes[3]?.payload).toMatchObject({
      origin: "engine",
      tool: "state",
      callId: "observer:state:2",
      result: "state m1",
    });
  });

  it("does not mutate the task state or the task journal", () => {
    const state = fold([request]);
    const before = state.nodes.size;
    const events = seedObserverUnit(trigger, state, survey);
    expect(state.nodes.size).toBe(before);
    expect(events.every((event) => event.type === "add_node")).toBe(true);
    expect([...state.nodes.keys()]).toEqual(["r1"]);
  });
});

describe("observer: the bounded run", () => {
  const tools: ObserverTools = { ...survey };

  it("returns a decision without touching the task journal", async () => {
    const state = fold([request]);
    const agent: RequestObserver = async () => ({
      decision: { kind: "hint", text: "reuse o1", evidence: ["o1"], state: "m1" },
    });
    const result = await runRequestObserver({ trigger, state, tools, agent });
    expect(result.turns).toBe(1);
    expect(result.decision).toEqual({
      kind: "hint",
      text: "reuse o1",
      evidence: ["o1"],
      state: "m1",
    });
    expect(result.journal).toHaveLength(4);
    expect([...state.nodes.keys()]).toEqual(["r1"]);
  });

  it("executes a read-only tool call and records the pair", async () => {
    const state = fold([request]);
    let turn = 0;
    const agent: RequestObserver = async () => {
      turn += 1;
      return turn === 1
        ? { toolCalls: [{ name: "state", args: { id: "m1" } }] }
        : { decision: { kind: "memo", text: "keep in mind", evidence: ["o1"] } };
    };
    const result = await runRequestObserver({ trigger, state, tools, agent });
    expect(result.turns).toBe(2);
    expect(result.journal).toHaveLength(6);
    const nodes = result.journal.flatMap((event) =>
      event.type === "add_node" ? [event.node] : [],
    );
    expect(nodes[4]?.payload).toMatchObject({
      origin: "doxa",
      tool: "state",
      args: { id: "m1" },
    });
    expect(nodes[5]?.payload).toMatchObject({
      origin: "engine",
      tool: "state",
      result: "state m1",
    });
    expect(result.decision).toEqual({
      kind: "memo",
      text: "keep in mind",
      evidence: ["o1"],
    });
  });

  it("surfaces an unknown tool as a tool result", async () => {
    const state = fold([request]);
    let turn = 0;
    const agent: RequestObserver = async () => {
      turn += 1;
      return turn === 1
        ? { toolCalls: [{ name: "nope", args: {} }] }
        : { decision: { kind: "halt", reason: "cannot diagnose" } };
    };
    const result = await runRequestObserver({ trigger, state, tools, agent });
    expect(result.journal).toHaveLength(6);
    const resultNode = result.journal[5];
    expect(
      resultNode !== undefined && resultNode.type === "add_node"
        ? resultNode.node.payload
        : undefined,
    ).toMatchObject({ origin: "engine", tool: "nope", result: "unknown tool: nope" });
  });

  it("stops at the observer budget without a decision", async () => {
    const state = fold([request]);
    const agent: RequestObserver = async () => ({
      toolCalls: [{ name: "outline", args: {} }],
    });
    const result = await runRequestObserver({ trigger, state, tools, agent, maxTurns: 2 });
    expect(result.turns).toBe(2);
    expect(result.decision).toBeUndefined();
    expect(result.journal).toHaveLength(8);
  });

  it("asks for a decision after the survey limit", async () => {
    const state = fold([request]);
    const seen: string[] = [];
    const agent: RequestObserver = async (messages) => {
      seen.push(
        messages
          .map((message) => (typeof message.content === "string" ? message.content : ""))
          .join("\n"),
      );
      return { toolCalls: [{ name: "outline", args: {} }] };
    };
    await runRequestObserver({
      trigger,
      state,
      tools,
      agent,
      maxTurns: 4,
      surveyLimit: 2,
    });
    expect(seen[2]).toContain("inspected enough");
  });

  it("finishes on an empty reply", async () => {
    const state = fold([request]);
    const agent: RequestObserver = async () => ({});
    const result = await runRequestObserver({ trigger, state, tools, agent });
    expect(result.turns).toBe(1);
    expect(result.decision).toBeUndefined();
    expect(result.journal).toHaveLength(4);
  });

  it("is deterministic for the same proposer", async () => {
    const state = fold([request]);
    const agent: RequestObserver = async () => ({
      toolCalls: [{ name: "outline", args: {}, callId: "call:outline" }],
    });
    const first = await runRequestObserver({ trigger, state, tools, agent, maxTurns: 2 });
    const second = await runRequestObserver({ trigger, state, tools, agent, maxTurns: 2 });
    expect(first).toEqual(second);
  });
});

describe("observer: projection", () => {
  it("renders the journal as assistant calls and tool results", () => {
    const state = fold([request]);
    const context = projectObserver(trigger, seedObserverUnit(trigger, state, survey));
    expect(context.history.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "assistant",
      "tool",
    ]);
    expect(context.history[0]).toMatchObject({
      call: { id: "observer:outline:0", name: "outline", args: {} },
    });
    expect(context.history[1]).toMatchObject({
      role: "tool",
      callId: "observer:outline:0",
      text: "outline body",
    });
    expect(context.history[2]).toMatchObject({
      call: { id: "observer:state:2", name: "state", args: { id: "m1" } },
    });
    expect(context.history[3]).toMatchObject({
      role: "tool",
      callId: "observer:state:2",
      text: "state m1",
    });
  });

  it("ignores events that are not observer calls or results", () => {
    const state = fold([request]);
    const journal = [
      ...seedObserverUnit(trigger, state, survey),
      {
        type: "record_rejection" as const,
        tool: "apply",
        target: "echo hi",
        reason: "refused",
        turn: 1,
      },
    ];
    expect(projectObserver(trigger, journal).history).toHaveLength(4);
  });

  it("is deterministic", () => {
    const state = fold([request]);
    const journal = seedObserverUnit(trigger, state, survey);
    expect(projectObserver(trigger, journal)).toEqual(projectObserver(trigger, journal));
  });

  it("builds a system prompt and the trigger before the history", () => {
    const state = fold([request]);
    const context = projectObserver(trigger, seedObserverUnit(trigger, state, survey));
    const messages = buildObserverMessages(context);
    expect(messages).toHaveLength(6);
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.role).toBe("system");
    expect(messages[1]?.content).toContain("budget");
    expect(messages[1]?.content).toContain("m1");
    expect(messages[1]?.content).toContain("o1, o2");
    expect(messages.slice(2).map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "assistant",
      "tool",
    ]);
  });
});
