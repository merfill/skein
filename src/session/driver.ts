import type { Event } from "../ir/events";
import { fold } from "../ir/graph";
import { runAgent, type AgentDeps, type AgentResult } from "../loop/graph";
import type { Workspace } from "../tools/workspace";
import { applyReaction } from "./apply";
import { LOCAL_SESSION_ID, type TelemetrySink } from "./telemetry";
import type { OperationResult } from "./operations";
import type { ProgressSink } from "./progress";
import { runGeneralAgent, type GeneralDeps, type GeneralResult } from "./general";
import { runRequestObserver } from "./observer";
import {
  popUnit,
  recordReaction,
  recordReport,
  sessionFocus,
  takePending,
  unitOf,
} from "./session";
import {
  runSessionAgent,
  type RunSessionAgentResult,
  type SessionAgentDeps,
} from "./session_agent";
import { unitOutline } from "./session_outline";
import type {
  NoDecisionReason,
  SessionOperation,
  SessionState,
  Trigger,
} from "./types";

// One dialogue turn: interpret the user's line, apply the operation, and, for `start`, run the
// new task unit. The task sees only the reformulated request; the session (traces, history
// tools) belongs to the session agent.

export interface SessionTurnDeps {
  sessionAgent: SessionAgentDeps;
  task: AgentDeps;
  general?: GeneralDeps;
  // The driver records pause/resume/cancel here; the loops receive their own copy.
  telemetry?: TelemetrySink;
  onProgress?: ProgressSink;
}

export interface SessionTurnOptions {
  // The utterance ordinal to use; defaults to `session.utteranceSeq`.
  turn?: number;
  // A user pause. The in-flight model call is aborted and the turn returns `paused`.
  signal?: AbortSignal;
}

export interface PausedState {
  agent: "session" | "task" | "general" | "observer";
  // The paused unit: the session unit, the task unit, or the observer unit.
  unitId: string;
  utterance: string;
  utteranceTurn: number;
  // The session unit that proposed the `start`; the post-task report belongs to it.
  interpretationUnitId?: string;
  // Session resume: the loop turn already completed and the captured L0.
  startTurn?: number;
  outline?: string;
  // Observer resume: the parent task and the trigger that opened the observer.
  taskUnitId?: string;
  trigger?: Trigger;
}

export interface SessionTurnResult {
  session: SessionState;
  turn: number;
  // The full interpretation turn; absent on a resumed task, where it happened earlier.
  interpretation?: RunSessionAgentResult;
  operation?: SessionOperation;
  applied?: OperationResult;
  reasoning?: string;
  reply?: string;
  task?: { unitId: string; result: AgentResult };
  general?: { unitId: string; result: GeneralResult };
  // The session agent's Markdown report after the task finished.
  report?: string;
  // Why the interpretation ended without an operation.
  noDecision?: NoDecisionReason;
  // The turn stopped on a user pause; the unit is open and focused.
  paused?: PausedState;
}

export interface CancelResult {
  session: SessionState;
  // Set when the world could not be restored; the task's changes are kept.
  warning?: string;
}

function nextRequestId(session: SessionState): string {
  let index = 1;
  while (session.units.has(`r${index}`)) index += 1;
  return `r${index}`;
}

