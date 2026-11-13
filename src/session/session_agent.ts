import type { ModelMessage } from "ai";

import { isAborted } from "../abort";
import {
  LOCAL_SESSION_ID,
  contextSnapshot,
  type TelemetrySink,
  type Usage,
} from "./telemetry";

import type { Event } from "../ir/events";
import type { TapeMessage } from "../ir/project";
import type { Node } from "../ir/types";
import { historyMessages } from "../loop/propose";
import { applyOperation, type OperationResult } from "./operations";
import type { ProgressSink } from "./progress";
import { SESSION_AGENT_BASE_PROMPT } from "./session_agent_prompts";
import {
  openUnit,
  popUnit,
  pushUnit,
  recordNoDecision,
  recordRefusal,
  sessionFocus,
  setPending,
  takePending,
  unitOf,
} from "./session";
import { sessionOutline } from "./session_outline";
import type { NoDecisionReason, SessionOperation, SessionState } from "./types";

export interface SessionReply {
  operation?: SessionOperation;
  // The session agent's hidden reasoning for this reply, shown back on its tape.
  reasoning?: string;
  // Side-channel telemetry.
  usage?: Usage;
  model?: string;
}

export type SessionAgent = (
  messages: ModelMessage[],
  options?: { signal?: AbortSignal },
) => Promise<SessionReply>;

export interface SessionAgentDeps {
  agent: SessionAgent;
  // Side-channel telemetry; never rendered on the tape.
  telemetry?: TelemetrySink;
  onProgress?: ProgressSink;
}

export interface SessionUnitRunInput {
  utterance: string;
  session: SessionState;
  agent: SessionAgent;
  journal?: readonly Event[];
  startTurn?: number;
  // The session outline (L0) to show; computed before the current session unit is opened.
  outline?: string;
  // The active execution plan, rendered for the session agent (statuses and the next item).
  plan?: string;
  // A user pause: the in-flight model call is aborted and the loop returns `paused`.
  signal?: AbortSignal;
  // Side-channel telemetry; never rendered on the tape.
  telemetry?: TelemetrySink;
  onProgress?: ProgressSink;
}

export interface SessionUnitRunResult {
  journal: Event[];
  operation?: SessionOperation;
  reasoning?: string;
  turns: number;
  // Set when the loop ended without an operation (an empty reply or the safety cap).
  noDecision?: NoDecisionReason;
  // The loop stopped on a user pause; the journal is committed and the unit stays open.
  paused?: boolean;
}

export interface SessionContext {
  utterance: string;
  outline: string;
  history: TapeMessage[];
  // The active execution plan as a system turn (plan execution mode only).
  plan?: string;
}

interface ToolCallPayload {
  origin: "engine" | "model";
  tool: string;
  args: Record<string, unknown>;
  callId: string;
}

interface ToolResultPayload {
  origin: "engine" | "model";
  tool: string;
  callId: string;
  result: string;
}

function callPayload(node: Node): ToolCallPayload | undefined {
  const payload = node.payload as Partial<ToolCallPayload> | undefined;
  if (payload?.origin !== "engine" && payload?.origin !== "model") return undefined;
  if (typeof payload.tool !== "string" || typeof payload.callId !== "string") return undefined;
  return {
    origin: payload.origin,
    tool: payload.tool,
    callId: payload.callId,
    args: payload.args ?? {},
  };
}

function resultPayload(node: Node): ToolResultPayload | undefined {
  const payload = node.payload as Partial<ToolResultPayload> | undefined;
  if (payload?.origin !== "engine" && payload?.origin !== "model") return undefined;
  if (
    typeof payload.tool !== "string" ||
    typeof payload.callId !== "string" ||
    typeof payload.result !== "string"
  ) {
    return undefined;
  }
  return {
    origin: payload.origin,
    tool: payload.tool,
    callId: payload.callId,
    result: payload.result,
  };
}

// The session unit's root is the user utterance. The L0 outline is not journalled here: it is
// derived from the session each turn and rendered as a system message, so the session unit's
// journal holds only its own calls and observations.
export function seedSessionUnit(utterance: string): Event[] {
  return [
    {
      type: "add_node",
      node: {
        id: "session:request",
        space: "work",
        kind: "request",
        label: utterance.replace(/\s+/g, " ").trim().slice(0, 120),
        payload: { text: utterance },
        seq: 0,
      },
    },
  ];
}

