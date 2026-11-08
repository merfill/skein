import type { Event } from "../ir/events";

export type UnitType = "task" | "general" | "plan" | "observer" | "session";

export interface Unit {
  id: string;
  type: UnitType;
  journal: Event[];
  turn: number;
  // The task-entry checkpoint id (task units only). Engine scaffolding, not the projection.
  checkpoint?: string;
  // The execution-plan item this unit was opened for (task/general units under a plan).
  planItem?: string;
}

export interface UnitRef {
  unitId: string;
  turn: number;
}

export interface PendingUtterance {
  text: string;
  unitType?: "task" | "general" | "plan";
  // The execution-plan item this pending unit executes; the opened unit records the link.
  planItem?: string;
  planUnitId?: string;
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

// What the observer proposes. A hint's state is not part of the proposal: the trigger already
// named the state it fired in, so the engine stamps it instead of trusting the model to repeat it
// (and `apply` still checks it against the tree).
export type ReactionProposal =
  | { kind: "hint"; text: string; evidence: string[] }
  | { kind: "memo"; text: string; evidence: string[] }
  | { kind: "halt"; reason: string };

// A structured action of the SessionAgent on the session (docs/en/sessions.md §4.3).
// The model proposes it; the executor checks and applies it as a session event. The vocabulary is
// deliberately minimal: answer, open a task from a reformulated request, or delegate to the
// general agent. Resume/cancel strategies and `revise` are deferred.
export type SessionOperation =
  | { kind: "respond"; text: string }
  | { kind: "task"; text: string }
  | { kind: "general"; text: string }
  // Open the plan unit: an agent develops a plan (a structured list of items) from the
  // request and the workspace. It does not start execution; the user confirms first.
  | { kind: "plan"; text: string };

// The session's attention for a unit. Derived from the journals, never stored as a field:
// `completed` is a terminal marker of the unit journal, `abandoned` is a session fact, and
// neither closes a state (docs/en/sessions.md §2).
export type Attention = "active" | "suspended" | "abandoned" | "completed";

// Why an interpretation turn ended without an operation: the model gave nothing, or the loop
// reached its safety cap. The unit stays suspended; the journal keeps the reason.
export type NoDecisionReason = "empty_reply" | "max_turns";

export type SessionEvent =
  | {
      type: "open_unit";
      unitId: string;
      unitType: UnitType;
      turn: number;
      // The plan item this unit executes, when the unit belongs to an execution plan.
      planItem?: string;
    }
  // The user confirmed the plan: execution mode. The plan items are executed as ordinary
  // units, one after another; the mode is derived from this event until `plan_finished`.
  | { type: "plan_started"; unitId: string; planUnitId: string; turn: number }
  // The plan execution is over: either every item completed, or it was aborted.
  | {
      type: "plan_finished";
      unitId: string;
      planUnitId: string;
      turn: number;
      status: "done" | "aborted";
      completed: number;
      total: number;
    }
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
  | { type: "no_decision"; unitId: string; turn: number; reason: NoDecisionReason };

export interface SessionState {
  journal: SessionEvent[];
  units: Map<string, Unit>;
  stack: UnitRef[];
  pending?: PendingUtterance;
  // The ordinal of the next user utterance. It is a dialogue clock, not a task turn.
  utteranceSeq: number;
}
