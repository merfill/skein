// Build a FRESH tape with the CURRENT projection and roll the live model forward a few turns.
//
// The tape is the engine's own (`runAgent` → `project`/`buildMessages`), NOT the recorded one:
// the first call is the current request context, each later call is the current state of the
// tape. Tool results are taken POSITIONALLY from a recorded run — a tool call consumes the next
// recorded observation. The trace stores observation TEXT only (no file contents), so the file
// tools (`read`/`grep`/`list`) run against the task's mini spec tree, while `bash` results come
// from the recording. This is a decision replay, not a faithful environment.
//
// Usage:
//   npx tsx bench/rollout.ts <run-dir-or-name> [--turns N] [--dry]
//
// Live model calls cost money and are gated (AGENTS.md): run only with the owner's go-ahead.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { loadSettings } from "../src/config/settings";
import type { Event } from "../src/ir/events";
import { fold } from "../src/ir/graph";
import { project, type Context, type TapeMessage } from "../src/ir/project";
import { createChatModel } from "../src/llm/client";
import type { Action, Proposals } from "../src/llm/schemas";
import { toolNamesFor } from "../src/llm/tools";
import { runAgent } from "../src/loop/graph";
import { BASE_PROMPT, buildMessages, propose as proposeModel } from "../src/loop/propose";
import type { CommandResult, Workspace } from "../src/tools/workspace";
import { fixOcamlGc } from "../tests/sandbox/specs/fix-ocaml-gc";
import { sandboxWorkspace } from "../tests/sandbox/workspace";
import { TurnMeter } from "./metrics";

const RUNS = join(import.meta.dirname, "runs", "sandbox-tasks");

interface Row {
  turn: number;
  history?: TapeMessage[];
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function resolveTrace(arg: string): string {
  if (arg.endsWith(".ndjson")) return arg;
  if (existsSync(join(arg, "contexts.ndjson"))) return join(arg, "contexts.ndjson");
  const dirs = readdirSync(RUNS).filter((dir) => dir.includes(arg)).sort();
  const last = dirs[dirs.length - 1];
  if (last === undefined) throw new Error(`no trace matching "${arg}" under ${RUNS}`);
  return join(RUNS, last, "contexts.ndjson");
}

function loadRows(path: string): Row[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Row)
    .sort((a, b) => a.turn - b.turn);
}

// The recorded environment: each recorded turn's NEW tool messages (the previous model's
// command results), in order, with the projection's `[obs:NN] ` prefix stripped so the current
// projection assigns its own ids.
function recordedObservations(rows: readonly Row[]): string[] {
  const out: string[] = [];
  let prev = rows.find((row) => row.turn === 1)?.history?.length ?? 0;
  for (const row of rows) {
    if (row.turn < 2 || row.history === undefined) continue;
    const added = row.history.slice(prev);
    prev = row.history.length;
    for (const message of added) {
      if (message.role !== "tool") continue;
      out.push(message.text.replace(/^\[[^\]]+\]\s*/, ""));
    }
  }
  return out;
}

// A `bash` result from a recorded observation: its text is `<exit line>\n<body>` (the old
// projection), so the exit code is parsed off the head and the rest is the body.
function parseShell(text: string): CommandResult {
  const match = text.match(/^exit (\d+)\b/);
  if (match === null) return { code: 0, stdout: text, stderr: "" };
  return { code: Number(match[1]), stdout: text.slice(match[0].length).replace(/^\n/, ""), stderr: "" };
}

// The engine drives the tape; `run` is the cassette that serves the recorded shell results in
// order. The file tools fall through to the task's mini spec tree.
function cassette(base: Workspace, observations: readonly string[]): Workspace {
  let index = 0;
  const next = (): string => {
    const text = observations[index] ?? "(no recorded result left)";
    index += 1;
    return text;
  };
  return {
    ...base,
    run: (): CommandResult => parseShell(next()),
  };
}

function label(action: Action): string {
  return action.operator === "apply" ? `${action.action.tool}` : action.operator;
}

const traceArg = process.argv[2];
if (traceArg === undefined || traceArg.startsWith("--")) {
  console.error("usage: tsx bench/rollout.ts <run-dir-or-name> [--turns N] [--dry]");
  process.exit(1);
}

