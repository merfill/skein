// Skein-vs-opencode comparison over a Harbor job (or the latest one).
//
//   npx tsx bench/agents_compare.ts [jobDir]
//
// Both agents write per-call token usage in different shapes:
//   - Skein (langgraph): agent/langgraph-run.log, `SKEIN_TURN` lines
//     (`inputTokens` per turn) and one `SKEIN_METRICS` summary line.
//   - opencode: agent/opencode.txt, one `step-finish` per LLM call carrying
//     `tokens.{input,output,reasoning,cache.read}` and one `tool_use` per tool call.
//     Its `trajectory.json` final_metrics has no reasoning/step breakdown.
//
// The report this feeds: docs/benches/bench_report.md §4.4.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseOpenCodeStream } from "../tests/sandbox/opencode-metrics";

interface Trial {
  agent: string;
  task: string;
  reward: number | null;
  solves: boolean;
  llmCalls: number;
  toolCalls: number;
  promptTokens: number[];
  cacheRead: number;
  inputTotal: number;
  outputTotal: number;
  // Hidden reasoning tokens within outputTotal (0 when not reported).
  reasoningTotal: number;
  cost: number;
  costUnit: string;
  exception: string | null;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function rewardOf(trialDir: string): number | null {
  const raw = readText(join(trialDir, "verifier", "reward.txt"))?.trim();
  if (raw !== undefined && raw !== null && raw !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  const result = readJson(join(trialDir, "result.json"));
  const reward = result?.reward;
  return typeof reward === "number" ? reward : null;
}

function parseSkein(trialDir: string): Omit<Trial, "agent" | "task" | "reward" | "solves" | "exception"> | null {
  const log = readText(join(trialDir, "agent", "langgraph-run.log"));
  if (log === null) return null;
  const promptTokens: number[] = [];
  let llmCalls = 0;
  let cacheRead = 0;
  let inputTotal = 0;
  let outputTotal = 0;
  let reasoningTotal = 0;
  let cost = 0;
  for (const line of log.split("\n")) {
    if (!line.startsWith("SKEIN_TURN ")) continue;
    const turn = JSON.parse(line.slice("SKEIN_TURN ".length)) as {
      inputTokens?: number;
      outputTokens?: number;
      reasoningTokens?: number;
      cacheRead?: number;
      llmCalls?: number;
      cost?: number | null;
    };
    if (typeof turn.inputTokens === "number") {
      promptTokens.push(turn.inputTokens);
      inputTotal += turn.inputTokens;
    }
    if (typeof turn.outputTokens === "number") outputTotal += turn.outputTokens;
    if (typeof turn.reasoningTokens === "number") reasoningTotal += turn.reasoningTokens;
    if (typeof turn.cacheRead === "number") cacheRead += turn.cacheRead;
    if (typeof turn.llmCalls === "number") llmCalls += turn.llmCalls;
    if (typeof turn.cost === "number") cost += turn.cost;
  }
  const metricsLine = log.split("\n").find((line) => line.startsWith("SKEIN_METRICS "));
  let toolCalls = 0;
  if (metricsLine !== undefined) {
    const metrics = JSON.parse(metricsLine.slice("SKEIN_METRICS ".length)) as {
      toolCalls?: number;
      outputTokens?: number;
      reasoningTokens?: number;
    };
    toolCalls = metrics.toolCalls ?? 0;
    if (typeof metrics.outputTokens === "number") outputTotal = metrics.outputTokens;
    if (typeof metrics.reasoningTokens === "number") reasoningTotal = metrics.reasoningTokens;
  }
  return {
    promptTokens,
    llmCalls: llmCalls || promptTokens.length,
    toolCalls,
    cacheRead,
    inputTotal,
    outputTotal,
    reasoningTotal,
    cost,
    costUnit: "₽",
  };
}

// opencode streams one `step-finish` per LLM call (tokens per call, incl. hidden
// reasoning and cache) and one `tool_use` per tool call. `trajectory.json` final_metrics
// only carries input/output/cached totals, no reasoning — so parse the stream.
function parseOpencodeStream(text: string): Omit<Trial, "agent" | "task" | "reward" | "solves" | "exception"> {
  const metric = parseOpenCodeStream(text);
  return {
    promptTokens: metric.perCall,
    llmCalls: metric.steps,
    toolCalls: metric.toolCalls,
    cacheRead: metric.cacheRead,
    inputTotal: metric.inputTokens,
    // Total completion = visible output + hidden reasoning, so `out` is comparable with
    // Skein's `outputTokens` (which bundles reasoning in the old runs).
    outputTotal: metric.outputTokens,
    reasoningTotal: metric.reasoningTokens,
    cost: 0,
    costUnit: "$",
  };
}

function parseOpencode(trialDir: string): Omit<Trial, "agent" | "task" | "reward" | "solves" | "exception"> | null {
  const stream = readText(join(trialDir, "agent", "opencode.txt"));
  if (stream !== null && stream.includes('"type":"step-finish"')) {
    return parseOpencodeStream(stream);
  }
  const traj = readJson(join(trialDir, "agent", "trajectory.json"));
  if (traj === null) return null;
  const final = (traj.final_metrics as Record<string, number> | undefined) ?? {};
  const steps = (traj.steps as Record<string, unknown>[] | undefined) ?? [];
  return {
    promptTokens: [],
    llmCalls: steps.filter((s) => s.source === "agent").length,
    toolCalls: 0,
    cacheRead: final.total_cached_tokens ?? 0,
    inputTotal: final.total_prompt_tokens ?? 0,
    outputTotal: final.total_completion_tokens ?? 0,
    reasoningTotal: 0,
    cost: final.total_cost_usd ?? 0,
    costUnit: "$",
  };
}

function latestJobDir(): string {
  const root = join(homedir(), ".skein-bench", "harbor");
  const dirs = readdirSync(root)
    .map((name) => join(root, name))
    .filter((path) => statSync(path).isDirectory())
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
  const latest = dirs[dirs.length - 1];
  if (latest === undefined) throw new Error(`no jobs under ${root}`);
  return latest;
}

function collect(jobDir: string): Trial[] {
  const trials: Trial[] = [];
  for (const name of readdirSync(jobDir)) {
    const dir = join(jobDir, name);
    if (!statSync(dir).isDirectory() || !name.includes("__")) continue;
    const result = readJson(join(dir, "result.json"));
    const config = result?.config as { agent?: { name?: string } } | undefined;
    // result.json is only fully written when the trial finishes; fall back to
    // the directory layout so partial jobs still resolve.
    const inferred = existsSync(join(dir, "agent", "langgraph-run.log")) ? "langgraph" : "opencode";
    const agent = config?.agent?.name ?? inferred;
    const task = (result?.task_name as string | undefined) ?? name.split("__")[0] ?? name;
    const parsed = agent === "opencode" ? parseOpencode(dir) : parseSkein(dir);
    if (parsed === null) continue;
    const reward = rewardOf(dir);
    const exception = (result?.exception_info as { exception_type?: string } | undefined)?.exception_type ?? null;
    trials.push({ agent, task, reward, solves: reward === 1, exception, ...parsed });
  }
  return trials;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function k(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

function summarize(label: string, trials: Trial[]): void {
  if (trials.length === 0) {
    console.log(`${label}: no trials`);
    return;
  }
  const solved = trials.filter((t) => t.solves).length;
  // A run killed by a timeout never flushes SKEIN_METRICS/SKEIN_TURN: keep it in the
  // solved count but out of the token/call means (else zeros dilute them).
  const withData = trials.filter((t) => t.llmCalls > 0 || t.inputTotal > 0);
  const base = withData.length > 0 ? withData : trials;
  const ctx = base.flatMap((t) => t.promptTokens);
  const cacheRead = base.reduce((a, t) => a + t.cacheRead, 0);
  const inputTotal = base.reduce((a, t) => a + t.inputTotal, 0);
  const cacheShare = inputTotal === 0 ? 0 : (cacheRead / inputTotal) * 100;
  const ctxStat =
    ctx.length === 0
      ? "n/a"
      : `${k(Math.min(...ctx))}/${k(median(ctx))}/${k(mean(ctx))}/${k(Math.max(...ctx))}`;
  const costUnit = trials[0]?.costUnit ?? "";
  const dataNote = withData.length < trials.length ? ` (metrics n=${withData.length})` : "";
  console.log(
    [
      label.padEnd(24),
      `solved ${solved}/${trials.length}`,
      `llm ${mean(base.map((t) => t.llmCalls)).toFixed(0)}`,
      `tools ${mean(base.map((t) => t.toolCalls)).toFixed(0)}`,
      `tok in/out ${k(mean(base.map((t) => t.inputTotal)))}/${k(mean(base.map((t) => t.outputTotal)))}`,
      `reason ${k(mean(base.map((t) => t.reasoningTotal)))}`,
      `ctx ${ctxStat}`,
      `cache ${cacheShare.toFixed(0)}%`,
      `cost ${mean(base.map((t) => t.cost)).toFixed(2)}${costUnit}${dataNote}`,
    ].join("  "),
  );
}

function main(): void {
  const arg = process.argv[2];
  const jobDir = arg !== undefined ? arg : latestJobDir();
  console.log(`job ${jobDir}`);
  const trials = collect(jobDir);
  const agents = [...new Set(trials.map((t) => t.agent))].sort();
  for (const agent of agents) summarize(agent, trials.filter((t) => t.agent === agent));
  console.log("");
  for (const task of [...new Set(trials.map((t) => t.task))].sort()) {
    const rows = trials.filter((t) => t.task === task);
    for (const agent of agents) {
      const sub = rows.filter((t) => t.agent === agent);
      if (sub.length > 0) summarize(`${task}/${agent}`.slice(0, 24), sub);
    }
  }
  const failed = trials.filter((t) => !t.solves);
  if (failed.length > 0) {
    console.log("");
    console.log("unsolved trials (reward != 1):");
    for (const t of failed) {
      console.log(`  ${t.task}/${t.agent}  reward=${t.reward ?? "n/a"}  ${t.exception ?? "no exception"}`);
    }
  }
}

main();
