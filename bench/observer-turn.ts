// Runs the RequestObserver on ONE recorded turn of a `sandbox-tasks` run — no container, no
// task rerun. This is the cheap way to ask "does the observer say something real and usable on
// a turn that actually went wrong?", instead of spending a whole live run per question.
//
// The state is rebuilt from the recorded journal (`result.json`) up to the turn, exactly as the
// engine saw it: the trigger fires in `progress`, after the turn executed, so a trigger recorded
// at turn N is the state whose nodes carry `payload.turn <= N`.
//
// The trigger comes from the run's own `session.json` (recorded verbatim by the engine), unless
// `--detect` is given, in which case the current `detectTriggers` is asked instead — that is how
// a threshold change can be checked against the recorded history.
//
// The observer's answer is put through `applyReaction` (logos), so "it said something" and "the
// engine would accept it" are reported as separate facts. A hint whose evidence ids do not exist
// in the state is refused here exactly as it would be in a live run.
//
// Usage:
//   npx tsx bench/observer-turn.ts <run> --turn N [options]
//
// Options:
//   --turn N        the turn whose state the observer sees (required)
//   --kind K        pick a recorded trigger kind at that turn (`budget`, `state_long`, `state_cycle`)
//   --detect        ignore recorded triggers and run `detectTriggers` on the rebuilt state
//   --repeat K      run the observer K times (default 1); a single sample means little at
//                   temperature > 0
//   --dry           print the reconstructed tape and the messages; no model call, free
//   --tape          also print the full state tape the observer is given
//
// Live model calls cost money and are gated (AGENTS.md): run only with the owner's go-ahead.
// `--dry` is free.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { ModelMessage } from "ai";

import { loadSettings } from "../src/config/settings";
import { fold } from "../src/ir/graph";
import { project } from "../src/ir/project";
import { currentMove } from "../src/ir/traversal";
import type { Event } from "../src/ir/events";
import { createChatModel } from "../src/llm/client";
import { modelRequestObserver } from "../src/llm/observer";
import { applyReaction } from "../src/session/apply";
import {
  buildObserverMessages,
  projectObserver,
  runRequestObserver,
  seedObserverUnit,
  type RequestObserver,
} from "../src/session/observer";
import { createSession, openUnit } from "../src/session/session";
import { detectTriggers } from "../src/session/triggers";
import type { Trigger } from "../src/session/types";
import { TurnMeter } from "./metrics";

const RUNS = join(import.meta.dirname, "runs", "sandbox-tasks");

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function resolveRun(arg: string): string {
  const direct = join(RUNS, arg);
  if (existsSync(join(direct, "result.json"))) return direct;
  const dirs = readdirSync(RUNS)
    .filter((dir) => dir === arg || dir.endsWith(`-${arg}`) || dir.includes(`-${arg}-`) || dir.includes(arg))
    .sort();
  const last = dirs[dirs.length - 1];
  if (last === undefined) throw new Error(`no run matching "${arg}" under ${RUNS}`);
  return join(RUNS, last);
}

interface RecordedTrigger {
  trigger: Trigger;
  reaction?: { kind: string; text?: string; reason?: string; evidence?: string[] };
  noDecision?: string;
}

function recordedTriggers(runDir: string): RecordedTrigger[] {
  const path = join(runDir, "session.json");
  if (!existsSync(path)) return [];
  const journal = (JSON.parse(readFileSync(path, "utf8")) as { journal?: Record<string, unknown>[] }).journal ?? [];
  const out: RecordedTrigger[] = [];
  for (const event of journal) {
    if (event.type === "trigger" && event.trigger !== undefined) {
      out.push({ trigger: event.trigger as Trigger });
      continue;
    }
    const current = out.at(-1);
    if (current === undefined) continue;
    if (event.type === "reaction" && event.reaction !== undefined) {
      current.reaction = event.reaction as RecordedTrigger["reaction"];
    }
    if (event.type === "no_decision") {
      const reason = (event as { reason?: unknown }).reason;
      current.noDecision = typeof reason === "string" ? reason : "no_decision";
    }
  }
  return out;
}

