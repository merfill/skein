// Mini-runner for the skein-plugin synthetic cases.
//
// Usage:
//   npm run bench -- <case> [--model provider/model] [--max-turns N] [--compare]
//
// Copies <plugin>/pilot/synthetic/<case>/repo into a fresh workdir, runs the
// Skein agent live on the case prompt, then runs check.sh. Per LLM call it logs
// the projection size, provider token usage (including prompt-cache hits), and
// the number of underlying model calls. The behavioural loop metric is imported
// from the plugin itself (single yardstick). Runs land in
// bench/runs/<ts>-<case>-skein/.
//
// Cases and the metric live in the neighboring repo; point SKEIN_PLUGIN_ROOT at
// it if it is not at ../skein-plugin.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadSettings } from "../src/config/settings";
import type { Event } from "../src/ir/events";
import { type State } from "../src/ir/graph";
import type { Context } from "../src/ir/project";
import { currentGoalId, goalPayload } from "../src/ir/traversal";
import { createChatModel } from "../src/llm/client";
import type { Action, Proposal } from "../src/llm/schemas";
import { invokeTools } from "../src/llm/structured";
import { runAgent } from "../src/loop/graph";
import { buildMessages, promptText } from "../src/loop/propose";
import { fsWorkspace } from "../src/tools/workspace";
import {
  actionName,
  contextStats,
  graphCounts,
  sum,
  TurnMeter,
  type TurnRecord,
} from "./metrics";

interface LoopEvent {
  tool: string;
  input: Record<string, unknown>;
  failed?: boolean;
}

interface LoopMetrics {
  actions: number;
  repeats: number;
  repeatsAfterFailure: number;
  rereads: number;
  maxStreak: number;
  loopScore: number;
}

interface LoopModule {
  detectLoops: (events: LoopEvent[]) => LoopMetrics;
}

const REPO_ROOT = resolve(import.meta.dirname, "..");
const PLUGIN_ROOT = process.env.SKEIN_PLUGIN_ROOT
  ? resolve(process.env.SKEIN_PLUGIN_ROOT)
  : resolve(REPO_ROOT, "..", "skein-plugin");
const CASES_ROOT = process.env.SKEIN_CASES
  ? resolve(process.env.SKEIN_CASES)
  : join(PLUGIN_ROOT, "pilot", "synthetic");
const RUNS_ROOT = join(REPO_ROOT, "bench", "runs");

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const PRICE_IN = num(process.env.SKEIN_PRICE_IN, 4);
const PRICE_OUT = num(process.env.SKEIN_PRICE_OUT, 16);

interface Args {
  case: string;
  model?: string;
  maxTurns?: number;
  compare: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { case: "", compare: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--model") out.model = argv[++i];
    else if (arg === "--max-turns") out.maxTurns = Number(argv[++i]);
    else if (arg === "--compare") out.compare = true;
    else if (!arg.startsWith("--")) out.case = arg;
  }
  return out;
}

async function loadLoopModule(): Promise<LoopModule> {
  const path = join(PLUGIN_ROOT, "src", "loop.ts");
  if (!existsSync(path)) {
    throw new Error(`plugin loop metric not found at ${path}; set SKEIN_PLUGIN_ROOT`);
  }
  return (await import(pathToFileURL(path).href)) as LoopModule;
}

function toLoopEvent(action: Action): LoopEvent {
  if (action.operator !== "apply") return { tool: action.operator, input: {} };
  const apply = action.action;
  switch (apply.tool) {
    case "read":
      return { tool: "read", input: { filePath: apply.path } };
    case "edit":
      return { tool: "edit", input: { filePath: apply.path } };
    case "run":
      return { tool: "bash", input: { command: apply.command ?? "" } };
    default:
      return { tool: apply.tool, input: {} };
  }
}

function summary(metrics: Record<string, unknown>): string {
  const context = metrics.context as { first: number; last: number; peak: number; growth: number };
  const graph = metrics.graph as Record<string, number>;
  return [
    `case=${metrics.case}`,
    `arm=skein`,
    `reward=${metrics.reward}`,
    `steps=${metrics.steps}`,
    `llmCalls=${metrics.llmCalls}`,
    `ctx ${context.first}->${context.last} peak=${context.peak} growth=${context.growth}`,
    `tok in=${metrics.inputTokens} out=${metrics.outputTokens} reason=${metrics.reasoningTokens}`,
    `cache=${metrics.cacheRead} (${(((metrics.cacheHitRatio as number | null) ?? 0) * 100).toFixed(0)}%)`,
    `cost=${(metrics.costRub as number).toFixed(2)}₽`,
    `graph goals${graph.goals}/plans${graph.plans}/alt${graph.alternatives}/checks${graph.checks}`,
    `loop=${((metrics.loopScore as number) * 100).toFixed(0)}%`,
    `rereads=${metrics.rereads}`,
  ].join(" ");
}

