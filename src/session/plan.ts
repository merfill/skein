import { fold, type State } from "../ir/graph";
import type { PlanItemKind, PlanItemPayload, PlanPayload } from "../ir/types";
import { attentionOf, unitsInOrder } from "./session";
import type { SessionState, Unit } from "./types";

// The execution plan is a session-level artifact built by the `plan` unit: a `plan` header and
// its ordered `plan_item` nodes. Everything here is derived from the journals; the plan is not
// rewritten, and a rework adds a new plan unit instead.

export interface PlanItemData {
  id: string;
  title: string;
  detail: string;
  kind: PlanItemKind;
  done?: string;
  order: number;
}

export interface PlanData {
  planUnitId: string;
  planId: string;
  summary?: string;
  items: PlanItemData[];
}

export type PlanItemStatus = "pending" | "active" | "suspended" | "completed" | "abandoned";

function planNodeOf(state: State): string | undefined {
  let best: { seq: number; id: string } | undefined;
  for (const node of state.nodes.values()) {
    if (node.kind !== "plan") continue;
    if (best === undefined || node.seq > best.seq) best = { seq: node.seq, id: node.id };
  }
  return best?.id;
}

function itemsOf(state: State, planId: string): PlanItemData[] {
  const items: { seq: number; item: PlanItemData }[] = [];
  for (const edge of state.edges.values()) {
    if (edge.kind !== "plan_item" || edge.from !== planId) continue;
    const node = state.nodes.get(edge.to);
    if (node === undefined || node.kind !== "plan_item") continue;
    const payload = node.payload as Partial<PlanItemPayload> | undefined;
    const title = typeof payload?.title === "string" ? payload.title : node.label;
    const detail = typeof payload?.detail === "string" ? payload.detail : "";
    const kind: PlanItemKind = payload?.kind === "general" ? "general" : "task";
    const order = typeof payload?.order === "number" ? payload.order : items.length + 1;
    items.push({
      seq: node.seq,
      item: {
        id: node.id,
        title,
        detail,
        kind,
        ...(typeof payload?.done === "string" && payload.done !== "" ? { done: payload.done } : {}),
        order,
      },
    });
  }
  items.sort((left, right) => left.item.order - right.item.order || left.seq - right.seq);
  return items.map((entry) => entry.item);
}

// The plan a unit's journal holds, if it is a plan unit that submitted a plan.
export function planOfUnit(unit: Unit): PlanData | undefined {
  if (unit.type !== "plan") return undefined;
  const state = fold(unit.journal);
  const planId = planNodeOf(state);
  if (planId === undefined) return undefined;
  const node = state.nodes.get(planId);
  const payload = node?.payload as Partial<PlanPayload> | undefined;
  const summary =
    typeof payload?.summary === "string" && payload.summary !== "" ? payload.summary : undefined;
  return {
    planUnitId: unit.id,
    planId,
    ...(summary !== undefined ? { summary } : {}),
    items: itemsOf(state, planId),
  };
}

export function planOfSession(session: SessionState, planUnitId: string): PlanData | undefined {
  const unit = session.units.get(planUnitId);
  return unit !== undefined ? planOfUnit(unit) : undefined;
}

// Newest plan first: a rework opens a new plan unit and supersedes the older one.
export function plansInOrder(session: SessionState): PlanData[] {
  const plans: PlanData[] = [];
  for (const unit of unitsInOrder(session)) {
    if (unit.type !== "plan") continue;
    const plan = planOfUnit(unit);
    if (plan !== undefined) plans.push(plan);
  }
  return plans;
}

export function latestPlan(session: SessionState): PlanData | undefined {
  return plansInOrder(session).at(-1);
}

// The plan execution mode: the newest `plan_started` with no matching `plan_finished`.
export function planModeOf(session: SessionState): string | undefined {
  const started = new Map<string, number>();
  const finished = new Set<string>();
  for (const event of session.journal) {
    if (event.type === "plan_started") {
      started.set(event.planUnitId, event.turn);
    } else if (event.type === "plan_finished") {
      finished.add(event.planUnitId);
    }
  }
  let best: { planUnitId: string; seq: number } | undefined;
  for (const [planUnitId, seq] of started) {
    if (finished.has(planUnitId)) continue;
    if (best === undefined || seq >= best.seq) best = { planUnitId, seq };
  }
  return best?.planUnitId;
}

