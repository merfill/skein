import type { ModelMessage } from "ai";

import { isAborted } from "../abort";
import type { Event } from "../ir/events";
import { childrenOf, fold, turnsOf, type State } from "../ir/graph";
import { GENERAL_STATE } from "../ir/islands";
import { asCall, observationText, type TapeMessage } from "../ir/project";
import type { PlanItemKind } from "../ir/types";
import { historyMessages } from "../loop/propose";
import type { Action } from "../llm/schemas";
import { toProposal } from "../llm/tools";
import { executeAction } from "../tools";
import type { Workspace } from "../tools/workspace";
import { openUnit, pushUnit, unitOf } from "./session";
import type { ProgressSink } from "./progress";
import { LOCAL_SESSION_ID, contextSnapshot, type TelemetrySink, type Usage } from "./telemetry";
import type { SessionState } from "./types";

export const PLANNER_BASE_PROMPT = [
  "You are the plan agent. You develop an execution plan for the user's request in this workspace. You do not change the workspace.",
  "Read the request and inspect the workspace with the read-only tools (read, grep, list, recall; `shell` only for read-only commands). Ground every step in what you actually read: a step that names files, commands or acceptance checks must come from the material, not from imagination.",
  "When you have enough, call `submit_plan` exactly once with a short summary and an ordered list of items. Each item is one work order for a later agent: a title, a self-contained detail (the goal plus the facts that work order needs), its kind (`general` for a read-only answer, `coding` for a workspace change), and — when the request declares one — its `done` condition. Keep the plan linear and minimal; do not write code and do not split work that one agent can do in one unit.",
  "The plan is a proposal, not the work: after it is submitted the user decides whether to execute it.",
].join("\n\n");

// The planner's model reply: a batch of native tool calls (read-only tools and the terminal
// `submit_plan`). Unlike the task proposer, `submit_plan` is not an IR `Action`; the planner
// loop turns it into the plan nodes.
export interface PlannerCall {
  name: string;
  args: Record<string, unknown>;
  callId: string;
}

export interface PlannerReply {
  calls: PlannerCall[];
  thought: string;
  reasoning?: string;
  usage?: Usage;
  model?: string;
}

export type PlannerAgent = (
  messages: ModelMessage[],
  options?: { signal?: AbortSignal; final?: boolean },
) => Promise<PlannerReply>;

export interface PlannerDeps {
  agent: PlannerAgent;
  workspace: Workspace;
  maxTurns: number;
  telemetry?: TelemetrySink;
  onProgress?: ProgressSink;
}

export interface PlannerItemInput {
  title: string;
  detail: string;
  kind: PlanItemKind;
  done?: string;
}

export interface PlannerDraft {
  summary?: string;
  items: PlannerItemInput[];
}

export interface PlannerInput {
  request: { id: string; text: string };
  seed?: Event[];
  startTurn?: number;
  session?: SessionState;
  open?: boolean;
  // Engine-recorded workspace facts (project directory and top-level structure).
  workspace?: string;
  // The entry checkpoint id; a read-only unit restores any mutation when it ends.
  snapshot?: string;
  signal?: AbortSignal;
}

export interface PlannerResult {
  events: Event[];
  done: boolean;
  paused?: boolean;
  stopReason: string | null;
  turns: number;
  // The submitted plan; absent when the planner produced none (the unit is not completed).
  plan?: PlannerDraft;
  session?: SessionState;
}

function node(
  id: string,
  kind: "request" | "move",
  label: string,
  payload: unknown,
  seq: number,
): Event {
  return {
    type: "add_node",
    node: { id, space: "work", kind, label, payload, seq },
  };
}

function seedPlanner(request: { id: string; text: string }, turn: number): Event[] {
  const moveId = `${request.id}:plan`;
  return [
    node(request.id, "request", request.text, { text: request.text }, 0),
    node(moveId, "move", "Plan", { state: GENERAL_STATE, what: request.text, turn }, 1),
    {
      type: "add_edge",
      edge: {
        id: `${request.id}:move`,
        from: request.id,
        to: moveId,
        kind: "move",
        provenance: { kind: "llm" },
      },
    },
    { type: "descend", node: moveId },
  ];
}

function moveOf(events: readonly Event[], requestId: string): string | undefined {
  const state = fold(events);
  const root = state.rootId ?? requestId;
  return childrenOf(state, root).find((id) => state.nodes.get(id)?.kind === "move");
}

function resultOf(state: State, actionId: string): string | undefined {
  for (const edge of state.edges.values()) {
    if (edge.kind === "result" && edge.from === actionId) return edge.to;
  }
  return undefined;
}

