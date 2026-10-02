export interface BaselineEntry {
  reward: number;
  steps?: number;
  inputTokens?: number;
  outputTokens?: number;
  costRub?: number;
  peakContextChars?: number;
  source: string;
}

export interface Baseline {
  version: number;
  tolerance: number;
  cases: Record<string, BaselineEntry>;
}

export interface RunMetrics {
  case: string;
  reward: number;
  steps: number;
  inputTokens?: number;
  outputTokens?: number;
  costRub?: number;
  peakContextChars?: number;
}

export interface RawMetrics {
  case?: unknown;
  reward?: unknown;
  steps?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  costRub?: unknown;
  context?: { peak?: unknown } | null;
}

export interface MetricDelta {
  baseline: number;
  run: number;
  ratio: number;
}

export interface Comparison {
  case: string;
  ok: boolean;
  violations: string[];
  deltas: Record<string, MetricDelta>;
}

const COST_METRICS = [
  "steps",
  "inputTokens",
  "outputTokens",
  "costRub",
  "peakContextChars",
] as const;

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function runFromMetrics(raw: RawMetrics): RunMetrics {
  const run: RunMetrics = {
    case: typeof raw.case === "string" ? raw.case : "",
    reward: asNumber(raw.reward) ?? 0,
    steps: asNumber(raw.steps) ?? 0,
  };
  const inputTokens = asNumber(raw.inputTokens);
  if (inputTokens !== undefined) run.inputTokens = inputTokens;
  const outputTokens = asNumber(raw.outputTokens);
  if (outputTokens !== undefined) run.outputTokens = outputTokens;
  const costRub = asNumber(raw.costRub);
  if (costRub !== undefined) run.costRub = costRub;
  const peak = raw.context ? asNumber(raw.context.peak) : undefined;
  if (peak !== undefined) run.peakContextChars = peak;
  return run;
}

export function compareRun(
  baseline: Baseline,
  run: RunMetrics,
  tolerance = baseline.tolerance,
): Comparison {
  const entry = baseline.cases[run.case];
  if (entry === undefined) {
    return {
      case: run.case,
      ok: false,
      violations: [`no baseline for case "${run.case}"`],
      deltas: {},
    };
  }

  const violations: string[] = [];
  const deltas: Record<string, MetricDelta> = {};

  if (run.reward < entry.reward) {
    violations.push(`reward ${run.reward} < baseline ${entry.reward}`);
  }

  for (const metric of COST_METRICS) {
    const base = entry[metric];
    const value = run[metric];
    if (base === undefined || value === undefined || base === 0) continue;
    const ratio = value / base;
    deltas[metric] = { baseline: base, run: value, ratio };
    if (ratio > tolerance) {
      violations.push(`${metric} ${value} > baseline ${base} x ${tolerance}`);
    }
  }

  return { case: run.case, ok: violations.length === 0, violations, deltas };
}
