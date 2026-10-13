import type { Event } from "./events";
import {
  actionExecuted,
  actionSucceeded,
  childrenOf,
  hasStopped,
  lastChild,
  planOf,
  unactionableOf,
  type State,
} from "./graph";
import { isTerminalIsland, type IslandId } from "./islands";
import type { MovePayload } from "./types";

export function stackOf(state: State): string[] {
  return [...state.branch];
}

// The current state: the last `move` child of the request (`move` edges, in order).
export function currentMove(state: State): string | undefined {
  const root = state.rootId;
  if (root === undefined) return undefined;
  return lastChild(state, root);
}

// The island a `move` declares.
export function movePayload(state: State, id: string): MovePayload | undefined {
  const node = state.nodes.get(id);
  if (node === undefined || node.kind !== "move") return undefined;
  return node.payload as MovePayload | undefined;
}

export function moveIsland(state: State, id: string): IslandId | undefined {
  return movePayload(state, id)?.state;
}

// Is the state of this `move` finished? A state (including the terminal hand-off, which has
// no plan) is finished when it is stopped — the doxa's `stop` is the only closure
// (docs/ir_semantics.md §2.5).
export function isMoveFinished(state: State, id: string): boolean {
  return hasStopped(state, id);
}

// A frame the engine must return out of: a finished state or an executed action.
export function isFinished(state: State, id: string): boolean {
  const node = state.nodes.get(id);
  if (node?.kind === "action") return actionExecuted(state, id);
  if (node?.kind === "move") return isMoveFinished(state, id);
  return hasStopped(state, id);
}

// An item is fulfilled when its current (last) alternative is an executed, succeeded
// action. An item's alternatives are actions only (no sub-goal) (docs/ir_semantics.md §2.5).
export function itemFulfilled(state: State, itemId: string): boolean {
  const current = lastChild(state, itemId);
  if (current === undefined) return false;
  const option = state.nodes.get(current);
  if (option?.kind === "action") return actionSucceeded(state, current);
  return false;
}

export function cursorOf(state: State, moveId: string): number | undefined {
  const plan = planOf(state, moveId);
  if (plan === undefined) return undefined;
  const items = childrenOf(state, plan);
  const index = items.findIndex((id) => !itemFulfilled(state, id));
  return index === -1 ? items.length : index;
}

export function firstUnfulfilledItem(state: State, moveId: string): string | undefined {
  const plan = planOf(state, moveId);
  if (plan === undefined) return undefined;
  return childrenOf(state, plan).find((id) => !itemFulfilled(state, id));
}

export function planExhausted(state: State, moveId: string): boolean {
  return firstUnfulfilledItem(state, moveId) === undefined;
}

// The path from the root the focus should sit on: the request and its current state (`move`),
// while the state is still open; a finished state stays focused on the `move` so the doxa can
// make the transition (docs/ir_semantics.md §2.6). The states are flat children of the request.
function desiredPath(state: State): string[] {
  const root = state.rootId;
  if (root === undefined) return [];
  const path = [root];
  const move = currentMove(state);
  if (move === undefined) return path;
  path.push(move);
  return path;
}

// Deterministic logos moves that bring the stack to the focus: descend into the current
// state, or return out of a finished state. One computation feeds both the projection and
// `classify` (docs/ir_semantics.md §2.6).
export function focusEvents(state: State): Event[] {
  const root = state.rootId;
  if (root === undefined) return [];
  const branch = state.branch.length > 0 ? [...state.branch] : [root];
  const target = desiredPath(state);
  let common = 0;
  while (common < branch.length && common < target.length && branch[common] === target[common]) {
    common += 1;
  }
  const out: Event[] = [];
  for (let i = branch.length - 1; i >= common; i--) out.push({ type: "return" });
  for (let i = common; i < target.length; i++) out.push({ type: "descend", node: target[i] as string });
  return out;
}

export interface Applicable {
  // The focus the moves are relative to.
  focus?: string;
  // Declare the state to work in (a fresh request, or a finished state — the transition).
  move: boolean;
  // Work the open state: the first `apply` seeds the plan, later ones extend it.
  apply: boolean;
  return: boolean;
  stop: boolean;
  // Decline to formulate a state (a non-actionable request); only at the request.
  decline: boolean;
}

// The frontier: the moves admissible at the focus. One computation feeds both the
// projection (the model surface is bound from it) and `classify`, so the two cannot drift
// (docs/ir_semantics.md §2.6). `return` is an engine-internal move, never a doxa operator.
export function applicable(state: State, focusId: string | undefined): Applicable {
  const none: Applicable = {
    move: false,
    apply: false,
    return: false,
    stop: false,
    decline: false,
  };
  if (focusId === undefined) return none;

  const node = state.nodes.get(focusId);
  if (node?.kind === "request") {
    // There is no `stop` on the request: it ends when its terminal state is stopped
    // (derived). A fresh request chooses its first state or declines.
    const declined = unactionableOf(state, focusId) !== undefined;
    return { ...none, focus: focusId, move: !declined, decline: !declined };
  }

  if (node?.kind === "move") {
    if (isTerminalIsland(moveIsland(state, focusId) ?? "")) {
      // The terminal state: it accepts `stop` directly (no plan); once stopped the request
      // is finished and the run ends.
      return isMoveFinished(state, focusId)
        ? { ...none, focus: focusId, return: true }
        : { ...none, focus: focusId, stop: true };
    }
    if (isMoveFinished(state, focusId)) {
      // A finished state: the forced transition decision.
      return { ...none, focus: focusId, move: true };
    }
    // An open state: work it (the first `apply` seeds the plan) or stop it.
    return { ...none, focus: focusId, apply: true, stop: true };
  }

  return none;
}
