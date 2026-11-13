import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadSettings } from "../../src/config/settings";
import type { Event } from "../../src/ir/events";
import { createChatModel } from "../../src/llm/client";
import { modelDocumentPlanAgent, modelDocumentTextAgent } from "../../src/llm/document";
import { modelGeneralProposer } from "../../src/llm/general";
import { modelPlannerAgent } from "../../src/llm/planner";
import { modelRevisionProposer } from "../../src/llm/revision";
import { createSessionAgentDeps } from "../../src/llm/session_agent";
import { probeSession } from "../../src/loop/probe";
import { propose as proposeModel } from "../../src/loop/propose";
import {
  executePlan,
  runSessionTurn,
  type SessionTurnDeps,
  type SessionTurnResult,
} from "../../src/session/driver";
import { createSession } from "../../src/session/session";
import { memoryTelemetry, usageTotals, type UsageTotals } from "../../src/session/telemetry";
import { cleanupContainers } from "./docker";
import {
  openTaskWorkspace,
  verifyOpenedTask,
  type OpenedTask,
  type TaskVerification,
} from "./harness";
import { parseNetworkMode, type NetworkMode } from "./network";
import { runOpenCodeTask } from "./opencode";
import type { SandboxTask } from "./task";
import { taskCacheDir } from "./task";
import { TASKS } from "./tasks/registry";
import { cleanupSandboxes } from "./workspace";

// One repository, three user lines in one session: an overview, a coding change, and the
// documentation of that change. Skein routes each line itself (no forced operation); opencode
// gets the same three lines via `opencode run --continue`. The coding change is graded by the
// task's own verifier; the overview and the document are captured for manual grading.
//
//   npx tsx tests/sandbox/session-scenario.ts --dry
//   SKEIN_LIVE=true npx tsx tests/sandbox/session-scenario.ts --repeat 3 --net off
//
// Owner's go-ahead required: a live run launches containers and costs model calls.

type Agent = "skein" | "opencode";

const AGENTS: Agent[] = ["skein", "opencode"];
const DEFAULT_TASK = "fix-code-vulnerability";

const OVERVIEW_REQUEST = [
  "Read and analyze this repository.",
  "Give me an overview of its structure, the main parts of bottle.py,",
  "and how HTTP request and response headers are handled.",
].join(" ");

const IDENTIFY_REQUEST = [
  "Which CWE category matches a missing control-character check in HTTP header names and values,",
  "and where is that vulnerability in /app/bottle.py? Identify the vulnerable code.",
].join(" ");

const REPORT_REQUEST = [
  "Create /app/report.jsonl with one line:",
  '{"file_path": "/app/bottle.py", "cwe_id": ["cwe-93"]}.',
].join(" ");

const FIX_REQUEST = [
  "Fix the vulnerability in /app/bottle.py:",
  "reject control characters in header names and values.",
].join(" ");

const TEST_REQUEST = "Run `pytest -rA` in /app and make sure everything passes.";

const DOCUMENT_REQUEST = [
  "Write a document at docs/security-fix.md describing the fix:",
  "the CWE-93 issue, the functions that changed, and why the new behavior is correct.",
  "Base it on the actual change in the repository.",
].join(" ");

interface Options {
  task: string;
  agents: Agent[];
  repeat: number;
  network: NetworkMode;
  out: string;
  dry: boolean;
  turns?: number;
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

function optionsOf(): Options {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const turns = arg("--turns", "");
  return {
    task: arg("--task", DEFAULT_TASK),
    agents: list(arg("--agents", AGENTS.join(",")), AGENTS, "--agents"),
    repeat: positive(arg("--repeat", "3"), "--repeat"),
    network: parseNetworkMode(arg("--net", "off")),
    out: arg("--out", join("bench", "runs", "session-scenario", ts)),
    dry: process.argv.includes("--dry"),
    ...(turns !== "" ? { turns: positive(turns, "--turns") } : {}),
  };
}

function utterances(): string[] {
  return [OVERVIEW_REQUEST, IDENTIFY_REQUEST, REPORT_REQUEST, FIX_REQUEST, TEST_REQUEST, DOCUMENT_REQUEST];
}

function resolvedOpenCodeBin(): string {
  const candidates = [
    process.env.OPENCODE_BIN,
    join(homedir(), ".opencode", "bin", "opencode"),
    spawnSync("sh", ["-c", "command -v opencode"], { encoding: "utf8" }).stdout?.trim(),
  ];
  return candidates.find((candidate): candidate is string => candidate !== undefined && candidate !== "" && existsSync(candidate)) ?? join(homedir(), ".opencode", "bin", "opencode");
}

function openCodeAvailable(): boolean {
  return existsSync(resolvedOpenCodeBin());
}

function dockerAvailable(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 }).status === 0;
}

