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
import type { ReadFile } from "./reading";
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
import {
  bodyText,
  searchUnit,
  stateDetail,
  stateTurnHistory,
  type BodyWindow,
  type SearchOptions,
  type TurnRange,
} from "./session_memory";
import { sessionOutline, unitOutline } from "./session_outline";
import type { NoDecisionReason, SessionOperation, SessionState } from "./types";

export const SESSION_BASE_PROMPT = [
  "You are the assistant that handles coding and general tasks: you talk to the user, answer from earlier work, and prepare work for the coding or general agent. Above is the history of earlier work: what was asked and how it ended.",
  "Choose the route by the kind of result:\n- `respond` — a conversational reply or an answer from earlier work; no separate record.\n- `general` — the request is itself a non-coding analysis, explanation, comparison or report on the material; it gets its own record. Reformulate it as a brief with the goal and relevant context.\n- `start` — the request changes files or runs side-effecting commands; reformulate it with the goal, facts and acceptance.",
  "Before starting work, make sure the brief is clear. If the request is ambiguous, or the reformulation depends on earlier work, first state it as you understand it and ask the user to confirm. Start only after the user agrees, or when the request is already unambiguous.",
  "You have no workspace tools: do not read files, edit them, or run commands yourself. Use `unit`/`state`/`turns`/`body`/`search` to inspect earlier work; the general agent reads the material and the coding agent makes changes.",
  "Answer in GitHub-flavored Markdown: short `##` sections, bullet lists, and `code` for paths and symbols. For a codebase investigation, say what you found, where (`path:line`), and what it means; cite only what the tools returned. No preamble.",
  "Ids: earlier work looks like `r1`, `g1`, or `reading:1`; observation ids look like `obs:…`. When earlier work matters, inspect it with the history tools. Stay brief and concrete; do not retell the record. Keep an answer under about 350 words and a task description under about 250 words.",
].join("\n\n");

// The post-task answer: the session agent reports a finished task to the user. It is a report,
// not a second interpretation, so it does not open a session unit of its own.
export const SESSION_REPORT_PROMPT = [
  "You are the assistant that reports a finished coding task to the user. The original request, the task request and the task trace are below.",
  "Write a concise GitHub-flavored Markdown report: what was done, where, how it was verified, and any caveats. Use only facts from the trace; do not invent results. If the task is still open, say where it stopped.",
  "Do not start a new task and do not change files. No preamble; keep it under about 250 words.",
].join("\n\n");

export interface SessionReportInput {
  // The user utterance that started the turn.
  utterance: string;
  // The reformulated task request the task agent received.
  request: string;
  // A deterministic trace of the task: states, changed files, outcome.
  trace: string;
}

export type SessionReporter = (input: SessionReportInput) => Promise<string | undefined>;

export interface SessionToolCall {
  name: string;
  args: Record<string, unknown>;
  callId?: string;
}

export interface SessionReply {
  toolCalls?: SessionToolCall[];
  operation?: SessionOperation;
  // The session agent's hidden reasoning for this reply, shown back on its tape.
  reasoning?: string;
  // Side-channel telemetry (docs/plans/session_interrupt_plan §5).
  usage?: Usage;
  model?: string;
}

export type SessionAgent = (
  messages: ModelMessage[],
  options?: { signal?: AbortSignal },
) => Promise<SessionReply>;

export interface SessionTools {
  unit(session: SessionState, id: string): string;
  state?(session: SessionState, unit: string, id: string): string;
  turns?(session: SessionState, unit: string, id: string, range?: TurnRange): string;
  body?(session: SessionState, unit: string, id: string, window?: BodyWindow): string;
  search?(session: SessionState, unit: string, pattern: string, options?: SearchOptions): string;
}

export function createSessionTools(readFile?: ReadFile): SessionTools {
  return {
    unit: (session, id) => unitOutline(session, id),
    state: (session, unit, id) => stateDetail(session, unit, id),
    turns: (session, unit, id, range) => stateTurnHistory(session, unit, id, range),
    body: (session, unit, id, window) => bodyText(session, unit, id, window, readFile),
    search: (session, unit, pattern, options) =>
      searchUnit(session, unit, pattern, options, readFile),
  };
}

export const defaultSessionTools: SessionTools = createSessionTools();

