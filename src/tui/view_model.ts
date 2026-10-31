import type { Event } from "../ir/events";
import {
  childrenOf,
  fold,
  planOf,
  stopOf,
  type State,
} from "../ir/graph";
import { currentMove } from "../ir/traversal";
import { unitsInOrder, attentionOf } from "../session/session";
import type {
  Attention,
  SessionState,
  Unit,
} from "../session/types";
import { usageTotals, type MetricEvent } from "../session/telemetry";

export interface TaskTiming {
  startedAt?: number;
  endedAt?: number;
}

export interface TaskAction {
  id: string;
  label: string;
  turn: number;
  tool?: string;
}

export interface TaskState {
  id: string;
  island: string;
  what: string;
  startTurn: number;
  endTurn: number;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  reasoningTokens: number;
  toolCalls: number;
  closed: boolean;
  current: boolean;
  stopWhy?: string;
  actions: TaskAction[];
}

export interface TaskView {
  unitId: string;
  number: number;
  request: string;
  attention: Attention;
  open: boolean;
  outcome: string;
  states: TaskState[];
  turns: number;
  tokensIn: number;
  tokensOut: number;
  reasoningTokens: number;
  toolCalls: number;
  startedAt?: number;
  endedAt?: number;
  elapsedMs?: number;
}

export interface HeaderView {
  totalTasks: number;
  totalTurns: number;
  modelCalls: number;
  sessionContextTokens: number;
  tokensIn: number;
  tokensOut: number;
}

export interface TuiView {
  header: HeaderView;
  current?: TaskView;
  history: TaskView[];
  totalsByTask: Map<string, TaskView>;
}

export interface ViewOptions {
  currentUnitId?: string;
  now?: number;
  timings?: Map<string, TaskTiming>;
  liveJournals?: Map<string, readonly Event[]>;
}

function requestText(journal: readonly Event[]): string {
  for (const event of journal) {
    if (event.type !== "add_node" || event.node.kind !== "request") continue;
    const payload = event.node.payload as { text?: unknown } | undefined;
    return typeof payload?.text === "string" ? payload.text : event.node.label;
  }
  return "";
}

function moveIds(state: State): string[] {
  if (state.rootId === undefined) return [];
  return childrenOf(state, state.rootId);
}

function movePayload(state: State, moveId: string): { state?: string; what?: string; turn?: number } {
  const payload = state.nodes.get(moveId)?.payload as
    | { state?: unknown; what?: unknown; turn?: unknown }
    | undefined;
  return {
    ...(typeof payload?.state === "string" ? { state: payload.state } : {}),
    ...(typeof payload?.what === "string" ? { what: payload.what } : {}),
    ...(typeof payload?.turn === "number" ? { turn: payload.turn } : {}),
  };
}

function actionsOf(state: State, moveId: string): TaskAction[] {
  const plan = planOf(state, moveId);
  if (plan === undefined) return [];
  const actions: TaskAction[] = [];
  for (const itemId of childrenOf(state, plan)) {
    for (const altId of childrenOf(state, itemId)) {
      const node = state.nodes.get(altId);
      if (node === undefined || node.kind !== "action") continue;
      const payload = node.payload as { turn?: unknown; tool?: unknown } | undefined;
      actions.push({
        id: altId,
        label: node.label,
        turn: typeof payload?.turn === "number" ? payload.turn : 0,
        ...(typeof payload?.tool === "string" ? { tool: payload.tool } : {}),
      });
    }
  }
  return actions;
}

function usageFor(
  events: readonly MetricEvent[],
  unitId: string,
  startTurn: number,
  endTurn: number,
  agent: "task" | "general",
): { input: number; output: number; reasoning: number; toolCalls: number } {
  let input = 0;
  let output = 0;
  let reasoning = 0;
  let toolCalls = 0;
  for (const event of events) {
    if (event.type === "session" || event.unitId !== unitId) continue;
    if (event.type === "model_call" && event.agent === agent) {
      if (event.turn < startTurn || event.turn > endTurn) continue;
      input += event.usage?.inputTokens ?? 0;
      output += event.usage?.outputTokens ?? 0;
      reasoning += event.usage?.reasoningTokens ?? 0;
    } else if (event.type === "tool_call" && event.agent === agent) {
      if (event.turn < startTurn || event.turn > endTurn) continue;
      if (event.tool === "stop" || event.tool === "decline" || event.tool.startsWith("state:")) {
        continue;
      }
      toolCalls += 1;
    }
  }
  return { input, output, reasoning, toolCalls };
}