function maxTurnsOf(settings: ReturnType<typeof loadSettings>, task: SandboxTask, options: Options): number {
  return options.turns ?? task.maxTurns ?? settings.maxTurns;
}

function lastStop(events: readonly Event[]): string | null {
  let text: string | null = null;
  for (const event of events) {
    if (event.type === "add_node" && event.node.kind === "stop") text = event.node.label;
  }
  return text;
}

function answerOf(result: SessionTurnResult): string | null {
  if (result.reply !== undefined) return result.reply;
  const unit =
    result.task?.result ??
    result.general?.result ??
    result.revision?.result ??
    result.document?.result ??
    result.plan?.result;
  return unit === undefined ? null : lastStop(unit.events);
}

interface TurnRecord {
  index: number;
  utterance: string;
  operation: string | null;
  reasoning: string | null;
  answer: string | null;
  turns: number | null;
  stopReason: string | null;
  plan?: { status: string; completed: number; total: number };
  usage: UsageTotals;
}

interface CellSummary {
  agent: Agent;
  repeat: number;
  reward: number;
  checkCode: number | null;
  dir: string;
  turns: number | null;
  steps: number | null;
  operations: (string | null)[];
  usage: UsageTotals | null;
  error?: string;
}

function capture(workspace: { read: (path: string) => string; run: (command: string) => { stdout: string; stderr: string } }, dir: string): void {
  try {
    writeFileSync(join(dir, "document.md"), workspace.read("docs/security-fix.md"));
  } catch {
    writeFileSync(join(dir, "document.md"), "");
  }
  const diff = workspace.run("git diff --no-color HEAD");
  writeFileSync(join(dir, "diff.txt"), diff.stdout !== "" ? diff.stdout : diff.stderr);
  const status = workspace.run("git status --porcelain");
  writeFileSync(join(dir, "status.txt"), status.stdout);
}

