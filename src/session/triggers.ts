import {
  DEFAULT_BUDGET_TURNS as SETTING_BUDGET_TURNS,
  DEFAULT_STATE_CYCLE_ENTRIES,
  DEFAULT_STATE_LONG_TURNS,
  loadSettings,
} from "../config/settings";
import type { State } from "../ir/graph";
import { currentMove, isMoveFinished, moveIsland, movePayload } from "../ir/traversal";
import { triggerSamples } from "./session";
import type { SessionState, Trigger, TriggerKind } from "./types";

export const DEFAULT_BUDGET_TURNS = SETTING_BUDGET_TURNS;
export const DEFAULT_STATE_TURNS = DEFAULT_STATE_LONG_TURNS;
export const DEFAULT_STATE_ENTRIES = DEFAULT_STATE_CYCLE_ENTRIES;

export interface DetectInput {
  state: State;
  session: SessionState;
  unitId: string;
  turn: number;
  terminal?: boolean;
}

export interface DetectOptions {
  budgetTurns?: number;
  maxTurns?: number;
  stateTurns?: number;
  stateEntries?: number;
}

function anchorOf(state: State, unitId: string): string {
  return currentMove(state) ?? state.rootId ?? unitId;
}

function recentEvidence(state: State): string[] {
  return [...state.nodes.values()]
    .filter((node) => node.kind !== "hint" && node.kind !== "memo")
    .sort((left, right) => right.seq - left.seq)
    .slice(0, 5)
    .map((node) => node.id)
    .reverse();
}

function epochOf(session: SessionState, unitId: string, kind: TriggerKind): number {
  return triggerSamples(session, unitId, kind).length + 1;
}

function triggerFor(
  input: DetectInput,
  kind: TriggerKind,
  anchor: string,
  evidence: string[],
  summary: string,
): Trigger {
  return {
    id: `${input.unitId}:${kind}:${input.turn}:${epochOf(input.session, input.unitId, kind)}`,
    kind,
    anchor,
    evidence,
    epoch: epochOf(input.session, input.unitId, kind),
    summary,
    turn: input.turn,
  };
}

function alreadyFired(
  session: SessionState,
  unitId: string,
  kind: TriggerKind,
  anchor: string,
): boolean {
  return triggerSamples(session, unitId, kind).some(
    (record) => record.trigger.anchor === anchor,
  );
}

export function detectTriggers(
  input: DetectInput,
  options: DetectOptions = {},
): Trigger[] {
  if (input.terminal === true) return [];

  const triggers: Trigger[] = [];
  const move = currentMove(input.state);
  const island = move !== undefined ? moveIsland(input.state, move) : undefined;
  const anchor = anchorOf(input.state, input.unitId);
  const evidence = recentEvidence(input.state);

  const settings = loadSettings();
  const stateEntries = options.stateEntries ?? settings.stateCycleEntries;
  const entries = island !== undefined ? (input.state.stateEntries.get(island) ?? 0) : 0;
  if (
    move !== undefined &&
    entries === stateEntries &&
    !alreadyFired(input.session, input.unitId, "state_cycle", move)
  ) {
    triggers.push(
      triggerFor(
        input,
        "state_cycle",
        move,
        evidence,
        entries === 3
          ? `the agent has entered the state "${island ?? "unknown"}" for the third time`
          : `the agent has entered the state "${island ?? "unknown"}" ${entries} times`,
      ),
    );
  }

  const stateTurns = options.stateTurns ?? settings.stateLongTurns;
  const entryTurn = move !== undefined ? movePayload(input.state, move)?.turn : undefined;
  if (
    move !== undefined &&
    entryTurn !== undefined &&
    input.turn - entryTurn > stateTurns &&
    !alreadyFired(input.session, input.unitId, "state_long", move)
  ) {
    triggers.push(
      triggerFor(
        input,
        "state_long",
        move,
        evidence,
        `the agent has spent ${input.turn - entryTurn} turns in the state "${island ?? "unknown"}" (limit ${stateTurns})`,
      ),
    );
  }

  if (options.maxTurns !== undefined) {
    const budgetTurns = options.budgetTurns ?? settings.budgetTurns;
    const remaining = options.maxTurns - input.turn;
    const lastBudget = triggerSamples(input.session, input.unitId, "budget").at(-1);
    const stateOpen = move !== undefined && !isMoveFinished(input.state, move);
    if (stateOpen && remaining > 0 && remaining <= budgetTurns && lastBudget === undefined) {
      triggers.push(
        triggerFor(
          input,
          "budget",
          anchor,
          evidence,
          `the run has ${remaining} turn(s) left before max_turns`,
        ),
      );
    }
  }

  return triggers;
}