export interface SessionAgentDeps {
  agent: SessionAgent;
  tools: SessionTools;
  // Side-channel telemetry; never rendered on the tape.
  telemetry?: TelemetrySink;
  // The post-task report. Absent in tests and replays that do not need an extra model call.
  report?: SessionReporter;
  maxTurns?: number;
  surveyLimit?: number;
  onProgress?: ProgressSink;
}

export interface SessionUnitRunInput {
  utterance: string;
  session: SessionState;
  tools: SessionTools;
  agent: SessionAgent;
  journal?: readonly Event[];
  startTurn?: number;
  maxTurns?: number;
  surveyLimit?: number;
  // The session outline (L0) to show; computed before the current session unit is opened.
  outline?: string;
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
}

interface ToolCallPayload {
  origin: "engine" | "doxa";
  tool: string;
  args: Record<string, unknown>;
  callId: string;
}

interface ToolResultPayload {
  origin: "engine" | "doxa";
  tool: string;
  callId: string;
  result: string;
}

function callPayload(node: Node): ToolCallPayload | undefined {
  const payload = node.payload as Partial<ToolCallPayload> | undefined;
  if (payload?.origin !== "engine" && payload?.origin !== "doxa") return undefined;
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
  if (payload?.origin !== "engine" && payload?.origin !== "doxa") return undefined;
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
  return { utterance, outline, history };
}

export function buildSessionMessages(context: SessionContext): ModelMessage[] {
  return [
    { role: "system", content: SESSION_BASE_PROMPT },
    { role: "system", content: `Earlier tasks:\n${context.outline}` },
    { role: "user", content: context.utterance },
    ...historyMessages(context.history),
  ];
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" ? value : undefined;
}