function compareBaseline(caseName: string): void {
  const runsDir = join(PLUGIN_ROOT, "pilot", "synthetic", "runs");
  if (!existsSync(runsDir)) return;
  const matches = readdirSync(runsDir)
    .filter((name) => name.includes(`-${caseName}-baseline`))
    .sort();
  const latest = matches[matches.length - 1];
  if (latest === undefined) {
    console.log(`baseline: no run for ${caseName}`);
    return;
  }
  const measurePath = join(runsDir, latest, "measure.json");
  if (!existsSync(measurePath)) {
    console.log(`baseline ${latest}: no measure.json`);
    return;
  }
  const parsed = JSON.parse(readFileSync(measurePath, "utf8")) as Record<string, unknown>[];
  const m = parsed[0] ?? {};
  const reward = readFileSync(join(runsDir, latest, "reward.txt"), "utf8").trim();
  console.log(
    `baseline ${latest}: steps=${m.steps} tools=${m.toolCalls} in=${m.inputTokens} out=${m.outputTokens} peakCtx=${m.peakContextTokens} loop=${(((m.loopScore as number) ?? 0) * 100).toFixed(0)}% rereads=${m.rereads} reward=${reward}`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.case === "") {
    console.error(
      "usage: npm run bench -- <case> [--model provider/model] [--max-turns N] [--compare]",
    );
    process.exit(1);
  }
  const caseDir = join(CASES_ROOT, args.case);
  if (!existsSync(join(caseDir, "repo"))) {
    console.error(`no repo directory in ${caseDir}`);
    process.exit(1);
  }

  const settings = loadSettings();
  if (settings.apiKey === "") {
    console.error("SKEIN_API_KEY is empty; set it in .env");
    process.exit(1);
  }
  const model = args.model ?? settings.model;
  const { detectLoops } = await loadLoopModule();

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(RUNS_ROOT, `${ts}-${args.case}-skein`);
  const work = join(tmpdir(), "skein-bench", `${ts}-${args.case}`);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(work, { recursive: true });
  cpSync(join(caseDir, "repo"), work, { recursive: true });

  const prompt = readFileSync(join(caseDir, "prompt.txt"), "utf8").trim();
  const proposals: Action[] = [];
  const turns: Omit<TurnRecord, "accepted">[] = [];
  const contexts: { turn: number; chars: number; context: Context }[] = [];
  const chat = createChatModel({ ...settings, model });

  const propose = async (context: Context): Promise<Proposal> => {
    const contextChars = promptText(context).length;
    contexts.push({ turn: turns.length, chars: contextChars, context });
    const meter = new TurnMeter();
    const started = Date.now();
    const proposal = await invokeTools(chat, buildMessages(context), {
      callbacks: [meter],
    });
    const elapsedMs = Date.now() - started;
    proposals.push(proposal.action);
    turns.push({
      turn: turns.length,
      action: actionName(proposal.action),
      contextChars,
      inputTokens: meter.inputTokens,
      outputTokens: meter.outputTokens,
      reasoningTokens: meter.reasoningTokens,
      cacheRead: meter.cacheRead,
      cacheWrite: meter.cacheWrite,
      cacheHitRatio: meter.inputTokens === 0 ? null : meter.cacheRead / meter.inputTokens,
      llmCalls: meter.calls,
      elapsedMs,
      cost: meter.costCalls > 0 ? meter.costRub : null,
      usage: meter.usage,
    });
    return proposal;
  };

  const result = await runAgent(
    { propose, workspace: fsWorkspace(work), maxTurns: args.maxTurns ?? settings.maxTurns },
    { request: { id: "r1", text: prompt } },
  );

  const check = spawnSync("bash", [join(caseDir, "check.sh")], {
    cwd: work,
    encoding: "utf8",
    timeout: 120_000,
  });
  const reward = check.status === 0 ? 1 : 0;

  const rejectedTurns = new Set(
    result.events.filter((event) => event.type === "record_rejection").map((event) => event.turn),
  );
  const turnRecords: TurnRecord[] = turns.map((turn) => ({
    ...turn,
    accepted: !rejectedTurns.has(turn.turn),
  }));

  const loops = detectLoops(proposals.map(toLoopEvent));
  const inputTokens = sum(turnRecords.map((turn) => turn.inputTokens));
  const outputTokens = sum(turnRecords.map((turn) => turn.outputTokens));
  const reasoningTokens = sum(turnRecords.map((turn) => turn.reasoningTokens));
  const cacheRead = sum(turnRecords.map((turn) => turn.cacheRead));
  const cacheWrite = sum(turnRecords.map((turn) => turn.cacheWrite));
  const llmCalls = sum(turnRecords.map((turn) => turn.llmCalls));
  const knownCosts = turnRecords.map((turn) => turn.cost).filter((cost): cost is number => cost !== null);
  const costRub =
    turnRecords.length > 0 && knownCosts.length === turnRecords.length
      ? sum(knownCosts)
      : (inputTokens / 1_000_000) * PRICE_IN + (outputTokens / 1_000_000) * PRICE_OUT;

  const metrics = {
    case: args.case,
    arm: "skein",
    model,
    reward,
    steps: result.turns,
    toolCalls: proposals.length,
    llmCalls,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheRead,
    cacheWrite,
    cacheHitRatio: inputTokens === 0 ? null : cacheRead / inputTokens,
    costRub,
    context: contextStats(turnRecords),
    ...loops,
    graph: graphCounts(proposals, result.events),
  };

  writeFileSync(join(runDir, "trajectory.json"), JSON.stringify(proposals, null, 2));
  writeFileSync(join(runDir, "turns.ndjson"), turnRecords.map((t) => JSON.stringify(t)).join("\n"));
  writeFileSync(join(runDir, "contexts.ndjson"), contexts.map((c) => JSON.stringify(c)).join("\n"));
  writeFileSync(join(runDir, "events.ndjson"), result.events.map((e) => JSON.stringify(e)).join("\n"));
  writeFileSync(join(runDir, "metrics.json"), JSON.stringify(metrics, null, 2));
  writeFileSync(join(runDir, "reward.txt"), String(reward));
  writeFileSync(join(runDir, "check.out.txt"), `${check.stdout ?? ""}${check.stderr ?? ""}`);
  writeFileSync(join(runDir, "summary.txt"), `${summary(metrics)}\n`);

  console.log(summary(metrics));
  console.log(`run=${runDir}`);
  if (args.compare) compareBaseline(args.case);
}

await main();
