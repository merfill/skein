import {
  actionExecuted,
  actionSucceeded,
  childrenOf,
  fold,
  stopOf,
  turnsOf,
  type State,
} from "../ir/graph";
import { observationText, requestTextOf, clipRequestText } from "../ir/project";
import type { Node } from "../ir/types";
import { isMoveFinished, moveIsland, movePayload } from "../ir/traversal";
import { readingText, type ReadFile } from "./reading";
import { unitOf } from "./session";
import type { SessionState } from "./types";

// Read-only queries over a past unit's journal (docs/en/session_concepts.md §5). These are the
// session agent's tools for L2 (state), turns, L4 (body) and content search; they never write
// to a unit journal. The result is returned as text with the ids needed for the next query.

const BODY_LIMIT = 8000;
const REASONING_LIMIT = 1200;
const SEARCH_LIMIT = 16000;

export interface TurnRange {
  from?: number;
  to?: number;
}

export interface BodyWindow {
  start?: number;
  end?: number;
}

export interface SearchOptions {
  before?: number;
  after?: number;
  from?: number;
  count?: number;
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? "";
}

function labelOf(state: State, id: string): string {
  return state.nodes.get(id)?.label ?? id;
}

function resultOf(state: State, actionId: string): string | undefined {
  for (const edge of state.edges.values()) {
    if (edge.kind === "result" && edge.from === actionId) return edge.to;
  }
  return undefined;
}

function unitState(session: SessionState, unitId: string): State {
  return fold(unitOf(session, unitId).journal);
}

function statusOf(state: State, actionId: string): string {
  if (actionSucceeded(state, actionId)) return "succeeded";
  return actionExecuted(state, actionId) ? "executed" : "not executed";
}

function resultSummary(state: State, actionId: string): string {
  const id = resultOf(state, actionId);
  if (id === undefined) return "";
  const node = state.nodes.get(id);
  const summary = node !== undefined ? firstLine(observationText(node)) : "";
  return ` -> ${id}${summary !== "" ? `: ${summary}` : ""}`;
}

// L2: the state's turns, each action's outcome and result.
export function stateDetail(session: SessionState, unitId: string, moveId: string): string {
  const state = unitState(session, unitId);
  const node = state.nodes.get(moveId);
  if (node === undefined || node.kind !== "move") return `unknown state: ${moveId}`;
  const island = moveIsland(state, moveId) ?? "unknown";
  const payload = movePayload(state, moveId);
  const closed = isMoveFinished(state, moveId);
  const stop = stopOf(state, moveId);
  const lines = [
    `state ${moveId}: ${island}`,
    `what: ${payload?.what ?? ""}`,
    `closure: ${closed ? `closed (${stop !== undefined ? labelOf(state, stop) : ""})` : "open"}`,
    "turns:",
  ];

  const turns = turnsOf(state, moveId);
  const actions = turns !== undefined ? childrenOf(state, turns) : [];
  if (actions.length === 0) {
    lines.push("(empty)");
    return lines.join("\n");
  }
  for (const action of actions) {
    lines.push(
      `- ${action}: ${labelOf(state, action)} [${statusOf(state, action)}]${resultSummary(state, action)}`,
    );
  }
  return lines.join("\n");
}

// The state's turns: action, result id and outcome, plus the task agent's reasoning as stored
// on the action node. The range selects turns, not text lines.
export function stateTurnHistory(
  session: SessionState,
  unitId: string,
  moveId: string,
  range: TurnRange = {},
): string {
  const state = unitState(session, unitId);
  const turns = turnsOf(state, moveId);
  const actions = turns !== undefined ? childrenOf(state, turns) : [];
  const history: string[] = [];
  for (const action of actions) {
    const node = state.nodes.get(action);
    if (node === undefined || node.kind !== "action") continue;
    const reasoning = (node.payload as { reasoning?: unknown } | undefined)?.reasoning;
    let line = `- ${action}: ${labelOf(state, action)} [${statusOf(state, action)}]${resultSummary(state, action)}`;
    if (typeof reasoning === "string" && reasoning.trim() !== "") {
      line += `\n  reasoning: ${clip(reasoning.replace(/\s+/g, " ").trim(), REASONING_LIMIT)}`;
    }
    history.push(line);
  }
  if (history.length === 0) return "no turns";
  const from = Math.max(0, range.from ?? 0);
  const to = range.to !== undefined ? Math.max(from, range.to) + 1 : history.length;
  return history.slice(from, to).join("\n");
}

