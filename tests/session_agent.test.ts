import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import type { Event } from "../src/ir/events";
import { toSessionReply } from "../src/llm/session_agent";
import {
  attentionOf,
  createSession,
  openUnit,
  pushUnit,
  sessionFocus,
} from "../src/session/session";
import {
  runSessionAgent,
  runSessionUnit,
  seedSessionUnit,
  type SessionAgent,
  type SessionTools,
} from "../src/session/session_agent";
import { sessionOutline } from "../src/session/session_outline";

function request(id = "req", text = "task"): Event {
  return {
    type: "add_node",
    node: { id, space: "work", kind: "request", label: text, payload: { text }, seq: 0 },
  };
}

function move(id: string, island: string, seq: number): Event[] {
  return [
    {
      type: "add_node",
      node: {
        id,
        space: "work",
        kind: "move",
        label: island,
        payload: { state: island, what: "do it", turn: seq },
        seq,
      },
    },
    {
      type: "add_edge",
      edge: {
        id: `e:${id}`,
        from: "req",
        to: id,
        kind: "move",
        provenance: { kind: "llm" },
      },
    },
  ];
}

const tools: SessionTools = {
  unit: (_session, id) => `UNIT ${id}`,
};

function taskSession() {
  const session = createSession();
  openUnit(session, "r1", "task", [request(), ...move("m1", "patch", 1)]);
  pushUnit(session, "r1", 0);
  return session;
}

describe("session agent: bounded unit loop", () => {
  it("surveys a unit read-only, then answers", async () => {
    const session = taskSession();
    const taskJournal = session.units.get("r1")?.journal ?? [];
    const taskLength = taskJournal.length;
    const seen: ModelMessage[][] = [];
    let calls = 0;
    const agent: SessionAgent = async (messages) => {
      seen.push(messages);
      calls += 1;
      if (calls === 1) {
        return { toolCalls: [{ name: "unit", args: { id: "r1" }, callId: "c1" }] };
      }
      return { operation: { kind: "respond", text: "hello" } };
    };

    const result = await runSessionAgent({ agent, tools }, session, "hello", { turn: 5 });

    expect(result.unitId).toBe("session:1");
    expect(result.applied?.ok).toBe(true);
    expect(attentionOf(session, "session:1")).toBe("completed");
    expect(result.journal.some((event) =>
      event.type === "add_node" &&
      event.node.kind === "observation" &&
      (event.node.payload as { result?: string }).result === "UNIT r1",
    )).toBe(true);
    expect(taskJournal).toHaveLength(taskLength);
    expect(seen[0]?.[1]?.role).toBe("system");
    expect(seen[0]?.[2]).toEqual({ role: "user", content: "hello" });
    expect(seen[1]?.length).toBeGreaterThan(seen[0]?.length ?? 0);
  });

  it("takes one operation per run and ignores any tool calls in the same reply", async () => {
    const session = taskSession();
    const agent: SessionAgent = async () => ({
      toolCalls: [{ name: "unit", args: { id: "r1" }, callId: "c1" }],
      operation: { kind: "respond", text: "done" },
    });
    const result = await runSessionAgent({ agent, tools }, session, "hi");
    expect(result.operation).toEqual({ kind: "respond", text: "done" });
    expect(result.journal).toHaveLength(1);
  });

  it("records a refused operation in the session unit journal, not the task tree", async () => {
    const session = taskSession();
    const taskJournal = session.units.get("r1")?.journal ?? [];
    const taskLength = taskJournal.length;
    const agent: SessionAgent = async () => ({
      operation: { kind: "start", text: "  " },
    });
    const result = await runSessionAgent({ agent, tools }, session, "start something");
    expect(result.applied?.ok).toBe(false);
    const refusal = result.journal.at(-1);
    expect(refusal?.type).toBe("add_node");
    if (refusal?.type === "add_node") {
      expect(refusal.node.label).toBe("refusal");
      expect((refusal.node.payload as { result?: string }).result).toContain(
        "refused: empty text",
      );
    }
    expect(taskJournal).toHaveLength(taskLength);
    expect(sessionFocus(session)?.unitId).toBe("r1");
    expect(session.journal.some((event) => event.type === "operation")).toBe(false);
    expect(
      session.journal.some(
        (event) => event.type === "refusal" && event.reason === "empty text",
      ),
    ).toBe(true);
    expect(attentionOf(session, "session:1")).toBe("completed");
  });

  it("records the decision reasoning in the session journal and L0", async () => {
    const session = taskSession();
    const agent: SessionAgent = async () => ({
      operation: { kind: "respond", text: "hi" },
      reasoning: "the user only greeted me",
    });
    const result = await runSessionAgent({ agent, tools }, session, "hi");
    expect(result.reasoning).toBe("the user only greeted me");
    expect(
      session.journal.some(
        (event) =>
          event.type === "operation" && event.reasoning === "the user only greeted me",
      ),
    ).toBe(true);
    expect(sessionOutline(session)).toContain(
      'respond: "hi" · reasoning: "the user only greeted me"',
    );
  });

  it("records an empty reply as no_decision", async () => {
    const session = taskSession();
    const agent: SessionAgent = async () => ({});
    const result = await runSessionAgent({ agent, tools }, session, "hi");
    expect(result.operation).toBeUndefined();
    expect(result.applied).toBeUndefined();
    expect(result.noDecision).toBe("empty_reply");
    expect(sessionFocus(session)?.unitId).toBe("r1");
    expect(
      session.journal.some(
        (event) => event.type === "no_decision" && event.reason === "empty_reply",
      ),
    ).toBe(true);
    expect(sessionOutline(session)).toContain("no decision: empty_reply");
    expect(attentionOf(session, "session:1")).toBe("suspended");
  });

  it("records max_turns when the loop runs out", async () => {
    const session = taskSession();
    const agent: SessionAgent = async () => ({
      toolCalls: [{ name: "unit", args: { id: "r1" }, callId: "c1" }],
    });
    const result = await runSessionAgent({ agent, tools }, session, "hi", { maxTurns: 2 });
    expect(result.operation).toBeUndefined();
    expect(result.noDecision).toBe("max_turns");
    expect(
      session.journal.some(
        (event) => event.type === "no_decision" && event.reason === "max_turns",
      ),
    ).toBe(true);
    expect(sessionOutline(session)).toContain("no decision: max_turns");
    expect(attentionOf(session, "session:1")).toBe("suspended");
  });

  it("replays the journal and shows L0 as a system message", async () => {
    const session = taskSession();
    const journal = seedSessionUnit("hello");
    let messages: ModelMessage[] = [];
    const agent: SessionAgent = async (input) => {
      messages = input;
      return { operation: { kind: "respond", text: "ok" } };
    };
    const result = await runSessionUnit({ utterance: "hello", session, tools, agent, journal });
    expect(result.operation).toEqual({ kind: "respond", text: "ok" });
    expect(messages[2]).toEqual({ role: "user", content: "hello" });
    expect(
      messages.some(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.includes("Earlier tasks") &&
          message.content.includes("task r1"),
      ),
    ).toBe(true);
  });
});

describe("session agent: model reply mapping", () => {
  it("maps operation tools and keeps read-only calls", () => {
    expect(
      toSessionReply([{ toolName: "start", input: { text: "do it" }, toolCallId: "x" }]),
    ).toEqual({ operation: { kind: "start", text: "do it" } });
    expect(
      toSessionReply([{ toolName: "unit", input: { id: "r1" }, toolCallId: "x" }]),
    ).toEqual({ toolCalls: [{ name: "unit", args: { id: "r1" }, callId: "x" }] });
  });
});
