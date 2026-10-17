// Shared metrics for the Skein bench and the Harbor LangGraph adapter:
// per-call token/cache usage (via a LangChain callback), context size, and the
// work-graph node/action counts.
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { AIMessage } from "@langchain/core/messages";
import type { ChatGeneration, LLMResult } from "@langchain/core/outputs";

import type { Event } from "../src/ir/events";
import { fold } from "../src/ir/graph";
import type { Action } from "../src/llm/schemas";
import type { ModelReply } from "../src/llm/structured";

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

  // The AI SDK path (`src/llm/structured.ts`) reports one assembled reply per model call.
  record(reply: ModelReply): void {
    this.calls += 1;
    this.inputTokens += reply.usage.inputTokens ?? 0;
    this.outputTokens += reply.usage.outputTokens ?? 0;
    this.reasoningTokens += reply.usage.outputTokenDetails.reasoningTokens ?? 0;
    this.cacheRead += reply.usage.inputTokenDetails.cacheReadTokens ?? 0;
    this.cacheWrite += reply.usage.inputTokenDetails.cacheWriteTokens ?? 0;
    const cost = (reply.rawUsage as { cost?: unknown } | undefined)?.cost;
    if (typeof cost === "number") {
      this.costRub += cost;
      this.costCalls += 1;
    }
    this.usage.push(reply.rawUsage);
  }

  handleUsage = (reply: unknown): void => this.record(reply as ModelReply);
}

// A LangChain callback handler (Harbor's inherited handlers; `TurnMeter`'s legacy path)
// exposed as an AI SDK usage handler. The synthetic `LLMResult` carries the same message
// shape the LangChain model path used to produce.
export function langChainUsage(callback: unknown): { handleUsage(reply: ModelReply): Promise<void> } {
  return {
    async handleUsage(reply) {
      const handler = callback as { handleLLMEnd?: (output: LLMResult) => unknown };
      if (typeof handler.handleLLMEnd !== "function") return;
      const message = new AIMessage({
        content: reply.text,
        usage_metadata: {
          input_tokens: reply.usage.inputTokens ?? 0,
          output_tokens: reply.usage.outputTokens ?? 0,
          total_tokens: reply.usage.totalTokens ?? 0,
          input_token_details: {
            cache_read: reply.usage.inputTokenDetails.cacheReadTokens ?? 0,
            cache_creation: reply.usage.inputTokenDetails.cacheWriteTokens ?? 0,
          },
          output_token_details: {
            reasoning: reply.usage.outputTokenDetails.reasoningTokens ?? 0,
          },
        },
        response_metadata: { finish_reason: reply.finishReason, usage: reply.rawUsage },
      });
      const output = {
        generations: [[{ text: reply.text, message }]],
        llmOutput: reply.rawUsage,
      } as unknown as LLMResult;
      await handler.handleLLMEnd(output);
    },
  };
}

export function actionName(action: Action): string {
  if (action.operator !== "apply") return action.operator;
  return action.action.tool;
}

export function graphCounts(proposals: Action[], events: readonly Event[]): Record<string, number> {
  const nodes = fold(events).nodes;
  const byKind: Record<string, number> = {};
  for (const node of nodes.values()) byKind[node.kind] = (byKind[node.kind] ?? 0) + 1;
  let moves = 0;
  let edits = 0;
  let checks = 0;
  for (const action of proposals) {
    if (action.operator === "move") moves++;
    else if (action.operator === "apply" && action.action.tool === "edit") edits++;
    else if (action.operator === "apply" && action.action.tool === "bash") checks++;
  }
  return {
    moves,
    edits,
    checks: byKind.check ?? 0,
    checkProposals: checks,
    states: byKind.move ?? 0,
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