function nextGeneralId(session: SessionState): string {
  let index = 1;
  while (session.units.has(`g${index}`)) index += 1;
  return `g${index}`;
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

function lastTrigger(session: SessionState, taskUnitId: string): Trigger | undefined {
  for (let index = session.journal.length - 1; index >= 0; index -= 1) {
    const event = session.journal[index];
    if (event?.type === "trigger" && event.unitId === taskUnitId) return event.trigger;
  }
  return undefined;
}

function snapshotFor(deps: SessionTurnDeps, unitId: string): string | undefined {
  try {
    return deps.task.workspace.checkpoint?.(`task-start:${unitId}`);
  } catch {
    return undefined;
  }
}

function recordPause(deps: SessionTurnDeps, paused: PausedState): void {
  deps.telemetry?.record({
    type: "pause",
    sessionId: LOCAL_SESSION_ID,
    unitId: paused.unitId,
    at: Date.now(),
  });
}

function makeResult(
  session: SessionState,
  turn: number,
  interpretation?: RunSessionAgentResult,
): SessionTurnResult {
  return {
    session,
    turn,
    ...(interpretation !== undefined ? { interpretation } : {}),
    ...(interpretation?.operation !== undefined ? { operation: interpretation.operation } : {}),
    ...(interpretation?.applied !== undefined ? { applied: interpretation.applied } : {}),
    ...(interpretation?.reasoning !== undefined ? { reasoning: interpretation.reasoning } : {}),
    ...(interpretation?.noDecision !== undefined ? { noDecision: interpretation.noDecision } : {}),
  };
}

function pauseState(
  session: SessionState,
  taskUnitId: string,
  interpretationUnitId: string,
  utteranceTurn: number,
  utterance: string,
): PausedState {
  const focus = sessionFocus(session);
  if (focus !== undefined && unitOf(session, focus.unitId).type === "observer") {
    const taskUnit = unitOf(session, taskUnitId);
    return {
      agent: "observer",
      unitId: focus.unitId,
      taskUnitId,
      utterance,
      utteranceTurn,
      interpretationUnitId,
      trigger: lastTrigger(session, taskUnitId),
      startTurn: unitOf(session, focus.unitId).turn,
    };
  }
  return {
    agent: "task",
    unitId: taskUnitId,
    utterance,
    utteranceTurn,
    interpretationUnitId,
    startTurn: unitOf(session, taskUnitId).turn,
  };
}

async function reportTask(
  deps: SessionTurnDeps,
  session: SessionState,
  utterance: string,
  turn: number,
  interpretationUnitId: string,
  unitId: string,
  run: AgentResult,
  result: SessionTurnResult,
): Promise<void> {
  if (deps.sessionAgent.report === undefined) return;
  deps.onProgress?.({ type: "report_started", unitId: interpretationUnitId });
  try {
    const report = await deps.sessionAgent.report({
      utterance,
      request: requestText(unitOf(session, unitId).journal),
      trace: taskTrace(session, unitId, run.events, run),
    });
    if (report !== undefined && report.trim() !== "") {
      recordReport(session, interpretationUnitId, turn, report);
      result.report = report;
    }
    deps.onProgress?.({
      type: "report_finished",
      unitId: interpretationUnitId,
      ...(result.report !== undefined ? { text: result.report } : {}),
    });
  } catch {
    // The task result is the fact; the report is a presentation aid.
    deps.onProgress?.({ type: "report_finished", unitId: interpretationUnitId });
  }
}

async function dispatch(
  deps: SessionTurnDeps,
  session: SessionState,
  utterance: string,
  turn: number,
  interpretation: RunSessionAgentResult,
  result: SessionTurnResult,
  signal?: AbortSignal,
): Promise<SessionTurnResult> {
  const applied = interpretation.applied;
  if (applied === undefined || !applied.ok) return result;
  if (applied.operation.kind === "respond") {
    result.reply = applied.operation.text;
    return result;
  }

  const pending = takePending(session);
  if (pending === undefined) return result;

  if (applied.operation.kind === "general") {
    if (deps.general === undefined) return result;
    const unitId = nextGeneralId(session);
    const run = await runGeneralAgent(deps.general, {
      request: { id: unitId, text: pending.text },
      session,
      open: true,
      ...(signal !== undefined ? { signal } : {}),
    });
    syncUnit(session, unitId, run);
    result.general = { unitId, result: run };
    if (run.paused === true) {
      result.paused = {
        agent: "general",
        unitId,
        utterance,
        utteranceTurn: turn,
        startTurn: unitOf(session, unitId).turn,
      };
      recordPause(deps, result.paused);
    }
    return result;
  }

  const unitId = nextRequestId(session);
  const snapshot = snapshotFor(deps, unitId);
  const run = await runAgent(deps.task, {
    request: { id: unitId, text: pending.text },
    session,
    open: true,
    ...(snapshot !== undefined ? { snapshot } : {}),
    ...(signal !== undefined ? { signal } : {}),
  });
  syncUnit(session, unitId, run);
  result.task = { unitId, result: run };

  if (run.paused === true) {
    result.paused = pauseState(session, unitId, interpretation.unitId, turn, utterance);
    recordPause(deps, result.paused);
    return result;
  }
  await reportTask(deps, session, utterance, turn, interpretation.unitId, unitId, run, result);
  return result;
}

export async function runSessionTurn(
  deps: SessionTurnDeps,
  session: SessionState,
  utterance: string,
  options: SessionTurnOptions = {},
): Promise<SessionTurnResult> {
  const turn = options.turn ?? session.utteranceSeq;
  const interpretation = await runSessionAgent(deps.sessionAgent, session, utterance, {
    turn,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  session.utteranceSeq = turn + 1;

  const result = makeResult(session, turn, interpretation);
  if (interpretation.paused === true) {
    result.paused = {
      agent: "session",
      unitId: interpretation.unitId,
      utterance,
      utteranceTurn: turn,
      startTurn: interpretation.turns,
      ...(interpretation.outline !== undefined ? { outline: interpretation.outline } : {}),
    };
    recordPause(deps, result.paused);
    return result;
  }
  return dispatch(deps, session, utterance, turn, interpretation, result, options.signal);
}

async function resumeObserver(
  deps: SessionTurnDeps,
  session: SessionState,
  paused: PausedState,
  signal?: AbortSignal,
): Promise<SessionTurnResult> {
  const taskUnitId = paused.taskUnitId;
  if (taskUnitId === undefined) return { session, turn: paused.utteranceTurn, paused };
  const taskUnit = unitOf(session, taskUnitId);
  const observerUnit = unitOf(session, paused.unitId);
  const trigger = paused.trigger ?? lastTrigger(session, taskUnitId);
  const observerDeps = deps.task.observer;
  if (trigger === undefined || observerDeps === undefined) {
    const result = makeResult(session, paused.utteranceTurn);
    result.paused = { ...paused, agent: "task", unitId: taskUnitId };
    return result;
  }

  const observer = await runRequestObserver({
    trigger,
    state: fold(taskUnit.journal),
    tools: observerDeps.tools,
    agent: observerDeps.agent,
    journal: observerUnit.journal,
    startTurn: observerUnit.turn,
    events: taskUnit.journal,
    unitId: observerUnit.id,
    ...(deps.telemetry !== undefined ? { telemetry: deps.telemetry } : {}),
    ...(observerDeps.maxTurns !== undefined ? { maxTurns: observerDeps.maxTurns } : {}),
    ...(observerDeps.surveyLimit !== undefined ? { surveyLimit: observerDeps.surveyLimit } : {}),
    ...(observerDeps.onProgress !== undefined ? { onProgress: observerDeps.onProgress } : {}),
    ...(signal !== undefined ? { signal } : {}),
  });
  observerUnit.journal.push(...observer.journal.slice(observerUnit.journal.length));
  observerUnit.turn = observer.turns;

  if (observer.paused === true) {
    const result = makeResult(session, paused.utteranceTurn);
    result.paused = { ...paused, startTurn: observer.turns };
    recordPause(deps, result.paused);
    return result;
  }

  popUnit(session);
  if (observer.decision !== undefined) {
    recordReaction(session, taskUnitId, observer.decision);
    if (observer.decision.kind === "halt") {
      const run: AgentResult = {
        events: taskUnit.journal,
        done: true,
        stopReason: "observer_halt",
        turns: taskUnit.turn,
      };
      const result = makeResult(session, paused.utteranceTurn);
      result.task = { unitId: taskUnitId, result: run };
      return result;
    }
    const applied = applyReaction({
      state: fold(taskUnit.journal),
      reaction: observer.decision,
      sourceUnit: observerUnit.id,
    });
    if (applied.ok) taskUnit.journal.push(...applied.events);
  }

  const run = await runAgent(deps.task, {
    request: { id: taskUnitId, text: requestText(taskUnit.journal) },
    seed: taskUnit.journal,
    startTurn: taskUnit.turn,
    session,
    open: false,
    ...(signal !== undefined ? { signal } : {}),
  });
  syncUnit(session, taskUnitId, run);
  const result = makeResult(session, paused.utteranceTurn);
  result.task = { unitId: taskUnitId, result: run };
  if (run.paused === true) {
    result.paused = pauseState(
      session,
      taskUnitId,
      paused.interpretationUnitId ?? taskUnitId,
      paused.utteranceTurn,
      paused.utterance,
    );
    recordPause(deps, result.paused);
    return result;
  }
  await reportTask(
    deps,
    session,
    paused.utterance,
    paused.utteranceTurn,
    paused.interpretationUnitId ?? taskUnitId,
    taskUnitId,
    run,
    result,
  );
  return result;
}

export async function resumeTurn(
  deps: SessionTurnDeps,
  session: SessionState,
  paused: PausedState,
  options: SessionTurnOptions = {},
): Promise<SessionTurnResult> {
  deps.telemetry?.record({
    type: "resume",
    sessionId: LOCAL_SESSION_ID,
    unitId: paused.unitId,
    at: Date.now(),
  });
  if (paused.agent === "session") {
    const interpretation = await runSessionAgent(deps.sessionAgent, session, paused.utterance, {
      turn: paused.utteranceTurn,
      unitId: paused.unitId,
      ...(paused.startTurn !== undefined ? { startTurn: paused.startTurn } : {}),
      ...(paused.outline !== undefined ? { outline: paused.outline } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    const result = makeResult(session, paused.utteranceTurn, interpretation);
    if (interpretation.paused === true) {
      result.paused = {
        ...paused,
        startTurn: interpretation.turns,
        ...(interpretation.outline !== undefined ? { outline: interpretation.outline } : {}),
      };
      recordPause(deps, result.paused);
      return result;
    }
    return dispatch(
      deps,
      session,
      paused.utterance,
      paused.utteranceTurn,
      interpretation,
      result,
      options.signal,
    );
  }

  if (paused.agent === "general") {
    if (deps.general === undefined) return { session, turn: paused.utteranceTurn, paused };
    const unit = unitOf(session, paused.unitId);
    const run = await runGeneralAgent(deps.general, {
      request: { id: paused.unitId, text: requestText(unit.journal) },
      seed: unit.journal,
      startTurn: unit.turn,
      session,
      open: false,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    syncUnit(session, paused.unitId, run);
    const result = makeResult(session, paused.utteranceTurn);
    result.general = { unitId: paused.unitId, result: run };
    if (run.paused === true) {
      result.paused = {
        agent: "general",
        unitId: paused.unitId,
        utterance: paused.utterance,
        utteranceTurn: paused.utteranceTurn,
        startTurn: unitOf(session, paused.unitId).turn,
      };
      recordPause(deps, result.paused);
    }
    return result;
  }

  if (paused.agent === "observer") {
    return resumeObserver(deps, session, paused, options.signal);
  }

  const unit = unitOf(session, paused.unitId);
  const run = await runAgent(deps.task, {
    request: { id: paused.unitId, text: requestText(unit.journal) },
    seed: unit.journal,
    startTurn: unit.turn,
    session,
    open: false,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  syncUnit(session, paused.unitId, run);
  const result = makeResult(session, paused.utteranceTurn);
  result.task = { unitId: paused.unitId, result: run };
  if (run.paused === true) {
    result.paused = pauseState(
      session,
      paused.unitId,
      paused.interpretationUnitId ?? paused.unitId,
      paused.utteranceTurn,
      paused.utterance,
    );
    recordPause(deps, result.paused);
    return result;
  }
  await reportTask(
    deps,
    session,
    paused.utterance,
    paused.utteranceTurn,
    paused.interpretationUnitId ?? paused.unitId,
    paused.unitId,
    run,
    result,
  );
  return result;
}

// Cancel is not an IR operation for the session: it pops the paused units and, for a task with
// a checkpoint, restores the world and records the `rollback` fact in the task journal.
export function cancelTurn(
  workspace: Workspace,
  session: SessionState,
  paused: PausedState,
  telemetry?: TelemetrySink,
): CancelResult {
  if (paused.agent === "observer" && sessionFocus(session)?.unitId === paused.unitId) {
    popUnit(session);
  }
  if (paused.agent === "session" || paused.agent === "general") {
    if (sessionFocus(session)?.unitId === paused.unitId) popUnit(session);
    telemetry?.record({
      type: "cancel",
      sessionId: LOCAL_SESSION_ID,
      unitId: paused.unitId,
      at: Date.now(),
      rollback: "unavailable",
    });
    return { session };
  }

  const taskUnitId = paused.agent === "observer" ? paused.taskUnitId : paused.unitId;
  if (taskUnitId === undefined) return { session };
  const taskUnit = unitOf(session, taskUnitId);
  let warning: string | undefined;
  let rollback: "ok" | "unavailable" | "error" = "unavailable";
  if (taskUnit.checkpoint === undefined || workspace.restoreTree === undefined) {
    warning = "rollback unavailable: no task snapshot; the task's changes are kept";
  } else {
    try {
      workspace.restoreTree(taskUnit.checkpoint);
      taskUnit.journal.push({
        type: "rollback",
        checkpoint: taskUnit.checkpoint,
        reason: "cancelled",
      });
      rollback = "ok";
    } catch (error) {
      rollback = "error";
      warning = `rollback failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (sessionFocus(session)?.unitId === taskUnit.id) popUnit(session);
  telemetry?.record({
    type: "cancel",
    sessionId: LOCAL_SESSION_ID,
    unitId: paused.unitId,
    at: Date.now(),
    rollback,
  });
  return { session, ...(warning !== undefined ? { warning } : {}) };
}
