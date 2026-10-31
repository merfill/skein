import type { Event } from "../ir/events";
import { runAgent, type AgentDeps, type AgentResult } from "../loop/graph";
import { recordReport, takePending, unitOf } from "./session";
import {
  runSessionAgent,
  type RunSessionAgentResult,
  type SessionAgentDeps,
} from "./session_agent";
import { unitOutline } from "./session_outline";
import type { OperationResult } from "./operations";
import type { NoDecisionReason, SessionOperation, SessionState } from "./types";

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
  // The session agent's Markdown report after the task finished.
  report?: string;
  // Why the interpretation ended without an operation.
  noDecision?: NoDecisionReason;
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

function requestText(journal: readonly Event[]): string {
  for (const event of journal) {
    if (event.type !== "add_node" || event.node.kind !== "request") continue;
    const payload = event.node.payload as { text?: unknown } | undefined;
    return typeof payload?.text === "string" ? payload.text : event.node.label;
  }
  return "";
}

function lastStop(events: readonly Event[]): string | undefined {
  let stop: string | undefined;
  for (const event of events) {
    if (event.type === "add_node" && event.node.kind === "stop") stop = event.node.label;
  }
  return stop;
}

function changedFiles(events: readonly Event[]): string[] {
  const refs = new Set<string>();
  for (const event of events) {
    if (event.type === "mutate") refs.add(event.ref);
  }
  return [...refs];
}

// The deterministic facts the reporter may use: the task's states, changed files, outcome.
function taskTrace(
  session: SessionState,
  unitId: string,
  events: readonly Event[],
  result: AgentResult,
): string {
  const changed = changedFiles(events);
  const stop = lastStop(events);
  const outcome =
    stop !== undefined ? `${result.stopReason ?? "done"}: ${stop}` : (result.stopReason ?? "still open");
  return [
    unitOutline(session, unitId),
    changed.length > 0 ? `changed files: ${changed.join(", ")}` : "changed files: none",
    `outcome: ${outcome}`,
    `turns: ${result.turns}`,
  ].join("\n");
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
    ...(interpretation.noDecision !== undefined
      ? { noDecision: interpretation.noDecision }
      : {}),
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

  // The session agent reports the finished task in the user's language. A failed report must
  // never hide the task result: the caller can still show the terminal stop.
  if (deps.sessionAgent.report !== undefined) {
    try {
      const report = await deps.sessionAgent.report({
        utterance,
        request: requestText(unitOf(session, unitId).journal),
        trace: taskTrace(session, unitId, run.events, run),
      });
      if (report !== undefined && report.trim() !== "") {
        recordReport(session, interpretation.unitId, turn, report);
        result.report = report;
      }
    } catch {
      // The task result is the fact; the report is a presentation aid.
    }
  }
  return result;
}
