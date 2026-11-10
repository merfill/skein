import type { ModelMessage } from "ai";

import { isAborted } from "../abort";
import type { Event } from "../ir/events";
import {
  childrenOf,
  fold,
  stopOf,
  turnsOf,
  type State,
} from "../ir/graph";
import { observationText, type TapeMessage } from "../ir/project";
import { historyMessages } from "../loop/propose";
import { toProposal } from "../llm/tools";
import { executeAction } from "../tools";
import type { Workspace } from "../tools/workspace";
import { openUnit, pushUnit, unitOf } from "./session";
import type { ProgressSink } from "./progress";
import { LOCAL_SESSION_ID, contextSnapshot, type TelemetrySink, type Usage } from "./telemetry";
import type { SessionState } from "./types";

// The document unit writes ONE large text artifact section by section. It has no `move` and no
// state transitions: the whole unit is one goal, so the journal is a monotone tape hanging off
// the request. The model first submits an outline (a JSON section list), then replies with one
// section at a time as plain text; the executor appends each section to the file and decides
// when to stop (after the last section + the summary). The model never emits the whole file in
// one call and never chooses when the work is done.

export const DOCUMENT_BASE_PROMPT = [
  "You are a document-writing agent. Your job is to produce ONE file in the workspace (Markdown by default), in the language of the request.",
  "Phase 1 — plan. Read only what the order requires (read, grep, list, recall; `shell` only for read-only commands). Then call `submit_plan` exactly once with the file `path` and an ordered list of `items`. Each item is one section: a short `title` and a self-contained `brief` with what the section must establish and the exact facts, quotes or file:line references it must use. Do not write the document yet; do not put the whole document into the plan.",
  "Phase 2 — sections. You will be asked for one item at a time: 'Write item i of N'. Reply with that section's Markdown body ONLY — the executor writes '## <title>'. Do not start with a heading and never emit '#' or '##' headings; use '###' or deeper for subsections. No code fence around the whole reply, no commentary, no other items. Keep the section focused on its brief rather than restating it. Do not repeat sections already written. If your reply is cut by the output limit, continue on the next request from exactly where it stopped.",
  "Phase 3 — summary. When asked, reply with a short summary of the file, based on the plan items and the written file.",
  "Ground every claim in the brief or the material you read; never invent citations. The file is the deliverable.",
].join("\n\n");

const MAX_SECTIONS = 40;
const TAIL_CHARS = 800;
const SUMMARY_FILE_CHARS = 24_000;

export interface DocumentPlanCall {
  name: string;
  args: Record<string, unknown>;
  callId: string;
}

export interface DocumentPlanReply {
  calls: DocumentPlanCall[];
  thought: string;
  reasoning?: string;
  usage?: Usage;
  model?: string;
}

export type DocumentPlanAgent = (
  messages: ModelMessage[],
  options?: { signal?: AbortSignal; final?: boolean },
) => Promise<DocumentPlanReply>;

export interface DocumentTextReply {
  text: string;
  // `length` means the reply was cut by the completion cap: the caller continues it.
  finishReason: string;
  reasoning?: string;
  usage?: Usage;
  model?: string;
}

export type DocumentTextAgent = (
  messages: ModelMessage[],
  options?: { signal?: AbortSignal },
) => Promise<DocumentTextReply>;

export interface DocumentDeps {
  plan: DocumentPlanAgent;
  write: DocumentTextAgent;
  workspace: Workspace;
  maxTurns: number;
  // Cap on the read-only outline phase (inspection turns before `submit_plan`).
  maxPlanTurns: number;
  // Cap on continuation requests for one section cut by the output limit.
  maxContinuations?: number;
  telemetry?: TelemetrySink;
  onProgress?: ProgressSink;
}

