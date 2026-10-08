import type { TurnMeter } from "../../bench/metrics";

// Token/call accounting for a sandbox live run. The heavy lifting is `TurnMeter`
// (`bench/metrics.ts`, shared with the Harbor adapter): it aggregates, per LangChain
// LLM call, the provider's `usage_metadata` — input/output/reasoning tokens, cache
// read/write, cost. `live-trace.ts` snapshots the meter around each turn and calls
// `summarize`; this module is pure so it is verified offline (`metrics.test.ts`).

export interface Snapshot {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheRead: number;
  cacheWrite: number;
  costRub: number;
  costCalls: number;
}

export interface TurnMetric {
  turn: number;
  operator: string;
  tool: string;
  chars: number;
  refused: boolean;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number | null;
}

export interface Bucket {
  calls: number;
  input: number;
  output: number;
  reasoning: number;
}

export interface MetricTotals {
  turns: number;
  llmCalls: number;
  toolCalls: number;
  accepted: number;
  refused: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheRead: number;
  cacheWrite: number;
  freshInput: number;
  visibleOutput: number;
  cacheHitRatio: number | null;
  costRub: number | null;
  contextChars: { first: number; last: number; peak: number };
}

export interface MetricsSummary {
  totals: MetricTotals;
  byTool: Record<string, Bucket>;
  byOperator: Record<string, Bucket>;
}

export function snapshot(meter: TurnMeter): Snapshot {
  return {
    llmCalls: meter.calls,
    inputTokens: meter.inputTokens,
    outputTokens: meter.outputTokens,
    reasoningTokens: meter.reasoningTokens,
    cacheRead: meter.cacheRead,
    cacheWrite: meter.cacheWrite,
    costRub: meter.costRub,
    costCalls: meter.costCalls,
  };
}

export function delta(
  after: Snapshot,
  before: Snapshot,
): Omit<TurnMetric, "turn" | "operator" | "tool" | "chars" | "refused"> {
  const costCalls = after.costCalls - before.costCalls;
  return {
    llmCalls: after.llmCalls - before.llmCalls,
    inputTokens: after.inputTokens - before.inputTokens,
    outputTokens: after.outputTokens - before.outputTokens,
    reasoningTokens: after.reasoningTokens - before.reasoningTokens,
    cacheRead: after.cacheRead - before.cacheRead,
    cacheWrite: after.cacheWrite - before.cacheWrite,
    cost: costCalls > 0 ? after.costRub - before.costRub : null,
  };
}

function bump(bucket: Bucket, turn: TurnMetric): void {
  bucket.calls += 1;
  bucket.input += turn.inputTokens;
  bucket.output += turn.outputTokens;
  bucket.reasoning += turn.reasoningTokens;
}

export function summarize(turns: TurnMetric[]): MetricsSummary {
  const totals: MetricTotals = {
    turns: turns.length,
    llmCalls: 0,
    // Each turn is exactly one proposed tool call (tool_choice is "required"); retries
    // within a turn add LLM calls, not tool calls. A refused proposal is still a call.
    toolCalls: turns.length,
    accepted: 0,
    refused: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    freshInput: 0,
    visibleOutput: 0,
    cacheHitRatio: null,
    costRub: null,
    contextChars: { first: 0, last: 0, peak: 0 },
  };
  const byTool: Record<string, Bucket> = {};
  const byOperator: Record<string, Bucket> = {};
  let cost = 0;
  let costSeen = false;
  for (const turn of turns) {
    totals.llmCalls += turn.llmCalls;
    if (turn.refused) totals.refused += 1;
    else totals.accepted += 1;
    totals.inputTokens += turn.inputTokens;
    totals.outputTokens += turn.outputTokens;
    totals.reasoningTokens += turn.reasoningTokens;
    totals.cacheRead += turn.cacheRead;
    totals.cacheWrite += turn.cacheWrite;
    if (turn.cost !== null) {
      cost += turn.cost;
      costSeen = true;
    }
    bump((byTool[turn.tool] ??= { calls: 0, input: 0, output: 0, reasoning: 0 }), turn);
    bump((byOperator[turn.operator] ??= { calls: 0, input: 0, output: 0, reasoning: 0 }), turn);
  }
  totals.freshInput = totals.inputTokens - totals.cacheRead;
  totals.visibleOutput = totals.outputTokens - totals.reasoningTokens;
  totals.cacheHitRatio = totals.inputTokens > 0 ? totals.cacheRead / totals.inputTokens : null;
  totals.costRub = costSeen ? cost : null;
  const chars = turns.map((turn) => turn.chars);
  totals.contextChars = {
    first: chars[0] ?? 0,
    last: chars[chars.length - 1] ?? 0,
    peak: chars.length === 0 ? 0 : Math.max(...chars),
  };
  return { totals, byTool, byOperator };
}
