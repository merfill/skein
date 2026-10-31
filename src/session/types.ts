import type { Event } from "../ir/events";

export type UnitType = "task" | "observer" | "session" | "reading";

export interface Unit {
  id: string;
  type: UnitType;
  journal: Event[];
  turn: number;
  // The task-entry checkpoint id (task units only). Engine scaffolding, not the projection.
  checkpoint?: string;
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

// A structured action of the SessionAgent on the session (docs/session_concepts.md §4.3).
// The doxa proposes it; logos checks and applies it as a session event. The vocabulary is
// deliberately minimal: answer, or start a task from a reformulated request. Resume/cancel
// strategies and `revise` are deferred.
export type SessionOperation =
  | { kind: "respond"; text: string }
  | { kind: "start"; text: string };

// The session's attention for a unit. Derived from the journals, never stored as a field:
// `completed` is a terminal marker of the unit journal, `abandoned` is a session fact, and
// neither closes a state (docs/session_concepts.md §2).
export type Attention = "active" | "suspended" | "abandoned" | "completed";

// Why an interpretation turn ended without an operation: the model gave nothing, or the loop
// reached its safety cap. The unit stays suspended; the journal keeps the reason.
export type NoDecisionReason = "empty_reply" | "max_turns";

export type SessionEvent =
  | { type: "open_unit"; unitId: string; unitType: UnitType; turn: number }
  | { type: "push"; unitId: string; turn: number }
  | { type: "pop"; unitId: string }
  | { type: "trigger"; unitId: string; turn: number; trigger: Trigger }
  | { type: "reaction"; unitId: string; reaction: Reaction }
  | { type: "suspend"; unitId: string; turn: number }
  | { type: "resume"; unitId: string; turn: number }
  | { type: "abandon"; unitId: string; turn: number }
  | {
      type: "operation";
      unitId: string;
      turn: number;
      operation: SessionOperation;
      reasoning?: string;
    }
  | {
      type: "refusal";
      unitId: string;
      turn: number;
      operation: SessionOperation;
      reason: string;
      reasoning?: string;
    }
  // The session agent's answer after a task it started has finished. It is a report, not a
  // second interpretation of the utterance, so it belongs to the same session unit.
  | { type: "report"; unitId: string; turn: number; text: string }
  | { type: "no_decision"; unitId: string; turn: number; reason: NoDecisionReason };

export interface SessionState {
  journal: SessionEvent[];
  units: Map<string, Unit>;
  stack: UnitRef[];
  pending?: PendingUtterance;
  // The ordinal of the next user utterance. It is a dialogue clock, not a task turn.
  utteranceSeq: number;
}