export function projectSessionUnit(
  journal: readonly Event[],
  outline = "",
  plan?: string,
): SessionContext {
  let utterance = "";
  const history: TapeMessage[] = [];
  for (const event of journal) {
    if (event.type !== "add_node") continue;
    const node = event.node;
    if (node.kind === "request" && utterance === "") {
      const payload = node.payload as { text?: unknown } | undefined;
      utterance = typeof payload?.text === "string" ? payload.text : node.label;
      continue;
    }
    if (node.kind === "action") {
      const call = callPayload(node);
      if (call !== undefined) {
        const reasoning = (node.payload as { reasoning?: unknown } | undefined)?.reasoning;
        history.push({
          role: "assistant",
          text: "",
          call: { id: call.callId, name: call.tool, args: call.args },
          ...(typeof reasoning === "string" ? { reasoning } : {}),
        });
      }
    } else if (node.kind === "observation") {
      const result = resultPayload(node);
      if (result !== undefined) {
        history.push({ role: "tool", text: result.result, callId: result.callId });
      }
    }
  }
  return {
    utterance,
    outline,
    history,
    ...(plan !== undefined && plan !== "" ? { plan } : {}),
  };
}

export function buildSessionMessages(context: SessionContext): ModelMessage[] {
  return [
    { role: "system", content: SESSION_AGENT_BASE_PROMPT },
    { role: "system", content: `Earlier tasks:\n${context.outline}` },
    ...(context.plan !== undefined ? [{ role: "system" as const, content: context.plan }] : []),
    { role: "user", content: context.utterance },
    ...historyMessages(context.history),
  ];
}

export async function runSessionUnit(input: SessionUnitRunInput): Promise<SessionUnitRunResult> {
  const journal = [
    ...(input.journal !== undefined ? input.journal : seedSessionUnit(input.utterance)),
  ];
  const startTurn = input.startTurn ?? 0;
  const turn = startTurn + 1;
  const outline = input.outline ?? sessionOutline(input.session, { truncate: false });

  const progressUnitId = sessionFocus(input.session)?.unitId ?? "";
  if (isAborted(input.signal)) {
    input.onProgress?.({ type: "paused", agent: "session", unitId: progressUnitId });
    return { journal, turns: startTurn, paused: true };
  }
  const messages = buildSessionMessages(
    projectSessionUnit(journal, outline, input.plan),
  );
  const startedAt = Date.now();
  input.onProgress?.({
    type: "turn_started",
    agent: "session",
    unitId: progressUnitId,
    turn,
  });
  input.onProgress?.({
    type: "model_call_started",
    agent: "session",
    unitId: progressUnitId,
    turn,
  });
  let reply: SessionReply;
  try {
    reply = await input.agent(
      messages,
      input.signal !== undefined ? { signal: input.signal } : undefined,
    );
  } catch (error) {
    input.onProgress?.({
      type: "model_call_finished",
      agent: "session",
      unitId: progressUnitId,
      turn,
      status: isAborted(input.signal) ? "aborted" : "error",
    });
    if (input.telemetry !== undefined) {
      input.telemetry.record({
        type: "model_call",
        sessionId: LOCAL_SESSION_ID,
        agent: "session",
        unitId: sessionFocus(input.session)?.unitId ?? "",
        turn,
        model: "",
        startedAt,
        endedAt: Date.now(),
        status: isAborted(input.signal) ? "aborted" : "error",
        context: contextSnapshot(messages),
      });
    }
    if (isAborted(input.signal)) return { journal, turns: turn, paused: true };
    throw error;
  }
  if (input.telemetry !== undefined) {
    input.telemetry.record({
      type: "model_call",
      sessionId: LOCAL_SESSION_ID,
      agent: "session",
      unitId: sessionFocus(input.session)?.unitId ?? "",
      turn,
      model: reply.model ?? "",
      startedAt,
      endedAt: Date.now(),
      status: isAborted(input.signal) ? "aborted" : "ok",
      ...(reply.usage !== undefined ? { usage: reply.usage } : {}),
      context: contextSnapshot(messages),
    });
  }
  input.onProgress?.({
    type: "model_call_finished",
    agent: "session",
    unitId: progressUnitId,
    turn,
    model: reply.model,
    status: isAborted(input.signal) ? "aborted" : "ok",
    ...(reply.usage !== undefined ? { usage: reply.usage } : {}),
    ...(reply.reasoning !== undefined ? { reasoning: reply.reasoning } : {}),
  });
  if (reply.operation !== undefined) {
    if (isAborted(input.signal)) {
      input.onProgress?.({ type: "paused", agent: "session", unitId: progressUnitId });
      return { journal, turns: turn, paused: true };
    }
    return {
      journal,
      operation: reply.operation,
      ...(reply.reasoning !== undefined ? { reasoning: reply.reasoning } : {}),
      turns: turn,
    };
  }
  return { journal, turns: turn, noDecision: "empty_reply" };
}

export interface RunSessionAgentOptions {
  turn?: number;
  unitId?: string;
  startTurn?: number;
  // The outline captured when the unit first opened; required to rebuild the same prefix.
  outline?: string;
  // The active execution plan, rendered for the session agent.
  plan?: string;
  // The plan item this interpretation executes; the opened unit records the link.
  planItem?: string;
  planUnitId?: string;
  signal?: AbortSignal;
}

