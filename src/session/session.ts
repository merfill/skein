import type { Event } from "../ir/events";
import { fold, unactionableOf } from "../ir/graph";
import { isTerminalIsland } from "../ir/islands";
import { currentMove, isMoveFinished, moveIsland } from "../ir/traversal";
import type {
  Attention,
  PendingUtterance,
  Reaction,
  SessionEvent,
  SessionOperation,
  SessionState,
  Trigger,
  Unit,
  UnitRef,
  UnitType,
} from "./types";

export function createSession(): SessionState {
  return { journal: [], units: new Map(), stack: [], utteranceSeq: 0 };
}

export function openUnit(
  session: SessionState,
  id: string,
  type: UnitType,
  journal: Event[] = [],
  turn = 0,
): Unit {
  if (session.units.has(id)) throw new Error(`unit already open: ${id}`);
  const unit: Unit = { id, type, journal, turn };
  session.units.set(id, unit);
  append(session, { type: "open_unit", unitId: id, unitType: type, turn });
  return unit;
}

export function unitOf(session: SessionState, id: string): Unit {
  const unit = session.units.get(id);
  if (unit === undefined) throw new Error(`unknown unit: ${id}`);
  return unit;
}

export function appendUnitEvent(session: SessionState, id: string, event: Event): void {
  unitOf(session, id).journal.push(event);
}

export function pushUnit(session: SessionState, unitId: string, turn: number): void {
  unitOf(session, unitId);
  session.stack.push({ unitId, turn });
  append(session, { type: "push", unitId, turn });
}

export function popUnit(session: SessionState): UnitRef | undefined {
  const ref = session.stack.pop();
  if (ref !== undefined) append(session, { type: "pop", unitId: ref.unitId });
  return ref;
}

export function sessionFocus(session: SessionState): UnitRef | undefined {
  return session.stack.at(-1);
}

export function focusedUnit(session: SessionState): Unit | undefined {
  const ref = sessionFocus(session);
  return ref === undefined ? undefined : session.units.get(ref.unitId);
}

export function observerDepth(session: SessionState): number {
  return session.stack.filter(
    (ref) => session.units.get(ref.unitId)?.type === "observer",
  ).length;
}

export function setPending(session: SessionState, text: string): void {
  session.pending = { text };
}

export function takePending(session: SessionState): PendingUtterance | undefined {
  const pending = session.pending;
  session.pending = undefined;
  return pending;
}

export function recordTrigger(
  session: SessionState,
  unitId: string,
  turn: number,
  trigger: Trigger,
): void {
  unitOf(session, unitId);
  append(session, { type: "trigger", unitId, turn, trigger });
}

export interface TriggerRecord {
  turn: number;
  trigger: Trigger;
}

export function triggerSamples(
  session: SessionState,
  unitId: string,
  kind: Trigger["kind"],
): TriggerRecord[] {
  const records: TriggerRecord[] = [];
  for (const event of session.journal) {
    if (event.type === "trigger" && event.unitId === unitId && event.trigger.kind === kind) {
      records.push({ turn: event.turn, trigger: event.trigger });
    }
  }
  return records;
}

export function recordReaction(session: SessionState, unitId: string, reaction: Reaction): void {
  unitOf(session, unitId);
  append(session, { type: "reaction", unitId, reaction });
}

export function suspendUnit(session: SessionState, unitId: string, turn: number): void {
  unitOf(session, unitId);
  append(session, { type: "suspend", unitId, turn });
}

export function abandonUnit(session: SessionState, unitId: string, turn: number): void {
  unitOf(session, unitId);
  append(session, { type: "abandon", unitId, turn });
}

export function recordOperation(
  session: SessionState,
  unitId: string,
  turn: number,
  operation: SessionOperation,
  reasoning?: string,
): void {
  unitOf(session, unitId);
  append(session, {
    type: "operation",
    unitId,
    turn,
    operation,
    ...(reasoning !== undefined ? { reasoning } : {}),
  });
}

export function recordRefusal(
  session: SessionState,
  unitId: string,
  turn: number,
  operation: SessionOperation,
  reason: string,
  reasoning?: string,
): void {
  unitOf(session, unitId);
  append(session, {
    type: "refusal",
    unitId,
    turn,
    operation,
    reason,
    ...(reasoning !== undefined ? { reasoning } : {}),
  });
}

// Units in the order they were opened (the session journal order); the caller filters the
// transient observer units it does not want to show.
export function unitsInOrder(session: SessionState): Unit[] {
  const seen = new Set<string>();
  const units: Unit[] = [];
  for (const event of session.journal) {
    if (event.type !== "open_unit" || seen.has(event.unitId)) continue;
    seen.add(event.unitId);
    const unit = session.units.get(event.unitId);
    if (unit !== undefined) units.push(unit);
  }
  return units;
}

// The request ended when its terminal state is stopped or the interpretation declined it
// (`unactionable`). This mirrors the loop's `progress` check without any run state.
function taskEnded(journal: readonly Event[]): boolean {
  const state = fold(journal);
  if (state.rootId === undefined) return false;
  if (unactionableOf(state, state.rootId) !== undefined) return true;
  const move = currentMove(state);
  if (move === undefined) return false;
  const island = moveIsland(state, move);
  return island !== undefined && isTerminalIsland(island) && isMoveFinished(state, move);
}

function lastAttentionEvent(session: SessionState, unitId: string): SessionEvent | undefined {
  let last: SessionEvent | undefined;
  for (const event of session.journal) {
    if (event.type !== "suspend" && event.type !== "resume" && event.type !== "abandon") continue;
    if (event.unitId === unitId) last = event;
  }
  return last;
}

function unitCompleted(session: SessionState, unit: Unit): boolean {
  if (unit.type === "task") return taskEnded(unit.journal);
  // A session unit is completed once its operation is committed or refused.
  if (unit.type === "session") {
    return session.journal.some(
      (event) =>
        (event.type === "operation" || event.type === "refusal") && event.unitId === unit.id,
    );
  }
  // A reading unit is complete once its observation is written.
  if (unit.type === "reading") {
    return unit.journal.some(
      (event) => event.type === "add_node" && event.node.kind === "observation",
    );
  }
  return false;
}

// The attention status is a deterministic read of the journals (docs/session_concepts.md §2):
// `abandoned` beats a closure, `completed` is the unit's own terminal fact, `active` is the
// focus. Nothing is stored.
export function attentionOf(session: SessionState, unitId: string): Attention {
  const unit = unitOf(session, unitId);
  const last = lastAttentionEvent(session, unitId);
  if (last?.type === "abandon") return "abandoned";
  if (unitCompleted(session, unit)) return "completed";
  if (sessionFocus(session)?.unitId === unitId) return "active";
  return "suspended";
}

function append(session: SessionState, event: SessionEvent): void {
  session.journal.push(event);
}
