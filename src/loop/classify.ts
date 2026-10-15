import { currentFocus, hasStopped, unactionableOf, type State } from "../ir/graph";
import { ISLANDS, isIsland, isTerminalIsland } from "../ir/islands";
import { currentMove, isMoveFinished, moveIsland } from "../ir/traversal";
import { nativeToolName } from "../llm/tools";
import type { Action } from "../llm/schemas";

export interface Classification {
  accept: boolean;
  reason?: string;
  constraintId?: string;
}

function reject(reason: string, constraintId?: string): Classification {
  return {
    accept: false,
    reason,
    ...(constraintId !== undefined ? { constraintId } : {}),
  };
}

const accept: Classification = { accept: true };

// The gate for the doxa's structural moves (move / stop / decline): if such a move is
// inadmissible in the current context it is refused — the reason is returned and no node is
// created (docs/ir_semantics.md §2.6–2.7). A command (`apply`) is normally a non-execution
// observation in the engine (a repeat, a stale base, a forbidden path); only `apply` outside
// an open state is a protocol error refused here.
export function classify(action: Action, state: State): Classification {
  const current = currentFocus(state);
  const node = current !== undefined ? state.nodes.get(current) : undefined;

  if (action.operator === "move") {
    if (!isIsland(action.state)) return reject("empty_state: move needs a state");
    // The state's goal text is required (`what`), except for the terminal Finish state, which
    // has no plan and is closed directly (docs/plans/archive/goal_into_move_plan.md).
    if (!isTerminalIsland(action.state) && action.what.trim() === "") {
      return reject("empty_what: name the state's goal in `what`");
    }
    // The state's stop criterion is required too (except for the terminal Finish, which is closed
    // directly): the state must know when it is done (docs/ir_semantics.md §4.1).
    if (!isTerminalIsland(action.state) && (action.done ?? "").trim() === "") {
      return reject("empty_done: name the state's stop criterion in `done`");
    }
    if (node?.kind === "request") {
      if (unactionableOf(state, current as string) !== undefined) {
        return reject("interpreted: the request is already declined");
      }
      return accept;
    }
    // A move is legal at a finished state (the transition); otherwise the state is still open.
    if (node?.kind === "move" && isMoveFinished(state, current as string)) return accept;
    return reject("state_open: finish the current state (stop) before moving to the next one");
  }

  if (action.operator === "decline") {
    // Decline to formulate a state: only at a fresh request (no move, not already declined).
    if (node?.kind !== "request") {
      return reject("not_request: decline formulates no state, so it applies only at the request");
    }
    if (currentMove(state) !== undefined) {
      return reject("interpreted: the request has already started; work it or stop instead");
    }
    if (unactionableOf(state, current as string) !== undefined) {
      return reject("repeated_action: the request is already declined");
    }
    return accept;
  }

  if (action.operator === "recall" || action.operator === "search") {
    // Recall/search read a stored body into the state's tape; they are work of an open state
    // (a closed state's turns are elided, and a fresh request has nothing stored yet).
    if (node?.kind === "move" && !hasStopped(state, current as string)) return accept;
    return reject("no_state: recall/search read stored results — they belong to an open state");
  }

  if (action.operator === "stop") {
    // The doxa's closure. On an open state it finishes it; on the terminal state it ends the
    // request. There is no `stop` on the request (docs/ir_semantics.md §4.4).
    if (node?.kind === "move" && !hasStopped(state, current as string)) return accept;
    return reject("not_addressed: stop applies to an open state or the terminal state");
  }

  if (action.operator === "apply") {
    // A command runs only inside an open state; elsewhere it is a protocol error.
    if (node?.kind === "move" && !hasStopped(state, current as string)) {
      // The state's island delimits the action surface: a tool that does not belong to the
      // state's work is refused (the model surface already omits it — this is the guard).
      const island = moveIsland(state, current as string);
      if (island !== undefined) {
        const tool = nativeToolName(action.action.tool);
        if (!ISLANDS[island].applies.includes(tool)) {
          return reject(
            `not_in_state: ${tool} is not admissible in ${ISLANDS[island].label}; ` +
              "stop it and move to the state that owns that work",
          );
        }
      }
      return accept;
    }
    return reject("no_state: there is no open state to work; move to a state first");
  }

  return accept;
}
