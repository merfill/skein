import { forbiddenConstraints, matchesPath } from "../ir/constraints";
import {
  actionExecuted,
  currentVersion,
  goalOf,
  unactionableOf,
  type State,
} from "../ir/graph";
import { currentGoalId } from "../ir/traversal";
import type { Proposal } from "../llm/schemas";
import { commandOf } from "../tools";

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

// How many times one unchanged file may be read before further reads are refused: a file
// read over and over with no edit in between is a thrash — its body is already addressable,
// so the doxa should act on it (a live run re-read one file's windows for 17 turns without
// editing). Any edit changes the version and resets the count, so a legitimate re-read
// after a change is unaffected.
const MAX_FILE_READS = 2;

function readsOf(state: State, ref: string): number {
  const version = currentVersion(state, ref);
  if (version === undefined) return 0;
  let count = 0;
  for (const node of state.nodes.values()) {
    if (node.kind !== "observation") continue;
    const payload = node.payload as { ref?: unknown; version?: unknown } | undefined;
    if (payload?.ref === ref && payload.version === version) count += 1;
  }
  return count;
}

function latestReadVersion(state: State, ref: string): string | undefined {
  let best: { seq: number; version: string } | undefined;
  for (const node of state.nodes.values()) {
    if (node.kind !== "observation") continue;
    const payload = node.payload as { ref?: unknown; version?: unknown } | undefined;
    if (payload?.ref !== ref || typeof payload.version !== "string") continue;
    if (best === undefined || node.seq > best.seq) best = { seq: node.seq, version: payload.version };
  }
  return best?.version;
}

function actionCommand(payload: unknown): string | undefined {
  const value = payload as { signature?: unknown; command?: unknown } | undefined;
  if (typeof value?.signature === "string") return value.signature;
  if (typeof value?.command === "string") return value.command;
  return undefined;
}

// The latest executed action with this command signature, if any.
function latestAction(state: State, command: string): { seq: number; id: string } | undefined {
  let best: { seq: number; id: string } | undefined;
  for (const node of state.nodes.values()) {
    if (node.kind !== "action" || !actionExecuted(state, node.id)) continue;
    if (actionCommand(node.payload) !== command) continue;
    if (best === undefined || node.seq > best.seq) best = { seq: node.seq, id: node.id };
  }
  return best;
}

// Why a repeat is refused points the model at the cheapest way to see the body: if it is
// already in the working set, use `shown`; otherwise fetch it by id. Never tell it to
// `query` a body that is already shown — that advice is itself refused, and the model
// loops read→query→read (tools §4.3).
function repeatReason(id: string, held: readonly string[]): string {
  return held.includes(id)
    ? `repeated_action: ${id} is already in "shown"; use the body there instead of repeating`
    : `repeated_action: ${id} already has it; retrieve by id (query), do not repeat`;
}

// The addressable result of an action: its produced child, else the action itself.
function resultId(state: State, actionId: string): string {
  let best: { seq: number; id: string } | undefined;
  for (const edge of state.edges.values()) {
    if (edge.kind !== "produces" || edge.from !== actionId) continue;
    const node = state.nodes.get(edge.to);
    if (node === undefined) continue;
    if (best === undefined || node.seq > best.seq) best = { seq: node.seq, id: edge.to };
  }
  return best?.id ?? actionId;
}

// The workspace-relative paths a unified diff would touch, from its `---`/`+++` headers.
// Used to enforce constraints on an `apply_patch` before it runs.
function patchTargets(patch: string): string[] {
  const out = new Set<string>();
  for (const line of patch.split("\n")) {
    const match = line.match(/^(?:\+\+\+|---) (?:[ab]\/)?(.+)$/);
    const path = match?.[1]?.trim();
    if (path !== undefined && path !== "" && path !== "/dev/null") out.add(path);
  }
  return [...out];
}

// A node has a retrievable body if it is a result (observation/check) or carries inline
// output / an outputRef; an action/goal/etc. has none, so `query` of it returns only the
// node's row, not a body.
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