export interface DocumentInput {
  request: { id: string; text: string };
  seed?: Event[];
  startTurn?: number;
  session?: SessionState;
  open?: boolean;
  // Engine-recorded workspace facts (project directory and top-level structure).
  workspace?: string;
  // The execution-plan item this unit executes (plan mode).
  planItem?: string;
  maxTurns?: number;
  signal?: AbortSignal;
}

export interface DocumentSection {
  order: number;
  title: string;
  brief: string;
}

export interface DocumentOutline {
  path: string;
  items: DocumentSection[];
}

export interface DocumentResult {
  events: Event[];
  done: boolean;
  paused?: boolean;
  stopReason: string | null;
  turns: number;
  outline?: DocumentOutline;
  session?: SessionState;
}

function node(
  id: string,
  kind: "request" | "turns",
  label: string,
  payload: unknown,
  seq: number,
): Event {
  return {
    type: "add_node",
    node: { id, space: "work", kind, label, payload, seq },
  };
}

// The tape hangs off the request: no `move`, no island, one goal. `stop` is also an edge from
// the request, so `unitCompleted` reads it directly.
function seedDocument(request: { id: string; text: string }): Event[] {
  const turnsId = `${request.id}:turns`;
  return [
    node(request.id, "request", request.text, { text: request.text }, 0),
    node(turnsId, "turns", `document for ${request.id}`, undefined, 1),
    {
      type: "add_edge",
      edge: {
        id: `${request.id}:turns:edge`,
        from: request.id,
        to: turnsId,
        kind: "turns",
        provenance: { kind: "llm" },
      },
    },
  ];
}

function nextSeq(events: readonly Event[]): number {
  return fold(events).seq;
}

function requestOf(state: State): string {
  const root = state.rootId;
  if (root === undefined) return "";
  const payload = state.nodes.get(root)?.payload as { text?: unknown } | undefined;
  return typeof payload?.text === "string" ? payload.text : (state.nodes.get(root)?.label ?? "");
}

function resultOf(state: State, actionId: string): string | undefined {
  for (const edge of state.edges.values()) {
    if (edge.kind === "result" && edge.from === actionId) return edge.to;
  }
  return undefined;
}

function actionPayload(
  state: State,
  actionId: string,
): { call?: { name?: unknown; args?: unknown }; reasoning?: unknown; itemId?: unknown } | undefined {
  const payload = state.nodes.get(actionId)?.payload;
  return typeof payload === "object" && payload !== null
    ? (payload as { call?: { name?: unknown; args?: unknown }; reasoning?: unknown; itemId?: unknown })
    : undefined;
}

function parseOutline(args: Record<string, unknown>): DocumentOutline | undefined {
  const path = typeof args.path === "string" ? args.path.trim() : "";
  if (path === "") return undefined;
  const raw = args.items;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SECTIONS) return undefined;
  const items: DocumentSection[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const value = entry as Record<string, unknown>;
    if (typeof value.title !== "string" || value.title.trim() === "") return undefined;
    if (typeof value.brief !== "string" || value.brief.trim() === "") return undefined;
    items.push({ order: index + 1, title: value.title.trim(), brief: value.brief.trim() });
  }
  return { path, items };
}

// The submitted outline is the first action on the tape; it carries the raw `submit_plan` call
// so the tape history shows it like any other tool call.
function outlineOf(state: State, requestId: string): DocumentOutline | undefined {
  const turns = turnsOf(state, requestId);
  if (turns === undefined) return undefined;
  for (const actionId of childrenOf(state, turns)) {
    const payload = actionPayload(state, actionId);
    if (payload?.call?.name !== "submit_plan") continue;
    const args =
      typeof payload.call.args === "object" && payload.call.args !== null
        ? (payload.call.args as Record<string, unknown>)
        : undefined;
    if (args === undefined) continue;
    return parseOutline(args);
  }
  return undefined;
}

function writtenOrders(state: State, requestId: string): Set<number> {
  const orders = new Set<number>();
  const turns = turnsOf(state, requestId);
  if (turns === undefined) return orders;
  for (const actionId of childrenOf(state, turns)) {
    const order = actionPayload(state, actionId)?.itemId;
    if (typeof order === "number") orders.add(order);
  }
  return orders;
}

