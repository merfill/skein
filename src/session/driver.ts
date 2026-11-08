import type { Event } from "../ir/events";
import { fold } from "../ir/graph";
import type { SessionProbe } from "../ir/session";
import { runAgent, type AgentDeps, type AgentResult } from "../loop/graph";
import type { Workspace } from "../tools/workspace";
import { applyReaction } from "./apply";
import { LOCAL_SESSION_ID, type TelemetrySink } from "./telemetry";
import type { OperationResult } from "./operations";
import type { ProgressSink } from "./progress";
import { runGeneralAgent, type GeneralDeps, type GeneralResult } from "./general";
import { runRequestObserver } from "./observer";
import {
  abandonUnit,
  attentionOf,
  popUnit,
  recordNoDecision,
  recordReaction,
  sessionFocus,
  takePending,
  unitOf,
} from "./session";
import {
  runSessionAgent,
  type RunSessionAgentResult,
  type SessionAgentDeps,
  type WorkspaceIntro,
} from "./session_agent";
import { generalFactsText, projectInstructionsText } from "./session_workspace";
import type {
  NoDecisionReason,
  SessionOperation,
  SessionState,
  Trigger,
  Unit,
} from "./types";

// One dialogue turn: interpret the user's line, apply the operation, and, for `task`, run the
// new task unit. The task sees only the reformulated request; the session (traces, history
// tools) belongs to the session agent.

export interface SessionTurnDeps {
  sessionAgent: SessionAgentDeps;
  task: AgentDeps;
  general?: GeneralDeps;
  // A lazy, session-scoped probe: the general unit gets the workspace facts. The session
  // agent gets only the root, so the brief cannot copy a directory or file list.
  sessionProbe?: () => SessionProbe | undefined;
  // The driver records pause/resume/cancel here; the loops receive their own copy.
  telemetry?: TelemetrySink;
  onProgress?: ProgressSink;
}