async function runSkeinCell(
  task: SandboxTask,
  options: Options,
  dir: string,
): Promise<CellSummary> {
  mkdirSync(dir, { recursive: true });
  const settings = loadSettings();
  const model = createChatModel(settings);
  const maxTurns = maxTurnsOf(settings, task, options);
  const telemetry = memoryTelemetry();
  const sessionDeps = createSessionAgentDeps(model, { settings });
  const generalBase = modelGeneralProposer(model, { settings });
  const revisionBase = modelRevisionProposer(model, { settings });
  const lines = utterances();

  let opened: OpenedTask | undefined;
  try {
    opened = openTaskWorkspace(task, { network: options.network });
    const deps: SessionTurnDeps = {
      sessionAgent: { ...sessionDeps, telemetry: telemetry.sink },
      task: {
        propose: (context) => proposeModel(model, context, { settings }),
        workspace: opened.workspace,
        maxTurns,
        probe: (workspace) => probeSession(workspace, { network: options.network }),
        telemetry: telemetry.sink,
      },
      general: {
        propose: generalBase,
        workspace: opened.workspace,
        maxTurns: settings.generalMaxTurns,
        telemetry: telemetry.sink,
      },
      revision: {
        propose: revisionBase,
        workspace: opened.workspace,
        maxTurns,
        telemetry: telemetry.sink,
      },
      planGeneralMaxTurns: settings.planGeneralMaxTurns,
      planItemRetries: settings.planItemRetries,
      planner: {
        agent: modelPlannerAgent(model, { settings }),
        workspace: opened.workspace,
        maxTurns: settings.plannerMaxTurns,
        telemetry: telemetry.sink,
      },
      document: {
        plan: modelDocumentPlanAgent(model, { settings }),
        write: modelDocumentTextAgent(model, { settings }),
        workspace: opened.workspace,
        maxTurns,
        maxPlanTurns: settings.plannerMaxTurns,
        telemetry: telemetry.sink,
      },
      telemetry: telemetry.sink,
    };

    const session = createSession();
    const records: TurnRecord[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const utterance = lines[index] as string;
      const before = telemetry.events.length;
      const result = await runSessionTurn(deps, session, utterance);
      let plan: TurnRecord["plan"];
      if (result.plan !== undefined) {
        const run = await executePlan(deps, session, result.plan.unitId);
        plan = { status: run.status, completed: run.completed, total: run.total };
      }
      const unit =
        result.task?.result ??
        result.general?.result ??
        result.revision?.result ??
        result.document?.result ??
        result.plan?.result;
      const record: TurnRecord = {
        index,
        utterance,
        operation: result.operation?.kind ?? null,
        reasoning: result.interpretation?.reasoning ?? null,
        answer: answerOf(result),
        turns: unit === undefined ? null : unit.turns,
        stopReason: unit === undefined ? null : unit.stopReason,
        ...(plan !== undefined ? { plan } : {}),
        usage: usageTotals(telemetry.events.slice(before)),
      };
      records.push(record);
      writeFileSync(join(dir, `turn-${index + 1}.json`), JSON.stringify(record, null, 2));
    }
    writeFileSync(join(dir, "turns.json"), JSON.stringify(records, null, 2));
    writeFileSync(join(dir, "overview.md"), records[0]?.answer ?? "");
    writeFileSync(join(dir, "identify.md"), records[1]?.answer ?? "");
    writeFileSync(join(dir, "document-answer.md"), records[records.length - 1]?.answer ?? "");

    let verification: TaskVerification;
    try {
      verification = verifyOpenedTask(task, opened);
    } finally {
      capture(opened.workspace, dir);
    }

    const usage = usageTotals(telemetry.events);
    const byAgent = Object.fromEntries(
      (["session", "plan", "task", "general", "revision", "document"] as const).map((agent) => {
        const totals = usageTotals(
          telemetry.events.filter((event) => event.type === "model_call" && event.agent === agent),
        );
        return [agent, { calls: totals.calls, inputTokens: totals.inputTokens, outputTokens: totals.outputTokens, reasoningTokens: totals.reasoningTokens, cachedInputTokens: totals.cachedInputTokens, cost: totals.cost }];
      }),
    );
    writeFileSync(join(dir, "session.json"), JSON.stringify(session.journal, null, 2));
    writeFileSync(
      join(dir, "units.json"),
      JSON.stringify(Object.fromEntries([...session.units].map(([id, unit]) => [id, unit.journal])), null, 2),
    );
    writeFileSync(
      join(dir, "run.json"),
      JSON.stringify(
        {
          agent: "skein",
          task: task.id,
          network: options.network,
          reward: verification.reward,
          check: verification.check,
          usage: { ...usage, byAgent },
          turns: records.map((record) => ({ index: record.index, operation: record.operation, turns: record.turns, stopReason: record.stopReason, ...(record.plan !== undefined ? { plan: record.plan } : {}) })),
        },
        null,
        2,
      ),
    );
    console.info(
      `\n[skein r${options.repeat}] reward=${verification.reward} turns=${records.map((r) => r.turns ?? "?").join("/")} ` +
        `ops=${records.map((r) => r.operation ?? "?").join("/")} in=${usage.inputTokens} out=${usage.outputTokens} cost=${usage.cost.toFixed(2)} -> ${dir}`,
    );
    return {
      agent: "skein",
      repeat: options.repeat,
      reward: verification.reward,
      checkCode: verification.check.code,
      dir,
      turns: records.reduce((sum, record) => sum + (record.turns ?? 0), 0),
      steps: null,
      operations: records.map((record) => record.operation),
      usage,
    };
  } finally {
    cleanupContainers();
    cleanupSandboxes();
  }
}

async function runOpenCodeCell(
  task: SandboxTask,
  options: Options,
  dir: string,
): Promise<CellSummary> {
  mkdirSync(dir, { recursive: true });
  const lines = utterances();
  const result = await runOpenCodeTask(task, {
    network: options.network,
    bin: resolvedOpenCodeBin(),
    messages: lines,
    dir,
    afterAgent: (workspace) => capture(workspace, dir),
    ...(options.turns !== undefined ? { maxSteps: options.turns } : {}),
  });
  const named: [number, string][] = [
    [0, "overview.md"],
    [1, "identify.md"],
    [lines.length - 1, "document-answer.md"],
  ];
  for (const [index, name] of named) {
    const path = join(dir, `opencode-turn-${index + 1}.txt`);
    if (existsSync(path)) {
      writeFileSync(join(dir, name), textOfStream(readFileSync(path, "utf8")));
    }
  }
  const metric = result.metric;
  const usage: UsageTotals = {
    inputTokens: metric.inputTokens,
    outputTokens: metric.outputTokens,
    reasoningTokens: metric.reasoningTokens,
    cachedInputTokens: metric.cacheRead,
    cacheWriteTokens: 0,
    cost: 0,
    calls: metric.steps,
    cacheHitRatio: metric.inputTokens === 0 ? 0 : metric.cacheRead / metric.inputTokens,
  };
  writeFileSync(
    join(dir, "run.json"),
    JSON.stringify(
      {
        agent: "opencode",
        task: task.id,
        network: options.network,
        reward: result.reward,
        metric,
        turnMetrics: result.turnMetrics ?? [],
      },
      null,
      2,
    ),
  );
  console.info(
    `\n[opencode r${options.repeat}] reward=${result.reward} steps=${metric.steps} ` +
      `in=${metric.inputTokens} out=${metric.outputTokens} cacheR=${metric.cacheRead} -> ${dir}`,
  );
  return {
    agent: "opencode",
    repeat: options.repeat,
    reward: result.reward,
    checkCode: result.check.code,
    dir,
    turns: result.turnMetrics?.length ?? null,
    steps: metric.steps,
    operations: [],
    usage,
  };
}

