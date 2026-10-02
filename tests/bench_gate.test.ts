import { describe, expect, it } from "vitest";

import { compareRun, runFromMetrics, type Baseline } from "../bench/compare";

const baseline: Baseline = {
  version: 1,
  tolerance: 1.2,
  cases: {
    "moving-target": {
      reward: 1,
      steps: 7,
      inputTokens: 17782,
      peakContextChars: 3526,
      source: "test",
    },
  },
};

describe("compareRun", () => {
  it("passes a run within tolerance", () => {
    const run = runFromMetrics({
      case: "moving-target",
      reward: 1,
      steps: 8,
      inputTokens: 18000,
      context: { peak: 3600 },
    });
    const result = compareRun(baseline, run);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("fails when reward drops", () => {
    const run = runFromMetrics({ case: "moving-target", reward: 0, steps: 7 });
    const result = compareRun(baseline, run);
    expect(result.ok).toBe(false);
    expect(result.violations.some((violation) => violation.startsWith("reward"))).toBe(true);
  });

  it("fails when a metric exceeds tolerance", () => {
    const run = runFromMetrics({ case: "moving-target", reward: 1, steps: 9 });
    const result = compareRun(baseline, run);
    expect(result.ok).toBe(false);
    expect(result.violations.some((violation) => violation.startsWith("steps"))).toBe(true);
  });

  it("ignores metrics absent from the baseline", () => {
    const partial: Baseline = {
      ...baseline,
      cases: { "moving-target": { reward: 1, steps: 7, source: "test" } },
    };
    const run = runFromMetrics({
      case: "moving-target",
      reward: 1,
      steps: 7,
      inputTokens: 999_999,
    });
    const result = compareRun(partial, run);
    expect(result.ok).toBe(true);
  });

  it("fails when the case has no baseline", () => {
    const run = runFromMetrics({ case: "unknown", reward: 1, steps: 1 });
    const result = compareRun(baseline, run);
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toContain("no baseline");
  });

  it("reads the peak context from the current metrics shape", () => {
    const run = runFromMetrics({ case: "moving-target", reward: 1, steps: 7, context: { peak: 3526 } });
    expect(run.peakContextChars).toBe(3526);
  });
});