function countReadTurns(state: State, requestId: string): number {
  const turns = turnsOf(state, requestId);
  if (turns === undefined) return 0;
  let count = 0;
  for (const actionId of childrenOf(state, turns)) {
    if (actionPayload(state, actionId)?.call?.name !== "submit_plan") count += 1;
  }
  return count;
}

function outlineHistory(state: State, requestId: string): TapeMessage[] {
  const history: TapeMessage[] = [{ role: "user", text: requestOf(state) }];
  const turns = turnsOf(state, requestId);
  if (turns === undefined) return history;
  for (const actionId of childrenOf(state, turns)) {
    const action = state.nodes.get(actionId);
    if (action === undefined || action.kind !== "action") continue;
    const payload = actionPayload(state, actionId);
    const reasoning =
      typeof payload?.reasoning === "string" && payload.reasoning !== ""
        ? { reasoning: payload.reasoning }
        : {};
    const name = payload?.call?.name;
    const args = payload?.call?.args;
    if (typeof name === "string") {
      history.push({
        role: "assistant",
        text: "",
        call: {
          id: actionId,
          name,
          args:
            typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {},
        },
        ...reasoning,
      });
    } else {
      history.push({ role: "assistant", text: action.label, ...reasoning });
    }
    const resultId = resultOf(state, actionId);
    const result = resultId !== undefined ? state.nodes.get(resultId) : undefined;
    history.push({
      role: "tool",
      text: result !== undefined ? observationText(result) : action.label,
      callId: actionId,
    });
  }
  return history;
}

function renderOutline(outline: DocumentOutline): string {
  return [
    `Document: ${outline.path}`,
    `Sections (${outline.items.length}):`,
    ...outline.items.map((item) => `${item.order}. ${item.title} — ${item.brief}`),
  ].join("\n");
}

function baseMessages(
  state: State,
  requestId: string,
  workspace: string | undefined,
): ModelMessage[] {
  return [
    { role: "system", content: DOCUMENT_BASE_PROMPT },
    ...(workspace !== undefined ? [{ role: "system" as const, content: workspace }] : []),
    { role: "user", content: requestOf(state) },
  ];
}

function sectionMessages(
  state: State,
  requestId: string,
  workspace: string | undefined,
  outline: DocumentOutline,
  item: DocumentSection,
  previous: string,
): ModelMessage[] {
  const tail =
    previous.trim() === ""
      ? ""
      : `\nThe file currently ends with:\n…${previous.slice(-TAIL_CHARS)}\n`;
  return [
    ...baseMessages(state, requestId, workspace),
    { role: "system", content: `Document plan:\n${renderOutline(outline)}` },
    {
      role: "user",
      content: `Write item ${item.order} of ${outline.items.length}: "${item.title}".\nBrief: ${item.brief}\n${tail}\nReply with the Markdown body only: no '# ' or '## ' heading, subsections at '###' or deeper.`,
    },
  ];
}

function continuationMessages(
  state: State,
  requestId: string,
  workspace: string | undefined,
  outline: DocumentOutline,
  item: DocumentSection,
  written: string,
): ModelMessage[] {
  return [
    ...baseMessages(state, requestId, workspace),
    { role: "system", content: `Document plan:\n${renderOutline(outline)}` },
    { role: "assistant", content: written },
    {
      role: "user",
      content: `Continue item ${item.order} exactly where the previous reply stopped. Output only the continuation, no heading, no repeated text.`,
    },
  ];
}

