import { childrenOf, fold, stopOf, unactionableOf, type State } from "../ir/graph";
import { currentMove, isMoveFinished, moveIsland, movePayload } from "../ir/traversal";
import {
  attentionOf,
  sessionFocus,
  unitOf,
  unitsInOrder,
} from "./session";
import type { NoDecisionReason, SessionOperation, SessionState, Unit } from "./types";

// The hierarchical outline of a session (docs/session_concepts.md §5): L0 — the units,
// L1 — a unit's states. It is a deterministic read of the session and unit journals, not a
// separate model of "knowledge"; every level is bounded and its truncation is explicit.

export interface OutlineOptions {
  limit?: number;
  // The session agent's L0 is shown in full; other callers (the terminal view) may bound it.
  truncate?: boolean;
}

export const DEFAULT_SESSION_OUTLINE_LIMIT = 20;
export const DEFAULT_UNIT_OUTLINE_LIMIT = 30;

// A trace is short by design: the body stays in the journal and is fetched by id.
const MAX_TRACE_TEXT = 240;

function short(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > MAX_TRACE_TEXT ? `${clean.slice(0, MAX_TRACE_TEXT)}…` : clean;
}

function labelOf(state: State, id: string): string {
  return state.nodes.get(id)?.label ?? id;
}

interface TraceDecision {
  operation?: SessionOperation;
  reason?: string;
  reasoning?: string;
  // The post-task answer, when the session unit started a task that has since finished.
  report?: string;
  // Why an interpretation turn ended without an operation.
  noDecision?: NoDecisionReason;
}

// The decision a session unit committed or had refused; a report may follow a `start`.
function decisionOf(session: SessionState, unitId: string): TraceDecision | undefined {
  const decision: TraceDecision = {};
  for (const event of session.journal) {
    if (event.unitId !== unitId) continue;
    if (event.type === "operation") {
      decision.operation = event.operation;
      if (event.reasoning !== undefined) decision.reasoning = event.reasoning;
      delete decision.reason;
    } else if (event.type === "refusal") {
      decision.operation = event.operation;
      decision.reason = event.reason;
      if (event.reasoning !== undefined) decision.reasoning = event.reasoning;
    } else if (event.type === "report") {
      decision.report = event.text;
    } else if (event.type === "no_decision") {
      decision.noDecision = event.reason;
    }
  }
  return Object.keys(decision).length > 0 ? decision : undefined;
}

function decisionText(decision: TraceDecision): string {
  const { operation, reason, reasoning, report, noDecision } = decision;
  const text =
    operation === undefined
      ? ""
      : operation.kind === "respond"
        ? `respond: "${short(operation.text)}"`
        : `start: "${short(operation.text)}"`;
  const refused = reason !== undefined ? ` (refused: ${reason})` : "";
  const thought =
    reasoning !== undefined ? ` · reasoning: "${short(reasoning)}"` : "";
  const answer = report !== undefined ? `${text !== "" ? " · " : ""}report: "${short(report)}"` : "";
  const base = `${text}${refused}${thought}${answer}`;
  const missing =
    noDecision !== undefined ? `${base !== "" ? " · " : ""}no decision: ${noDecision}` : "";
  return `${base}${missing}`;
}

function requestLabel(state: State, unit: Unit): string {
  const root = state.rootId;
  return root !== undefined ? labelOf(state, root) : unit.id;
}

// A terminal marker, not a verdict: the last state's `stop.why`, the declined
// interpretation, or where the work stands now.
function endingOf(state: State): string {
  const root = state.rootId;
  if (root === undefined) return "no request";
  const unactionable = unactionableOf(state, root);
  if (unactionable !== undefined) return `unactionable: "${labelOf(state, unactionable)}"`;
  const move = currentMove(state);
  if (move === undefined) return "open";
  const island = moveIsland(state, move) ?? "unknown";
  if (!isMoveFinished(state, move)) return `open at ${island}`;
  const stop = stopOf(state, move);
  return `${island}: "${stop !== undefined ? labelOf(state, stop) : ""}"`;
}

interface ReadingInfo {
  path: string;
  bytes?: number;
  lines?: number;
  observation?: string;
}

function readingInfo(unit: Unit): ReadingInfo {
  const state = fold(unit.journal);
  const root = state.rootId;
  const observation = [...state.nodes.values()].find((node) => node.kind === "observation");
  const payload = observation?.payload as { bytes?: unknown; lines?: unknown } | undefined;
  return {
    path: root !== undefined ? labelOf(state, root) : unit.id,
    ...(typeof payload?.bytes === "number" ? { bytes: payload.bytes } : {}),
    ...(typeof payload?.lines === "number" ? { lines: payload.lines } : {}),
    ...(observation !== undefined ? { observation: observation.id } : {}),
  };
}