function executeTool(
  tools: SessionTools,
  session: SessionState,
  name: string,
  args: Record<string, unknown>,
): string {
  try {
    if (name === "unit") {
      const id = stringArg(args, "id");
      return id === undefined ? "missing argument: id" : tools.unit(session, id);
    }
    const unit = stringArg(args, "unit");
    if (unit === undefined) return "missing argument: unit";
    if (name === "state") {
      const id = stringArg(args, "id");
      return id === undefined
        ? "missing argument: id"
        : (tools.state?.(session, unit, id) ?? "tool unavailable: state");
    }
    if (name === "turns") {
      const id = stringArg(args, "id");
      if (id === undefined) return "missing argument: id";
      const from = numberArg(args, "from");
      const to = numberArg(args, "to");
      return (
        tools.turns?.(session, unit, id, {
          ...(from !== undefined ? { from } : {}),
          ...(to !== undefined ? { to } : {}),
        }) ?? "tool unavailable: turns"
      );
    }
    if (name === "body") {
      const id = stringArg(args, "id");
      if (id === undefined) return "missing argument: id";
      const start = numberArg(args, "start");
      const end = numberArg(args, "end");
      return (
        tools.body?.(session, unit, id, {
          ...(start !== undefined ? { start } : {}),
          ...(end !== undefined ? { end } : {}),
        }) ?? "tool unavailable: body"
      );
    }
    if (name === "search") {
      const pattern = stringArg(args, "pattern");
      if (pattern === undefined) return "missing argument: pattern";
      const before = numberArg(args, "before");
      const after = numberArg(args, "after");
      const from = numberArg(args, "from");
      const count = numberArg(args, "count");
      return (
        tools.search?.(session, unit, pattern, {
          ...(before !== undefined ? { before } : {}),
          ...(after !== undefined ? { after } : {}),
          ...(from !== undefined ? { from } : {}),
          ...(count !== undefined ? { count } : {}),
        }) ?? "tool unavailable: search"
      );
    }
    return `unknown tool: ${name}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function runSessionUnit(input: SessionUnitRunInput): Promise<SessionUnitRunResult> {
  const journal = [
    ...(input.journal !== undefined ? input.journal : seedSessionUnit(input.utterance)),
  ];
  const startTurn = input.startTurn ?? 0;
  let turns = startTurn;
  const maxTurns = input.maxTurns ?? 12;
  const surveyLimit = input.surveyLimit ?? 4;
  const outline = input.outline ?? sessionOutline(input.session, { truncate: false });
  let surveys =
    input.journal !== undefined
      ? input.journal.filter(
          (event) => event.type === "add_node" && event.node.kind === "observation",
        ).length
      : 0;

  const progressUnitId = sessionFocus(input.session)?.unitId ?? "";
  for (let turn = startTurn + 1; turn <= maxTurns; turn += 1) {
    if (isAborted(input.signal)) {
      input.onProgress?.({ type: "paused", agent: "session", unitId: progressUnitId });
      return { journal, turns, paused: true };
    }
    const messages = buildSessionMessages(projectSessionUnit(journal, outline));
    if (surveys >= surveyLimit) {
      messages.push({
        role: "system",
        content: "You have inspected enough. Decide now: call `respond` or `start`.",
      });
    }
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
      if (isAborted(input.signal)) return { journal, turns, paused: true };
      throw error;
    }
    turns = turn;
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
    });
    if (reply.operation !== undefined) {
      if (isAborted(input.signal)) {
        input.onProgress?.({ type: "paused", agent: "session", unitId: progressUnitId });
        return { journal, turns, paused: true };
      }
      return {
        journal,
        operation: reply.operation,
        ...(reply.reasoning !== undefined ? { reasoning: reply.reasoning } : {}),
        turns,
      };
    }
    if (reply.toolCalls === undefined || reply.toolCalls.length === 0) {
      return { journal, turns, noDecision: "empty_reply" };
    }
    for (const [index, toolCall] of reply.toolCalls.entries()) {
      const callId = toolCall.callId ?? `session:call:${journal.length}`;
      const emitFrom = journal.length;
      const target = JSON.stringify(toolCall.args).slice(0, 160);
      input.onProgress?.({
        type: "tool_started",
        agent: "session",
        unitId: progressUnitId,
        turn,
        tool: toolCall.name,
        target,
      });
      journal.push({
        type: "add_node",
        node: {
          id: callId,
          space: "work",
          kind: "action",
          label: `session:${toolCall.name}`,
          // The reply's reasoning belongs to the turn: keep it on its first call.
          payload: {
            origin: "doxa",
            tool: toolCall.name,
            args: toolCall.args,
            callId,
            ...(index === 0 && reply.reasoning !== undefined
              ? { reasoning: reply.reasoning }
              : {}),
          },
          seq: journal.length,
        },
      });
      const toolStartedAt = Date.now();
      const toolResult = executeTool(
        input.tools,
        input.session,
        toolCall.name,
        toolCall.args,
      );
      input.telemetry?.record({
        type: "tool_call",
        sessionId: LOCAL_SESSION_ID,
        agent: "session",
        unitId: sessionFocus(input.session)?.unitId ?? "",
        turn,
        tool: toolCall.name,
        startedAt: toolStartedAt,
        endedAt: Date.now(),
        status: "ok",
      });
      journal.push({
        type: "add_node",
        node: {
          id: `session:result:${journal.length}`,
          space: "work",
          kind: "observation",
          label: `session:${toolCall.name}`,
          payload: {
            origin: "engine",
            tool: toolCall.name,
            callId,
            result: toolResult,
          },
          seq: journal.length,
        },
      });
      input.onProgress?.({
        type: "events_added",
        unitId: progressUnitId,
        events: journal.slice(emitFrom),
      });
      input.onProgress?.({
        type: "tool_finished",
        agent: "session",
        unitId: progressUnitId,
        turn,
        tool: toolCall.name,
        target,
        status: "ok",
        preview: toolResult,
      });
      surveys += 1;
      if (isAborted(input.signal)) {
        input.onProgress?.({ type: "paused", agent: "session", unitId: progressUnitId });
        return { journal, turns, paused: true };
      }
    }
  }

  return { journal, turns: maxTurns, noDecision: "max_turns" };
}

export interface RunSessionAgentOptions {
  turn?: number;
  unitId?: string;
  maxTurns?: number;
  surveyLimit?: number;
  startTurn?: number;
  // The outline captured when the unit first opened; required to rebuild the same prefix.
  outline?: string;
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
        origin: "doxa",
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
    const maxTurns = options.maxTurns ?? deps.maxTurns;
    const surveyLimit = options.surveyLimit ?? deps.surveyLimit;
    const run = await runSessionUnit({
      utterance: utteranceText,
      session,
      tools: deps.tools,
      agent: deps.agent,
      ...(seed !== undefined ? { journal: seed } : {}),
      ...(options.startTurn !== undefined ? { startTurn: options.startTurn } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(deps.telemetry !== undefined ? { telemetry: deps.telemetry } : {}),
      ...(deps.onProgress !== undefined ? { onProgress: deps.onProgress } : {}),
      outline,
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(surveyLimit !== undefined ? { surveyLimit } : {}),
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
