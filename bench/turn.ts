// Replays ONE recorded turn from a `sandbox-tasks` trace, optionally patching the context,
// through the live model — to test the effect of a single prompt change without rerunning the
// task. The trace row (`tests/sandbox/live.ts`) is
//   { turn, chars, situation, constraints, history, messages }
// and `messages` already carries the native `tool_calls`/`tool_call_id` (live.ts renders them),
// so the exact model-facing transcript is reconstructible. The trace does NOT store
// `applicable`, so the tool surface is reconstructed from `situation`.
//
// Usage:
//   npx tsx bench/turn.ts <run-dir-or-trace> --turn N [--patch patch.json]
//       [--append-system "text"] [--repeat K] [--model M] [--dump out.txt] [--dry] [--list]
//
// A patch file is a JSON array of ops applied in order:
//   { "op": "append",  "role": "system", "text": "..." }        // push at the end
//   { "op": "insert",  "at": 3, "role": "system", "text": "..." } // 0-based insert
//   { "op": "remove",  "match": "substring" }                   // drop messages whose text has it
//   { "op": "replace", "match": "substring", "text": "..." }     // rewrite the first match
//
// Live model calls cost money and are gated (AGENTS.md): run only with the owner's go-ahead.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";

import { createChatModel } from "../src/llm/client";
import { invokeTools } from "../src/llm/structured";
import type { Action, Proposals } from "../src/llm/schemas";
import { toolNamesFor } from "../src/llm/tools";
import { loadSettings } from "../src/config/settings";
import { ISLANDS, stateDescription, type IslandId } from "../src/ir/islands";
import { observationInstruction, type Context, type Situation, type TapeMessage } from "../src/ir/project";
import { buildMessages } from "../src/loop/propose";
import { TurnMeter } from "./metrics";

const RUNS = join(import.meta.dirname, "runs", "sandbox-tasks");

interface RenderedMessage {
  type: string;
  content: string;
  tool_calls?: { name: string; args: unknown; id: string }[];
  tool_call_id?: string;
}

interface Row {
  turn: number;
  chars?: number;
  situation: Situation;
  messages: RenderedMessage[];
  // `--rebuild` sources (present in `sandbox-tasks` traces, `tests/sandbox/live.ts`).
  history?: TapeMessage[];
  constraints?: { id: string; forbid: string[] }[];
}

type PatchOp =
  | { op: "append"; role: string; text: string }
  | { op: "insert"; at: number; role: string; text: string }
  | { op: "remove"; match: string }
  | { op: "replace"; match: string; text: string };

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function resolveTrace(arg: string): string {
  if (arg.endsWith(".ndjson")) return arg;
  if (existsSync(join(arg, "contexts.ndjson"))) return join(arg, "contexts.ndjson");
  const dirs = readdirSync(RUNS)
    .filter((dir) => dir === arg || dir.endsWith(`-${arg}`) || dir.includes(`-${arg}-`) || dir.includes(arg))
    .sort();
  const last = dirs[dirs.length - 1];
  if (last === undefined) throw new Error(`no trace matching "${arg}" under ${RUNS}`);
  return join(RUNS, last, "contexts.ndjson");
}

function loadRows(path: string): Row[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Row);
}

// The frontier a situation implies (`src/ir/project.ts:situationOf` + `traversal.applicable`);
// the trace does not store `applicable`, so the tool surface is reconstructed from this and the
// focused island (the apply vocabulary).
function frontierFor(situation: Situation, island?: IslandId) {
  switch (situation) {
    case "request":
      return { move: true, apply: false, stop: false, decline: true };
    case "plan":
    case "working":
      return {
        move: false,
        apply: true,
        stop: true,
        decline: false,
        ...(island !== undefined ? { applies: ISLANDS[island].applies } : {}),
      };
    case "terminal":
      return { move: false, apply: false, stop: true, decline: false };
    case "transition":
    default:
      return { move: true, apply: false, stop: false, decline: false };
  }
}