function readingEnding(unit: Unit): string {
  const info = readingInfo(unit);
  return `read ${info.bytes ?? "?"} B, ${info.lines ?? "?"} line(s)${info.observation !== undefined ? `; ${info.observation}` : ""}`;
}

function unitLine(session: SessionState, unit: Unit, index: number): string {
  const state = fold(unit.journal);
  const label = requestLabel(state, unit);
  const status = attentionOf(session, unit.id);
  const ending =
    unit.type === "task" ? endingOf(state) : unit.type === "reading" ? readingEnding(unit) : "";
  // A session unit's trace carries its answer or the reformulated request it committed. The
  // task unit's trace carries the same reformulation as its request once the driver opens it.
  const decision = unit.type === "session" ? decisionOf(session, unit.id) : undefined;
  const detail = decision !== undefined ? `; ${decisionText(decision)}` : "";
  return `${index}. ${unit.type} ${unit.id} "${label}" ${status}${ending !== "" ? `; ${ending}` : ""}${detail}`;
}

export function sessionOutline(session: SessionState, options: OutlineOptions = {}): string {
  const units = unitsInOrder(session).filter((unit) => unit.type !== "observer");
  if (units.length === 0) return "no units";

  const limit =
    options.truncate === false
      ? Number.MAX_SAFE_INTEGER
      : Math.max(1, options.limit ?? DEFAULT_SESSION_OUTLINE_LIMIT);
  const indexOf = (unit: Unit): number => units.indexOf(unit) + 1;
  const lines: string[] = [];

  let shown = units;
  if (units.length > limit) {
    shown = units.slice(units.length - limit);
    const focusId = sessionFocus(session)?.unitId;
    const focus = focusId !== undefined ? units.find((unit) => unit.id === focusId) : undefined;
    const focusOutside = focus !== undefined && !shown.includes(focus);
    const omitted = units.filter((unit) => !shown.includes(unit) && unit !== focus);
    if (omitted.length > 0) {
      lines.push(`... ${omitted.length} more (before ${shown[0]?.id ?? ""})`);
    }
    if (focus !== undefined && focusOutside) {
      lines.push(unitLine(session, focus, indexOf(focus)));
    }
  }

  for (const unit of shown) lines.push(unitLine(session, unit, indexOf(unit)));
  return lines.join("\n");
}

export function unitOutline(
  session: SessionState,
  unitId: string,
  options: OutlineOptions = {},
): string {
  const unit = unitOf(session, unitId);
  const status = attentionOf(session, unitId);
  if (unit.type === "reading") {
    const info = readingInfo(unit);
    return [
      `unit ${unit.id} (reading) status: ${status}`,
      `path: ${info.path}`,
      `bytes: ${info.bytes ?? "?"}`,
      `lines: ${info.lines ?? "?"}`,
      `observation: ${info.observation ?? "?"}`,
    ].join("\n");
  }
  const state = fold(unit.journal);
  const root = state.rootId;
  const lines = [`unit ${unit.id} (${unit.type}) status: ${status}`];
  if (root === undefined) {
    lines.push("no request");
    return lines.join("\n");
  }

  lines.push(`request: ${labelOf(state, root)}`);
  const unactionable = unactionableOf(state, root);
  if (unactionable !== undefined) {
    lines.push(`unactionable: ${labelOf(state, unactionable)}`);
    return lines.join("\n");
  }

  const moves = childrenOf(state, root).filter(
    (id) => state.nodes.get(id)?.kind === "move",
  );
  if (moves.length === 0) {
    lines.push("(no states)");
    return lines.join("\n");
  }

  const limit = Math.max(1, options.limit ?? DEFAULT_UNIT_OUTLINE_LIMIT);
  const shown = moves.length > limit ? moves.slice(moves.length - limit) : moves;
  if (moves.length > limit) {
    lines.push(`... ${moves.length - limit} more (before ${shown[0] ?? ""})`);
  }
  for (const move of shown) {
    const island = moveIsland(state, move) ?? "unknown";
    const payload = movePayload(state, move);
    const closed = isMoveFinished(state, move);
    const stop = stopOf(state, move);
    const outcome = closed
      ? `closed: ${stop !== undefined ? labelOf(state, stop) : ""}`
      : "open";
    lines.push(`${move} ${island} what="${payload?.what ?? ""}" ${outcome}`);
  }
  return lines.join("\n");
}