function outcomeOf(state: State, task: Unit): string {
  const move = currentMove(state);
  if (move === undefined) return "no state";
  const payload = movePayload(state, move);
  const label = payload.state ?? "?";
  const stopId = stopOf(state, move);
  if (stopId !== undefined) {
    const why = state.nodes.get(stopId)?.label;
    return why !== undefined && why !== "" ? why : `${label} closed`;
  }
  if (task.journal.some((event) => event.type === "rollback")) {
    return `cancelled at ${label}`;
  }
  return `open at ${label}`;
}

function buildTask(
  session: SessionState,
  unit: Unit,
  number: number,
  telemetry: readonly MetricEvent[],
  timing: TaskTiming | undefined,
  now: number,
  liveJournal?: readonly Event[],
): TaskView {
  const state = fold(liveJournal ?? unit.journal);
  const ids = moveIds(state);
  const states: TaskState[] = ids.map((id, index) => {
    const payload = movePayload(state, id);
    const start = payload.turn ?? 0;
    const next = ids[index + 1];
    const nextStart = next !== undefined ? (movePayload(state, next).turn ?? start + 1) : undefined;
    const end = nextStart !== undefined ? Math.max(start, nextStart - 1) : Math.max(start, unit.turn - 1);
    const usage = usageFor(
      telemetry,
      unit.id,
      start,
      end,
      unit.type === "general" ? "general" : "task",
    );
    const stopId = stopOf(state, id);
    return {
      id,
      island: payload.state ?? "?",
      what: payload.what ?? "",
      startTurn: start,
      endTurn: end,
      turns: Math.max(0, end - start + 1),
      tokensIn: usage.input,
      tokensOut: usage.output,
      reasoningTokens: usage.reasoning,
      toolCalls: usage.toolCalls,
      closed: stopId !== undefined,
      current: index === ids.length - 1,
      ...(stopId !== undefined
        ? { stopWhy: state.nodes.get(stopId)?.label ?? "" }
        : {}),
      actions: actionsOf(state, id),
    };
  });

  const tokensIn = states.reduce((sum, item) => sum + item.tokensIn, 0);
  const tokensOut = states.reduce((sum, item) => sum + item.tokensOut, 0);
  const reasoningTokens = states.reduce((sum, item) => sum + item.reasoningTokens, 0);
  const toolCalls = states.reduce((sum, item) => sum + item.toolCalls, 0);
  const startedAt = timing?.startedAt;
  const endedAt = timing?.endedAt;
  const elapsedMs =
    startedAt !== undefined
      ? Math.max(0, (endedAt ?? now) - startedAt)
      : undefined;

  return {
    unitId: unit.id,
    number,
    request: requestText(unit.journal),
    attention: attentionOf(session, unit.id),
    open: ids.length > 0 && !states[states.length - 1]?.closed,
    outcome: outcomeOf(state, unit),
    states,
    turns: unit.turn,
    tokensIn,
    tokensOut,
    reasoningTokens,
    toolCalls,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
  };
}

export function buildTuiView(
  session: SessionState,
  telemetry: readonly MetricEvent[],
  options: ViewOptions = {},
): TuiView {
  const now = options.now ?? Date.now();
  const timings = options.timings ?? new Map<string, TaskTiming>();
  const tasks = unitsInOrder(session).filter(
    (unit) => unit.type === "task" || unit.type === "general",
  );
  const byTask = new Map<string, TaskView>();
  tasks.forEach((unit, index) => {
    byTask.set(
      unit.id,
      buildTask(
        session,
        unit,
        index + 1,
        telemetry,
        timings.get(unit.id),
        now,
        options.liveJournals?.get(unit.id),
      ),
    );
  });

  const currentId =
    options.currentUnitId ??
    (session.stack.at(-1)?.unitId !== undefined &&
    byTask.has(session.stack.at(-1)?.unitId as string)
      ? (session.stack.at(-1)?.unitId as string)
      : tasks.at(-1)?.id);

  const history = [...byTask.values()].reverse();
  const usage = usageTotals(telemetry);
  let sessionContextTokens = 0;
  for (const event of telemetry) {
    if (event.type !== "model_call" || event.agent !== "session") continue;
    if (event.usage?.inputTokens !== undefined) sessionContextTokens = event.usage.inputTokens;
    else if (event.context?.approxTokens !== undefined) {
      sessionContextTokens = event.context.approxTokens;
    }
  }
  const header: HeaderView = {
    totalTasks: tasks.length,
    totalTurns: tasks.reduce((sum, unit) => sum + unit.turn, 0),
    modelCalls: usage.calls,
    sessionContextTokens,
    tokensIn: usage.inputTokens,
    tokensOut: usage.outputTokens,
  };

  return {
    header,
    ...(currentId !== undefined && byTask.has(currentId)
      ? { current: byTask.get(currentId) }
      : {}),
    history,
    totalsByTask: byTask,
  };
}

export function requestOf(unit: Unit): string {
  return requestText(unit.journal);
}
