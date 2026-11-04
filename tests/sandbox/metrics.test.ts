import { describe, expect, it } from "vitest";

import { TurnMeter } from "../../bench/metrics";
import { chargeTrailing, delta, snapshot, summarize, type TurnMetric } from "./metrics";

// Offline verification of the sandbox token accounting — no model, no money. It pins the
// provider shapes `extractUsage` must read (`usage_metadata`, the provider's
// `response_metadata.usage`) so a live run's `metrics.json` is trustworthy.

function llmResult(message: unknown): unknown {
  return { generations: [[{ message }]], llmOutput: {} };
}

describe("sandbox metrics: token extraction (TurnMeter)", () => {
  it("reads input/output/reasoning/cache/cost from the usage shape", async () => {
    const meter = new TurnMeter();
    await meter.handleLLMEnd(
      llmResult({
        usage_metadata: {
          input_tokens: 100,
          output_tokens: 40,
          input_token_details: { cache_read: 30, cache_creation: 5 },
          output_token_details: { reasoning: 10 },
        },
        response_metadata: { usage: { cost: 0.02 } },
      }),
    );
    expect(meter.calls).toBe(1);
    expect(meter.inputTokens).toBe(100);
    expect(meter.outputTokens).toBe(40);
    expect(meter.reasoningTokens).toBe(10);
    expect(meter.cacheRead).toBe(30);
    expect(meter.cacheWrite).toBe(5);
    expect(meter.costRub).toBeCloseTo(0.02);
    expect(meter.costCalls).toBe(1);
  });

  it("falls back to the provider reasoning shape and counts calls without cost", async () => {
    const meter = new TurnMeter();
    await meter.handleLLMEnd(
      llmResult({
        usage_metadata: { input_tokens: 10, output_tokens: 8 },
        response_metadata: { usage: { completion_tokens_details: { reasoning_tokens: 7 } } },
      }),
    );
    expect(meter.reasoningTokens).toBe(7);
    // No cost on this call: costCalls stays 0 so the turn's cost is not fabricated.
    expect(meter.costCalls).toBe(0);
    expect(meter.costRub).toBe(0);
  });
});

describe("sandbox metrics: snapshot/delta", () => {
  it("yields the per-turn delta and a null cost when no cost was reported", () => {
    const meter = new TurnMeter();
    meter.calls = 1;
    meter.inputTokens = 100;
    meter.outputTokens = 40;
    meter.reasoningTokens = 10;
    meter.cacheRead = 30;
    meter.cacheWrite = 5;
    const before = snapshot(meter);
    meter.calls = 3; // a completion-cap bump + a repair within the same turn
    meter.inputTokens = 350;
    meter.outputTokens = 90;
    meter.reasoningTokens = 25;
    meter.cacheRead = 80;
    meter.cacheWrite = 5;
    const usage = delta(snapshot(meter), before);
    expect(usage).toEqual({
      llmCalls: 2,
      inputTokens: 250,
      outputTokens: 50,
      reasoningTokens: 15,
      cacheRead: 50,
      cacheWrite: 0,
      cost: null,
    });
  });
});

describe("sandbox metrics: summarize", () => {
  const turn = (partial: Partial<TurnMetric> & { turn: number }): TurnMetric => ({
    operator: "apply",
    tool: "read",
    chars: 1000,
    refused: false,
    llmCalls: 1,
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: 5,
    cacheRead: 60,
    cacheWrite: 0,
    cost: 0.01,
    ...partial,
  });

  it("totals calls/tokens and splits input and output", () => {
    const summary = summarize([
      turn({ turn: 0, operator: "create_goal", tool: "create_goal" }),
      turn({ turn: 1, tool: "read" }),
      turn({ turn: 2, tool: "edit", refused: true }),
    ]);
    const t = summary.totals;
    expect(t.turns).toBe(3);
    expect(t.toolCalls).toBe(3);
    expect(t.llmCalls).toBe(3);
    expect(t.accepted).toBe(2);
    expect(t.refused).toBe(1);
    expect(t.inputTokens).toBe(300);
    expect(t.cacheRead).toBe(180);
    expect(t.freshInput).toBe(120);
    expect(t.outputTokens).toBe(60);
    expect(t.reasoningTokens).toBe(15);
    expect(t.visibleOutput).toBe(45);
    expect(t.cacheHitRatio).toBeCloseTo(0.6);
    expect(t.costRub).toBeCloseTo(0.03);
    expect(t.contextChars).toEqual({ first: 1000, last: 1000, peak: 1000 });
    expect(summary.byTool.read?.calls).toBe(1);
    expect(summary.byTool.edit?.calls).toBe(1);
    expect(summary.byOperator.create_goal?.calls).toBe(1);
    expect(summary.byOperator.apply?.calls).toBe(2);
  });

  it("sums multiple LLM calls in one turn and reports n/a cost when none is seen", () => {
    const summary = summarize([turn({ turn: 0, llmCalls: 2, cost: null })]);
    expect(summary.totals.llmCalls).toBe(2);
    expect(summary.totals.toolCalls).toBe(1);
    expect(summary.totals.costRub).toBeNull();
  });
});

describe("sandbox metrics: chargeTrailing", () => {
  const turn = (partial: Partial<TurnMetric> & { turn: number }): TurnMetric => ({
    operator: "apply",
    tool: "read",
    chars: 1000,
    refused: false,
    llmCalls: 1,
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: 5,
    cacheRead: 60,
    cacheWrite: 0,
    cost: 0.01,
    ...partial,
  });

  // The observer fires in `progress`, after the turn's delta was taken. With no turn left, its
  // tokens used to vanish from `totals` because `summarize` only sums `perTurn`.
  it("charges usage recorded after the last delta to the last turn", () => {
    const meter = new TurnMeter();
    meter.calls = 1;
    meter.inputTokens = 100;
    meter.outputTokens = 20;
    const consumed = snapshot(meter);
    const turns = [turn({ turn: 0 }), turn({ turn: 1 })];

    // The observer's two calls land after the final delta.
    meter.calls = 3;
    meter.inputTokens = 160;
    meter.outputTokens = 35;
    meter.costCalls = 2;
    meter.costRub = 0.05;

    chargeTrailing(turns, meter, consumed);
    // Added to the last turn's own usage, not replacing it.
    expect(turns[1]!.llmCalls).toBe(1 + 2);
    expect(turns[1]!.inputTokens).toBe(100 + (160 - 100));
    expect(turns[1]!.outputTokens).toBe(20 + (35 - 20));
    expect(turns[1]!.cost).toBeCloseTo(0.01 + 0.05);
    expect(summarize(turns).totals.llmCalls).toBe(1 + 3);
  });

  it("is a no-op when nothing was recorded after the last delta", () => {
    const meter = new TurnMeter();
    meter.calls = 2;
    const consumed = snapshot(meter);
    const turns = [turn({ turn: 0 })];
    chargeTrailing(turns, meter, consumed);
    expect(turns[0]!.llmCalls).toBe(1);
  });

  it("is a no-op on an empty run", () => {
    const meter = new TurnMeter();
    meter.calls = 5;
    expect(() => chargeTrailing([], meter, snapshot(new TurnMeter()))).not.toThrow();
  });
});