function summaryMessages(
  state: State,
  requestId: string,
  workspace: string | undefined,
  outline: DocumentOutline,
  file: string,
): ModelMessage[] {
  const body =
    file.length > SUMMARY_FILE_CHARS
      ? `${file.slice(0, SUMMARY_FILE_CHARS)}\n\n[file truncated for the summary]`
      : file;
  return [
    ...baseMessages(state, requestId, workspace),
    { role: "system", content: `Document plan:\n${renderOutline(outline)}` },
    {
      role: "user",
      content: `The document is written. Write a short summary of it: what it covers and its structure.\n\n--- ${outline.path} ---\n${body}`,
    },
  ];
}

function appendText(workspace: Workspace, path: string, text: string): number {
  const previous = workspace.exists(path) ? workspace.read(path) : "";
  workspace.write(path, previous + text);
  return Buffer.byteLength(text, "utf8");
}

function recordOutline(
  events: Event[],
  requestId: string,
  outline: DocumentOutline,
  turn: number,
  reasoning: string | undefined,
): void {
  const turns = turnsOf(fold(events), requestId);
  if (turns === undefined) return;
  const seq = nextSeq(events);
  const id = `${requestId}:outline`;
  events.push({
    type: "add_node",
    node: {
      id,
      space: "work",
      kind: "action",
      label: `plan ${outline.path}`,
      payload: {
        call: {
          name: "submit_plan",
          args: { path: outline.path, items: outline.items },
        },
        outline,
        turn,
        ...(reasoning !== undefined ? { reasoning } : {}),
      },
      seq,
    },
  });
  events.push({
    type: "add_edge",
    edge: { id: `${id}:turn`, from: turns, to: id, kind: "turn", provenance: { kind: "llm" } },
  });
}

function recordSection(
  events: Event[],
  requestId: string,
  outline: DocumentOutline,
  item: DocumentSection,
  text: string,
  bytes: number,
  turn: number,
  reasoning: string | undefined,
): void {
  const turns = turnsOf(fold(events), requestId);
  if (turns === undefined) return;
  const seq = nextSeq(events);
  const id = `${requestId}:section:${item.order}`;
  events.push({
    type: "add_node",
    node: {
      id,
      space: "work",
      kind: "action",
      label: `section ${item.order}: ${item.title}`,
      payload: { itemId: item.order, title: item.title, text, turn, ...(reasoning !== undefined ? { reasoning } : {}) },
      seq,
    },
  });
  events.push({
    type: "add_edge",
    edge: { id: `${id}:turn`, from: turns, to: id, kind: "turn", provenance: { kind: "llm" } },
  });
  const observationId = `${requestId}:section:${item.order}:result`;
  const observationSeq = nextSeq(events);
  events.push({
    type: "add_node",
    node: {
      id: observationId,
      space: "work",
      kind: "observation",
      label: `appended ${bytes} bytes to ${outline.path}`,
      payload: { output: `appended ${bytes} bytes to ${outline.path}` },
      seq: observationSeq,
    },
  });
  events.push({
    type: "add_edge",
    edge: {
      id: `${observationId}:result`,
      from: id,
      to: observationId,
      kind: "result",
      provenance: { kind: "llm" },
    },
  });
}

function recordSummary(events: Event[], requestId: string, text: string, turn: number): void {
  const turns = turnsOf(fold(events), requestId);
  if (turns === undefined) return;
  const seq = nextSeq(events);
  const actionId = `${requestId}:summary`;
  events.push({
    type: "add_node",
    node: {
      id: actionId,
      space: "work",
      kind: "action",
      label: "summary",
      payload: { text, turn },
      seq,
    },
  });
  events.push({
    type: "add_edge",
    edge: {
      id: `${actionId}:turn`,
      from: turns,
      to: actionId,
      kind: "turn",
      provenance: { kind: "llm" },
    },
  });
  const stopSeq = nextSeq(events);
  const stopId = `${requestId}:stop`;
  events.push({
    type: "add_node",
    node: {
      id: stopId,
      space: "work",
      kind: "stop",
      label: text,
      payload: { why: text, turn },
      seq: stopSeq,
    },
  });
  events.push({
    type: "add_edge",
    edge: {
      id: `${stopId}:stop`,
      from: requestId,
      to: stopId,
      kind: "stop",
      provenance: { kind: "llm" },
    },
  });
}