function toolsFor(situation: Situation, island?: IslandId): string[] {
  return toolNamesFor(frontierFor(situation, island));
}

function toBaseMessage(message: RenderedMessage): BaseMessage {
  if (message.type === "human") return new HumanMessage(message.content);
  if (message.type === "system") return new SystemMessage(message.content);
  if (message.type === "tool") {
    if (message.tool_call_id === undefined) {
      throw new Error(`rendered tool message without tool_call_id: ${message.content.slice(0, 60)}`);
    }
    return new ToolMessage({ content: message.content, tool_call_id: message.tool_call_id });
  }
  const calls = (message.tool_calls ?? []).map((call) => ({
    name: call.name,
    args: (typeof call.args === "string" ? JSON.parse(call.args) : call.args) as Record<string, unknown>,
    id: call.id,
    type: "tool_call" as const,
  }));
  if (calls.length > 0) return new AIMessage({ content: message.content, tool_calls: calls });
  return new AIMessage(message.content);
}

function applyPatch(messages: RenderedMessage[], patch: PatchOp[]): RenderedMessage[] {
  const out = [...messages];
  for (const op of patch) {
    if (op.op === "append") {
      out.push({ type: op.role === "system" ? "system" : op.role, content: op.text });
    } else if (op.op === "insert") {
      out.splice(op.at, 0, { type: op.role === "system" ? "system" : op.role, content: op.text });
    } else if (op.op === "remove") {
      for (let i = out.length - 1; i >= 0; i -= 1) {
        if (out[i]!.content.includes(op.match)) out.splice(i, 1);
      }
    } else {
      const index = out.findIndex((message) => message.content.includes(op.match));
      if (index < 0) throw new Error(`patch replace: no message matches ${JSON.stringify(op.match)}`);
      out[index] = { ...out[index]!, content: op.text };
    }
  }
  return out;
}

// The focused state, read from the last `move` call on the recorded history.
function lastMoveOf(history: TapeMessage[]):
  | { island: IslandId; what?: string; done?: string }
  | undefined {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i]!;
    const calls = message.calls ?? (message.call !== undefined ? [message.call] : []);
    for (const call of calls) {
      if (call.name !== "move") continue;
      const args = call.args as { state?: unknown; what?: unknown; done?: unknown };
      if (typeof args.state !== "string" || !(args.state in ISLANDS)) continue;
      return {
        island: args.state as IslandId,
        ...(typeof args.what === "string" ? { what: args.what } : {}),
        ...(typeof args.done === "string" ? { done: args.done } : {}),
      };
    }
  }
  return undefined;
}

// `--rebuild`: re-render the prompt from the CURRENT code over the recorded `history` — the
// state description (from the island of the last `move` and its concretized what/done) and the
// situation/observation instructions are recomputed, so a prompt edit can be tested on a
// recorded run without a new run. Needs a `sandbox-tasks` trace (it carries `history`).
function rebuildMessages(row: Row): BaseMessage[] {
  if (row.history === undefined) throw new Error("--rebuild needs a trace with `history` (sandbox-tasks)");
  const move = lastMoveOf(row.history);
  const island = move?.island;
  const history: TapeMessage[] = row.history.map((message) =>
    island !== undefined && message.role === "system" && message.text.startsWith("State: ")
      ? { ...message, text: stateDescription(ISLANDS[island], move?.what, move?.done) }
      : message,
  );
  const last = history.at(-1);
  const result =
    row.situation === "working" && last?.role === "tool" && island !== undefined
      ? observationInstruction(ISLANDS[island].applies)
      : undefined;
  const context: Context = {
    history,
    situation: row.situation,
    constraints: row.constraints ?? [],
    ...(island !== undefined ? { island } : {}),
    ...(move?.done !== undefined && move.done !== "" ? { done: move.done } : {}),
    ...(result !== undefined ? { result } : {}),
  };
  return buildMessages(context);
}

