import { goalOf, unactionableOf, type State } from "../ir/graph";
import { currentGoalId, firstUnfulfilledItem } from "../ir/traversal";
import type { Proposal } from "../llm/schemas";

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
// an outputRef; an action/goal/etc. has none, so `recall`/`search` of it finds no body.
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

// The gate for the doxa's structural moves (create_goal / stop / decline): if such a move is
// inadmissible in the current context it is refused — the reason is returned and no node is
// created (docs/ir_revision.md §4). A command (`apply`) is never refused here: its
// non-execution (a repeat, a stale base, a forbidden path, an empty command) is recorded by
// the engine as an observation with a reason (docs/ir_revision.md §3.3, §4).
export function classify(
  proposal: Proposal,
  state: State,
  held: readonly string[] = [],
  queried: readonly string[] = [],
): Classification {
  const action = proposal.action;
  const current = currentGoalId(state);
  const node = current !== undefined ? state.nodes.get(current) : undefined;

  if (action.operator === "stop") {
    // The doxa's terminal move. On a goal it finishes the frame (the engine then returns to
    // the parent and continues); the request has no `stop` — it ends when its goal is
    // stopped (docs/ir_revision.md §3.4).
    if (node?.kind !== "goal") {
      return reject("not_addressed: stop applies to a goal; the request ends when its goal is stopped");
    }
    return accept;
  }

  if (action.operator === "decline") {
    // Decline to formulate a goal: only at a fresh request (no goal, not already declined).
    if (node?.kind !== "request") {
      return reject("not_request: decline formulates no goal, so it applies only at the request");
    }
    if (goalOf(state, current as string) !== undefined) {
      return reject(
        "interpreted: the request already has an interpretation; work it or stop instead of declining",
      );
    }
    if (unactionableOf(state, current as string) !== undefined) {
      return reject("repeated_action: the request is already declined");
    }
    return accept;
  }

  if (action.operator === "recall") {
    // A windowed recall reads a different fragment of the body: new content, not a redundant
    // re-fetch (§4.5). Only a bare recall of an id already in view is refused.
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

  if (action.operator === "create_goal") {
    if (action.what.trim() === "") return reject("empty_what");
    if (action.command.trim() === "") return reject("empty_command");
    if (current === undefined) return reject("no_current_goal");
    // The interpretation is fixed: a request accepts one goal, created once.
    if (node?.kind === "request" && goalOf(state, current) !== undefined) {
      return reject(
        "interpreted: the request already has an interpretation; work it or stop instead of interpreting it again",
      );
    }
    // Decomposing an open goal needs a current plan item to replace (docs/ir_revision.md §3.2).
    if (node?.kind === "goal" && firstUnfulfilledItem(state, current) === undefined) {
      return reject("no_current_item: the plan is already fulfilled; apply an action to add the next item");
    }
    return accept;
  }

  // apply: always accepted here; a command problem becomes an observation in the engine.
  return accept;
}
