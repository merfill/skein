import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadSettings } from "../../src/config/settings";
import {
  aggregate,
  buildCells,
  isSupported,
  type Agent,
  type AggregateRow,
  type CellResult,
} from "./matrix";
import type { NetworkMode } from "./network";
import { DEFAULT_MODEL as OPENCODE_DEFAULT_MODEL } from "./opencode";
import { taskCacheDir } from "./task";
import { TASKS } from "./tasks/registry";

// A whole-task campaign on top of `matrix.ts`: the 13 ported terminal-bench tasks, every
// agent × net × repeat cell, one task at a time. `--concurrency` is the TOTAL number of
// simultaneous cells (containers) because only one matrix runs at a time — 5 means 5, not
// 5 per task. `net on|off` are ordinary grid values: each cell is its own child process, so
// the `off` allowlist proxy env stays isolated.
//
//   SKEIN_LIVE=true npx tsx tests/sandbox/campaign.ts --repeat 5 --concurrency 5
//   ... --concurrency 10 --task-concurrency fix-ocaml-gc=3
//
// `--task-concurrency` overrides the cell limit for one task (the OCaml verifier build is
// CPU-heavy). No wall-clock timeout is passed (the batch protocol): a cell ends on its turn
// budget or the verifier. `--dry` prints the grid and the commands without running anything.
// Owner's go-ahead required: this launches real containers and costs model calls.

const AGENTS: Agent[] = ["skein", "opencode"];
const NETS: NetworkMode[] = ["on", "off"];

