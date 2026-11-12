import type { Event } from "../ir/events";
import {
  childrenOf,
  fold,
  stopOf,
  turnsOf,
  type State,
} from "../ir/graph";
import { currentMove } from "../ir/traversal";
import {
  blockedItem,
  nextPendingItem,
  planFinished,
  planModeOf,
  planOfSession,
  planProgress,
  unitOfPlanItem,
  type PlanItemStatus,
} from "../session/plan";
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

export interface TaskTurn {
  turn: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
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
  cachedInputTokens: number;
  contextTokens: number;
  toolCalls: number;
  durationMs: number;
  turnDetails: TaskTurn[];
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
  cachedInputTokens: number;
  contextTokens: number;
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
  reasoningTokens: number;
  cachedInputTokens: number;
}

export type PlanViewStatus = "building" | "ready" | "executing" | "done" | "aborted";

export interface PlanItemView {
  id: string;
  order: number;
  title: string;
  status: PlanItemStatus;
  done?: string;
}

export interface PlanView {
  unitId: string;
  summary?: string;
  status: PlanViewStatus;
  completed: number;
  total: number;
  items: PlanItemView[];
  // The item the engine is on: active/suspended/abandoned, else the next one to open.
  activeItemId?: string;
  // The plan unit's own turn counter (the planner during `building`, the item units after).
  turns: number;
  elapsedMs?: number;
}

export interface TuiView {
  header: HeaderView;
  current?: TaskView;
  history: TaskView[];
  totalsByTask: Map<string, TaskView>;
  plan?: PlanView;
}

export interface ViewOptions {
  currentUnitId?: string;
  planUnitId?: string;
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
  const turns = turnsOf(state, moveId);
  if (turns === undefined) return [];
  const actions: TaskAction[] = [];
  for (const actionId of childrenOf(state, turns)) {
    const node = state.nodes.get(actionId);
    if (node === undefined || node.kind !== "action") continue;
    const payload = node.payload as { turn?: unknown; tool?: unknown } | undefined;
    actions.push({
      id: actionId,
      label: node.label,
      turn: typeof payload?.turn === "number" ? payload.turn : 0,
      ...(typeof payload?.tool === "string" ? { tool: payload.tool } : {}),
    });
  }
  return actions;
}

function usageFor(
  events: readonly MetricEvent[],
  unitId: string,
  startTurn: number,
  endTurn: number,
  agent: "task" | "general" | "revision" | "document",
): {
  input: number;
  output: number;
  reasoning: number;
  cached: number;
  context: number;
  toolCalls: number;
} {
  let input = 0;
  let output = 0;
  let reasoning = 0;
  let cached = 0;
  let context = 0;
  let toolCalls = 0;
  for (const event of events) {
    if (event.type === "session" || event.unitId !== unitId) continue;
    if (event.type === "model_call" && event.agent === agent) {
      if (event.turn < startTurn || event.turn > endTurn) continue;
      input += event.usage?.inputTokens ?? 0;
      output += event.usage?.outputTokens ?? 0;
      reasoning += event.usage?.reasoningTokens ?? 0;
      cached += event.usage?.cachedInputTokens ?? 0;
      if (event.usage?.inputTokens !== undefined) context = event.usage.inputTokens;
    } else if (event.type === "tool_call" && event.agent === agent) {
      if (event.turn < startTurn || event.turn > endTurn) continue;
      if (event.tool === "stop" || event.tool === "decline" || event.tool.startsWith("state:")) {
        continue;
      }
      toolCalls += 1;
    }
  }
  return { input, output, reasoning, cached, context, toolCalls };
}

function turnDetailsFor(
  events: readonly MetricEvent[],
  unitId: string,
  agent: "task" | "general" | "revision" | "document",
  startTurn: number,
  endTurn: number,
): TaskTurn[] {
  const byTurn = new Map<number, TaskTurn>();
  for (const event of events) {
    if (event.type !== "model_call" || event.agent !== agent || event.unitId !== unitId) continue;
    if (event.turn < startTurn || event.turn > endTurn) continue;
    const entry = byTurn.get(event.turn) ?? {
      turn: event.turn,
      tokensIn: 0,
      tokensOut: 0,
      durationMs: 0,
    };
    entry.tokensIn += event.usage?.inputTokens ?? 0;
    entry.tokensOut += event.usage?.outputTokens ?? 0;
    entry.durationMs += Math.max(0, event.endedAt - event.startedAt);
    byTurn.set(event.turn, entry);
  }
  const out: TaskTurn[] = [];
  for (let turn = startTurn; turn <= endTurn; turn += 1) {
    out.push(byTurn.get(turn) ?? { turn, tokensIn: 0, tokensOut: 0, durationMs: 0 });
  }
  return out;
}