function windowText(text: string, window: BodyWindow = {}): string {
  const lines = text.split("\n");
  const total = lines.length;
  const from = window.start !== undefined && window.start > 0 ? window.start : 1;
  const requestedEnd = window.end !== undefined && window.end > 0 ? window.end : total;
  const to = Math.max(from, Math.min(requestedEnd, total));
  const kept: string[] = [];
  let size = 0;
  for (let index = from; index <= to; index += 1) {
    const line = lines[index - 1] ?? "";
    if (index > from && size + line.length + 1 > BODY_LIMIT) break;
    kept.push(line);
    size += line.length + 1;
  }
  if (kept.length === 0) return `(nothing at line ${from}; body has ${total} lines)`;
  const last = from + kept.length - 1;
  const head = kept.join("\n");
  return last < total ? `${head}\n…[lines ${from}–${last} of ${total}; continue from ${last + 1}]` : head;
}

function observationContent(node: Node, readFile?: ReadFile): string {
  const payload = (node.payload ?? {}) as { path?: unknown; version?: unknown; output?: unknown };
  if (typeof payload.path === "string") {
    return readingText(payload, readFile) ?? observationText(node);
  }
  return observationText(node);
}

// L4: the stored content of an observation (or the result of an action), optionally windowed.
export function bodyText(
  session: SessionState,
  unitId: string,
  id: string,
  window: BodyWindow = {},
  readFile?: ReadFile,
): string {
  const state = unitState(session, unitId);
  const node = state.nodes.get(id);
  if (node === undefined) return `unknown observation: ${id}`;
  // The request's body is its full text: this is the id the outline prints, so asking for it
  // must return the request, not "not an observation".
  if (node.kind === "request") {
    return windowText(clipRequestText(requestTextOf(state) ?? node.label), window);
  }
  if (node.kind === "observation") return windowText(observationContent(node, readFile), window);
  if (node.kind === "action") {
    const result = resultOf(state, id);
    if (result === undefined) return "no result";
    const resultNode = state.nodes.get(result);
    return resultNode !== undefined
      ? windowText(observationContent(resultNode, readFile), window)
      : `unknown observation: ${result}`;
  }
  return `${id} is a ${node.kind}, not an observation; pass an observation id (e.g. obs:…), not a unit id or a path`;
}

// L4 search: deterministic regex over the unit's observation bodies. Returns the observation
// id, the matching line and its context; no similarity, no task-journal writes.
export function searchUnit(
  session: SessionState,
  unitId: string,
  pattern: string,
  options: SearchOptions = {},
  readFile?: ReadFile,
): string {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return `invalid pattern: ${pattern}`;
  }
  const state = unitState(session, unitId);
  const observations = [...state.nodes.values()]
    .filter((node) => node.kind === "observation")
    .sort((left, right) => left.seq - right.seq);
  const before = options.before ?? 2;
  const after = options.after ?? 2;
  const from = Math.max(0, options.from ?? 0);
  const count = Math.max(1, options.count ?? 20);

  const matches: string[] = [];
  let total = 0;
  for (const node of observations) {
    const lines = observationContent(node, readFile).split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (!regex.test(line)) continue;
      total += 1;
      if (total <= from || matches.length >= count) continue;
      const start = Math.max(0, index - before);
      const end = Math.min(lines.length - 1, index + after);
      const context = lines
        .slice(start, end + 1)
        .map((text, offset) => `  ${start + offset + 1}: ${text}`)
        .join("\n");
      matches.push(`[${node.id}] line ${index + 1}:\n${context}`);
    }
  }
  if (matches.length === 0) return "no matches";
  const head = `${matches.length} match(es)${total > matches.length + from ? ` of ${total}` : ""}:\n`;
  return clip(head + matches.join("\n"), SEARCH_LIMIT);
}