interface Options {
  tasks: string[];
  agents: Agent[];
  nets: NetworkMode[];
  repeat: number;
  concurrency: number;
  taskConcurrency: Record<string, number>;
  out: string;
  resume: boolean;
  onlyFailed: boolean;
  dry: boolean;
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

function list<T extends string>(value: string, allowed: readonly T[], flag: string): T[] {
  const items = value.split(",").map((item) => item.trim()).filter((item) => item !== "");
  if (items.length === 0) throw new Error(`${flag} needs at least one value from: ${allowed.join(", ")}`);
  for (const item of items) {
    if (!allowed.includes(item as T)) {
      throw new Error(`${flag}: unknown value "${item}"; expected one of: ${allowed.join(", ")}`);
    }
  }
  return items as T[];
}

function positive(value: string, flag: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${flag} must be a positive number, got "${value}"`);
  return Math.floor(number);
}

function taskConcurrencyOverrides(value: string): Record<string, number> {
  const overrides: Record<string, number> = {};
  for (const pair of value.split(",").map((item) => item.trim()).filter((item) => item !== "")) {
    const [id, raw] = pair.split("=");
    if (id === undefined || raw === undefined || id === "") {
      throw new Error(`--task-concurrency expects task=n, got "${pair}"`);
    }
    if (TASKS[id] === undefined) throw new Error(`--task-concurrency: unknown task "${id}"`);
    overrides[id] = positive(raw, "--task-concurrency");
  }
  return overrides;
}

function optionsOf(): Options {
  const taskNames = Object.keys(TASKS);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return {
    tasks: list(arg("--tasks", taskNames.join(",")), taskNames, "--tasks"),
    agents: list(arg("--agents", AGENTS.join(",")), AGENTS, "--agents"),
    nets: list(arg("--nets", NETS.join(",")), NETS, "--nets"),
    repeat: positive(arg("--repeat", "5"), "--repeat"),
    concurrency: positive(arg("--concurrency", "5"), "--concurrency"),
    taskConcurrency: taskConcurrencyOverrides(arg("--task-concurrency", "")),
    out: arg("--out", join("bench", "runs", "matrix", `campaign-${ts}`)),
    resume: process.argv.includes("--resume"),
    onlyFailed: process.argv.includes("--only-failed"),
    dry: process.argv.includes("--dry"),
  };
}

function concurrencyFor(options: Options, id: string): number {
  return options.taskConcurrency[id] ?? options.concurrency;
}

function gitCommit(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  return result.status === 0 ? (result.stdout ?? "").trim() : "unknown";
}

function dockerAvailable(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 }).status === 0;
}

function opencodeAvailable(): boolean {
  const bin = process.env.OPENCODE_BIN ?? join(homedir(), ".opencode", "bin", "opencode");
  return existsSync(bin);
}

function planOf(options: Options): { task: string; cells: number; runnable: number; command: string }[] {
  return options.tasks.map((id) => {
    const task = TASKS[id];
    if (task === undefined) throw new Error(`unknown task ${id}`);
    const cells = buildCells(options.agents, options.nets, options.repeat);
    const runnable = cells.filter((cell) => isSupported(task, cell.network)).length;
    const args = [
      "tests/sandbox/matrix.ts",
      id,
      "--agents",
      options.agents.join(","),
      "--nets",
      options.nets.join(","),
      "--repeat",
      String(options.repeat),
      "--concurrency",
      String(concurrencyFor(options, id)),
      "--max-steps",
      String(task.maxTurns ?? 80),
      "--out",
      join(options.out, id),
      ...(options.resume ? ["--resume"] : []),
      ...(options.onlyFailed ? ["--only-failed"] : []),
    ];
    return { task: id, cells: cells.length, runnable, command: `npx tsx ${args.join(" ")}` };
  });
}

function preflight(options: Options): void {
  if (options.dry) return;
  if (process.env.SKEIN_LIVE !== "true") {
    throw new Error("set SKEIN_LIVE=true to run a live campaign (or pass --dry)");
  }
  if (!dockerAvailable()) throw new Error("docker is not available");
  if (options.agents.includes("opencode") && !opencodeAvailable()) {
    throw new Error(
      "opencode binary not found (set OPENCODE_BIN or install it under ~/.opencode/bin/opencode)",
    );
  }
  const missing: string[] = [];
  for (const id of options.tasks) {
    try {
      taskCacheDir(id);
    } catch {
      missing.push(id);
    }
  }
  if (missing.length > 0) {
    throw new Error(`benchmark task cache missing for: ${missing.join(", ")}`);
  }
}

let current: ReturnType<typeof spawn> | undefined;

function runMatrix(args: string[]): Promise<number> {
  return new Promise((done) => {
    const child = spawn(join("node_modules", ".bin", "tsx"), args, {
      stdio: "inherit",
      env: process.env,
    });
    current = child;
    child.once("close", (code, signal) => {
      current = undefined;
      done(code ?? (signal !== null ? 1 : 0));
    });
    child.once("error", () => {
      current = undefined;
      done(1);
    });
  });
}

interface TaskSummary {
  task: string;
  aggregates: AggregateRow[];
  cells: CellResult[];
  error?: string;
}

function readSummary(dir: string, id: string): TaskSummary {
  const summaryPath = join(dir, "summary.json");
  const manifestPath = join(dir, "manifest.json");
  try {
    if (existsSync(summaryPath)) {
      const parsed = JSON.parse(readFileSync(summaryPath, "utf8")) as {
        task?: unknown;
        aggregates?: AggregateRow[];
        cells?: CellResult[];
      };
      return {
        task: typeof parsed.task === "string" ? parsed.task : id,
        aggregates: parsed.aggregates ?? [],
        cells: parsed.cells ?? [],
      };
    }
    if (existsSync(manifestPath)) {
      // Interrupted before `summary.json`: the manifest already carries the finished cells.
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        task?: unknown;
        cells?: CellResult[];
      };
      const cells = parsed.cells ?? [];
      return {
        task: typeof parsed.task === "string" ? parsed.task : id,
        aggregates: aggregate(cells),
        cells,
      };
    }
  } catch (error) {
    return {
      task: id,
      aggregates: [],
      cells: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return { task: id, aggregates: [], cells: [], error: "no summary or manifest" };
}

function k(value: number | null): string {
  if (value === null) return "-";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function statusLine(statuses: Record<string, number>): string {
  const entries = Object.entries(statuses).sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([status, count]) => `${status}:${count}`).join(" ");
}

function aggregateRow(row: AggregateRow): string {
  return (
    `| ${row.agent}/${row.network} | ${row.runs} | ${row.solved}/${row.runs} | ` +
    `${row.medianTurns ?? "-"} | ${row.medianCostRub === null ? "-" : `${row.medianCostRub.toFixed(3)}₽`} | ` +
    `${k(row.medianInputTokens)} | ${k(row.medianFreshInput)} | ${k(row.medianOutputTokens)} | ` +
    `${k(row.medianReasoningTokens)} | ${statusLine(row.statuses)} |`
  );
}

const AGG_HEADER =
  "| agent/net | runs | solved | turns | cost | in | fresh | out | rsn | statuses |\n" +
  "|---|---:|---:|---:|---:|---:|---:|---:|---:|---|";

function renderMarkdown(
  options: Options,
  protocol: Record<string, unknown>,
  tasks: TaskSummary[],
  overall: AggregateRow[],
  totals: Record<string, number>,
): string {
  const lines = [
    `# Skein campaign — ${String(protocol["generatedAt"])}`,
    "",
    "## Protocol",
    "",
    ...Object.entries(protocol).map(([key, value]) => `- **${key}**: ${String(value)}`),
    "",
    "## Overall",
    "",
    AGG_HEADER,
    ...overall.map(aggregateRow),
    "",
    `Cells: ${totals["cells"]} · runs: ${totals["runs"]} · solved: ${totals["solved"]} · ` +
      `cost: ${(totals["costRub"] ?? 0).toFixed(2)}₽`,
    "",
    "## By task",
    "",
    "| task | agent/net | runs | solved | turns | cost | in | fresh | out | rsn | statuses |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const task of tasks) {
    if (task.error !== undefined) {
      lines.push(`| ${task.task} | — | — | — | — | — | — | — | — | — | ${task.error} |`);
      continue;
    }
    for (const row of task.aggregates) {
      lines.push(
        `| ${task.task} | ${row.agent}/${row.network} | ${row.runs} | ${row.solved}/${row.runs} | ` +
          `${row.medianTurns ?? "-"} | ${row.medianCostRub === null ? "-" : `${row.medianCostRub.toFixed(3)}₽`} | ` +
          `${k(row.medianInputTokens)} | ${k(row.medianFreshInput)} | ${k(row.medianOutputTokens)} | ` +
          `${k(row.medianReasoningTokens)} | ${statusLine(row.statuses)} |`,
      );
    }
  }
  lines.push(
    "",
    "Notes: `cost` is reported by Skein only (opencode does not expose it); `fresh` is input",
    "minus the provider's prompt cache. A task that requires the network is `unsupported` for",
    "`net=off`. Cells run with no wall-clock timeout; the budget is the task's turn/steps cap.",
  );
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const options = optionsOf();
  const plan = planOf(options);
  const cells = plan.reduce((sum, entry) => sum + entry.cells, 0);
  const runnable = plan.reduce((sum, entry) => sum + entry.runnable, 0);