function outcomeOf(state: State, task: Unit): string {
  const move = currentMove(state);
  if (move === undefined) {
    // A request-anchored unit (general has no `move`): its closure is the request's `stop`.
    const root = state.rootId;
    const stopId = root !== undefined ? stopOf(state, root) : undefined;
    if (stopId === undefined) return "no state";
    const why = state.nodes.get(stopId)?.label;
    return why !== undefined && why !== "" ? why : "closed";
  }
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
  const rawIds = moveIds(state);
  const rootId = state.rootId;
  // General has no `move`: its tape hangs off the request. Render that one tape as the unit's
  // single state so the panel keeps its turns and token totals.
  const requestAnchored =
    rawIds.length === 0 &&
    (unit.type === "general" || unit.type === "revision" || unit.type === "document") &&
    rootId !== undefined &&
    (turnsOf(state, rootId) !== undefined || stopOf(state, rootId) !== undefined);
  const ids = requestAnchored && rootId !== undefined ? [rootId] : rawIds;
  const states: TaskState[] = ids.map((id, index) => {
    const payload =
      requestAnchored && id === rootId
        ? { state: unit.type, what: requestText(unit.journal), turn: 0 }
        : movePayload(state, id);
    const start = payload.turn ?? 0;
    const next = ids[index + 1];
    const nextStart = next !== undefined ? (movePayload(state, next).turn ?? start + 1) : undefined;
    const end = nextStart !== undefined ? Math.max(start, nextStart - 1) : Math.max(start, unit.turn - 1);
    const usage = usageFor(
      telemetry,
      unit.id,
      start,
      end,
      unit.type === "revision"
        ? "revision"
        : unit.type === "general"
          ? "general"
          : unit.type === "document"
            ? "document"
            : "task",
    );
    const turnDetails = turnDetailsFor(
      telemetry,
      unit.id,
      unit.type === "revision"
        ? "revision"
        : unit.type === "general"
          ? "general"
          : unit.type === "document"
            ? "document"
            : "task",
      start,
      end,
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
      cachedInputTokens: usage.cached,
      contextTokens: usage.context,
      toolCalls: usage.toolCalls,
      durationMs: turnDetails.reduce((sum, turn) => sum + turn.durationMs, 0),
      turnDetails,
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
  const cachedInputTokens = states.reduce((sum, item) => sum + item.cachedInputTokens, 0);
  const contextTokens =
    [...states].reverse().find((item) => item.contextTokens > 0)?.contextTokens ?? 0;
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
    cachedInputTokens,
    contextTokens,
    toolCalls,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
  };
}

function buildPlanView(
  session: SessionState,
  requestedUnitId: string | undefined,
  timings: Map<string, TaskTiming>,
  now: number,
): PlanView | undefined {
  const unitId = requestedUnitId ?? activePlanUnitId(session);
  if (unitId === undefined) return undefined;
  const unit = session.units.get(unitId);
  if (unit === undefined || unit.type !== "plan") return undefined;
  const timing = timings.get(unitId);
  const elapsedMs =
    timing?.startedAt !== undefined && timing.endedAt === undefined
      ? Math.max(0, now - timing.startedAt)
      : undefined;
  const progressOf = (): { turns: number; elapsedMs?: number } => ({
    turns: unit.turn,
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
  });
  const plan = planOfSession(session, unitId);
  if (plan === undefined) {
    // The planner unit is open but has not submitted a plan yet.
    return {
      unitId,
      status: "building",
      completed: 0,
      total: 0,
      items: [],
      ...progressOf(),
    };
  }
  const finished = planFinished(session, unitId);
  const executing = planModeOf(session) === unitId;
  const progress = planProgress(session, plan);
  const activeItemId = blockedItem(session, plan)?.item.id ?? nextPendingItem(session, plan)?.id;
  const status: PlanViewStatus =
    finished !== undefined ? finished.status : executing ? "executing" : "ready";
  return {
    unitId,
    ...(plan.summary !== undefined ? { summary: plan.summary } : {}),
    status,
    completed: progress.completed,
    total: progress.total,
    items: progress.items.map(({ item, status: itemStatus }) => ({
      id: item.id,
      order: item.order,
      title: item.title,
      status: itemStatus,
      ...(item.done !== undefined ? { done: item.done } : {}),
    })),
    ...(activeItemId !== undefined ? { activeItemId } : {}),
    ...progressOf(),
  };
}

// A plan unit that is still being built: open, not completed, and without a submitted plan.
function activePlanUnitId(session: SessionState): string | undefined {
  for (const unit of unitsInOrder(session)) {
    if (unit.type === "plan" && attentionOf(session, unit.id) === "active") return unit.id;
  }
  return undefined;
}

export function buildTuiView(
  session: SessionState,
  telemetry: readonly MetricEvent[],
  options: ViewOptions = {},
): TuiView {
  const now = options.now ?? Date.now();
  const timings = options.timings ?? new Map<string, TaskTiming>();
  const tasks = unitsInOrder(session).filter(
    (unit) =>
      unit.type === "task" ||
      unit.type === "general" ||
      unit.type === "revision" ||
      unit.type === "document",
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

  const plan = buildPlanView(session, options.planUnitId, timings, now);
  let currentId = options.currentUnitId;
  if (currentId === undefined) {
    const planOwnsFocus = plan?.status === "ready" || plan?.status === "building";
    if (plan?.status === "executing" && plan.activeItemId !== undefined) {
      const activeUnit = unitOfPlanItem(session, plan.activeItemId);
      if (activeUnit !== undefined && byTask.has(activeUnit.id)) currentId = activeUnit.id;
    }
    if (currentId === undefined && !planOwnsFocus) {
      const top = session.stack.at(-1)?.unitId;
      currentId = top !== undefined && byTask.has(top) ? top : tasks.at(-1)?.id;
    }
  }

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
    reasoningTokens: usage.reasoningTokens,
    cachedInputTokens: usage.cachedInputTokens,
  };

  return {
    header,
    ...(currentId !== undefined && byTask.has(currentId)
      ? { current: byTask.get(currentId) }
      : {}),
    history,
    totalsByTask: byTask,
    ...(plan !== undefined ? { plan } : {}),
  };
}

export function requestOf(unit: Unit): string {
  return requestText(unit.journal);
}
