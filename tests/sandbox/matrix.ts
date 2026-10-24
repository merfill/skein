import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { NetworkMode } from "./network";
import type { SandboxTask } from "./task";
import { TASKS } from "./tasks/registry";

// Live matrix for ONE task: every agent × network × repeat, in parallel child processes.
//   npx tsx tests/sandbox/matrix.ts <task-id> [--agents skein,opencode] [--nets on,off]
//     [--repeat K] [--concurrency N] [--timeout N] [--turns N] [--max-steps N]
//     [--out <dir>] [--resume] [--only-failed] [--dry]
// The task is an argument, not a baked-in list: the full campaign is one invocation per task
// (a shell loop outside). Each cell runs the existing single-run CLI in its own process, so
// the `--net off` proxy env stays isolated and a wall-clock timeout can kill the whole cell.
// Cost discipline: docs/task_testing.md §7. Live runs need the owner's go-ahead.

export type Agent = "skein" | "opencode";
export type CellStatus = "pending" | "running" | "ok" | "reward0" | "error" | "timeout" | "unsupported";

export interface Cell {
  agent: Agent;
  network: NetworkMode;
  repeat: number;
}

export interface CellResult extends Cell, CellMetrics {
  dir: string;
  status: CellStatus;
  elapsedMs: number | null;
  error?: string;
}

export interface CellMetrics {
  reward: number | null;
  turns: number | null;
  costRub: number | null;
  inputTokens: number | null;
  // Input that was not served from the provider's prompt cache: what the model actually
  // re-read this run. opencode reports only the total + cache reads, so it is derived.
  freshInput: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheRead: number | null;
}

export interface AggregateRow {
  agent: Agent;
  network: NetworkMode;
  // Cells that produced a reward (ok + reward0); errors/timeouts are counted in `statuses`.
  runs: number;
  solved: number;
  medianTurns: number | null;
  medianCostRub: number | null;
  medianElapsedMs: number | null;
  medianInputTokens: number | null;
  medianFreshInput: number | null;
  medianOutputTokens: number | null;
  medianReasoningTokens: number | null;
  statuses: Record<string, number>;
}

const AGENTS: Agent[] = ["skein", "opencode"];
const NETS: NetworkMode[] = ["on", "off"];

// A task that declares `network` needs it for the agent (crack-7z-hash); `off` is impossible,
// so such a cell is reported as `unsupported` instead of being run and failing.
export function isSupported(task: SandboxTask, network: NetworkMode): boolean {
  return !(task.network !== undefined && network === "off");
}

export function buildCells(agents: Agent[], nets: NetworkMode[], repeat: number): Cell[] {
  const cells: Cell[] = [];
  for (const agent of agents) {
    for (const network of nets) {
      for (let index = 1; index <= repeat; index += 1) cells.push({ agent, network, repeat: index });
    }
  }
  return cells;
}

export function cellDir(out: string, cell: Cell): string {
  return join(out, "cells", `${cell.agent}-net${cell.network}-r${cell.repeat}`);
}

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const NO_METRICS: CellMetrics = {
  reward: null,
  turns: null,
  costRub: null,
  inputTokens: null,
  freshInput: null,
  outputTokens: null,
  reasoningTokens: null,
  cacheRead: null,
};

// Skein and opencode write different `metrics.json` shapes; the summary needs the reward, the
// step/turn count, cost (Skein only) and the token breakdown — the primary comparison.
export function normalizeMetrics(agent: Agent, raw: unknown): CellMetrics {
  if (raw === null || typeof raw !== "object") return { ...NO_METRICS };
  const metrics = raw as Record<string, unknown>;
  const reward = finite(metrics.reward);
  if (agent === "opencode") {
    const metric = metrics.metric;
    const record = metric !== null && typeof metric === "object" ? (metric as Record<string, unknown>) : undefined;
    const inputTokens = finite(record?.inputTokens);
    const cacheRead = finite(record?.cacheRead);
    return {
      reward,
      turns: finite(record?.steps),
      costRub: null,
      inputTokens,
      freshInput: inputTokens !== null && cacheRead !== null ? inputTokens - cacheRead : null,
      outputTokens: finite(record?.outputTokens),
      reasoningTokens: finite(record?.reasoningTokens),
      cacheRead,
    };
  }
  const totals = metrics.totals;
  const record = totals !== null && typeof totals === "object" ? (totals as Record<string, unknown>) : undefined;
  const inputTokens = finite(record?.inputTokens);
  const cacheRead = finite(record?.cacheRead);
  return {
    reward,
    turns: finite(record?.turns),
    costRub: finite(record?.costRub),
    inputTokens,
    freshInput: finite(record?.freshInput) ?? (inputTokens !== null && cacheRead !== null ? inputTokens - cacheRead : null),
    outputTokens: finite(record?.outputTokens),
    reasoningTokens: finite(record?.reasoningTokens),
    cacheRead,
  };
}