export interface RunSessionAgentResult {
  session: SessionState;
  unitId: string;
  journal: Event[];
  operation?: SessionOperation;
  applied?: OperationResult;
  reasoning?: string;
  turns: number;
  noDecision?: NoDecisionReason;
  // The loop stopped on a user pause; the unit is committed, open and focused.
  paused?: boolean;
  // The L0 outline used for this interpretation, so a resume can reuse the same prefix.
  outline?: string;
}

function nextSessionUnitId(session: SessionState): string {
  let index = 1;
  while (session.units.has(`session:${index}`)) index += 1;
  return `session:${index}`;
}

// A refused operation is a fact for the session unit, not for the task tree: the proposal and
// the engine's reason pair as an ordinary assistant/tool turn, so a replay shows them.
function appendRefusal(
  journal: Event[],
  operation: SessionOperation,
  reason: string,
  reasoning?: string,
): void {
  const callId = `session:refusal:${journal.length}`;
  journal.push({
    type: "add_node",
    node: {
      id: callId,
      space: "work",
      kind: "action",
      label: `session:${operation.kind}`,
      payload: {
        origin: "model",
        tool: operation.kind,
        args: operation as unknown as Record<string, unknown>,
        callId,
        ...(reasoning !== undefined ? { reasoning } : {}),
      },
      seq: journal.length,
    },
  });
  journal.push({
    type: "add_node",
    node: {
      id: `session:refusal:result:${journal.length}`,
      space: "work",
      kind: "observation",
      label: "refusal",
      payload: {
        origin: "engine",
        tool: operation.kind,
        callId,
        result: `refused: ${reason}`,
      },
      seq: journal.length,
    },
  });
}

export async function runSessionAgent(
  deps: SessionAgentDeps,
  session: SessionState,
  utterance: string,
  options: RunSessionAgentOptions = {},
): Promise<RunSessionAgentResult> {
  const turn = options.turn ?? 0;
  const unitId = options.unitId ?? nextSessionUnitId(session);
  const resuming = options.unitId !== undefined && session.units.has(unitId);
  let utteranceText = utterance;
  if (!resuming) {
    setPending(session, utterance);
    const pending = takePending(session);
    utteranceText = pending?.text ?? utterance;
  }
  // L0 without the current interpretation turn: it is the root of this unit, not a past trace.
  const outline = options.outline ?? sessionOutline(session, { truncate: false });
  if (!resuming) {
    openUnit(session, unitId, "session", [], turn);
    pushUnit(session, unitId, turn);
  } else if (sessionFocus(session)?.unitId !== unitId) {
    pushUnit(session, unitId, turn);
  }
  const seed = resuming ? unitOf(session, unitId).journal : undefined;

  try {
    const run = await runSessionUnit({
      utterance: utteranceText,
      session,
      agent: deps.agent,
      ...(seed !== undefined ? { journal: seed } : {}),
      ...(options.startTurn !== undefined ? { startTurn: options.startTurn } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(deps.telemetry !== undefined ? { telemetry: deps.telemetry } : {}),
      ...(deps.onProgress !== undefined ? { onProgress: deps.onProgress } : {}),
      ...(options.plan !== undefined ? { plan: options.plan } : {}),
      outline,
    });
    const unit = unitOf(session, unitId);
    unit.journal.push(...run.journal.slice(unit.journal.length));
    unit.turn = turn;

    if (run.paused === true) {
      return {
        session,
        unitId,
        journal: unit.journal,
        turns: run.turns,
        outline,
        paused: true,
        ...(run.reasoning !== undefined ? { reasoning: run.reasoning } : {}),
      };
    }

    popUnit(session);
    const result: RunSessionAgentResult = {
      session,
      unitId,
      journal: unit.journal,
      turns: run.turns,
      outline,
      ...(run.reasoning !== undefined ? { reasoning: run.reasoning } : {}),
      ...(run.noDecision !== undefined ? { noDecision: run.noDecision } : {}),
    };
    if (run.operation !== undefined) {
      result.operation = run.operation;
      const applied = applyOperation({
        session,
        operation: run.operation,
        turn,
        sourceUnit: unitId,
        ...(run.reasoning !== undefined ? { reasoning: run.reasoning } : {}),
        ...(options.planItem !== undefined ? { planItem: options.planItem } : {}),
        ...(options.planUnitId !== undefined ? { planUnitId: options.planUnitId } : {}),
      });
      result.applied = applied;
      if (!applied.ok) {
        recordRefusal(
          session,
          unitId,
          turn,
          run.operation,
          applied.reason,
          run.reasoning,
        );
        appendRefusal(unit.journal, run.operation, applied.reason, run.reasoning);
      }
    } else if (run.noDecision !== undefined) {
      recordNoDecision(session, unitId, turn, run.noDecision);
    }
    return result;
  } catch (error) {
    if (sessionFocus(session)?.unitId === unitId) popUnit(session);
    throw error;
  }
}
