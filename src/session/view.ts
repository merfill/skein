import type { Event } from "../ir/events";
import { observationText } from "../ir/project";
import type { SessionTurnResult } from "./driver";

// The terminal view is a deterministic projection of a driver turn, not a second store: the
// session-unit journal supplies the tool calls/results, the task events supply the work, and
// the answers stay Markdown. Reasoning is diagnostic only (`verbose`).

export interface RenderOptions {
  verbose?: boolean;
}

const RESULT_LIMIT = 600;
const REASONING_LIMIT = 2000;
const TRUNCATED = "… [truncated; use --verbose]";

function short(text: string, limit = RESULT_LIMIT): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

// Tool results keep their lines: a grep/list preview is read, not retold. `--verbose` expands
// the complete result (already bounded by the tool itself).
function resultText(text: string, options: RenderOptions): string {
  if (options.verbose === true || text.length <= RESULT_LIMIT) return text;
  return text.slice(0, RESULT_LIMIT) + TRUNCATED;
}

// The provider's hidden reasoning, shown like opencode's collapsed "Thought" block: only on
// `--verbose`, since a plain terminal cannot collapse it.
function thoughtLines(reasoning: string | undefined, options: RenderOptions): string[] {
  if (options.verbose !== true || reasoning === undefined) return [];
  const text = reasoning.trim();
  if (text === "") return [];
  const shown = text.length > REASONING_LIMIT ? `${text.slice(0, REASONING_LIMIT)}…` : text;
  return ["  Thought:", ...shown.split("\n").map((line) => `    ${line}`)];
}

function payloadOf(event: Event): Record<string, unknown> | undefined {
  return event.type === "add_node"
    ? (event.node.payload as Record<string, unknown> | undefined)
    : undefined;
}

function reasoningOf(payload: Record<string, unknown> | undefined): string | undefined {
  const reasoning = payload?.reasoning;
  return typeof reasoning === "string" && reasoning.trim() !== "" ? reasoning : undefined;
}

// The session agent's own tool calls and results. The operation tools (`respond`/`start`) are
// the decision line itself, so they are not repeated here.
function sessionLines(journal: readonly Event[], options: RenderOptions): string[] {
  const lines: string[] = [];
  for (const event of journal) {
    if (event.type !== "add_node") continue;
    const node = event.node;
    const payload = payloadOf(event);
    if (node.kind === "action") {
      const tool = String(payload?.tool ?? "");
      if (tool === "respond" || tool === "start") continue;
      lines.push(...thoughtLines(reasoningOf(payload), options));
      lines.push(`  call: ${tool}(${JSON.stringify(payload?.args ?? {})})`);
    } else if (node.kind === "observation") {
      const tool = String(payload?.tool ?? "");
      if (tool === "respond" || tool === "start") continue;
      lines.push(`  result: ${resultText(String(payload?.result ?? node.label), options)}`);
    }
  }
  return lines;
}

function taskAnswer(events: readonly Event[]): string | undefined {
  let answer: string | undefined;
  for (const event of events) {
    if (event.type === "add_node" && event.node.kind === "stop") answer = event.node.label;
  }
  return answer;
}

function taskLines(events: readonly Event[], options: RenderOptions): string[] {
  const lines: string[] = [];
  for (const event of events) {
    if (event.type === "record_rejection") {
      lines.push(`  rejected: ${event.tool} ${event.target}: ${event.reason}`);
      continue;
    }
    if (event.type !== "add_node") continue;
    const node = event.node;
    const payload = payloadOf(event);
    if (node.kind === "move") {
      lines.push(`  move: ${String(payload?.state)} — ${short(String(payload?.what ?? ""), 120)}`);
    } else if (node.kind === "action") {
      lines.push(...thoughtLines(reasoningOf(payload), options));
      lines.push(`  action: ${node.label}`);
    } else if (node.kind === "observation") {
      lines.push(`  observation ${node.id}: ${resultText(observationText(node), options)}`);
    } else if (node.kind === "stop") {
      lines.push(`  stop: ${short(node.label)}`);
    }
  }
  return lines;
}

export function renderTurn(result: SessionTurnResult, options: RenderOptions = {}): string[] {
  const lines = sessionLines(result.interpretation.journal, options);

  const operation = result.operation;
  if (operation === undefined) {
    const reason =
      result.noDecision === "max_turns"
        ? "max turns"
        : result.noDecision === "empty_reply"
          ? "empty reply"
          : undefined;
    lines.push(reason !== undefined ? `session: no decision (${reason})` : "session: no action");
  } else if (operation.kind === "respond") {
    lines.push("session: respond");
  } else {
    lines.push(`session: start("${operation.text}")`);
  }
  lines.push(...thoughtLines(result.reasoning, options));
  if (result.applied !== undefined && !result.applied.ok) {
    lines.push(`refused: ${result.applied.reason}`);
  }
  if (result.reply !== undefined) {
    lines.push("answer:", result.reply);
  }

  if (result.task !== undefined) {
    const { unitId, result: run } = result.task;
    const outcome = run.done ? (run.stopReason ?? "done") : "still open";
    lines.push(`task ${unitId}: ${outcome} after ${run.turns} turns`);
    lines.push(...taskLines(run.events, options));
    if (result.report === undefined) {
      const answer = taskAnswer(run.events);
      if (run.done && answer !== undefined && answer !== "") lines.push(`task answer: ${answer}`);
    }
  }

  if (result.report !== undefined) {
    lines.push("report:", result.report);
  }
  return lines;
}