// A finished cell has a parseable `metrics.json` with a numeric reward and no timeout marker.
// `--resume` skips only these; a partial or timed-out directory is rerun.
export function readCell(dir: string, agent: Agent): CellMetrics & { status: CellStatus } | null {
  const timedOut = existsSync(join(dir, ".timeout"));
  const path = join(dir, "metrics.json");
  if (!existsSync(path)) return timedOut ? { status: "timeout", ...NO_METRICS } : null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return timedOut ? { status: "timeout", ...NO_METRICS } : null;
  }
  const metrics = normalizeMetrics(agent, raw);
  if (metrics.reward === null) return null;
  if (timedOut) return { status: "timeout", ...metrics };
  return { status: metrics.reward === 1 ? "ok" : "reward0", ...metrics };
}

// The wall-clock of a finished cell survives `--resume`. The runner records it in
// `elapsed.json`; for cells from before that file existed, the cell dir's birth and the log's
// last write give the same full-cell wall (agent + verifier), unlike opencode's agent-only
// `metrics.elapsedMs`.
function readElapsed(dir: string): number | null {
  const path = join(dir, "elapsed.json");
  if (existsSync(path)) {
    try {
      const value = finite((JSON.parse(readFileSync(path, "utf8")) as { elapsedMs?: unknown }).elapsedMs);
      if (value !== null) return value;
    } catch {
      // fall back to the filesystem timestamps
    }
  }
  try {
    const birth = statSync(dir).birthtimeMs;
    const end = statSync(join(dir, "run.log")).mtimeMs;
    if (birth > 0 && end >= birth) return end - birth;
  } catch {
    // no log (e.g. a cell that never started)
  }
  return null;
}