const tracePath = resolveTrace(traceArg);
const rows = loadRows(tracePath);
const requestText = rows[0]?.history?.[0]?.text?.trim() ?? "";
const observations = recordedObservations(rows);
const turns = Math.max(1, Number(flag("--turns") ?? "5") || 5);
const dry = process.argv.includes("--dry");
const settings = loadSettings();

const seed: Event[] = [
  {
    type: "add_node",
    node: {
      id: "r1",
      space: "work",
      kind: "request",
      label: requestText.replace(/\s+/g, " ").trim().slice(0, 120),
      payload: { text: requestText },
      seq: 0,
    },
  },
];

if (dry) {
  const context = project(fold(seed));
  console.log(`trace ${tracePath}`);
  console.log(`recorded observations: ${observations.length}; turns=${turns}`);
  console.log(`\n===== turn 0 (current request context) =====`);
  for (const message of buildMessages(context)) {
    const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    console.log(`  [${message.role}] ${text === BASE_PROMPT ? "<base prompt>" : text.length > 110 ? `${text.slice(0, 110)}…` : text}`);
  }
  console.log(`\nfirst recorded results:`);
  observations.slice(0, 4).forEach((text, i) => console.log(`  [${i}] ${text.replace(/\n/g, " ⏎ ").slice(0, 120)}`));
  process.exit(0);
}

interface TurnLog {
  turn: number;
  situation: string;
  tools: string[];
  tokens: { input: number; output: number; reasoning: number; calls: number };
  reasoning: string;
  proposal: Proposals;
}

async function main(): Promise<void> {
  const reasoning: string[] = [];
  const model = createChatModel(settings);
  const rebuild = (maxTokens: number, opts?: { reasoningOff?: boolean }) =>
    createChatModel({
      ...settings,
      maxTokens,
      ...(opts?.reasoningOff === true ? { reasoningEffort: "none" } : {}),
    });

  const logs: TurnLog[] = [];
  const propose = async (context: Context): Promise<Proposals> => {
    const meter = new TurnMeter();
    reasoning.length = 0;
    const proposal = await proposeModel(model, context, {
      settings,
      rebuild,
      usageHandlers: [meter],
      onResponse: (response) => {
        const raw = (response as { reasoning?: unknown }).reasoning;
        if (typeof raw === "string" && raw !== "") reasoning.push(raw);
      },
    });
    logs.push({
      turn: logs.length,
      situation: context.situation,
      tools: context.applicable !== undefined ? toolNamesFor(context.applicable) : [],
      tokens: {
        input: meter.inputTokens,
        output: meter.outputTokens,
        reasoning: meter.reasoningTokens,
        calls: meter.calls,
      },
      reasoning: reasoning.join("\n").replace(/\s+/g, " ").trim(),
      proposal,
    });
    return proposal;
  };

  const workspace = cassette(sandboxWorkspace(fixOcamlGc), observations);
  console.log(`trace ${tracePath}   model=${settings.model}   turns=${turns}   observations=${observations.length}`);
  console.log(`request: ${requestText.slice(0, 140)}…\n`);

  const result = await runAgent({ propose, workspace, maxTurns: turns }, { request: { id: "r1", text: requestText } });

  console.log("| t | situation | action(s) | in | out | reason | calls |");
  console.log("|---|---|---|---|---|---|---|");
  for (const log of logs) {
    const actions = log.proposal.actions.map(label).join("+") || "none";
    console.log(
      `| ${log.turn} | ${log.situation} | ${actions} | ${log.tokens.input} | ${log.tokens.output} | ${log.tokens.reasoning} | ${log.tokens.calls} |`,
    );
  }
  const totals = logs.reduce(
    (acc, log) => ({
      input: acc.input + log.tokens.input,
      output: acc.output + log.tokens.output,
      reasoning: acc.reasoning + log.tokens.reasoning,
      calls: acc.calls + log.tokens.calls,
    }),
    { input: 0, output: 0, reasoning: 0, calls: 0 },
  );
  console.log(
    `| Σ | | | ${totals.input} | ${totals.output} | ${totals.reasoning} | ${totals.calls} |`,
  );

  console.log(`\nstop=${result.stopReason ?? "none"} turns=${result.turns}`);
  for (const log of logs) {
    console.log(`\n--- t${log.turn} (${log.situation}) — ${log.proposal.actions.map((action) => JSON.stringify(action)).join(" | ").slice(0, 300)}`);
    if (log.reasoning !== "") console.log(`reasoning: ${log.reasoning.slice(0, 1200)}`);
  }
}

void main();
