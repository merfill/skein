// Replays recorded turns from a trace through the live model with the SAME context, so the
// structured-output path and the proposed next step can be checked without Harbor.
//
// Usage:
//   npx tsx bench/replay.ts <trace-or-scenario> [--limit N] [--model M]
//
// Trace forms (auto-detected):
//   * a scenario run: bench/runs/live-<ts>-<name>/contexts.ndjson (pass the path or the name)
//   * a Harbor log:   langgraph-run.log (SKEIN_CONTEXT / SKEIN_PROPOSAL lines)
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { loadSettings } from "../src/config/settings";
import type { Context } from "../src/ir/project";
import { createChatModel } from "../src/llm/client";
import type { Action, Proposal } from "../src/llm/schemas";
import { invokeTools } from "../src/llm/structured";
import { buildMessages } from "../src/loop/propose";
import { TurnMeter } from "./metrics";

const RUNS = join(import.meta.dirname, "runs");

interface Turn {
  turn: number;
  context: Context;
  operator?: string;
  tool?: string;
}

function summaryOf(action: Action | undefined): { operator?: string; tool?: string } {
  if (action === undefined) return {};
  return action.operator === "apply"
    ? { operator: "apply", tool: action.action.tool }
    : { operator: action.operator };
}

function fromContextsNdjson(path: string): Turn[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      const row = JSON.parse(line) as { turn?: number; context: Context; action?: Action };
      return { turn: row.turn ?? index, context: row.context, ...summaryOf(row.action) };
    });
}

function fromHarborLog(path: string): Turn[] {
  const contexts: Context[] = [];
  const actions: Action[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.startsWith("SKEIN_CONTEXT ")) {
      contexts.push(JSON.parse(line.slice("SKEIN_CONTEXT ".length)).context as Context);
    } else if (line.startsWith("SKEIN_PROPOSAL ")) {
      actions.push(JSON.parse(line.slice("SKEIN_PROPOSAL ".length)).action as Action);
    }
  }
  return contexts.map((context, index) => ({ turn: index, context, ...summaryOf(actions[index]) }));
}

function resolveTrace(arg: string): string {
  if (arg.includes("/") || arg.endsWith(".log") || arg.endsWith(".ndjson")) return arg;
  const dirs = readdirSync(RUNS)
    .filter((dir) => dir.endsWith(`-${arg}`))
    .sort();
  const last = dirs[dirs.length - 1];
  if (last === undefined) throw new Error(`no trace for scenario ${arg}`);
  return join(RUNS, last, "contexts.ndjson");
}

function loadTurns(arg: string): Turn[] {
  const path = resolveTrace(arg);
  const text = readFileSync(path, "utf8");
  return text.includes("SKEIN_CONTEXT ") ? fromHarborLog(path) : fromContextsNdjson(path);
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function finishOf(response: unknown): string | undefined {
  const value = (response as { response_metadata?: { finish_reason?: unknown } } | undefined)
    ?.response_metadata?.finish_reason;
  return typeof value === "string" ? value : undefined;
}

const traceArg = process.argv[2];
if (traceArg === undefined || traceArg.startsWith("--")) {
  console.error("usage: tsx bench/replay.ts <trace-or-scenario> [--limit N] [--model M]");
  process.exit(1);
}

const settings = loadSettings();
const modelName = flag("--model") ?? settings.model;
const model = createChatModel({ ...settings, model: modelName });

const limit = Number(flag("--limit") ?? "0") || 0;
const offset = Number(flag("--offset") ?? "0") || 0;
const full = process.argv.includes("--full");
const all = loadTurns(traceArg);
const window = limit > 0 ? all.slice(offset, offset + limit) : all.slice(offset);
const turns = window;
console.log(`replay ${traceArg}: ${turns.length} turns (offset ${offset}), model=${modelName}`);

const finishes = new Map<string, number>();
let ok = 0;
let fail = 0;
let match = 0;
let mismatch = 0;
let outputTokens = 0;
let maxOut = 0;

for (const turn of turns) {
  const meter = new TurnMeter();
  let lastFinish: string | undefined;
  try {
    const proposal: Proposal = await invokeTools(model, buildMessages(turn.context), {
      callbacks: [meter],
      settings,
      rebuild: (maxTokens) => createChatModel({ ...settings, maxTokens, model: modelName }),
      onResponse: (response) => {
        lastFinish = finishOf(response);
        if (lastFinish !== undefined) finishes.set(lastFinish, (finishes.get(lastFinish) ?? 0) + 1);
      },
    });
    ok += 1;
    outputTokens += meter.outputTokens;
    maxOut = Math.max(maxOut, meter.outputTokens);
    const got = summaryOf(proposal.action);
    const same = turn.operator !== undefined && got.operator === turn.operator && got.tool === turn.tool;
    if (turn.operator !== undefined) {
      if (same) match += 1;
      else mismatch += 1;
    }
    const gotText = `${got.operator ?? "?"}${got.tool !== undefined ? `:${got.tool}` : ""}`;
    const recText = turn.operator !== undefined ? `${turn.operator}${turn.tool !== undefined ? `:${turn.tool}` : ""}` : "-";
    console.log(
      `t${turn.turn} OK op=${gotText} rec=${recText} ${same ? "=" : "≠"} th=${proposal.thought.length} out=${meter.outputTokens} finish=${lastFinish ?? "?"}`,
    );
    if (full) console.log(`    ${JSON.stringify(proposal.action).slice(0, 1400)}`);
  } catch (error) {
    fail += 1;
    console.log(`t${turn.turn} FAIL out=${meter.outputTokens} finish=${lastFinish ?? "?"} ${(error as Error).message.slice(0, 140)}`);
  }
}

const finishText = [...finishes.entries()].map(([k, v]) => `${k}:${v}`).join(" ");
console.log(
  `RESULT ok=${ok}/${turns.length} fail=${fail} match=${match} mismatch=${mismatch} outTokens=${outputTokens} maxOut=${maxOut} finish=[${finishText}]`,
);