// The state as the engine saw it at turn `at`: every node whose `payload.turn` is <= at.
function stateAt(events: readonly Event[], at: number) {
  let cut = events.length;
  for (const [index, event] of events.entries()) {
    if (event.type !== "add_node") continue;
    const turn = (event.node.payload as { turn?: number } | undefined)?.turn;
    if (turn !== undefined && turn > at) {
      cut = index;
      break;
    }
  }
  return fold(events.slice(0, cut));
}

function textOf(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => {
      if (part.type === "text" || part.type === "reasoning") return part.text;
      if (part.type === "tool-call") {
        return `-> call ${part.toolName}(${JSON.stringify(part.input)}) [id ${part.toolCallId}]`;
      }
      if (part.type === "tool-result") {
        const output = part.output as { value?: unknown } | undefined;
        const value = typeof output?.value === "string" ? output.value : JSON.stringify(output?.value ?? "");
        return `(answers ${part.toolCallId}) ${value}`;
      }
      return "";
    })
    .join("\n");
}

function percent(value: number, total: number): string {
  return total === 0 ? "0%" : `${Math.round((value / total) * 100)}%`;
}

async function main(): Promise<void> {
  const runArg = process.argv[2];
  if (runArg === undefined || runArg.startsWith("--")) {
    console.error(
      "usage: tsx bench/observer-turn.ts <run> --turn N [--kind K] [--detect] [--repeat K] [--dry] [--tape]",
    );
    process.exit(1);
  }
  const runDir = resolveRun(runArg);
  const at = Number(flag("--turn") ?? NaN);
  if (!Number.isInteger(at) || at < 0) {
    console.error("--turn N is required");
    process.exit(1);
  }
  const dry = process.argv.includes("--dry");
  const showTape = process.argv.includes("--tape");
  const useDetect = process.argv.includes("--detect");
  const repeat = Math.max(1, Number(flag("--repeat") ?? "1"));

  const result = JSON.parse(readFileSync(join(runDir, "result.json"), "utf8")) as {
    events?: Event[];
    stopReason?: string;
    reward?: number;
  };
  const events = result.events ?? [];
  if (events.length === 0) throw new Error(`no events in ${runDir}/result.json`);

  const state = stateAt(events, at);
  const move = currentMove(state);
  if (move === undefined) {
    console.error(`no current state at turn ${at}`);
    process.exit(1);
  }
  const hasTurns = [...state.nodes.values()].some((node) => node.kind === "turns");
  if (!hasTurns) {
    console.warn(
      "warning: this run predates the `turns` container (legacy IR layout) — the tape has no turn sections.",
    );
  }

  console.log(`run    ${runDir.split("/").at(-1)}`);
  console.log(`outcome stop=${result.stopReason} reward=${result.reward}`);
  console.log(`turn   ${at}   state=${move}   nodes=${state.nodes.size}`);

  const recorded = recordedTriggers(runDir);
  let trigger: Trigger | undefined;
  if (useDetect) {
    const session = createSession();
    openUnit(session, "r1", "task");
    const detected = detectTriggers(
      { state, session, unitId: "r1", turn: at },
      { maxTurns: 24 },
    );
    trigger = detected[0];
    console.log(`trigger (detected) ${trigger === undefined ? "none" : `${trigger.kind} @t${trigger.turn}`}`);
  } else {
    const kind = flag("--kind");
    const candidates = recorded.filter(
      (entry) => entry.trigger.turn === at && (kind === undefined || entry.trigger.kind === kind),
    );
    const picked = candidates[0];
    trigger = picked?.trigger;
    if (picked?.reaction !== undefined) {
      const text = picked.reaction.text ?? picked.reaction.reason ?? "";
      console.log(`recorded  trigger=${picked.trigger.kind}  reaction=${picked.reaction.kind}`);
      console.log(`  text: ${text.replace(/\n/g, " ")}`);
      console.log(`  evidence: ${JSON.stringify(picked.reaction.evidence ?? [])}`);
    } else if (picked?.noDecision !== undefined) {
      console.log(`recorded  trigger=${picked.trigger.kind}  no decision (${picked.noDecision})`);
    }
  }
  if (trigger === undefined) {
    console.error(`no trigger at turn ${at} (try --kind or --detect)`);
    process.exit(1);
  }

  const seed = seedObserverUnit(trigger, state);
  const tape = (seed[1] as { node: { payload: { result: string } } }).node.payload.result;
  const messages = buildObserverMessages(projectObserver(trigger, seed));
  const total = tape.length;
  const requestPart = tape.indexOf("\nstate ");
  const headerChars = requestPart === -1 ? total : requestPart;
  console.log(
    `tape      ${total} chars (~${Math.round(total / 3.38)} tok): header ${headerChars} (${percent(headerChars, total)}) ` +
      `+ state ${total - headerChars} (${percent(total - headerChars, total)}); ` +
      `${(tape.match(/^## /gm) ?? []).length} turns, ${(tape.match(/^thinking: /gm) ?? []).length} with reasoning, ` +
      `${(tape.match(/^-> obs:/gm) ?? []).length} observations`,
  );

  if (showTape) {
    console.log("\n--- state tape ---");
    console.log(tape);
    console.log("--- end tape ---\n");
  }

  if (dry) {
    console.log("\n--- observer messages (dry) ---");
    for (const message of messages) {
      const text = textOf(message);
      console.log(`[${message.role}] ${text.length} chars: ${text.slice(0, 220).replace(/\n/g, " ")}…`);
    }
    console.log("--- no model call was made ---");
    return;
  }

  const settings = loadSettings();
  if (process.env.SKEIN_LIVE !== "true") {
    console.error("Set SKEIN_LIVE=true to make live model calls (or use --dry).");
    process.exit(1);
  }
  const model = createChatModel(settings);
  console.log(`model     ${settings.model}\n`);

  for (let attempt = 1; attempt <= repeat; attempt += 1) {
    const meter = new TurnMeter();
    const live = modelRequestObserver(model, { settings, usageHandlers: [meter] });
    const agent: RequestObserver = async (input) => live(input);

    const started = Date.now();
    const outcome = await runRequestObserver({ trigger, state, agent });
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const decision = outcome.decision;

    console.log(`=== attempt ${attempt}/${repeat} (${elapsed}s) ===`);
    console.log(
      `tokens    in=${meter.inputTokens} out=${meter.outputTokens} reason=${meter.reasoningTokens} ` +
        `calls=${meter.calls} cost=${meter.costCalls > 0 ? `${meter.costRub.toFixed(4)}₽` : "?"}`,
    );
    if (decision === undefined) {
      console.log(`decision  NONE (${outcome.noDecision ?? "unknown"})`);
      continue;
    }
    console.log(`decision  ${decision.kind}`);
    if (decision.kind === "halt") {
      console.log(`  reason: ${decision.reason}`);
      continue;
    }
    console.log(`  text: ${decision.text.replace(/\n/g, " ")}`);
    console.log(`  evidence: ${JSON.stringify(decision.evidence)}`);
    if (decision.kind === "hint") console.log(`  state: ${decision.state} (stamped by the engine)`);

    // Logos: the same check a live run applies. This is the part that separates a plausible
    // sentence from a reaction the engine can actually record.
    const applied = applyReaction({
      state,
      reaction: decision,
      sourceUnit: `observer:bench:${attempt}`,
    });
    if (!applied.ok) {
      console.log(`  APPLIED  no — ${applied.reason}`);
      continue;
    }
    // The task tape after the reaction, to show the hint as the agent will see it.
    const context = project(fold([...events, ...applied.events]));
    const advisories = context.history
      .filter((message) => message.role === "system" && message.text.startsWith("Tape-agent"))
      .map((message) => message.text);
    const rendered = advisories.at(-1);
    console.log(`  APPLIED  yes${rendered === undefined ? "" : `  ->  ${rendered.replace(/\n/g, " ")}`}`);
  }
}

await main();
