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
  // Reasoning (hidden "thinking") tokens: LangChain's OpenAI-compatible shape. The
  // provider may instead report them under response_metadata (see extractUsage).
  output_token_details?: { reasoning?: number };
}

export interface TurnRecord {
  turn: number;
  action: string;
  accepted: boolean;
  contextChars: number;
  inputTokens: number;
  outputTokens: number;
  // Hidden reasoning tokens within outputTokens (0 when the provider does not report them).
  reasoningTokens: number;
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

// Provider usage blob under response_metadata, when it carries a raw completion
// breakdown (OpenAI-compatible providers name reasoning tokens there).
interface ProviderUsage {
  cost?: unknown;
  completion_tokens_details?: { reasoning_tokens?: unknown };
}

export function extractUsage(output: LLMResult): {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
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
  const providerUsage = message?.response_metadata?.usage as ProviderUsage | undefined;
  // LangChain (output_token_details.reasoning) first; the provider's raw
  // completion_tokens_details.reasoning_tokens is the fallback shape.
  const fromMetadata = usage?.output_token_details?.reasoning;
  const fromProvider = providerUsage?.completion_tokens_details?.reasoning_tokens;
  const reasoningTokens =
    typeof fromMetadata === "number"
      ? fromMetadata
      : typeof fromProvider === "number"
        ? fromProvider
        : 0;
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    reasoningTokens,
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
  reasoningTokens = 0;
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
    this.reasoningTokens += usage.reasoningTokens;
    this.cacheRead += usage.cacheRead;
    this.cacheWrite += usage.cacheWrite;
    if (usage.cost !== null) {
      this.costRub += usage.cost;
      this.costCalls += 1;
    }
    this.usage.push(usage.raw);
  }
}

export function actionName(action: Action): string {
  if (action.operator !== "apply") return action.operator;
  return action.action.tool;
}

export function graphCounts(proposals: Action[], events: readonly Event[]): Record<string, number> {
  const nodes = fold(events).nodes;
  const byKind: Record<string, number> = {};
  for (const node of nodes.values()) byKind[node.kind] = (byKind[node.kind] ?? 0) + 1;
  let createGoal = 0;
  let edits = 0;
  let checks = 0;
  for (const action of proposals) {
    if (action.operator === "create_goal") createGoal++;
    else if (action.operator === "apply" && action.action.tool === "edit") edits++;
    else if (action.operator === "apply" && action.action.tool === "run" && action.action.target) {
      checks++;
    }
  }
  return {
    createGoal,
    edits,
    checks: byKind.check ?? 0,
    checkProposals: checks,
    goals: byKind.goal ?? 0,
    plans: byKind.plan ?? 0,
    alternatives: byKind.alternatives ?? 0,
    actions: byKind.action ?? 0,
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
