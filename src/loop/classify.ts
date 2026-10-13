import { currentFocus, hasStopped, unactionableOf, type State } from "../ir/graph";
import { isIsland, isTerminalIsland } from "../ir/islands";
import { currentMove, isMoveFinished } from "../ir/traversal";
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

// A node has a retrievable body if it is a result (observation) or carries inline output /
// an outputRef; an action/etc. has none, so `recall`/`search` of it finds no body.
function hasBody(state: State, id: string): boolean {
  const node = state.nodes.get(id);
  if (node === undefined) return false;
  if (node.kind === "observation") return true;
  const payload = node.payload as
    | { output?: unknown; outputRef?: unknown; error?: unknown; errorRef?: unknown }
    | undefined;
  return (
    typeof payload?.output === "string" ||
    typeof payload?.outputRef === "string" ||
    typeof payload?.error === "string" ||
    typeof payload?.errorRef === "string"
  );
}

// The gate for the doxa's structural moves (move / stop / decline): if such a move is
// inadmissible in the current context it is refused — the reason is returned and no node is
// created (docs/ir_semantics.md §2.6–2.7). A command (`apply`) is normally a non-execution
// observation in the engine (a repeat, a stale base, a forbidden path); only `apply` outside
// an open state is a protocol error refused here.
export function classify(
  action: Action,
  state: State,
  held: readonly string[] = [],
  queried: readonly string[] = [],
): Classification {
  const current = currentFocus(state);
  const node = current !== undefined ? state.nodes.get(current) : undefined;

  if (action.operator === "move") {
    if (!isIsland(action.state)) return reject("empty_state: move needs a state");
    // The state's goal text is required (`what`), except for the terminal hand-off, which has
    // no plan and is closed directly (docs/plans/goal_into_move_plan.md).
    if (!isTerminalIsland(action.state) && action.what.trim() === "") {
      return reject("empty_what: name the state's goal in `what`");
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

  if (action.operator === "recall") {
    // A windowed recall reads a different fragment of the body: new content, not a redundant
    // re-fetch (§4.6). Only a bare recall of an id already in view is refused.
    const windowed = action.start !== undefined || action.end !== undefined;
    if (held.includes(action.id) && !windowed) {
      return reject(
        `repeated_action: ${action.id} was just recalled; use that result (no need to recall it again)`,
      );
    }
    if (!hasBody(state, action.id) && queried.includes(action.id)) {
      return reject(`repeated_action: ${action.id} was already recalled; do not recall it again`);
    }
    return accept;
  }

  if (action.operator === "search") {
    // A pattern search reads a different fragment of the body: always new content.
    return accept;
  }

  if (action.operator === "stop") {
    // The doxa's closure. On an open state it finishes it; on the terminal state it ends the
    // request. There is no `stop` on the request (docs/ir_semantics.md §4.4).
    if (node?.kind === "move" && !hasStopped(state, current as string)) return accept;
    return reject("not_addressed: stop applies to an open state or the terminal state");
  }

  if (action.operator === "apply") {
    // A command runs only inside an open state; elsewhere it is a protocol error.
    if (node?.kind === "move" && !hasStopped(state, current as string)) return accept;
    return reject("no_state: there is no open state to work; move to a state first");
  }

  return accept;
}
