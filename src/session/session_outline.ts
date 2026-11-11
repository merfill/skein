import { childrenOf, fold, stopOf, turnsOf, unactionableOf, type State } from "../ir/graph";
import { clipRequestText, requestTextOf } from "../ir/project";
import { currentMove, isMoveFinished, moveIsland, movePayload } from "../ir/traversal";
import {
  attentionOf,
  sessionFocus,
  unitOf,
  unitsInOrder,
} from "./session";
import {
  latestPlan,
  planFinished,
  planModeOf,
  planOfUnit,
  planProgress,
} from "./plan";
import type { NoDecisionReason, SessionOperation, SessionState, Unit } from "./types";

// The hierarchical outline of a session (docs/en/sessions.md §2): L0 — the units,
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
  // Why an interpretation turn ended without an operation.
  noDecision?: NoDecisionReason;
}

// The decision a session unit committed or had refused.
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
    } else if (event.type === "no_decision") {
      decision.noDecision = event.reason;
    }
  }
  return Object.keys(decision).length > 0 ? decision : undefined;
}

function decisionText(decision: TraceDecision): string {
  const { operation, reason, reasoning, noDecision } = decision;
  const text =
    operation === undefined
      ? ""
      : operation.kind === "respond"
        ? `respond: "${short(operation.text)}"`
      : operation.kind === "general"
        ? `general: "${short(operation.text)}"`
        : operation.kind === "plan"
          ? `plan: "${short(operation.text)}"`
          : operation.kind === "document"
            ? `document: "${short(operation.text)}"`
            : `task: "${short(operation.text)}"`;
  const refused = reason !== undefined ? ` (refused: ${reason})` : "";
  const thought =
    reasoning !== undefined ? ` · reasoning: "${short(reasoning)}"` : "";
  const base = `${text}${refused}${thought}`;
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
  const island = moveIsland(state, move) ?? movePayload(state, move)?.state ?? "unknown";
  if (!isMoveFinished(state, move)) return `open at ${island}`;
  const stop = stopOf(state, move);
  return `${island}: "${stop !== undefined ? short(labelOf(state, stop)) : ""}"`;
}

function resultOfAction(state: State, actionId: string): string | undefined {
  for (const edge of state.edges.values()) {
    if (edge.kind === "result" && edge.from === actionId) return edge.to;
  }
  return undefined;
}

function generalActionText(state: State, actionId: string): string | undefined {
  const action = state.nodes.get(actionId);
  if (action === undefined || action.kind !== "action") return undefined;
  const payload = action.payload as { call?: { name?: unknown; args?: unknown } } | undefined;
  const name = typeof payload?.call?.name === "string" ? payload.call.name : undefined;
  const args =
    payload?.call?.args !== null && typeof payload?.call?.args === "object"
      ? (payload.call.args as Record<string, unknown>)
      : {};
  const observationId = resultOfAction(state, actionId);
  const observation = observationId !== undefined ? state.nodes.get(observationId) : undefined;
  const result = observation?.payload as
    | { total?: unknown; failed?: unknown; refused?: unknown }
    | undefined;
  const failed = result?.failed === true || result?.refused === true;
  const total = typeof result?.total === "number" ? result.total : undefined;
  if (name === "read") {
    const path =
      typeof args.filePath === "string"
        ? args.filePath
        : typeof args.path === "string"
          ? args.path
          : action.label;
    const suffix = failed ? " (failed)" : total !== undefined ? ` (${total} line(s))` : "";
    return `read ${path.startsWith("read ") ? path.slice(5) : path}${suffix}`;
  }
  if (name === "grep") {
    const pattern = typeof args.pattern === "string" ? args.pattern : "?";
    const path = typeof args.path === "string" ? ` in ${args.path}` : "";
    const suffix = failed ? " (failed)" : total !== undefined ? ` (${total} match(es))` : "";
    return `grep "${pattern}"${path}${suffix}`;
  }
  if (name === "list") {
    const path = typeof args.path === "string" ? ` ${args.path}` : "";
    const suffix = failed ? " (failed)" : total !== undefined ? ` (${total} file(s))` : "";
    return `list${path}${suffix}`;
  }
  return name ?? action.label;
}

