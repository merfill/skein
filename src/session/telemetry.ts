import type { LanguageModelUsage, ModelMessage } from "ai";

import type { UnitType } from "./types";

// Telemetry is an append-only side channel, not IR and not the projection (docs/plans/
// session_interrupt_plan.md §5). Keys are stable across a resume: session, unit, turn and call.

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
}

export interface ContextSnapshot {
  messages: number;
  chars: number;
  approxTokens: number;
  sections?: Record<string, number>;
}

export type MetricEvent =
  | { type: "session"; sessionId: string; title?: string; startedAt: number; endedAt?: number }
  | {
      type: "unit";
      sessionId: string;
      unitId: string;
      unitType: UnitType;
      openedAt: number;
      closedAt?: number;
    }
  | {
      type: "turn";
      sessionId: string;
      unitId: string;
      turn: number;
      state?: string;
      startedAt: number;
      endedAt: number;
    }
  | {
      type: "model_call";
      sessionId: string;
      agent: "session" | "task" | "general" | "observer";
      unitId: string;
      turn: number;
      callId?: string;
      model: string;
      startedAt: number;
      endedAt: number;
      status: "ok" | "aborted" | "error";
      usage?: Usage;
      context?: ContextSnapshot;
    }
  | {
      type: "tool_call";
      sessionId: string;
      agent: "session" | "task" | "general" | "observer";
      unitId: string;
      turn: number;
      callId?: string;
      tool: string;
      startedAt: number;
      endedAt: number;
      status: "ok" | "error";
      mutated?: string[];
    }
  | { type: "pause"; sessionId: string; unitId: string; at: number }
  | { type: "resume"; sessionId: string; unitId: string; at: number }
  | {
      type: "cancel";
      sessionId: string;
      unitId: string;
      at: number;
      rollback: "ok" | "unavailable" | "error";
    };

export interface TelemetrySink {
  record(event: MetricEvent): void;
}

export const LOCAL_SESSION_ID = "local";

export const noopTelemetry: TelemetrySink = {
  record: () => {},
};

export interface MemoryTelemetry {
  sink: TelemetrySink;
  events: MetricEvent[];
}

export function memoryTelemetry(): MemoryTelemetry {
  const events: MetricEvent[] = [];
  return {
    events,
    sink: { record: (event) => events.push(event) },
  };
}

export function usageOf(usage: LanguageModelUsage | undefined): Usage | undefined {
  if (usage === undefined) return undefined;
  const result: Usage = {};
  if (usage.inputTokens !== undefined) result.inputTokens = usage.inputTokens;
  if (usage.outputTokens !== undefined) result.outputTokens = usage.outputTokens;
  const reasoning = usage.outputTokenDetails?.reasoningTokens ?? usage.reasoningTokens;
  if (reasoning !== undefined) result.reasoningTokens = reasoning;
  const cached = usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens;
  if (cached !== undefined) result.cachedInputTokens = cached;
  if (usage.inputTokenDetails?.cacheWriteTokens !== undefined) {
    result.cacheWriteTokens = usage.inputTokenDetails.cacheWriteTokens;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function textOf(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => {
      if (part.type === "text" || part.type === "reasoning") return part.text;
      if (part.type === "tool-result") {
        const output = part.output as { value?: unknown } | undefined;
        return typeof output?.value === "string"
          ? output.value
          : JSON.stringify(output?.value ?? "");
      }
      return "";
    })
    .join("\n");
}

// A bounded description of what the model saw this turn. `approxTokens` is a rough size, not
// the provider's inputTokens (which are recorded separately from `usage`).
export function contextSnapshot(messages: readonly ModelMessage[]): ContextSnapshot {
  const sections: Record<string, number> = {};
  let chars = 0;
  for (const message of messages) {
    const text = textOf(message);
    chars += text.length;
    const role = message.role;
    sections[role] = (sections[role] ?? 0) + text.length;
  }
  return {
    messages: messages.length,
    chars,
    approxTokens: Math.ceil(chars / 4),
    sections,
  };
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  cost: number;
  calls: number;
  cacheHitRatio: number;
}

export function usageTotals(events: readonly MetricEvent[]): UsageTotals {
  const totals: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    calls: 0,
    cacheHitRatio: 0,
  };
  for (const event of events) {
    if (event.type !== "model_call" || event.usage === undefined) continue;
    totals.calls += 1;
    totals.inputTokens += event.usage.inputTokens ?? 0;
    totals.outputTokens += event.usage.outputTokens ?? 0;
    totals.reasoningTokens += event.usage.reasoningTokens ?? 0;
    totals.cachedInputTokens += event.usage.cachedInputTokens ?? 0;
    totals.cacheWriteTokens += event.usage.cacheWriteTokens ?? 0;
    totals.cost += event.usage.cost ?? 0;
  }
  totals.cacheHitRatio =
    totals.inputTokens > 0 ? totals.cachedInputTokens / totals.inputTokens : 0;
  return totals;
}

