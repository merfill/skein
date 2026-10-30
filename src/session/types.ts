import type { Event } from "../ir/events";

export type UnitType = "task" | "observer" | "session";

export interface Unit {
  id: string;
  type: UnitType;
  journal: Event[];
  turn: number;
}

export interface UnitRef {
  unitId: string;
  turn: number;
}

export interface PendingUtterance {
  text: string;
}

export type TriggerKind = "budget" | "state_cycle" | "state_long";

export interface Trigger {
  id: string;
  kind: TriggerKind;
  anchor: string;
  evidence: string[];
  epoch: number;
  summary?: string;
  turn?: number;
}

export type Reaction =
  | { kind: "hint"; text: string; evidence: string[]; state: string }
  | { kind: "memo"; text: string; evidence: string[] }
  | { kind: "halt"; reason: string };

export type SessionEvent =
  | { type: "open_unit"; unitId: string; unitType: UnitType; turn: number }
  | { type: "push"; unitId: string; turn: number }
  | { type: "pop"; unitId: string }
  | { type: "trigger"; unitId: string; turn: number; trigger: Trigger }
  | { type: "reaction"; unitId: string; reaction: Reaction };

export interface SessionState {
  journal: SessionEvent[];
  units: Map<string, Unit>;
  stack: UnitRef[];
  pending?: PendingUtterance;
}
