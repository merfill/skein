// Shared metrics for the Skein bench and the Harbor LangGraph adapter:
// per-call token/cache usage (via a LangChain callback), context size, and the
// work-graph node/action counts.
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { ChatGeneration, LLMResult } from "@langchain/core/outputs";

import type { Event } from "../src/ir/events";
import { fold } from "../src/ir/graph";
import type { Action } from "../src/llm/schemas";

export interface UsageLike {
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: { cache_read?: number; cache_creation?: number };
}

export interface TurnRecord {
  turn: number;
  action: string;
  accepted: boolean;
  contextChars: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  cacheHitRatio: number | null;
  llmCalls: number;
  elapsedMs: number;
  cost: number | null;
  usage: unknown[];
}

export function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function extractUsage(output: LLMResult): {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number | null;
  raw: unknown;
} {
  const generation = output.generations?.[0]?.[0] as ChatGeneration | undefined;
  const message = generation?.message as
    | { usage_metadata?: UsageLike; response_metadata?: Record<string, unknown> }
    | undefined;
  const usage = message?.usage_metadata;
  const details = usage?.input_token_details;
  const providerUsage = message?.response_metadata?.usage as { cost?: unknown } | undefined;
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheRead: details?.cache_read ?? 0,
    cacheWrite: details?.cache_creation ?? 0,
    cost: typeof providerUsage?.cost === "number" ? providerUsage.cost : null,
    raw: {
      usage_metadata: usage ?? null,
      llmOutput: output.llmOutput ?? null,
      response_metadata: message?.response_metadata ?? null,
    },
  };
}

export class TurnMeter extends BaseCallbackHandler {
  name = "turn-meter";
  calls = 0;
  inputTokens = 0;
  outputTokens = 0;
  cacheRead = 0;
  cacheWrite = 0;
  costRub = 0;
  costCalls = 0;
  usage: unknown[] = [];

  async handleLLMEnd(output: LLMResult): Promise<void> {
    this.calls += 1;
    const usage = extractUsage(output);
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.cacheRead += usage.cacheRead;
    this.cacheWrite += usage.cacheWrite;
    if (usage.cost !== null) {
      this.costRub += usage.cost;
      this.costCalls += 1;
    }
    this.usage.push(usage.raw);
  }
}

export function graphCounts(proposals: Action[], events: readonly Event[]): Record<string, number> {
  const nodes = fold(events).nodes;
  const byKind: Record<string, number> = {};
  for (const node of nodes.values()) byKind[node.kind] = (byKind[node.kind] ?? 0) + 1;
  let decompose = 0;
  let decide = 0;
  let claims = 0;
  let constraints = 0;
  for (const action of proposals) {
    if (action.tool === "decompose") decompose++;
    else if (action.tool === "decide") decide++;
    else if (action.tool === "track" && action.kind === "claim") claims++;
    else if (action.tool === "track" && action.kind === "constraint") constraints++;
  }
  return {
    decompose,
    decide,
    claims,
    constraints,
    subgoals: byKind.subgoal ?? 0,
    decisions: byKind.decision ?? 0,
    checks: byKind.check ?? 0,
  };
}

export function contextStats(turns: TurnRecord[]): {
  first: number;
  last: number;
  peak: number;
  growth: number;
} {
  const chars = turns.map((turn) => turn.contextChars);
  const first = chars[0] ?? 0;
  const last = chars[chars.length - 1] ?? 0;
  return {
    first,
    last,
    peak: chars.length === 0 ? 0 : Math.max(...chars),
    growth: last - first,
  };
}
