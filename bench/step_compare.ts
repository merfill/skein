// Normalized step/token comparison across sandbox runs, whichever agent produced them.
// Reads each run's `metrics.json` and detects its shape:
//   - Skein: { totals, byTool, byOperator, perTurn } (tests/sandbox/metrics.ts).
//   - opencode: { agent, metric: { steps, toolCalls, inputTokens, ... byTool } }.
// For the Skein reasoning-by-phase table, run `bench/reasoning-breakdown.ts` on the same dir.
//
//   npx tsx bench/step_compare.ts <run-dir> [<run-dir> ...]
import { readFileSync } from "node:fs";
import { basename } from "node:path";

interface Normalized {
  name: string;
  agent: string;
  network: string;
  reward: number | null;
  steps: number;
  toolCalls: number;
  input: number;
  output: number;
  reasoning: number;
  visible: number;
  cacheRead: number;
  elapsedMs: number | null;
  byTool: Record<string, number>;
}

interface RawMetrics {
  agent?: string;
  network?: string;
  reward?: number;
  elapsedMs?: number;
  perTurn?: unknown[];
  totals?: Record<string, number>;
  byTool?: Record<string, { calls: number }>;
  metric?: Record<string, number> & { byTool?: Record<string, number> };
}

function normalize(dir: string): Normalized {
  const raw = JSON.parse(readFileSync(`${dir}/metrics.json`, "utf8")) as RawMetrics;
  if (raw.perTurn !== undefined) {
    const totals = raw.totals ?? {};
    const byTool: Record<string, number> = {};
    for (const [tool, bucket] of Object.entries(raw.byTool ?? {})) {
      byTool[tool] = bucket.calls;
    }
    return {
      name: basename(dir),
      agent: "skein",
      network: raw.network ?? "-",
      reward: raw.reward ?? null,
      steps: totals.turns ?? 0,
      toolCalls: totals.toolCalls ?? 0,
      input: totals.inputTokens ?? 0,
      output: totals.outputTokens ?? 0,
      reasoning: totals.reasoningTokens ?? 0,
      visible: totals.visibleOutput ?? 0,
      cacheRead: totals.cacheRead ?? 0,
      elapsedMs: raw.elapsedMs ?? null,
      byTool,
    };
  }
  const metric = raw.metric ?? {};
  return {
    name: basename(dir),
    agent: raw.agent ?? "opencode",
    network: raw.network ?? "-",
    reward: raw.reward ?? null,
    steps: metric.steps ?? 0,
    toolCalls: metric.toolCalls ?? 0,
    input: metric.inputTokens ?? 0,
    output: metric.outputTokens ?? 0,
    reasoning: metric.reasoningTokens ?? 0,
    visible: metric.visibleOutput ?? 0,
    cacheRead: metric.cacheRead ?? 0,
    elapsedMs: raw.elapsedMs ?? null,
    byTool: metric.byTool ?? {},
  };
}

function column(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function secs(ms: number | null): string {
  return ms === null ? "-" : `${Math.round(ms / 1000)}s`;
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("usage: npx tsx bench/step_compare.ts <run-dir> [<run-dir> ...]");
  process.exit(1);
}

const runs = dirs.map(normalize);
console.info(
  `${column("run", 42)}${column("agent", 10)}${column("net", 6)}${column("rew", 5)}${column("steps", 7)}` +
    `${column("calls", 7)}${column("input", 10)}${column("output", 10)}${column("reason", 10)}${column("visible", 9)}` +
    `${column("cacheR", 10)}${column("time", 7)}`,
);
for (const run of runs) {
  console.info(
    `${column(run.name, 42)}${column(run.agent, 10)}${column(String(run.network), 6)}${column(String(run.reward), 5)}` +
      `${column(String(run.steps), 7)}${column(String(run.toolCalls), 7)}${column(String(run.input), 10)}` +
      `${column(String(run.output), 10)}${column(String(run.reasoning), 10)}${column(String(run.visible), 9)}` +
      `${column(String(run.cacheRead), 10)}${column(secs(run.elapsedMs), 7)}`,
  );
}

const tools = [...new Set(runs.flatMap((run) => Object.keys(run.byTool)))].sort();
console.info(`\ntool calls:`);
console.info(`${column("tool", 14)}${runs.map((run) => column(run.agent.slice(0, 12), 14)).join("")}`);
for (const tool of tools) {
  const cells = runs.map((run) => column(String(run.byTool[tool] ?? 0), 14)).join("");
  console.info(`${column(tool, 14)}${cells}`);
}
