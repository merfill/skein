// Skein-vs-opencode comparison over a Harbor job (or the latest one).
//
//   npx tsx bench/agents_compare.ts [jobDir]
//
// Both agents write per-call token usage in different shapes:
//   - Skein (langgraph): agent/langgraph-run.log, `SKEIN_TURN` lines
//     (`inputTokens` per turn) and one `SKEIN_METRICS` summary line.
//   - opencode: agent/trajectory.json, one step per LLM call with
//     `metrics.prompt_tokens` (= input + cache, see harbor agents/opencode.py).
//
// The report this feeds: docs/bench_report.md §4.4.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
  let cost = 0;
  for (const line of log.split("\n")) {
    if (!line.startsWith("SKEIN_TURN ")) continue;
    const turn = JSON.parse(line.slice("SKEIN_TURN ".length)) as {
      inputTokens?: number;
      cacheRead?: number;
      llmCalls?: number;
      cost?: number | null;
    };
    if (typeof turn.inputTokens === "number") {
      promptTokens.push(turn.inputTokens);
      inputTotal += turn.inputTokens;
    }
    if (typeof turn.cacheRead === "number") cacheRead += turn.cacheRead;
    if (typeof turn.llmCalls === "number") llmCalls += turn.llmCalls;
    if (typeof turn.cost === "number") cost += turn.cost;
  }
  const metricsLine = log.split("\n").find((line) => line.startsWith("SKEIN_METRICS "));
  let toolCalls = 0;
  let outputTotal = 0;
  if (metricsLine !== undefined) {
    const metrics = JSON.parse(metricsLine.slice("SKEIN_METRICS ".length)) as {
      toolCalls?: number;
      outputTokens?: number;
    };
    toolCalls = metrics.toolCalls ?? 0;
    outputTotal = metrics.outputTokens ?? 0;
  }
  return {
    promptTokens,
    llmCalls: llmCalls || promptTokens.length,
    toolCalls,
    cacheRead,
    inputTotal,
    outputTotal,
    cost,
    costUnit: "₽",
  };
}

function parseOpencode(trialDir: string): Omit<Trial, "agent" | "task" | "reward" | "solves" | "exception"> | null {
  const traj = readJson(join(trialDir, "agent", "trajectory.json"));
  if (traj === null) return null;
  const steps = (traj.steps as Record<string, unknown>[] | undefined) ?? [];
  const agentSteps = steps.filter((step) => step.source === "agent");
  const promptTokens: number[] = [];
  let llmCalls = 0;
  let toolCalls = 0;
  for (const step of agentSteps) {
    const metrics = step.metrics as { prompt_tokens?: number } | undefined;
    if (typeof metrics?.prompt_tokens === "number") promptTokens.push(metrics.prompt_tokens);
    const count = step.llm_call_count;
    llmCalls += typeof count === "number" ? count : 1;
    const calls = step.tool_calls as unknown[] | undefined;
    toolCalls += calls?.length ?? 0;
  }
  const final = (traj.final_metrics as Record<string, number> | undefined) ?? {};
  const cacheRead = final.total_cached_tokens ?? 0;
  const inputTotal = final.total_prompt_tokens ?? promptTokens.reduce((a, b) => a + b, 0);
  return {
    promptTokens,
    llmCalls,
    toolCalls,
    cacheRead,
    inputTotal,
    outputTotal: final.total_completion_tokens ?? 0,
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
  const ctx = trials.flatMap((t) => t.promptTokens);
  const cacheRead = trials.reduce((a, t) => a + t.cacheRead, 0);
  const inputTotal = trials.reduce((a, t) => a + t.inputTotal, 0);
  const cacheShare = inputTotal === 0 ? 0 : (cacheRead / inputTotal) * 100;
  const ctxStat =
    ctx.length === 0
      ? "n/a"
      : `${k(Math.min(...ctx))}/${k(median(ctx))}/${k(mean(ctx))}/${k(Math.max(...ctx))}`;
  const costUnit = trials[0]?.costUnit ?? "";
  console.log(
    [
      label.padEnd(24),
      `solved ${solved}/${trials.length}`,
      `llm ${mean(trials.map((t) => t.llmCalls)).toFixed(0)}`,
      `tools ${mean(trials.map((t) => t.toolCalls)).toFixed(0)}`,
      `tok in/out ${k(mean(trials.map((t) => t.inputTotal)))}/${k(mean(trials.map((t) => t.outputTotal)))}`,
      `ctx ${ctxStat}`,
      `cache ${cacheShare.toFixed(0)}%`,
      `cost ${mean(trials.map((t) => t.cost)).toFixed(2)}${costUnit}`,
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
