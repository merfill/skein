import type { ModelMessage } from "ai";

import type { Event } from "../ir/events";
import type { TapeMessage } from "../ir/project";
import type { Node } from "../ir/types";
import { historyMessages } from "../loop/propose";
import { applyOperation, type OperationResult } from "./operations";
import {
  readUnit,
  readingResultText,
  type ReadFile,
} from "./reading";
import {
  grepText,
  listText,
  probeText,
  PROBE_KINDS,
  type ProbeKind,
  type SessionWorkspace,
} from "./session_workspace";
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
  "You are the assistant that handles coding tasks: you talk to the user and prepare work for the coding agent. Above is the history of earlier tasks: what was asked and how it ended.",
  "If the message is a question, a remark, or does not ask for work, answer it; do not start a task.",
  "When the user asks for work, reformulate the message into a complete task description for the coding agent: the goal, the relevant facts from earlier work, and the acceptance. The coding agent sees only this description, so it must stand on its own.",
  "Before starting, make sure the task is clear. If the request is ambiguous, or the reformulation depends on earlier work, first state the task as you understand it and ask the user to confirm. Start only after the user agrees, or when the request is already unambiguous.",
  "To read a file, use `read`: it is one action, not a task. It returns a bounded preview and an address; use `body`/`search` on that reading unit for more. Use `start` only for work that changes files or needs several turns.",
  "Answer in GitHub-flavored Markdown: short `##` sections, bullet lists, and `code` for paths and symbols. For a codebase investigation, say what you found, where (`path:line`), and what it means; cite only what the tools returned. No preamble.",
  "Ids: unit ids look like `r1` or `reading:1`; observation ids look like `obs:…`. `read` returns both. When earlier work matters, inspect it with the history tools. Do not edit files or run commands yourself. Stay brief and concrete; do not retell the record. Keep an answer under about 350 words and a task description under about 250 words.",
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
}

export type SessionAgent = (messages: ModelMessage[]) => Promise<SessionReply>;

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
  // Read-only file access for the `read` tool; the reading unit keeps the trace.
  readFile?: ReadFile;
  // Read-only workspace access for `grep`/`list` and the session probe.
  workspace?: SessionWorkspace;
  // The post-task report. Absent in tests and replays that do not need an extra model call.
  report?: SessionReporter;
  maxTurns?: number;
  surveyLimit?: number;
}

export interface SessionUnitRunInput {
  utterance: string;
  session: SessionState;
  tools: SessionTools;
  agent: SessionAgent;
  journal?: readonly Event[];
  maxTurns?: number;
  surveyLimit?: number;
  readFile?: ReadFile;
  workspace?: SessionWorkspace;
  // The session outline (L0) to show; computed before the current session unit is opened.
  outline?: string;
}

export interface SessionUnitRunResult {
  journal: Event[];
  operation?: SessionOperation;
  reasoning?: string;
  turns: number;
  // Set when the loop ended without an operation (an empty reply or the safety cap).
  noDecision?: NoDecisionReason;
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
  readFile?: ReadFile,
  workspace?: SessionWorkspace,
): string {
  try {
    if (name === "read") {
      const path = stringArg(args, "path");
      if (path === undefined) return "missing argument: path";
      const reader = readFile ?? workspace?.read;
      if (reader === undefined) return "tool unavailable: read";
      return readingResultText(readUnit(session, path, reader));
    }
    if (name === "grep") {
      const pattern = stringArg(args, "pattern");
      if (pattern === undefined) return "missing argument: pattern";
      if (workspace === undefined) return "tool unavailable: grep";
      const path = stringArg(args, "path");
      const include = stringArg(args, "include");
      const from = numberArg(args, "from");
      return grepText(
        workspace.grep(pattern, {
          ...(path !== undefined ? { path } : {}),
          ...(include !== undefined ? { include } : {}),
        }),
        from,
      );
    }
    if (name === "list") {
      if (workspace === undefined) return "tool unavailable: list";
      const path = stringArg(args, "path");
      const include = stringArg(args, "include");
      const from = numberArg(args, "from");
      return listText(
        workspace.listFiles({
          ...(path !== undefined ? { path } : {}),
          ...(include !== undefined ? { include } : {}),
        }),
        {
          ...(path !== undefined ? { root: path } : {}),
          ...(from !== undefined ? { from } : {}),
        },
      );
    }
    if (name === "probe") {
      if (workspace === undefined) return "tool unavailable: probe";
      const kind = stringArg(args, "kind");
      if (kind !== undefined && !PROBE_KINDS.includes(kind as ProbeKind)) {
        return `unknown probe kind: ${kind}`;
      }
      return probeText(workspace.probe(), (kind as ProbeKind | undefined) ?? "environment");
    }
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
  const maxTurns = input.maxTurns ?? 12;
  const surveyLimit = input.surveyLimit ?? 4;
  const outline = input.outline ?? sessionOutline(input.session);
  let surveys = 0;

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const messages = buildSessionMessages(projectSessionUnit(journal, outline));
    if (surveys >= surveyLimit) {
      messages.push({
        role: "system",
        content: "You have inspected enough. Decide now: call `respond` or `start`.",
      });
    }
    const reply = await input.agent(messages);
    if (reply.operation !== undefined) {
      return {
        journal,
        operation: reply.operation,
        ...(reply.reasoning !== undefined ? { reasoning: reply.reasoning } : {}),
        turns: turn,
      };
    }
    if (reply.toolCalls === undefined || reply.toolCalls.length === 0) {
      return { journal, turns: turn, noDecision: "empty_reply" };
    }
    for (const [index, toolCall] of reply.toolCalls.entries()) {
      const callId = toolCall.callId ?? `session:call:${journal.length}`;
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
            result: executeTool(
              input.tools,
              input.session,
              toolCall.name,
              toolCall.args,
              input.readFile,
              input.workspace,
            ),
          },
          seq: journal.length,
        },
      });
      surveys += 1;
    }
  }

  return { journal, turns: maxTurns, noDecision: "max_turns" };
}

export interface RunSessionAgentOptions {
  turn?: number;
  unitId?: string;
  maxTurns?: number;
  surveyLimit?: number;
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
  setPending(session, utterance);
  const pending = takePending(session);
  const unitId = options.unitId ?? nextSessionUnitId(session);
  // L0 without the current interpretation turn: it is the root of this unit, not a past trace.
  const outline = sessionOutline(session);
  openUnit(session, unitId, "session", [], turn);
  pushUnit(session, unitId, turn);

  try {
    const maxTurns = options.maxTurns ?? deps.maxTurns;
    const surveyLimit = options.surveyLimit ?? deps.surveyLimit;
    const run = await runSessionUnit({
      utterance: pending?.text ?? utterance,
      session,
      tools: deps.tools,
      agent: deps.agent,
      ...(deps.readFile !== undefined ? { readFile: deps.readFile } : {}),
      ...(deps.workspace !== undefined ? { workspace: deps.workspace } : {}),
      outline,
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(surveyLimit !== undefined ? { surveyLimit } : {}),
    });
    const unit = unitOf(session, unitId);
    unit.journal.push(...run.journal);
    unit.turn = turn;
    popUnit(session);

    const result: RunSessionAgentResult = {
      session,
      unitId,
      journal: unit.journal,
      turns: run.turns,
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