function textOfStream(raw: string): string {
  const texts: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.includes('"type":"text"')) continue;
    try {
      const event = JSON.parse(line) as { part?: { type?: string; text?: string } };
      if (event.part?.type === "text" && typeof event.part.text === "string") texts.push(event.part.text);
    } catch {
      // A non-JSON line (e.g. a log line) is not part of the stream.
    }
  }
  return texts.join("\n\n");
}

function summaryMarkdown(cells: CellSummary[], options: Options): string {
  const lines = [
    `# Session scenario: ${options.task}`,
    "",
    `network=${options.network}, repeat=${options.repeat}, agents=${options.agents.join(",")}`,
    "",
    "| agent | run | reward | turns | steps | input | output | cost | operations |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const cell of cells) {
    const usage = cell.usage;
    lines.push(
      `| ${cell.agent} | ${cell.repeat} | ${cell.reward} | ${cell.turns ?? "-"} | ${cell.steps ?? "-"} | ` +
        `${usage?.inputTokens ?? "-"} | ${usage?.outputTokens ?? "-"} | ` +
        `${usage === null ? "-" : usage.cost.toFixed(2)} | ${cell.operations.map((op) => op ?? "?").join("/")} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const options = optionsOf();
  const task = TASKS[options.task];
  if (task === undefined) throw new Error(`unknown task ${options.task}; known: ${Object.keys(TASKS).join(", ")}`);

  const lines = utterances();
  const cells = options.agents.length * options.repeat;

  if (options.dry) {
    console.info("=== session scenario (dry) ===");
    console.info(`task: ${task.id} (image ${task.image ?? "-"}, network ${options.network})`);
    console.info(`agents: ${options.agents.join(", ")}; repeat: ${options.repeat}; cells: ${cells}`);
    console.info(`out: ${options.out}`);
    console.info("\nturns:");
    lines.forEach((line, index) => console.info(`  ${index + 1}. ${line}`));
    let cache = "ok";
    try {
      taskCacheDir(task.id);
    } catch (error) {
      cache = error instanceof Error ? error.message : String(error);
    }
    console.info(`\nprereqs: task cache ${cache}; docker ${dockerAvailable() ? "ok" : "unavailable"}; ` +
      `opencode ${openCodeAvailable() ? resolvedOpenCodeBin() : "unavailable"}`);
    return;
  }

  if (process.env.SKEIN_LIVE !== "true") {
    throw new Error("set SKEIN_LIVE=true to run a live scenario (or pass --dry)");
  }
  if (!dockerAvailable()) throw new Error("docker is not available");
  if (options.agents.includes("opencode") && !openCodeAvailable()) {
    throw new Error(`opencode binary not found (set OPENCODE_BIN; tried ${resolvedOpenCodeBin()})`);
  }
  mkdirSync(options.out, { recursive: true });
  writeFileSync(
    join(options.out, "manifest.json"),
    JSON.stringify({ task: task.id, image: task.image ?? null, network: options.network, agents: options.agents, repeat: options.repeat, turns: options.turns ?? null, utterances: lines }, null, 2),
  );

  const results: CellSummary[] = [];
  for (const agent of options.agents) {
    for (let repeat = 1; repeat <= options.repeat; repeat += 1) {
      const cellOptions = { ...options, repeat };
      const dir = join(options.out, `${agent}-r${repeat}`);
      try {
        const cell = agent === "skein" ? await runSkeinCell(task, cellOptions, dir) : await runOpenCodeCell(task, cellOptions, dir);
        results.push(cell);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`\n[${agent} r${repeat}] failed: ${message}`);
        results.push({ agent, repeat, reward: 0, checkCode: null, dir, turns: null, steps: null, operations: [], usage: null, error: message });
      } finally {
        cleanupContainers();
        cleanupSandboxes();
      }
    }
  }

  writeFileSync(join(options.out, "summary.json"), JSON.stringify({ task: task.id, network: options.network, repeat: options.repeat, agents: options.agents, cells: results }, null, 2));
  writeFileSync(join(options.out, "summary.md"), summaryMarkdown(results, options));
  console.info(`\n${summaryMarkdown(results, options)}`);
  console.info(`results: ${options.out}`);
}

void main();
