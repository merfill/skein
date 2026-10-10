import type { Event } from "./events";
import {
  actionExecuted,
  actionSucceeded,
  childrenOf,
  goalOf,
  hasStopped,
  lastChild,
  planOf,
  unactionableOf,
  type State,
} from "./graph";
import type { GoalPayload } from "./types";

export function stackOf(state: State): string[] {
  return [...state.branch];
}

export function currentGoalId(state: State): string | undefined {
  return state.branch[state.branch.length - 1] ?? state.rootId;
}

// A frame the engine must return out of: a goal or request the doxa has stopped
// (`has_stopped`), or an executed action. The criterion verdict does NOT close anything —
// the doxa declares the arm done with `stop` (docs/plans/stop_closure_plan.md §2).
export function isFinished(state: State, id: string): boolean {
  const node = state.nodes.get(id);
  if (node?.kind === "action") return actionExecuted(state, id);
  return hasStopped(state, id);
}

// An item is fulfilled when its current (last) alternative is: an executed action or a
// stopped goal. The item itself is a container of alternatives; the last one is current
// (docs/ir_revision.md §2.3).
export function itemFulfilled(state: State, itemId: string): boolean {
  const current = lastChild(state, itemId);
  if (current === undefined) return false;
  const option = state.nodes.get(current);
  if (option?.kind === "action") return actionSucceeded(state, current);
  if (option?.kind === "goal") return isFinished(state, current);
  return false;
}

export function cursorOf(state: State, goalId: string): number | undefined {
  const plan = planOf(state, goalId);
  if (plan === undefined) return undefined;
  const items = childrenOf(state, plan);
  const index = items.findIndex((id) => !itemFulfilled(state, id));
  return index === -1 ? items.length : index;
}

export function firstUnfulfilledItem(state: State, goalId: string): string | undefined {
  const plan = planOf(state, goalId);
  if (plan === undefined) return undefined;
  return childrenOf(state, plan).find((id) => !itemFulfilled(state, id));
}

// No unfulfilled plan item: the doxa has carried out its whole plan. The give-up branch
// of the `stop` gate (docs/plans/stop_closure_plan.md §2): a goal may be stopped without
// a passing criterion only once its plan is exhausted.
export function planExhausted(state: State, goalId: string): boolean {
  return firstUnfulfilledItem(state, goalId) === undefined;
}

export function goalPayload(state: State, id: string): GoalPayload | undefined {
  const node = state.nodes.get(id);
  if (node === undefined || node.kind !== "goal") return undefined;
  return node.payload as GoalPayload | undefined;
}

// Deterministic logos moves that bring the stack to the current node: descend
// into the request's goal or the first unfulfilled subgoal, or return
// once the current goal closes.
export function focusEvents(state: State): Event[] {
  const out: Event[] = [];
  const rootId = state.rootId;
  if (rootId === undefined) return out;
  const branch = state.branch.length > 0 ? [...state.branch] : [rootId];

  for (;;) {
    const current = branch[branch.length - 1];
    if (current === undefined) break;
    const node = state.nodes.get(current);

    if (node?.kind === "request") {
      const goal = goalOf(state, current);
      if (goal !== undefined && goal !== current) {
        // A finished goal is not descended into: the request stays the focus and the doxa
        // may stop it.
        if (isFinished(state, goal)) break;
        out.push({ type: "descend", node: goal });
        branch.push(goal);
        continue;
      }
      break;
    }

    // Invariant 17 extends to the subtree: if the top is still open but an ancestor
    // above the request root has closed, return out of it (the branch is trimmed under a
    // closed ancestor, not only when the top itself closes).
    if (
      branch.length > 1 &&
      branch.slice(0, -1).some((id) => id !== rootId && isFinished(state, id))
    ) {
      out.push({ type: "return" });
      branch.pop();
      continue;
    }

    if (isFinished(state, current) && branch.length > 1) {
      out.push({ type: "return" });
      branch.pop();
      continue;
    }
    if (isFinished(state, current)) break;
    const first = firstUnfulfilledItem(state, current);
    if (first === undefined) break;
    // Descend into the current item's alternative when it is an open sub-goal.
    const altId = lastChild(state, first);
    if (altId !== undefined && altId !== current) {
      const altNode = state.nodes.get(altId);
      if (altNode?.kind === "goal") {
        out.push({ type: "descend", node: altId });
        branch.push(altId);
        continue;
      }
    }
    break;
  }
  return out;
}

export interface Applicable {
  goalId?: string;
  createGoal: boolean;
  apply: boolean;
  return: boolean;
  stop: boolean;
  // Decline to formulate a goal (a non-actionable request); only at the request.
  decline: boolean;
}

// The frontier: the moves admissible at the focus. One computation feeds both the
// projection and `classify`, so the two cannot drift (docs/ir_semantics.md §2.6).
// `return` is an engine-internal move, never a doxa operator.
export function applicable(state: State, goalId: string | undefined): Applicable {
  const none: Applicable = {
    createGoal: false,
    apply: false,
    return: false,
    stop: false,
    decline: false,
  };
  if (goalId === undefined) return none;

  const node = state.nodes.get(goalId);
  if (node?.kind === "request") {
    // There is no `stop` on the request: it ends when its goal is stopped (derived). A
    // fresh request may be interpreted or declined; once it has a goal, the goal is the
    // focus (create_goal/decline only before that).
    const goal = goalOf(state, goalId);
    const declined = unactionableOf(state, goalId) !== undefined;
    return {
      ...none,
      goalId,
      createGoal: goal === undefined && !declined,
      decline: goal === undefined && !declined,
    };
  }

  if (isFinished(state, goalId)) return { ...none, goalId, return: true };

  // An open goal: a command (a new plan item or a branched one) or a sub-goal is always
  // available; `stop` closes it — there is no criterion gate.
  return { goalId, createGoal: true, apply: true, return: false, stop: true, decline: false };
}