const traceArg = process.argv[2];
if (traceArg === undefined || traceArg.startsWith("--")) {
  console.error(
    "usage: tsx bench/turn.ts <run-dir-or-trace> (--turn N | --turns A-B) " +
      "[--patch f.json] [--rebuild] [--append-system s] [--repeat K] [--dry] [--reasoning]",
  );
  process.exit(1);
}
const tracePath = resolveTrace(traceArg);
const rows = loadRows(tracePath);

if (process.argv.includes("--list")) {
  for (const row of rows) {
    const last = row.messages.at(-1);
    console.log(`t${row.turn} situ=${row.situation} last=${last?.type}:${last?.content.slice(0, 60).replace(/\n/g, " ")}`);
  }
  process.exit(0);
}

// `--turn N` or `--turns A-B` / `--turns 16,18,20`. Several consecutive turns scanned with the
// SAME patch is a per-step counterfactual (each uses the recorded prefix), not a self-consistent
// rollout — a true rollout needs the workspace to execute the chosen tools.
function parseTurns(spec: string): number[] {
  if (spec.includes("-")) {
    const [from, to] = spec.split("-").map(Number);
    const out: number[] = [];
    for (let turn = from ?? 0; turn <= (to ?? 0); turn += 1) out.push(turn);
    return out;
  }
  return spec.split(",").map(Number);
}
const turnSpec = flag("--turns") ?? flag("--turn");
if (turnSpec === undefined) {
  console.error(`specify --turn N or --turns A-B (have ${rows.map((r) => r.turn).join(",")})`);
  process.exit(1);
}
const turns = parseTurns(turnSpec);

const patchFile = flag("--patch");
const patch: PatchOp[] = patchFile !== undefined ? (JSON.parse(readFileSync(patchFile, "utf8")) as PatchOp[]) : [];
const appendSystem = flag("--append-system");
if (appendSystem !== undefined) patch.push({ op: "append", role: "system", text: appendSystem });

const settings = loadSettings();
const modelName = flag("--model") ?? settings.model;
const repeat = Math.max(1, Number(flag("--repeat") ?? "1") || 1);
const showReasoning = process.argv.includes("--reasoning");
const showResponses = process.argv.includes("--responses");
const dumpPath = flag("--dump");
const dry = process.argv.includes("--dry");
const useRebuild = process.argv.includes("--rebuild");
if (useRebuild && patchFile !== undefined) {
  console.error("--rebuild re-renders the prompt; --patch does not apply (use --append-system)");
  process.exit(1);
}

const label = (action: Action): string =>
  action.operator === "apply" ? `apply:${action.action.tool}` : action.operator;

interface Attempt {
  finish?: string;
  reasoning: string;
  content: string;
  keys: string;
}

// A fresh model per call that also captures each raw response body (one per model attempt —
// the `invokeTools` truncation retry re-invokes, so this shows the retry too): the provider's
// hidden reasoning (`choices[0].message.reasoning`) and the visible content/finish_reason.
function makeRenderer(sink: string[], attempts: Attempt[] = []) {
  const hooks = {
    onResponseBody: (body: unknown): void => {
      const choice = (
        body as
          | {
              choices?: {
                finish_reason?: unknown;
                message?: { reasoning?: unknown; reasoning_content?: unknown; content?: unknown };
              }[];
            }
          | undefined
      )?.choices?.[0];
      const message = choice?.message ?? {};
      const reasoningRaw = message.reasoning ?? message.reasoning_content;
      const reasoning = typeof reasoningRaw === "string" ? reasoningRaw : "";
      const raw = message.content;
      const content = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
      if (reasoning !== "") sink.push(reasoning);
      attempts.push({
        ...(typeof choice?.finish_reason === "string" ? { finish: choice.finish_reason } : {}),
        reasoning,
        content,
        keys: Object.keys(message).join(","),
      });
    },
  };
  return {
    model: createChatModel({ ...settings, model: modelName }, hooks),
    rebuild: (maxTokens: number, opts?: { reasoningOff?: boolean }) =>
      createChatModel(
        { ...settings, model: modelName, maxTokens, ...(opts?.reasoningOff === true ? { reasoningEffort: "none" } : {}) },
        hooks,
      ),
  };
}