export function classify(
  proposal: Proposal,
  state: State,
  held: readonly string[] = [],
  queried: readonly string[] = [],
): Classification {
  const action = proposal.action;

  if (action.operator === "stop") {
    // The doxa's terminal move. On a goal it finishes the frame (the engine then returns
    // to the parent and continues); on the request it ends the run. There is no criterion
    // gate: `stop` closes the goal while working (docs/plans/goal_reduction_plan.md §2).
    const current = currentGoalId(state);
    const node = current !== undefined ? state.nodes.get(current) : undefined;
    if (node?.kind !== "goal") {
      return reject("not_addressed: stop applies to a goal; the request ends when its goal is stopped");
    }
    return accept;
  }

  if (action.operator === "decline") {
    // Decline to formulate a goal: only at the request, and only while it has no
    // interpretation yet (docs/plans/request_goal_plan.md).
    const current = currentGoalId(state);
    const node = current !== undefined ? state.nodes.get(current) : undefined;
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

  if (action.operator === "query") {
    if (action.id !== undefined) {
      // Refuse a query of a body already shown (`held`), and a spin on a non-result node
      // (an action/goal has no body to show, so a recent query of it is not repeated).
      // A body evicted from the working set is NOT guarded here, so it can be re-fetched.
      if (held.includes(action.id)) {
        return reject(
          `repeated_action: ${action.id} is already in "shown"; use the body there (no need to re-query)`,
        );
      }
      if (!hasBody(state, action.id) && queried.includes(action.id)) {
        return reject(`repeated_action: ${action.id} already retrieved; do not re-query`);
      }
    }
    return accept;
  }

  if (action.operator === "create_goal") {
    if (action.what.trim() === "") return reject("empty_what");
    if (action.sketch.trim() === "") return reject("empty_sketch");
    if (action.command.trim() === "") return reject("empty_command");
    const current = currentGoalId(state);
    if (current === undefined) return reject("no_current_goal");
    const focusNode = state.nodes.get(current);
    // The interpretation is fixed: a request accepts one goal, created once.
    if (focusNode?.kind === "request" && goalOf(state, current) !== undefined) {
      return reject(
        "interpreted: the request already has an interpretation; work it or stop instead of interpreting it again",
      );
    }
    return accept;
  }

  // action.operator === "apply"
  const apply = action.action;
  // A repeated command with the same inputs and an unchanged world is a repeat; the
  // result already exists under an id, so the model must retrieve it (query) instead of
  // re-running. Applies to `read`/`grep` (same window/scope) and to `run` (below).
  if (apply.tool === "read" || apply.tool === "grep") {
    const found = latestAction(state, commandOf(apply));
    if (found !== undefined && state.lastMutationSeq < found.seq) {
      return reject(repeatReason(resultId(state, found.id), held));
    }
  }
  // A file already read MAX_FILE_READS times with no change has nothing new to show: refuse
  // a further read and point at the edit. (A different window is still a new action below
  // the cap — the guard stops a thrash, it does not forbid windowing.)
  if (apply.tool === "read" && readsOf(state, `file:${apply.path}`) >= MAX_FILE_READS) {
    return reject(
      `repeated_action: ${apply.path} has already been read ${MAX_FILE_READS} times with no change — if you can name the cause, edit it instead of reading it again`,
    );
  }

  if (apply.tool === "run") {
    const runCommand = apply.command ?? "";
    if (runCommand.trim() === "") return reject("run needs a command");
    const signature = `${runCommand}\u0000`;
    const found = latestAction(state, signature);
    if (found !== undefined && state.lastMutationSeq < found.seq) {
      const prior = state.nodes.get(resultId(state, found.id));
      const exit = (prior?.payload as { exitCode?: unknown } | undefined)?.exitCode;
      // A timeout brought no knowledge: an identical re-run after a timeout (no exit code)
      // is not a repeat, so the model may retry the same command.
      if (typeof exit === "number") {
        return reject(repeatReason(resultId(state, found.id), held));
      }
    }
  }
  if (apply.tool === "edit") {
    for (const { id, pattern } of forbiddenConstraints(state)) {
      if (matchesPath(pattern, apply.path)) {
        return reject(`constraint_violation:${pattern}`, id);
      }
    }
    const ref = `file:${apply.path}`;
    const readVersion = latestReadVersion(state, ref);
    if (readVersion !== undefined && currentVersion(state, ref) !== readVersion) {
      return reject("stale_base");
    }
    return accept;
  }

  if (apply.tool === "write") {
    for (const { id, pattern } of forbiddenConstraints(state)) {
      if (matchesPath(pattern, apply.path)) {
        return reject(`constraint_violation:${pattern}`, id);
      }
    }
    const ref = `file:${apply.path}`;
    const readVersion = latestReadVersion(state, ref);
    if (readVersion !== undefined && currentVersion(state, ref) !== readVersion) {
      return reject("stale_base");
    }
    return accept;
  }

  if (apply.tool === "fetch") {
    // The default target is engine-owned (`.skein/ref/…`); only an explicit path can be
    // forbidden, so it is the only one checked.
    if (apply.path !== undefined) {
      for (const { id, pattern } of forbiddenConstraints(state)) {
        if (matchesPath(pattern, apply.path)) {
          return reject(`constraint_violation:${pattern}`, id);
        }
      }
    }
    return accept;
  }

  if (apply.tool === "apply_patch") {
    for (const target of patchTargets(apply.patch)) {
      for (const { id, pattern } of forbiddenConstraints(state)) {
        if (matchesPath(pattern, target)) {
          return reject(`constraint_violation:${pattern}`, id);
        }
      }
    }
    return accept;
  }

  return accept;
}