export function median(values: number[]): number | null {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

export function aggregate(results: CellResult[]): AggregateRow[] {
  const groups = new Map<string, CellResult[]>();
  for (const result of results) {
    const key = `${result.agent}/${result.network}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [result]);
    else group.push(result);
  }
  const rows: AggregateRow[] = [];
  for (const group of groups.values()) {
    const first = group[0] as CellResult;
    const finished = group.filter((result) => result.reward !== null);
    const statuses: Record<string, number> = {};
    for (const result of group) statuses[result.status] = (statuses[result.status] ?? 0) + 1;
    const numbers = (pick: (result: CellResult) => number | null): number[] =>
      finished.map(pick).filter((value): value is number => value !== null);
    rows.push({
      agent: first.agent,
      network: first.network,
      runs: finished.length,
      solved: finished.filter((result) => result.reward === 1).length,
      medianTurns: median(numbers((result) => result.turns)),
      medianCostRub: median(numbers((result) => result.costRub)),
      medianElapsedMs: median(numbers((result) => result.elapsedMs)),
      medianInputTokens: median(numbers((result) => result.inputTokens)),
      medianFreshInput: median(numbers((result) => result.freshInput)),
      medianOutputTokens: median(numbers((result) => result.outputTokens)),
      medianReasoningTokens: median(numbers((result) => result.reasoningTokens)),
      statuses,
    });
  }
  return rows;
}

interface Manifest {
  task: string;
  agents: Agent[];
  nets: NetworkMode[];
  repeat: number;
  concurrency: number;
  timeoutSeconds: number;
  startedAt: string;
  updatedAt: string;
  cells: CellResult[];
}

const MANIFEST_TMP = `${process.pid}`;

export function writeManifest(out: string, manifest: Manifest): void {
  mkdirSync(out, { recursive: true });
  const path = join(out, "manifest.json");
  const tmp = `${path}.${MANIFEST_TMP}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  renameSync(tmp, path);
}

interface Options {
  task: string;
  agents: Agent[];
  nets: NetworkMode[];
  repeat: number;
  concurrency: number;
  timeoutSeconds: number;
  turns: number | undefined;
  maxSteps: number | undefined;
  out: string;
  resume: boolean;
  onlyFailed: boolean;
  dry: boolean;
}

function parseList(value: string, allowed: readonly string[], flag: string): string[] {
  const items = value.split(",").map((item) => item.trim()).filter((item) => item !== "");
  if (items.length === 0) throw new Error(`${flag} needs at least one value from: ${allowed.join(", ")}`);
  for (const item of items) {
    if (!allowed.includes(item)) throw new Error(`${flag}: unknown value "${item}"; expected one of: ${allowed.join(", ")}`);
  }
  return items;
}

function positive(value: string, flag: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${flag} must be a positive number, got "${value}"`);
  return number;
}

function parseOptions(argv: string[]): Options {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const booleans = new Set(["--resume", "--only-failed", "--dry"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (booleans.has(token)) {
      flags.set(token, true);
    } else if (token.startsWith("--")) {
      flags.set(token, argv[index + 1] ?? "");
      index += 1;
    } else {
      positional.push(token);
    }
  }
  const task = positional[0];
  if (task === undefined) throw new Error("usage: matrix.ts <task-id> [--agents skein,opencode] [--nets on,off] [--repeat K]");

  const flag = (name: string): string | undefined => {
    const value = flags.get(name);
    return typeof value === "string" ? value : undefined;
  };
  const agents = (flag("--agents") === undefined ? AGENTS : parseList(flag("--agents") as string, AGENTS, "--agents")) as Agent[];
  const nets = (flag("--nets") === undefined ? NETS : parseList(flag("--nets") as string, NETS, "--nets")) as NetworkMode[];
  const repeat = flag("--repeat") === undefined ? 1 : Math.floor(positive(flag("--repeat") as string, "--repeat"));
  const concurrency = flag("--concurrency") === undefined ? 5 : Math.floor(positive(flag("--concurrency") as string, "--concurrency"));
  const timeoutSeconds = flag("--timeout") === undefined ? 1800 : Math.floor(positive(flag("--timeout") as string, "--timeout"));
  const turns = flag("--turns") === undefined ? undefined : Math.floor(positive(flag("--turns") as string, "--turns"));
  const maxSteps = flag("--max-steps") === undefined ? undefined : Math.floor(positive(flag("--max-steps") as string, "--max-steps"));
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const out = flag("--out") ?? join("bench", "runs", "matrix", `${ts}-${task}`);
  return {
    task,
    agents,
    nets,
    repeat,
    concurrency,
    timeoutSeconds,
    turns,
    maxSteps,
    out,
    resume: flags.get("--resume") === true,
    onlyFailed: flags.get("--only-failed") === true,
    dry: flags.get("--dry") === true,
  };
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
}

// Children currently running, so Ctrl-C stops the in-flight cells instead of orphaning them.
const running = new Set<ReturnType<typeof spawn>>();

function cellArgs(task: SandboxTask, cell: CellResult, options: Options): string[] {
  const shared = ["--net", cell.network, "--dir", cell.dir];
  if (cell.agent === "skein") {
    return [
      join("tests", "sandbox", "sandbox-run.ts"),
      task.id,
      ...shared,
      ...(options.turns !== undefined ? ["--turns", String(options.turns)] : []),
    ];
  }
  return [
    join("tests", "sandbox", "opencode-run.ts"),
    task.id,
    ...shared,
    "--seconds",
    String(options.timeoutSeconds),
    ...(options.maxSteps !== undefined ? ["--steps", String(options.maxSteps)] : []),
  ];
}

// Remove the containers a killed cell left behind. The cell's container names carry the
// `SKEIN_CONTAINER_PREFIX` the runner set, so this works regardless of the pid inside the
// child (tsx may re-exec node in a grandchild process).
export function killContainers(prefix: string): void {
  const listed = spawnSync("docker", ["ps", "-aq", "--filter", `name=skein-${prefix}-`], { encoding: "utf8", timeout: 60_000 });
  const ids = (listed.stdout ?? "").split(/\s+/).filter((id) => id !== "");
  if (ids.length > 0) spawnSync("docker", ["rm", "-f", ...ids], { encoding: "utf8", timeout: 120_000 });
}

async function runCell(task: SandboxTask, cell: CellResult, options: Options): Promise<CellMetrics & { status: CellStatus; elapsedMs: number; error?: string }> {
  rmSync(cell.dir, { recursive: true, force: true });
  mkdirSync(cell.dir, { recursive: true });
  // Include the task and the matrix process: parallel matrices started in the same
  // millisecond otherwise share a prefix, and `killContainers` would remove each other's
  // cells (a finished cell calls it as a safety net).
  const prefix = `matrix-${task.id}-${cell.agent}-${cell.network}-r${cell.repeat}-${process.pid}-${Date.now().toString(36)}`;
  const started = Date.now();
  // No `TMPDIR` override: tsx keeps its IPC socket under it and opencode's legacy Docker path
  // bind-mounts the sandbox root (a relative `-v` source is read as a named volume). Isolation
  // between cells is the child process itself; the child cleans its own sandbox roots.
  const child = spawn(join("node_modules", ".bin", "tsx"), cellArgs(task, cell, options), {
    cwd: process.cwd(),
    env: { ...process.env, SKEIN_CONTAINER_PREFIX: prefix },
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.add(child);
  child.once("close", () => running.delete(child));
  child.once("error", () => running.delete(child));
  const log = createWriteStream(join(cell.dir, "run.log"));
  const tail: string[] = [];
  const capture = (chunk: Buffer): void => {
    log.write(chunk);
    for (const line of String(chunk).split("\n")) {
      if (line === "") continue;
      tail.push(line);
      if (tail.length > 60) tail.shift();
    }
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
  }, options.timeoutSeconds * 1000);

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.once("close", (code, signal) => done({ code, signal }));
    child.once("error", () => done({ code: null, signal: null }));
  });
  clearTimeout(deadline);
  await new Promise<void>((done) => log.end(done));
  killContainers(prefix);
  const elapsedMs = Date.now() - started;
  writeFileSync(join(cell.dir, "elapsed.json"), JSON.stringify({ elapsedMs }));

  if (timedOut) {
    writeFileSync(join(cell.dir, ".timeout"), new Date().toISOString());
    return { status: "timeout", ...NO_METRICS, elapsedMs };
  }
  const finished = readCell(cell.dir, cell.agent);
  if (finished === null) {
    const detail = tail.slice(-6).join(" | ");
    return {
      status: "error",
      ...NO_METRICS,
      elapsedMs,
      error: `no metrics (exit ${exit.code ?? exit.signal ?? "?"})${detail === "" ? "" : `: ${detail}`}`,
    };
  }
  return { ...finished, elapsedMs };
}

function shouldRun(result: CellResult, options: Options): boolean {
  if (result.status === "unsupported") return false;
  if (options.onlyFailed) return result.status !== "ok";
  if (options.resume) return result.status === "pending" || result.status === "error" || result.status === "timeout";
  return true;
}

function initialResults(task: SandboxTask, options: Options): CellResult[] {
  return buildCells(options.agents, options.nets, options.repeat).map((cell) => {
    const dir = cellDir(options.out, cell);
    if (!isSupported(task, cell.network)) {
      return { ...cell, dir, status: "unsupported", ...NO_METRICS, elapsedMs: null };
    }
    const existing = readCell(dir, cell.agent);
    if (existing === null) {
      return { ...cell, dir, status: "pending", ...NO_METRICS, elapsedMs: null };
    }
    return { ...cell, dir, ...existing, elapsedMs: readElapsed(dir) };
  });
}

const k = (value: number | null): string =>
  value === null ? "-" : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);

function formatRow(result: CellResult): string {
  const cost = result.costRub === null ? "-" : `${result.costRub.toFixed(3)}₽`;
  const elapsed = result.elapsedMs === null ? "-" : `${(result.elapsedMs / 1000).toFixed(0)}s`;
  return (
    `${`${result.agent}-net${result.network}-r${result.repeat}`.padEnd(22)} ` +
    `${result.status.padEnd(12)} reward=${String(result.reward ?? "-").padEnd(2)} ` +
    `turns=${String(result.turns ?? "-").padStart(3)} cost=${cost.padStart(7)} ${elapsed.padStart(5)} ` +
    `in=${k(result.inputTokens)} fresh=${k(result.freshInput)} out=${k(result.outputTokens)} reason=${k(result.reasoningTokens)}`
  );
}

function printSummary(task: SandboxTask, results: CellResult[], startedAt: string, out: string): void {
  console.info(`\n===== MATRIX ${task.id} =====`);
  for (const result of results) console.info(formatRow(result));
  console.info("\n----- aggregate -----");
  for (const row of aggregate(results)) {
    const statuses = Object.entries(row.statuses).map(([status, count]) => `${status}:${count}`).join(" ");
    console.info(
      `${`${row.agent}/net${row.network}`.padEnd(22)} runs=${row.runs} solved=${row.solved}/${row.runs} ` +
        `medianTurns=${row.medianTurns ?? "-"} medianCost=${row.medianCostRub === null ? "-" : `${row.medianCostRub.toFixed(3)}₽`} ` +
        `medianWall=${row.medianElapsedMs === null ? "-" : `${(row.medianElapsedMs / 1000).toFixed(0)}s`}\n` +
        `${"".padEnd(22)} medianTokens in=${k(row.medianInputTokens)} fresh=${k(row.medianFreshInput)} ` +
        `out=${k(row.medianOutputTokens)} reason=${k(row.medianReasoningTokens)} [${statuses}]`,
    );
  }
  const totalCost = results.reduce((sum, result) => sum + (result.costRub ?? 0), 0);
  console.info(`\ntotal cost ~${totalCost.toFixed(2)}₽  wall ${((Date.now() - Date.parse(startedAt)) / 60000).toFixed(1)}min`);
  console.info(`trace: ${out}`);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const task = TASKS[options.task];
  if (task === undefined) throw new Error(`unknown task ${options.task}; known: ${Object.keys(TASKS).join(", ")}`);

  const results = initialResults(task, options);
  const queue = results.filter((result) => shouldRun(result, options));
  const manifest: Manifest = {
    task: task.id,
    agents: options.agents,
    nets: options.nets,
    repeat: options.repeat,
    concurrency: options.concurrency,
    timeoutSeconds: options.timeoutSeconds,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cells: results,
  };

  if (options.dry) {
    console.info(`dry: ${task.id} — ${results.length} cells, ${queue.length} to run, concurrency ${options.concurrency}, timeout ${options.timeoutSeconds}s`);
    for (const result of results) console.info(formatRow(result));
    return;
  }

  mkdirSync(options.out, { recursive: true });
  writeManifest(options.out, manifest);
  console.info(`${task.id}: ${queue.length}/${results.length} cells, concurrency ${options.concurrency}, timeout ${options.timeoutSeconds}s, out ${options.out}`);

  // Ctrl-C stops the in-flight cells and does not start the queued ones. The cells already
  // written to `manifest.json` keep their status, so `--resume` picks up where this stopped.
  let aborted = false;
  const onSignal = (): void => {
    if (aborted) return;
    aborted = true;
    console.info("\ninterrupted: stopping in-flight cells (containers are removed by each child)");
    for (const child of running) child.kill("SIGTERM");
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  await pool(queue, options.concurrency, async (result) => {
    if (aborted) return;
    result.status = "running";
    writeManifest(options.out, manifest);
    const outcome = await runCell(task, result, options);
    const { status, elapsedMs, error, ...metrics } = outcome;
    Object.assign(result, metrics, { status, elapsedMs });
    if (error !== undefined) result.error = error;
    manifest.updatedAt = new Date().toISOString();
    writeManifest(options.out, manifest);
    console.info(formatRow(result));
  });
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);

  const summary = { task: task.id, generatedAt: new Date().toISOString(), aggregates: aggregate(results), cells: results };
  writeFileSync(join(options.out, "summary.json"), JSON.stringify(summary, null, 2));
  printSummary(task, results, manifest.startedAt, options.out);
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