function requestOf(state: State): string {
  const root = state.rootId;
  if (root === undefined) return "";
  const payload = state.nodes.get(root)?.payload as { text?: unknown } | undefined;
  return typeof payload?.text === "string" ? payload.text : (state.nodes.get(root)?.label ?? "");
}

const TOOL_RESULT_LIMIT = 2000;
const TOOL_RESULT_TAIL = 400;

function historyOf(state: State, moveId: string): TapeMessage[] {
  const history: TapeMessage[] = [{ role: "user", text: requestOf(state) }];
  const turns = turnsOf(state, moveId);
  if (turns === undefined) return history;
  for (const actionId of childrenOf(state, turns)) {
    const action = state.nodes.get(actionId);
    if (action === undefined || action.kind !== "action") continue;
    const payload = action.payload as
      | { call?: { name?: unknown; args?: unknown }; reasoning?: unknown }
      | undefined;
    const reasoning =
      typeof payload?.reasoning === "string" && payload.reasoning !== ""
        ? { reasoning: payload.reasoning }
        : {};
    const call = asCall(action);
    if (call !== undefined) {
      history.push({ role: "assistant", text: "", call: { id: actionId, ...call }, ...reasoning });
    } else {
      history.push({ role: "assistant", text: action.label, ...reasoning });
    }
    const resultId = resultOf(state, actionId);
    const result = resultId !== undefined ? state.nodes.get(resultId) : undefined;
    const text = result !== undefined ? observationText(result) : action.label;
    const bounded =
      text.length <= TOOL_RESULT_LIMIT
        ? text
        : `${text.slice(0, TOOL_RESULT_LIMIT - TOOL_RESULT_TAIL)}\n…[truncated]${
            resultId !== undefined ? ` recall ${resultId}` : ""
          }\n${text.slice(-TOOL_RESULT_TAIL)}`;
    history.push({ role: "tool", text: bounded, callId: actionId });
  }
  return history;
}

function messagesOf(state: State, moveId: string, workspace?: string): ModelMessage[] {
  return [
    { role: "system", content: PLANNER_BASE_PROMPT },
    ...(workspace !== undefined ? [{ role: "system" as const, content: workspace }] : []),
    ...historyMessages(historyOf(state, moveId)),
  ];
}

function parsePlan(args: Record<string, unknown>): PlannerDraft | undefined {
  const rawItems = args.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) return undefined;
  const items: PlannerItemInput[] = [];
  for (const raw of rawItems) {
    if (typeof raw !== "object" || raw === null) return undefined;
    const value = raw as Record<string, unknown>;
    if (typeof value.title !== "string" || typeof value.detail !== "string") return undefined;
    const kind: PlanItemKind = value.kind === "general" ? "general" : "task";
    items.push({
      title: value.title,
      detail: value.detail,
      kind,
      ...(typeof value.done === "string" && value.done !== "" ? { done: value.done } : {}),
    });
  }
  const summary = typeof args.summary === "string" && args.summary !== "" ? args.summary : undefined;
  return { ...(summary !== undefined ? { summary } : {}), items };
}

// Record the submitted plan on the unit's journal: a `plan` header hanging off the move, its
// ordered `plan_item` children, and the state's `stop` so the unit is complete.
function recordPlan(
  events: Event[],
  requestId: string,
  moveId: string,
  draft: PlannerDraft,
  turn: number,
): void {
  let seq = fold(events).seq;
  const next = (): number => {
    seq += 1;
    return seq;
  };
  const planId = `${requestId}:plan:body`;
  events.push({
    type: "add_node",
    node: {
      id: planId,
      space: "work",
      kind: "plan",
      label: draft.summary ?? "Plan",
      payload: { ...(draft.summary !== undefined ? { summary: draft.summary } : {}) },
      seq: next(),
    },
  });
  events.push({
    type: "add_edge",
    edge: {
      id: `${planId}:edge`,
      from: moveId,
      to: planId,
      kind: "plan",
      provenance: { kind: "llm" },
    },
  });
  for (const [index, item] of draft.items.entries()) {
    const itemId = `${planId}:item:${index + 1}`;
    events.push({
      type: "add_node",
      node: {
        id: itemId,
        space: "work",
        kind: "plan_item",
        label: item.title,
        payload: {
          title: item.title,
          detail: item.detail,
          kind: item.kind,
          order: index + 1,
          ...(item.done !== undefined ? { done: item.done } : {}),
        },
        seq: next(),
      },
    });
    events.push({
      type: "add_edge",
      edge: {
        id: `${itemId}:edge`,
        from: planId,
        to: itemId,
        kind: "plan_item",
        provenance: { kind: "llm" },
      },
    });
  }
  const stopId = `${requestId}:plan:stop`;
  events.push({
    type: "add_node",
    node: {
      id: stopId,
      space: "work",
      kind: "stop",
      label: draft.summary ?? "plan submitted",
      payload: { why: draft.summary ?? "plan submitted", turn },
      seq: next(),
    },
  });
  events.push({
    type: "add_edge",
    edge: {
      id: `${stopId}:edge`,
      from: moveId,
      to: stopId,
      kind: "stop",
      provenance: { kind: "llm" },
    },
  });
}