export function planFinished(
  session: SessionState,
  planUnitId: string,
): { status: "done" | "aborted"; completed: number; total: number } | undefined {
  for (let index = session.journal.length - 1; index >= 0; index -= 1) {
    const event = session.journal[index];
    if (event?.type === "plan_finished" && event.planUnitId === planUnitId) {
      return { status: event.status, completed: event.completed, total: event.total };
    }
  }
  return undefined;
}

// The unit opened for a plan item, if any.
export function unitOfPlanItem(session: SessionState, itemId: string): Unit | undefined {
  for (const unit of session.units.values()) {
    if (unit.planItem === itemId) return unit;
  }
  return undefined;
}

export function planItemStatus(
  session: SessionState,
  itemId: string,
): PlanItemStatus {
  const unit = unitOfPlanItem(session, itemId);
  if (unit === undefined) return "pending";
  return attentionOf(session, unit.id);
}

export interface PlanProgress {
  completed: number;
  total: number;
  items: { item: PlanItemData; status: PlanItemStatus }[];
}

export function planProgress(session: SessionState, plan: PlanData): PlanProgress {
  const items = plan.items.map((item) => ({ item, status: planItemStatus(session, item.id) }));
  return {
    completed: items.filter((entry) => entry.status === "completed").length,
    total: items.length,
    items,
  };
}

// The next item the engine may open: the first with no unit yet. An item whose unit is
// active/suspended (a pause) or abandoned is not "next" — the caller resolves that state
// instead of skipping it.
export function nextPendingItem(session: SessionState, plan: PlanData): PlanItemData | undefined {
  return plan.items.find((item) => planItemStatus(session, item.id) === "pending");
}

// An item that is not pending and not completed: the plan cannot advance by opening the next
// item until it is resolved.
export function blockedItem(
  session: SessionState,
  plan: PlanData,
): { item: PlanItemData; status: PlanItemStatus } | undefined {
  for (const item of plan.items) {
    const status = planItemStatus(session, item.id);
    if (status === "active" || status === "suspended" || status === "abandoned") {
      return { item, status };
    }
    if (status === "pending") return undefined;
  }
  return undefined;
}

// The active plan's rendered state, when the session is in plan execution mode. Used by the
// session agent's ordinary turns too, so a message during execution still sees the plan.
export function activePlanState(session: SessionState): string | undefined {
  const planUnitId = planModeOf(session);
  if (planUnitId === undefined) return undefined;
  const plan = planOfSession(session, planUnitId);
  return plan !== undefined ? renderPlanState(session, plan) : undefined;
}

// The plan as the session agent reads it during execution: item statuses and the current one.
export function renderPlanState(session: SessionState, plan: PlanData): string {
  const progress = planProgress(session, plan);
  const blocked = blockedItem(session, plan);
  const lines = [`Execution plan (unit ${plan.planUnitId}) ${progress.completed}/${progress.total} done:`];
  for (const { item, status } of progress.items) {
    const marker =
      status === "completed"
        ? "x"
        : status === "active" || status === "suspended"
          ? ">"
          : status === "abandoned"
            ? "!"
            : " ";
    const kind = item.kind === "general" ? "general" : "coding";
    lines.push(`[${marker}] ${item.order}. ${item.title} (${kind}, ${status})`);
    if (item.detail !== "") lines.push(`      ${item.detail}`);
    if (item.done !== undefined) lines.push(`      Done when: ${item.done}`);
  }
  if (blocked !== undefined) {
    lines.push(
      `Current item ${blocked.item.order} is ${blocked.status}; resolve it before opening another.`,
    );
  } else {
    const next = nextPendingItem(session, plan);
    if (next !== undefined) {
      lines.push(`Next item: ${next.order}. ${next.title} (${next.kind}).`);
    }
  }
  return lines.join("\n");
}