function generalEnding(state: State, unit: Unit): string {
  const root = state.rootId;
  if (root === undefined) return "open";
  const turns = turnsOf(state, root);
  const actions: string[] = [];
  const seen = new Set<string>();
  if (turns !== undefined) {
    for (const actionId of childrenOf(state, turns)) {
      const text = generalActionText(state, actionId);
      if (text !== undefined && !seen.has(text)) {
        seen.add(text);
        actions.push(text);
      }
    }
  }
  const stop = stopOf(state, root);
  const stopNode = stop !== undefined ? state.nodes.get(stop) : undefined;
  const payload = stopNode?.payload as { answer?: unknown } | undefined;
  const answer =
    typeof payload?.answer === "string"
      ? payload.answer
      : stopNode?.label !== undefined
        ? stopNode.label
        : undefined;
  const parts: string[] = [];
  if (actions.length > 0) {
    const shown = actions.slice(0, 6);
    parts.push(
      `actions: ${shown.join("; ")}${actions.length > shown.length ? `; +${actions.length - shown.length} more` : ""}`,
    );
  }
  if (answer !== undefined && answer !== "") parts.push(`answer: "${short(answer)}"`);
  if (parts.length === 0) return stop !== undefined ? "closed" : "open";
  return parts.join("; ");
}

function planEnding(session: SessionState, unit: Unit): string {
  const plan = planOfUnit(unit);
  if (plan === undefined) return "no plan submitted";
  const progress = planProgress(session, plan);
  return `${progress.completed}/${progress.total} item(s) done`;
}

function documentEnding(unit: Unit): string {
  const state = fold(unit.journal);
  let path = "";
  let total = 0;
  let written = 0;
  for (const node of state.nodes.values()) {
    const payload = node.payload as
      | {
          call?: { name?: unknown };
          outline?: { path?: unknown; items?: unknown };
          itemId?: unknown;
        }
      | undefined;
    if (node.kind !== "action") continue;
    if (payload?.call?.name === "submit_plan") {
      const outline = payload.outline;
      if (outline !== undefined) {
        path = typeof outline.path === "string" ? outline.path : "";
        total = Array.isArray(outline.items) ? outline.items.length : 0;
      }
    }
    if (typeof payload?.itemId === "number") written += 1;
  }
  if (path === "") return "no outline submitted";
  return `${path}: ${written}/${total} section(s)`;
}

function unitLine(session: SessionState, unit: Unit, index: number): string {
  const state = fold(unit.journal);
  const label = requestLabel(state, unit);
  const status = attentionOf(session, unit.id);
  const ending =
    unit.type === "task"
      ? endingOf(state)
      : unit.type === "general"
        ? generalEnding(state, unit)
        : unit.type === "plan"
          ? planEnding(session, unit)
          : unit.type === "document"
            ? documentEnding(unit)
            : "";
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
  // The plan execution marker: the active plan's progress, or the last plan's completion
  // (the "special element" that closes the plan run).
  const plan = latestPlan(session);
  if (plan !== undefined) {
    const finished = planFinished(session, plan.planUnitId);
    if (finished !== undefined) {
      lines.push(
        `plan ${plan.planUnitId}: ${finished.status} (${finished.completed}/${finished.total})`,
      );
    } else if (planModeOf(session) === plan.planUnitId) {
      const progress = planProgress(session, plan);
      lines.push(
        `plan ${plan.planUnitId}: executing (${progress.completed}/${progress.total})`,
      );
    }
  }
  return lines.join("\n");
}

export function unitOutline(
  session: SessionState,
  unitId: string,
  options: OutlineOptions = {},
): string {
  const unit = unitOf(session, unitId);
  const status = attentionOf(session, unitId);
  const state = fold(unit.journal);
  const root = state.rootId;
  const lines = [`unit ${unit.id} (${unit.type}) status: ${status}`];
  if (root === undefined) {
    lines.push("no request");
    return lines.join("\n");
  }

  // The full request, not the display label: the session agent must be able to read what the
  // request requires (the L0 unit line keeps the short label for one-line-per-unit display).
  lines.push(`request: ${clipRequestText(requestTextOf(state) ?? labelOf(state, root))}`);
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
    const island = moveIsland(state, move) ?? movePayload(state, move)?.state ?? "unknown";
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