  if (options.dry) {
    console.info(
      `dry: ${options.tasks.length} tasks, ${cells} cells (${runnable} runnable), ` +
        `agents=${options.agents.join(",")} nets=${options.nets.join(",")} repeat=${options.repeat} ` +
        `concurrency=${options.concurrency} out=${options.out}`,
    );
    for (const entry of plan) console.info(`  ${entry.task}: ${entry.runnable}/${entry.cells}\n    ${entry.command}`);
    return;
  }

  preflight(options);
  const settings = loadSettings();
  const startedAt = new Date().toISOString();
  const protocol = {
    generatedAt: startedAt,
    gitCommit: gitCommit(),
    node: process.version,
    skeinModel: settings.model,
    skeinReasoningEffort: settings.reasoningEffort,
    opencodeModel: OPENCODE_DEFAULT_MODEL,
    opencodeReasoningEffort: "low",
    agents: options.agents.join(","),
    nets: options.nets.join(","),
    repeat: options.repeat,
    concurrency: options.concurrency,
    taskConcurrency:
      Object.entries(options.taskConcurrency)
        .map(([id, value]) => `${id}=${value}`)
        .join(",") || "none",
    tasks: options.tasks.join(","),
    resume: options.resume,
    timeout: "none",
  };
  mkdirSync(options.out, { recursive: true });
  writeFileSync(join(options.out, "manifest.json"), JSON.stringify(protocol, null, 2));
  console.info(
    `campaign: ${options.tasks.length} tasks, ${runnable}/${cells} cells, ` +
      `concurrency ${options.concurrency} (total simultaneous cells), out ${options.out}`,
  );

