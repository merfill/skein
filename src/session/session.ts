import type { Event } from "../ir/events";
import type {
  PendingUtterance,
  Reaction,
  SessionEvent,
  SessionState,
  Trigger,
  Unit,
  UnitRef,
  UnitType,
} from "./types";

export function createSession(): SessionState {
  return { journal: [], units: new Map(), stack: [] };
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

function append(session: SessionState, event: SessionEvent): void {
  session.journal.push(event);
}
