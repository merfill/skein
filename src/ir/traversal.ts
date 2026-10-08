import type { Event } from "./events";
import {
  alternativesOf,
  childrenOf,
  latestChosen,
  planOf,
  predicateOf,
  type State,
} from "./graph";
import type { GoalPayload } from "./types";

export function stackOf(state: State): string[] {
  return [...state.branch];
}

export function currentGoalId(state: State): string | undefined {
  return state.branch[state.branch.length - 1] ?? state.rootId;
}

export function isClosedPredicate(state: State, id: string): boolean {
  const predicate = predicateOf(state, id);
  return (
    predicate === "achieved" ||
    predicate === "achieved_under" ||
    predicate === "refuted" ||
    predicate === "abandoned"
  );
}

function isSettledSuccess(predicate: string): boolean {
  return predicate === "achieved" || predicate === "achieved_under";
}

// An item is resolved when it is itself done, or when it owns an alternatives
// container with a chosen option that is done. The engine branches a stale item by
// adding an alternative (append-only), so a failed or bypassed attempt never blocks
// the plan (docs/context_design_ru.md).
export function itemFulfilled(state: State, itemId: string): boolean {
  const node = state.nodes.get(itemId);
  if (node === undefined) return false;
  const selfDone =
    node.kind === "action"
      ? predicateOf(state, itemId) === "executed"
      : node.kind === "goal"
        ? isClosedPredicate(state, itemId)
        : false;
  if (selfDone) return true;

  const alt = alternativesOf(state, itemId);
  if (alt === undefined) return false;
  const chosen = latestChosen(state, alt);
  if (chosen === undefined || chosen === itemId) return false;
  const option = state.nodes.get(chosen);
  if (option?.kind === "action") return predicateOf(state, chosen) === "executed";
  if (option?.kind === "goal") return isClosedPredicate(state, chosen);
  return false;
}

// Like `itemFulfilled`, but only a SUCCESSFUL resolution counts: a refuted/abandoned
// item resolves the cursor, yet the goal is not achieved, so the plan may still grow.
export function itemSucceeded(state: State, itemId: string): boolean {
  const node = state.nodes.get(itemId);
  if (node === undefined) return false;
  const selfDone =
    node.kind === "action"
      ? predicateOf(state, itemId) === "executed"
      : node.kind === "goal"
        ? isSettledSuccess(predicateOf(state, itemId))
        : false;
  if (selfDone) return true;

  const alt = alternativesOf(state, itemId);
  if (alt === undefined) return false;
  const chosen = latestChosen(state, alt);
  if (chosen === undefined || chosen === itemId) return false;
  const option = state.nodes.get(chosen);
  if (option?.kind === "action") return predicateOf(state, chosen) === "executed";
  if (option?.kind === "goal") return isSettledSuccess(predicateOf(state, chosen));
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

export function goalPayload(state: State, id: string): GoalPayload | undefined {
  const node = state.nodes.get(id);
  if (node === undefined || node.kind !== "goal") return undefined;
  return node.payload as GoalPayload | undefined;
}

export function chosenInterpretation(state: State, requestId: string): string | undefined {
  const alt = alternativesOf(state, requestId);
  return alt === undefined ? undefined : latestChosen(state, alt);
}

// Deterministic logos moves that bring the stack to the current node: descend
// into the chosen interpretation or the first unfulfilled subgoal, or return
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
      const chosen = chosenInterpretation(state, current);
      if (chosen !== undefined && chosen !== current) {
        const predicate = predicateOf(state, chosen);
        if (isSettledSuccess(predicate) || predicate === "refuted" || predicate === "abandoned") {
          break;
        }
        out.push({ type: "descend", node: chosen });
        branch.push(chosen);
        continue;
      }
      break;
    }

    // Invariant 17 extends to the subtree: if the top is still open but an ancestor
    // above the request root has closed, return out of it (the branch is trimmed under a
    // closed ancestor, not only when the top itself closes).
    if (
      branch.length > 1 &&
      branch.slice(0, -1).some((id) => id !== rootId && isClosedPredicate(state, id))
    ) {
      out.push({ type: "return" });
      branch.pop();
      continue;
    }

    if (isClosedPredicate(state, current) && branch.length > 1) {
      out.push({ type: "return" });
      branch.pop();
      continue;
    }
    if (isClosedPredicate(state, current)) break;
    const first = firstUnfulfilledItem(state, current);
    if (first === undefined) break;
    const firstNode = state.nodes.get(first);
    if (firstNode?.kind === "goal" && first !== current) {
      out.push({ type: "descend", node: first });
      branch.push(first);
      continue;
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
  nextAction?: string;
  checkReady: boolean;
}

// The frontier: the moves admissible at the focus. One computation feeds both the
// projection and `classify`, so the two cannot drift (docs/ir_semantics.md §2.6). The
// doxa is handed the whole arm; `nextAction` is only informational. `return` is an
// engine-internal move, never a doxa operator.
export function applicable(state: State, goalId: string | undefined): Applicable {
  const none: Applicable = {
    createGoal: false,
    apply: false,
    return: false,
    stop: false,
    checkReady: false,
  };
  if (goalId === undefined) return none;

  const node = state.nodes.get(goalId);
  if (node?.kind === "request") {
    // An addressed request accepts only the doxa's `stop`; an open one is interpreted.
    const addressed = predicateOf(state, goalId) === "addressed";
    return addressed
      ? { ...none, goalId, stop: true }
      : { ...none, goalId, createGoal: true };
  }

  const predicate = predicateOf(state, goalId);

  // A refuted goal is revised by a variant (create_goal with revises).
  if (predicate === "refuted") {
    return { ...none, goalId, createGoal: true };
  }

  const closed =
    predicate === "achieved" || predicate === "achieved_under" || predicate === "abandoned";
  if (closed) return { ...none, goalId, return: true };

  const plan = planOf(state, goalId);
  const items = plan === undefined ? [] : childrenOf(state, plan);
  const cursor = cursorOf(state, goalId);
  const done = cursor === undefined || items.length === 0 || cursor >= items.length;
  const payload = goalPayload(state, goalId);
  const objective = payload?.done_when.kind === "objective";
  const first = firstUnfulfilledItem(state, goalId);
  const nextNode = first !== undefined ? state.nodes.get(first) : undefined;
  const nextAction = nextNode?.kind === "action" ? first : undefined;
  const checkReady = done && objective && items.length > 0;

  return {
    goalId,
    // Decompose the current step: only with an unfulfilled action step (I6).
    createGoal: nextAction !== undefined,
    // Any open goal: a command may be executed now (continue or alternative).
    apply: true,
    return: false,
    stop: false,
    ...(nextAction !== undefined ? { nextAction } : {}),
    checkReady,
  };
}