function describeCall(call: PlannerCall): string {
  const target = JSON.stringify(call.args).slice(0, 160);
  return `${call.name} ${target}`;
}

export async function runPlanner(
  deps: PlannerDeps,
  input: PlannerInput,
): Promise<PlannerResult> {
  const session = input.session;
  const startTurn = input.startTurn ?? 0;
  let events: Event[] = input.seed !== undefined ? [...input.seed] : seedPlanner(input.request, startTurn);
  const moveId = moveOf(events, input.request.id);
  if (moveId === undefined) {
    return { events, done: false, stopReason: "no_state", turns: startTurn };
  }

  if (input.open === true && session !== undefined) {
    openUnit(session, input.request.id, "plan", events, startTurn);
    pushUnit(session, input.request.id, startTurn);
    if (input.snapshot !== undefined) {
      unitOf(session, input.request.id).checkpoint = input.snapshot;
    }
  }

  const unitId = input.request.id;
  const emit = deps.onProgress;
  emit?.({
    type: "state_changed",
    unitId,
    turn: startTurn,
    state: "plan",
    what: input.request.text,
    closed: false,
  });

  let turn = startTurn;
  let done = false;
  let paused = false;
  let stopReason: string | null = null;
  let plan: PlannerDraft | undefined;
  let askedForPlan = false;

  while (turn < deps.maxTurns) {
    if (isAborted(input.signal)) {
      paused = true;
      emit?.({ type: "paused", agent: "plan", unitId });
      break;
    }
    const state = fold(events);
    const messages = messagesOf(state, moveId, input.workspace);
    if (askedForPlan) {
      messages.push({
        role: "system",
        content:
          "Submit the plan now with `submit_plan`: a summary and an ordered list of items. Do not inspect anything else.",
      });
    }
    const startedAt = Date.now();
    emit?.({ type: "turn_started", agent: "plan", unitId, turn });
    emit?.({ type: "model_call_started", agent: "plan", unitId, turn });
    let reply: PlannerReply;
    try {
      reply = await deps.agent(
        messages,
        input.signal !== undefined ? { signal: input.signal } : undefined,
      );
    } catch (error) {
      deps.telemetry?.record({
        type: "model_call",
        sessionId: LOCAL_SESSION_ID,
        agent: "plan",
        unitId,
        turn,
        model: "",
        startedAt,
        endedAt: Date.now(),
        status: isAborted(input.signal) ? "aborted" : "error",
        context: contextSnapshot(messages),
      });
      if (isAborted(input.signal)) {
        paused = true;
        emit?.({ type: "paused", agent: "plan", unitId });
        break;
      }
      throw error;
    }
    deps.telemetry?.record({
      type: "model_call",
      sessionId: LOCAL_SESSION_ID,
      agent: "plan",
      unitId,
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
      agent: "plan",
      unitId,
      turn,
      model: reply.model,
      status: "ok",
      ...(reply.usage !== undefined ? { usage: reply.usage } : {}),
      ...(reply.reasoning !== undefined ? { reasoning: reply.reasoning } : {}),
    });

    if (isAborted(input.signal)) {
      paused = true;
      emit?.({ type: "paused", agent: "plan", unitId });
      break;
    }

    const submit = reply.calls.find((call) => call.name === "submit_plan");
    if (submit !== undefined) {
      const draft = parsePlan(submit.args);
      if (draft !== undefined) {
        const before = events.length;
        recordPlan(events, input.request.id, moveId, draft, turn);
        plan = draft;
        done = true;
        stopReason = "planned";
        emit?.({ type: "events_added", unitId, events: events.slice(before) });
        emit?.({ type: "state_changed", unitId, turn, state: "plan", closed: true });
        break;
      }
      askedForPlan = true;
      continue;
    }

    if (reply.calls.length === 0) {
      if (askedForPlan) {
        stopReason = "no_plan";
        break;
      }
      askedForPlan = true;
      continue;
    }

    for (const call of reply.calls) {
      if (isAborted(input.signal)) {
        paused = true;
        break;
      }
      let action: Action;
      try {
        action = toProposal(call.name, call.args, "").action;
      } catch {
        continue;
      }
      const target = describeCall(call);
      emit?.({
        type: "tool_started",
        agent: "plan",
        unitId,
        turn,
        tool: call.name,
        target,
      });
      const before = events.length;
      const outcome = executeAction(action, fold(events), deps.workspace, turn, reply.reasoning);
      events.push(...outcome.events);
      emit?.({ type: "events_added", unitId, events: events.slice(before) });
      const failed = outcome.events.some(
        (event) =>
          event.type === "add_node" &&
          event.node.kind === "observation" &&
          (event.node.payload as { failed?: unknown } | undefined)?.failed === true,
      );
      emit?.({
        type: "tool_finished",
        agent: "plan",
        unitId,
        turn,
        tool: call.name,
        target,
        status: failed ? "error" : "ok",
        preview: outcome.turn.text,
      });
      deps.telemetry?.record({
        type: "tool_call",
        sessionId: LOCAL_SESSION_ID,
        agent: "plan",
        unitId,
        turn,
        tool: call.name,
        startedAt: Date.now(),
        endedAt: Date.now(),
        status: failed ? "error" : "ok",
      });
    }

    turn += 1;
    emit?.({ type: "turn_finished", agent: "plan", unitId, turn: turn - 1, stopReason });
    if (paused) {
      emit?.({ type: "paused", agent: "plan", unitId });
      break;
    }
    if (done) break;
  }

  // The turn limit is a safety cap, not a deliverable: make one final call with `submit_plan`
  // as the only tool, so the work already read still produces a plan. Without this a real
  // task (a large source tree) never reaches the submit call.
  if (!done && !paused) {
    const messages = messagesOf(fold(events), moveId, input.workspace);
    messages.push({
      role: "system",
      content:
        "The turn limit is reached. Submit the plan now with `submit_plan`, using what you have already read. Do not inspect anything else and do not call another tool.",
    });
    const startedAt = Date.now();
    emit?.({ type: "turn_started", agent: "plan", unitId, turn });
    emit?.({ type: "model_call_started", agent: "plan", unitId, turn });
    let reply: PlannerReply | undefined;
    try {
      reply = await deps.agent(messages, {
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        final: true,
      });
    } catch (error) {
      deps.telemetry?.record({
        type: "model_call",
        sessionId: LOCAL_SESSION_ID,
        agent: "plan",
        unitId,
        turn,
        model: "",
        startedAt,
        endedAt: Date.now(),
        status: isAborted(input.signal) ? "aborted" : "error",
        context: contextSnapshot(messages),
      });
      emit?.({
        type: "model_call_finished",
        agent: "plan",
        unitId,
        turn,
        status: isAborted(input.signal) ? "aborted" : "error",
      });
      if (isAborted(input.signal)) {
        paused = true;
        emit?.({ type: "paused", agent: "plan", unitId });
      }
    }
    if (reply !== undefined) {
      deps.telemetry?.record({
        type: "model_call",
        sessionId: LOCAL_SESSION_ID,
        agent: "plan",
        unitId,
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
        agent: "plan",
        unitId,
        turn,
        model: reply.model,
        status: "ok",
        ...(reply.usage !== undefined ? { usage: reply.usage } : {}),
        ...(reply.reasoning !== undefined ? { reasoning: reply.reasoning } : {}),
      });
      const submit = reply.calls.find((call) => call.name === "submit_plan");
      if (submit !== undefined) {
        const draft = parsePlan(submit.args);
        if (draft !== undefined) {
          const before = events.length;
          recordPlan(events, input.request.id, moveId, draft, turn);
          plan = draft;
          done = true;
          stopReason = "planned";
          emit?.({ type: "events_added", unitId, events: events.slice(before) });
          emit?.({ type: "state_changed", unitId, turn, state: "plan", closed: true });
        }
      }
      turn += 1;
    }
  }

  if (!done && !paused) {
    stopReason = "no_plan";
  }

  return {
    events,
    done,
    ...(paused ? { paused: true } : {}),
    stopReason,
    turns: turn,
    ...(plan !== undefined ? { plan } : {}),
    ...(session !== undefined ? { session } : {}),
  };
}