function workspaceIntro(deps: SessionTurnDeps): WorkspaceIntro {
  return { root: workspaceRoot(deps.task.workspace) };
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
  // The session unit that proposed the `task`.
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

export interface LeaveResult {
  session: SessionState;
  // The unit that left the focus (the task when an observer was paused on top of it).
  unitId: string;
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

// A run that ends done without reaching its terminal closure (turn cap, observer halt,
// no_decision, llm_error) is not "suspended": it will not resume on its own. Mark it
// abandoned so the session view and history stop showing it as an open unit.
function settleAttention(
  session: SessionState,
  unitId: string,
  done: boolean,
  paused: boolean | undefined,
): void {
  if (!done || paused === true) return;
  if (attentionOf(session, unitId) === "completed") return;
  abandonUnit(session, unitId, unitOf(session, unitId).turn);
}

function requestText(journal: readonly Event[]): string {
  for (const event of journal) {
    if (event.type !== "add_node" || event.node.kind !== "request") continue;
    const payload = event.node.payload as { text?: unknown } | undefined;
    return typeof payload?.text === "string" ? payload.text : event.node.label;
  }
  return "";
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

function generalWorkspace(deps: SessionTurnDeps): Workspace {
  return deps.general?.workspace ?? deps.task.workspace;
}

function generalContextText(deps: SessionTurnDeps): string {
  const workspace = generalWorkspace(deps);
  const facts = generalFactsText(deps.sessionProbe?.(), workspaceRoot(workspace));
  const instructions = projectInstructionsText(workspace);
  return instructions === "" ? facts : `${facts}\n\n${instructions}`;
}

function workspaceRoot(workspace: Workspace): string {
  return workspace.displayRoot !== undefined && workspace.displayRoot !== ""
    ? workspace.displayRoot
    : workspace.root;
}

function generalSnapshotFor(deps: SessionTurnDeps, unitId: string): string | undefined {
  try {
    return generalWorkspace(deps).checkpoint?.(`general-start:${unitId}`);
  } catch {
    return undefined;
  }
}

// The general unit is read-only by contract. If a command changed the tree anyway, put only
// those paths back and record the fact; unchanged paths are left untouched.
function restoreGeneralChanges(workspace: Workspace, unit: Unit): void {
  const checkpoint = unit.checkpoint;
  if (checkpoint === undefined) return;
  if (workspace.restoreChanged === undefined) return;
  try {
    const changed = workspace.restoreChanged(checkpoint);
    if (changed.length > 0) {
      unit.journal.push({ type: "rollback", checkpoint, reason: "general-read-only" });
    }
  } catch (error) {
    unit.journal.push({
      type: "rollback",
      checkpoint,
      reason: `general-read-only restore failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

function restoreGeneral(deps: SessionTurnDeps, session: SessionState, unitId: string): void {
  const unit = session.units.get(unitId);
  if (unit === undefined) return;
  restoreGeneralChanges(generalWorkspace(deps), unit);
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
    const snapshot = generalSnapshotFor(deps, unitId);
    let run: GeneralResult;
    let paused = false;
    try {
      run = await runGeneralAgent(deps.general, {
        request: { id: unitId, text: pending.text },
        session,
        open: true,
        workspace: generalContextText(deps),
        ...(snapshot !== undefined ? { snapshot } : {}),
        ...(signal !== undefined ? { signal } : {}),
      });
      paused = run.paused === true;
    } finally {
      if (!paused) restoreGeneral(deps, session, unitId);
    }
    syncUnit(session, unitId, run);
    settleAttention(session, unitId, run.done, run.paused);
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
  settleAttention(session, unitId, run.done, run.paused);
  result.task = { unitId, result: run };

  if (run.paused === true) {
    result.paused = pauseState(session, unitId, interpretation.unitId, turn, utterance);
    recordPause(deps, result.paused);
    return result;
  }
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
    workspace: workspaceIntro(deps),
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
    agent: observerDeps.agent,
    journal: observerUnit.journal,
    startTurn: observerUnit.turn,
    unitId: observerUnit.id,
    ...(deps.telemetry !== undefined ? { telemetry: deps.telemetry } : {}),
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

  // Same fact as in `progress`: a resumed observer that never decided leaves it on its unit.
  if (observer.decision === undefined && observer.noDecision !== undefined) {
    recordNoDecision(session, observerUnit.id, observer.turns, observer.noDecision);
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
      settleAttention(session, taskUnitId, true, false);
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
  settleAttention(session, taskUnitId, run.done, run.paused);
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
      workspace: workspaceIntro(deps),
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
    let run: GeneralResult;
    let stillPaused = false;
    try {
      run = await runGeneralAgent(deps.general, {
        request: { id: paused.unitId, text: requestText(unit.journal) },
        seed: unit.journal,
        startTurn: unit.turn,
        session,
        open: false,
        workspace: generalContextText(deps),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      stillPaused = run.paused === true;
    } finally {
      if (!stillPaused) restoreGeneral(deps, session, paused.unitId);
    }
    syncUnit(session, paused.unitId, run);
    settleAttention(session, paused.unitId, run.done, run.paused);
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
  return result;
}

// Leaving is not cancel: the paused unit loses focus, its work is kept and nothing is written to
// a task journal. The unit is derived `suspended`, so a later session `resume` can revive it.
// A read-only general unit is still restored, because it must never mutate the tree.
export function leaveTurn(
  workspace: Workspace,
  session: SessionState,
  paused: PausedState,
  telemetry?: TelemetrySink,
): LeaveResult {
  if (paused.agent === "observer" && sessionFocus(session)?.unitId === paused.unitId) {
    popUnit(session);
  }
  if (paused.agent === "general") {
    const unit = unitOf(session, paused.unitId);
    restoreGeneralChanges(workspace, unit);
  }
  const unitId =
    paused.agent === "observer" ? (paused.taskUnitId ?? paused.unitId) : paused.unitId;
  if (sessionFocus(session)?.unitId === unitId) popUnit(session);
  telemetry?.record({
    type: "leave",
    sessionId: LOCAL_SESSION_ID,
    unitId,
    at: Date.now(),
  });
  return { session, unitId };
}

// Cancel is not an IR operation for the session: it pops the paused units and, for a task with
// a checkpoint, restores the world and records the `rollback` fact in the task journal. Unlike
// leaving, a cancelled unit cannot be resumed, so it is marked `abandoned`.
export function cancelTurn(
  workspace: Workspace,
  session: SessionState,
  paused: PausedState,
  telemetry?: TelemetrySink,
): CancelResult {
  if (paused.agent === "observer") {
    if (sessionFocus(session)?.unitId === paused.unitId) popUnit(session);
    abandonUnit(session, paused.unitId, unitOf(session, paused.unitId).turn);
  }
  if (paused.agent === "session" || paused.agent === "general") {
    let rollback: "ok" | "unavailable" | "error" = "unavailable";
    let warning: string | undefined;
    if (paused.agent === "general") {
      const unit = unitOf(session, paused.unitId);
      const checkpoint = unit.checkpoint;
      if (checkpoint !== undefined && workspace.restoreChanged !== undefined) {
        try {
          const changed = workspace.restoreChanged(checkpoint);
          if (changed.length > 0) {
            unit.journal.push({ type: "rollback", checkpoint, reason: "general-read-only" });
          }
          rollback = "ok";
        } catch (error) {
          rollback = "error";
          warning = `rollback failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }
    if (sessionFocus(session)?.unitId === paused.unitId) popUnit(session);
    abandonUnit(session, paused.unitId, unitOf(session, paused.unitId).turn);
    telemetry?.record({
      type: "cancel",
      sessionId: LOCAL_SESSION_ID,
      unitId: paused.unitId,
      at: Date.now(),
      rollback,
    });
    return { session, ...(warning !== undefined ? { warning } : {}) };
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
  abandonUnit(session, taskUnit.id, taskUnit.turn);
  telemetry?.record({
    type: "cancel",
    sessionId: LOCAL_SESSION_ID,
    unitId: paused.unitId,
    at: Date.now(),
    rollback,
  });
  return { session, ...(warning !== undefined ? { warning } : {}) };
}
