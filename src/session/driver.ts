import { runAgent, type AgentDeps, type AgentResult } from "../loop/graph";
import { takePending, unitOf } from "./session";
import {
  runSessionAgent,
  type RunSessionAgentResult,
  type SessionAgentDeps,
} from "./session_agent";
import type { OperationResult } from "./operations";
import type { SessionOperation, SessionState } from "./types";

// One dialogue turn: interpret the user's line, apply the operation, and, for `start`, run the
// new task unit. The task sees only the reformulated request; the session (traces, history
// tools) belongs to the session agent.

export interface SessionTurnDeps {
  sessionAgent: SessionAgentDeps;
  task: AgentDeps;
}

export interface SessionTurnOptions {
  // The utterance ordinal to use; defaults to `session.utteranceSeq`.
  turn?: number;
}

export interface SessionTurnResult {
  session: SessionState;
  turn: number;
  // The full interpretation turn: its journal (tool calls/results), operation and reasoning.
  interpretation: RunSessionAgentResult;
  operation?: SessionOperation;
  applied?: OperationResult;
  reasoning?: string;
  reply?: string;
  task?: { unitId: string; result: AgentResult };
}

function nextRequestId(session: SessionState): string {
  let index = 1;
  while (session.units.has(`r${index}`)) index += 1;
  return `r${index}`;
}

// `progress` checks request closure before syncing the focus unit journal, so the final stop
// can be missed. Extend the journal with the missing tail; never rewrite it.
function syncUnit(session: SessionState, unitId: string, result: AgentResult): void {
  const unit = unitOf(session, unitId);
  if (result.events.length > unit.journal.length) {
    unit.journal.push(...result.events.slice(unit.journal.length));
  }
  unit.turn = result.turns;
}

export async function runSessionTurn(
  deps: SessionTurnDeps,
  session: SessionState,
  utterance: string,
  options: SessionTurnOptions = {},
): Promise<SessionTurnResult> {
  const turn = options.turn ?? session.utteranceSeq;
  const interpretation: RunSessionAgentResult = await runSessionAgent(
    deps.sessionAgent,
    session,
    utterance,
    { turn },
  );
  session.utteranceSeq = turn + 1;

  const result: SessionTurnResult = {
    session,
    turn: session.utteranceSeq,
    interpretation,
    ...(interpretation.operation !== undefined
      ? { operation: interpretation.operation }
      : {}),
    ...(interpretation.applied !== undefined ? { applied: interpretation.applied } : {}),
    ...(interpretation.reasoning !== undefined ? { reasoning: interpretation.reasoning } : {}),
  };

  if (interpretation.applied === undefined || !interpretation.applied.ok) {
    return result;
  }

  const operation = interpretation.applied.operation;
  if (operation.kind === "respond") {
    result.reply = operation.text;
    return result;
  }

  const pending = takePending(session);
  if (pending === undefined) return result;

  const unitId = nextRequestId(session);
  const run = await runAgent(deps.task, {
    request: { id: unitId, text: pending.text },
    session,
    open: true,
  });
  syncUnit(session, unitId, run);
  result.task = { unitId, result: run };
  return result;
}