for (const turn of turns) {
  const row = rows.find((candidate) => candidate.turn === turn);
  if (row === undefined) {
    console.log(`t${turn} MISSING`);
    continue;
  }
  // `--rebuild` re-renders the tail from the CURRENT code; otherwise the recorded `messages`
  // are replayed (optionally patched). Reconstructing the native transcript validates the
  // trace's tool_calls/tool_call_id even in `--dry`, so a wrong patch/trace surfaces without a
  // model call.
  const patched = useRebuild ? undefined : patch.length > 0 ? applyPatch(row.messages, patch) : row.messages;
  let messages = useRebuild ? rebuildMessages(row) : patched!.map(toBaseMessage);
  if (useRebuild && appendSystem !== undefined) messages.push(new SystemMessage(appendSystem));
  if (process.argv.includes("--no-request")) messages = messages.filter((m) => m.getType() !== "human");
  if (process.argv.includes("--no-turn-system")) {
    while (messages.length > 0 && messages[messages.length - 1]!.getType() === "system") messages.pop();
  }
  const allowedTools = toolsFor(row.situation, lastMoveOf(row.history ?? [])?.island);

  if (dumpPath !== undefined) {
    const target = turns.length === 1 ? dumpPath : `${dumpPath}.t${turn}`;
    const text = (message: BaseMessage): string =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    writeFileSync(target, messages.map((m) => `===== ${m.getType()} =====\n${text(m)}`).join("\n\n"));
  }
  if (dry) {
    console.log(
      `dry t${row.turn} situation=${row.situation} mode=${useRebuild ? "rebuild" : "patch"} ` +
        `tools=[${allowedTools.join(",")}] messages=[${messages.map((message) => message.getType()).join(",")}]`,
    );
    continue;
  }

  console.log(
    `turn ${row.turn} situation=${row.situation} mode=${useRebuild ? "rebuild" : "patch"} ` +
      `messages=${messages.length} tools=[${allowedTools.join(",")}] model=${modelName} repeat=${repeat}`,
  );
  for (let run = 0; run < repeat; run += 1) {
    const reasoning: string[] = [];
    const attempts: Attempt[] = [];
    const { model, rebuild } = makeRenderer(reasoning, attempts);
    const meter = new TurnMeter();
    let finish: string | undefined;
    try {
      const proposal: Proposals = await invokeTools(model, messages, {
        settings,
        rebuild,
        callbacks: [meter],
        allowedTools,
        onResponse: (response) => {
          const value = (response as { response_metadata?: { finish_reason?: unknown } } | undefined)
            ?.response_metadata?.finish_reason;
          if (typeof value === "string") finish = value;
        },
      });
      console.log(
        `  #${run} actions=${proposal.actions.map(label).join("+")} thought=${proposal.thought.length} ` +
          `out=${meter.outputTokens} reason=${meter.reasoningTokens} in=${meter.inputTokens} calls=${meter.calls} finish=${finish ?? "?"}`,
      );
      console.log(`     args=${JSON.stringify(proposal.actions).slice(0, 6000)}`);
      if (showResponses) {
        attempts.forEach((a, i) => {
          const body = (a.reasoning || a.content).replace(/\s+/g, " ").trim();
          console.log(`     attempt#${i} finish=${a.finish ?? "?"} keys=[${a.keys}] rlen=${a.reasoning.length} clen=${a.content.length}`);
          console.log(`       ${body.slice(-1400)}`);
        });
      }
      const text = reasoning.join("\n").replace(/\s+/g, " ").trim();
      if (showReasoning && text !== "") console.log(`     reasoning: ${text}`);
    } catch (error) {
      console.log(`  #${run} FAIL finish=${finish ?? "?"} ${(error as Error).message.slice(0, 160)}`);
    }
  }
}
