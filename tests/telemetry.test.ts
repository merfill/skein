import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import {
  contextSnapshot,
  memoryTelemetry,
  sessionSummary,
  unitStats,
  usageTotals,
  type MetricEvent,
} from "../src/session/telemetry";

const events: MetricEvent[] = [
  {
    type: "model_call",
    sessionId: "local",
    agent: "task",
    unitId: "r1",
    turn: 0,
    model: "m",
    startedAt: 0,
    endedAt: 1,
    status: "ok",
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 5,
      cachedInputTokens: 50,
    },
    context: { messages: 3, chars: 400, approxTokens: 100 },
  },
  {
    type: "model_call",
    sessionId: "local",
    agent: "session",
    unitId: "session:1",
    turn: 0,
    model: "m",
    startedAt: 2,
    endedAt: 3,
    status: "ok",
    usage: { inputTokens: 50, outputTokens: 10, cachedInputTokens: 25 },
  },
  {
    type: "tool_call",
    sessionId: "local",
    agent: "task",
    unitId: "r1",
    turn: 0,
    tool: "write",
    startedAt: 1,
    endedAt: 2,
    status: "ok",
    mutated: ["file:a.txt"],
  },
  { type: "pause", sessionId: "local", unitId: "r1", at: 3 },
  { type: "resume", sessionId: "local", unitId: "r1", at: 4 },
  { type: "cancel", sessionId: "local", unitId: "r1", at: 5, rollback: "ok" },
  { type: "unit", sessionId: "local", unitId: "r1", unitType: "task", openedAt: 0 },
];

describe("telemetry", () => {
  it("sums usage and reports the cache hit ratio", () => {
    const totals = usageTotals(events);
    expect(totals.calls).toBe(2);
    expect(totals.inputTokens).toBe(150);
    expect(totals.outputTokens).toBe(30);
    expect(totals.reasoningTokens).toBe(5);
    expect(totals.cachedInputTokens).toBe(75);
    expect(totals.cacheHitRatio).toBeCloseTo(0.5);
  });

  it("counts per unit and summarizes the session", () => {
    expect(unitStats(events, "r1")).toMatchObject({
      modelCalls: 1,
      toolCalls: 1,
      inputTokens: 100,
      cachedInputTokens: 50,
    });
    expect(sessionSummary(events)).toMatchObject({
      units: 1,
      unitsByType: { task: 1 },
      modelCalls: 2,
      toolCalls: 1,
      paused: 1,
      resumed: 1,
      cancelled: 1,
      rollbackOk: 1,
    });
  });

  it("snapshots the message count, size and role sections", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "abc" },
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ];
    const snapshot = contextSnapshot(messages);
    expect(snapshot.messages).toBe(2);
    expect(snapshot.chars).toBe(8);
    expect(snapshot.approxTokens).toBe(2);
    expect(snapshot.sections).toMatchObject({ system: 3, user: 5 });
  });

  it("records into a memory sink", () => {
    const telemetry = memoryTelemetry();
    for (const event of events) telemetry.sink.record(event);
    expect(telemetry.events).toHaveLength(events.length);
  });
});