  let aborted = false;
  const onSignal = (): void => {
    if (aborted) return;
    aborted = true;
    console.info("\ninterrupted: forwarding to the running matrix (its cells stop)");
    current?.kill("SIGINT");
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  let failed = 0;
  for (const [index, entry] of plan.entries()) {
    if (aborted) break;
    const task = TASKS[entry.task];
    if (task === undefined) continue;
    console.info(`\n===== campaign ${index + 1}/${plan.length}: ${entry.task} (${entry.runnable}/${entry.cells}) =====`);
    const args = [
      "tests/sandbox/matrix.ts",
      entry.task,
      "--agents",
      options.agents.join(","),
      "--nets",
      options.nets.join(","),
      "--repeat",
      String(options.repeat),
      "--concurrency",
      String(concurrencyFor(options, entry.task)),
      "--max-steps",
      String(task.maxTurns ?? 80),
      "--out",
      join(options.out, entry.task),
      ...(options.resume ? ["--resume"] : []),
      ...(options.onlyFailed ? ["--only-failed"] : []),
    ];
    const code = await runMatrix(args);
    if (code !== 0) {
      failed += 1;
      console.error(`task ${entry.task}: matrix exited ${code}; continuing`);
    }
  }
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);

  const tasks = plan.map((entry) => readSummary(join(options.out, entry.task), entry.task));
  const allCells = tasks.flatMap((task) => task.cells);
  const overall = aggregate(allCells);
  const totals = {
    cells: allCells.length,
    runs: allCells.filter((cell) => cell.reward !== null).length,
    solved: allCells.filter((cell) => cell.reward === 1).length,
    costRub: allCells.reduce((sum, cell) => sum + (cell.costRub ?? 0), 0),
  };
  const finishedAt = new Date().toISOString();
  const payload = { ...protocol, finishedAt, totals, overall, tasks };
  writeFileSync(join(options.out, "summary.json"), JSON.stringify(payload, null, 2));
  writeFileSync(join(options.out, "summary.md"), renderMarkdown(options, { ...protocol, finishedAt }, tasks, overall, totals));
  writeFileSync(
    join(options.out, "summary.csv"),
    [
      "task,agent,net,runs,solved,median_turns,median_cost_rub,median_input,median_fresh,median_output,median_reasoning,statuses",
      ...tasks.flatMap((task) =>
        task.aggregates.map((row) =>
          [
            task.task,
            row.agent,
            row.network,
            row.runs,
            row.solved,
            row.medianTurns ?? "",
            row.medianCostRub ?? "",
            row.medianInputTokens ?? "",
            row.medianFreshInput ?? "",
            row.medianOutputTokens ?? "",
            row.medianReasoningTokens ?? "",
            `"${statusLine(row.statuses)}"`,
          ].join(","),
        ),
      ),
    ].join("\n") + "\n",
  );

  console.info("\n----- campaign aggregate -----");
  for (const row of overall) {
    console.info(
      `${row.agent}/net${row.network}`.padEnd(22) +
        ` runs=${row.runs} solved=${row.solved}/${row.runs} ` +
        `medianTurns=${row.medianTurns ?? "-"} ` +
        `medianCost=${row.medianCostRub === null ? "-" : `${row.medianCostRub.toFixed(3)}₽`} ` +
        `[${statusLine(row.statuses)}]`,
    );
  }
  console.info(
    `\ncells=${totals.cells} runs=${totals.runs} solved=${totals.solved} cost~${totals.costRub.toFixed(2)}₽`,
  );
  console.info(`summary: ${join(options.out, "summary.json")}`);
  console.info(`markdown: ${join(options.out, "summary.md")}`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