export interface ContextPoint {
  at: number;
  agent: "session" | "task" | "general" | "observer";
  unitId: string;
  turn: number;
  context: ContextSnapshot;
  inputTokens?: number;
}

export function contextTimeline(events: readonly MetricEvent[]): ContextPoint[] {
  const points: ContextPoint[] = [];
  for (const event of events) {
    if (event.type !== "model_call" || event.context === undefined) continue;
    points.push({
      at: event.endedAt,
      agent: event.agent,
      unitId: event.unitId,
      turn: event.turn,
      context: event.context,
      ...(event.usage?.inputTokens !== undefined ? { inputTokens: event.usage.inputTokens } : {}),
    });
  }
  return points;
}

export interface UnitStats {
  unitId: string;
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
}

export function unitStats(events: readonly MetricEvent[], unitId: string): UnitStats {
  const stats: UnitStats = {
    unitId,
    modelCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
  };
  for (const event of events) {
    if (event.type === "session" || event.unitId !== unitId) continue;
    if (event.type === "model_call") {
      stats.modelCalls += 1;
      stats.inputTokens += event.usage?.inputTokens ?? 0;
      stats.outputTokens += event.usage?.outputTokens ?? 0;
      stats.reasoningTokens += event.usage?.reasoningTokens ?? 0;
      stats.cachedInputTokens += event.usage?.cachedInputTokens ?? 0;
    } else if (event.type === "tool_call") {
      stats.toolCalls += 1;
    }
  }
  return stats;
}

export interface SessionSummary {
  units: number;
  unitsByType: Record<string, number>;
  modelCalls: number;
  toolCalls: number;
  paused: number;
  resumed: number;
  cancelled: number;
  rollbackOk: number;
  rollbackUnavailable: number;
}

export function sessionSummary(events: readonly MetricEvent[]): SessionSummary {
  const summary: SessionSummary = {
    units: 0,
    unitsByType: {},
    modelCalls: 0,
    toolCalls: 0,
    paused: 0,
    resumed: 0,
    cancelled: 0,
    rollbackOk: 0,
    rollbackUnavailable: 0,
  };
  for (const event of events) {
    if (event.type === "unit") {
      summary.units += 1;
      summary.unitsByType[event.unitType] = (summary.unitsByType[event.unitType] ?? 0) + 1;
    } else if (event.type === "model_call") {
      summary.modelCalls += 1;
    } else if (event.type === "tool_call") {
      summary.toolCalls += 1;
    } else if (event.type === "pause") {
      summary.paused += 1;
    } else if (event.type === "resume") {
      summary.resumed += 1;
    } else if (event.type === "cancel") {
      summary.cancelled += 1;
      if (event.rollback === "ok") summary.rollbackOk += 1;
      if (event.rollback === "unavailable") summary.rollbackUnavailable += 1;
    }
  }
  return summary;
}