export async function runDocumentUnit(
  deps: DocumentDeps,
  input: DocumentInput,
): Promise<DocumentResult> {
  const session = input.session;
  const startTurn = input.startTurn ?? 0;
  let events: Event[] = input.seed !== undefined ? [...input.seed] : seedDocument(input.request);
  const requestId = input.request.id;
  if (turnsOf(fold(events), requestId) === undefined) {
    return { events, done: false, stopReason: "no_state", turns: startTurn };
  }

  if (input.open === true && session !== undefined) {
    openUnit(session, requestId, "document", events, startTurn, input.planItem);
    pushUnit(session, requestId, startTurn);
  }

  const emit = deps.onProgress;
  const telemetry = deps.telemetry;
  emit?.({
    type: "state_changed",
    unitId: requestId,
    turn: startTurn,
    state: "document",
    what: input.request.text,
    closed: false,
  });

  let turn = startTurn;
  let done = false;
  let paused = false;
  let stopReason: string | null = null;
  let outline: DocumentOutline | undefined;
  let askedForOutline = false;
  const maxTurns = input.maxTurns ?? deps.maxTurns;
  const maxContinuations = deps.maxContinuations ?? 2;

  const callPlan = async (
    messages: ModelMessage[],
    final: boolean,
  ): Promise<DocumentPlanReply> => {
    const startedAt = Date.now();
    emit?.({ type: "turn_started", agent: "document", unitId: requestId, turn });
    emit?.({ type: "model_call_started", agent: "document", unitId: requestId, turn });
    try {
      const reply = await deps.plan(messages, {
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        ...(final ? { final: true } : {}),
      });
      telemetry?.record({
        type: "model_call",
        sessionId: LOCAL_SESSION_ID,
        agent: "document",
        unitId: requestId,
        turn,
        model: reply.model ?? "",
        startedAt,
        endedAt: Date.now(),
        status: "ok",
        ...(reply.usage !== undefined ? { usage: reply.usage } : {}),
        context: contextSnapshot(messages),
      });
      emit?.({
        type: "model_call_finished",
        agent: "document",
        unitId: requestId,
        turn,
        model: reply.model,
        status: "ok",
        ...(reply.usage !== undefined ? { usage: reply.usage } : {}),
        ...(reply.reasoning !== undefined ? { reasoning: reply.reasoning } : {}),
      });
      return reply;
    } catch (error) {
      telemetry?.record({
        type: "model_call",
        sessionId: LOCAL_SESSION_ID,
        agent: "document",
        unitId: requestId,
        turn,
        model: "",
        startedAt,
        endedAt: Date.now(),
        status: isAborted(input.signal) ? "aborted" : "error",
        context: contextSnapshot(messages),
      });
      emit?.({
        type: "model_call_finished",
        agent: "document",
        unitId: requestId,
        turn,
        status: isAborted(input.signal) ? "aborted" : "error",
      });
      throw error;
    }
  };

  const callText = async (messages: ModelMessage[]): Promise<DocumentTextReply> => {
    const startedAt = Date.now();
    emit?.({ type: "turn_started", agent: "document", unitId: requestId, turn });
    emit?.({ type: "model_call_started", agent: "document", unitId: requestId, turn });
    try {
      const reply = await deps.write(messages, {
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
      telemetry?.record({
        type: "model_call",
        sessionId: LOCAL_SESSION_ID,
        agent: "document",
        unitId: requestId,
        turn,
        model: reply.model ?? "",
        startedAt,
        endedAt: Date.now(),
        status: "ok",
        ...(reply.usage !== undefined ? { usage: reply.usage } : {}),
        context: contextSnapshot(messages),
      });
      emit?.({
        type: "model_call_finished",
        agent: "document",
        unitId: requestId,
        turn,
        model: reply.model,
        status: "ok",
        ...(reply.usage !== undefined ? { usage: reply.usage } : {}),
        ...(reply.reasoning !== undefined ? { reasoning: reply.reasoning } : {}),
      });
      return reply;
    } catch (error) {
      telemetry?.record({
        type: "model_call",
        sessionId: LOCAL_SESSION_ID,
        agent: "document",
        unitId: requestId,
        turn,
        model: "",
        startedAt,
        endedAt: Date.now(),
        status: isAborted(input.signal) ? "aborted" : "error",
        context: contextSnapshot(messages),
      });
      emit?.({
        type: "model_call_finished",
        agent: "document",
        unitId: requestId,
        turn,
        status: isAborted(input.signal) ? "aborted" : "error",
      });
      throw error;
    }
  };

  while (turn < maxTurns) {
    if (isAborted(input.signal)) {
      paused = true;
      emit?.({ type: "paused", agent: "document", unitId: requestId });
      break;
    }
    const state = fold(events);
    outline = outlineOf(state, requestId);

    if (outline === undefined) {
      if (countReadTurns(state, requestId) >= deps.maxPlanTurns) {
        const messages = [
          ...baseMessages(state, requestId, input.workspace),
          {
            role: "system" as const,
            content:
              "The outline must be submitted now. Call `submit_plan` with the path and the ordered sections; do not inspect anything else.",
          },
        ];
        const reply = await callPlan(messages, true);
        const submit = reply.calls.find((call) => call.name === "submit_plan");
        if (submit !== undefined) {
          const parsed = parseOutline(submit.args);
          if (parsed !== undefined) {
            const before = events.length;
            recordOutline(events, requestId, parsed, turn, reply.reasoning);
            outline = parsed;
            emit?.({ type: "events_added", unitId: requestId, events: events.slice(before) });
            emit?.({ type: "state_changed", unitId: requestId, turn, state: "document", closed: false });
          }
        }
        turn += 1;
        if (outline === undefined) {
          stopReason = "no_outline";
          break;
        }
        continue;
      }

      const messages = historyMessages(outlineHistory(state, requestId));
      const reply = await callPlan(
        [
          { role: "system", content: DOCUMENT_BASE_PROMPT },
          ...(input.workspace !== undefined
            ? [{ role: "system" as const, content: input.workspace }]
            : []),
          ...messages,
        ],
        false,
      );
      const submit = reply.calls.find((call) => call.name === "submit_plan");
      if (submit !== undefined) {
        const parsed = parseOutline(submit.args);
        if (parsed !== undefined) {
          const before = events.length;
          recordOutline(events, requestId, parsed, turn, reply.reasoning);
          outline = parsed;
          emit?.({ type: "events_added", unitId: requestId, events: events.slice(before) });
          emit?.({ type: "state_changed", unitId: requestId, turn, state: "document", closed: false });
          turn += 1;
          continue;
        }
      }
      if (reply.calls.length === 0) {
        if (askedForOutline) {
          stopReason = "no_outline";
          break;
        }
        askedForOutline = true;
        turn += 1;
        continue;
      }
      for (const call of reply.calls) {
        if (isAborted(input.signal)) {
          paused = true;
          break;
        }
        let action;
        try {
          action = toProposal(call.name, call.args, "").action;
        } catch {
          continue;
        }
        const target = `${call.name} ${JSON.stringify(call.args).slice(0, 160)}`;
        emit?.({
          type: "tool_started",
          agent: "document",
          unitId: requestId,
          turn,
          tool: call.name,
          target,
        });
        const before = events.length;
        const outcome = executeAction(
          action,
          fold(events),
          deps.workspace,
          turn,
          reply.reasoning,
        );
        events.push(...outcome.events);
        emit?.({ type: "events_added", unitId: requestId, events: events.slice(before) });
        const failed = outcome.events.some(
          (event) =>
            event.type === "add_node" &&
            event.node.kind === "observation" &&
            (event.node.payload as { failed?: unknown } | undefined)?.failed === true,
        );
        emit?.({
          type: "tool_finished",
          agent: "document",
          unitId: requestId,
          turn,
          tool: call.name,
          target,
          status: failed ? "error" : "ok",
          preview: outcome.turn.text,
        });
        telemetry?.record({
          type: "tool_call",
          sessionId: LOCAL_SESSION_ID,
          agent: "document",
          unitId: requestId,
          turn,
          tool: call.name,
          startedAt: Date.now(),
          endedAt: Date.now(),
          status: failed ? "error" : "ok",
        });
      }
      turn += 1;
      continue;
    }

    const written = writtenOrders(state, requestId);
    const item = outline.items.find((entry) => !written.has(entry.order));
    if (item !== undefined) {
      const previous = deps.workspace.exists(outline.path)
        ? deps.workspace.read(outline.path)
        : "";
      let body = "";
      let reasoning: string | undefined;
      for (let continuation = 0; ; continuation += 1) {
        if (isAborted(input.signal)) {
          paused = true;
          break;
        }
        const messages =
          continuation === 0
            ? sectionMessages(state, requestId, input.workspace, outline, item, previous)
            : continuationMessages(
                state,
                requestId,
                input.workspace,
                outline,
                item,
                body,
              );
        const reply = await callText(messages);
        body += reply.text;
        if (reasoning === undefined) reasoning = reply.reasoning;
        if (reply.finishReason !== "length" || continuation >= maxContinuations) break;
      }
      if (paused) break;
      if (written.size === 0) deps.workspace.write(outline.path, "");
      const chunk = `## ${item.title}\n\n${body.trim()}\n\n`;
      emit?.({
        type: "tool_started",
        agent: "document",
        unitId: requestId,
        turn,
        tool: "append",
        target: outline.path,
      });
      const bytes = appendText(deps.workspace, outline.path, chunk);
      telemetry?.record({
        type: "tool_call",
        sessionId: LOCAL_SESSION_ID,
        agent: "document",
        unitId: requestId,
        turn,
        tool: "append",
        startedAt: Date.now(),
        endedAt: Date.now(),
        status: "ok",
      });
      const before = events.length;
      recordSection(events, requestId, outline, item, body, bytes, turn, reasoning);
      emit?.({ type: "events_added", unitId: requestId, events: events.slice(before) });
      emit?.({
        type: "tool_finished",
        agent: "document",
        unitId: requestId,
        turn,
        tool: "append",
        target: outline.path,
        status: "ok",
        preview: `## ${item.title} (+${bytes} bytes)`,
      });
      turn += 1;
      continue;
    }

    if (stopOf(state, requestId) === undefined) {
      const file = deps.workspace.exists(outline.path)
        ? deps.workspace.read(outline.path)
        : "";
      const reply = await callText(
        summaryMessages(state, requestId, input.workspace, outline, file),
      );
      const before = events.length;
      recordSummary(events, requestId, reply.text.trim(), turn);
      emit?.({ type: "events_added", unitId: requestId, events: events.slice(before) });
      emit?.({ type: "state_changed", unitId: requestId, turn, state: "document", closed: true });
      turn += 1;
      done = true;
      stopReason = "summarized";
      break;
    }

    done = true;
    stopReason = "summarized";
    break;
  }

  if (isAborted(input.signal)) {
    paused = true;
    emit?.({ type: "paused", agent: "document", unitId: requestId });
  }

  // The stop is the unit's closure; `unitCompleted` reads it. A run that exhausted its turn
  // cap without writing the stop is not done.
  done = done || stopOf(fold(events), requestId) !== undefined;
  if (!done && !paused && stopReason === null) stopReason = "max_turns";

  return {
    events,
    done,
    ...(paused ? { paused: true } : {}),
    stopReason,
    turns: turn,
    ...(outline !== undefined ? { outline } : {}),
    ...(session !== undefined ? { session } : {}),
  };
}
