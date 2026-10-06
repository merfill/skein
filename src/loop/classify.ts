import { forbiddenConstraints, matchesPath } from "../ir/constraints";
import {
  alternativesOf,
  childrenOf,
  currentVersion,
  planOf,
  predicateOf,
  type State,
} from "../ir/graph";
import { currentGoalId, cursorOf, firstUnfulfilledItem, goalPayload, itemSucceeded } from "../ir/traversal";
import type { DoneWhen } from "../ir/types";
import type { PlanItem, Proposal } from "../llm/schemas";
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

function doneWhenOk(done: DoneWhen): boolean {
  return done.kind === "objective"
    ? done.command.trim() !== ""
    : done.text.trim() !== "";
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
    if (node.kind !== "action" || predicateOf(state, node.id) !== "executed") continue;
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

function planOk(plan: PlanItem[] | undefined): boolean {
  return plan === undefined || plan.length > 0;
}

function isFailed(state: State, id: string): boolean {
  const predicate = predicateOf(state, id);
  return predicate === "refuted" || predicate === "abandoned";
}

function containerOf(state: State, goalId: string): string | undefined {
  for (const [containerId, ids] of state.children) {
    if (!ids.includes(goalId)) continue;
    if (state.nodes.get(containerId)?.kind === "alternatives") return containerId;
  }
  return undefined;
}

// When a proposal replaces failed options, `revises` must name all of them.
// Returns the required set, or null when the proposal is not a revision.
function revisionContext(state: State, current: string): string[] | null {
  const node = state.nodes.get(current);
  if (node?.kind === "request") {
    const alt = alternativesOf(state, current);
    const failed = alt === undefined ? [] : childrenOf(state, alt).filter((id) => isFailed(state, id));
    return failed;
  }
  if (node?.kind === "goal" && predicateOf(state, current) === "refuted") {
    const failed = new Set<string>();
    const container = containerOf(state, current);
    if (container !== undefined) {
      for (const id of childrenOf(state, container)) if (isFailed(state, id)) failed.add(id);
    }
    failed.add(current);
    return [...failed];
  }
  return null;
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function repeatOfFailed(state: State, failed: string[], what: string): boolean {
  const target = normalize(what);
  for (const id of failed) {
    const node = state.nodes.get(id);
    if (node?.kind !== "goal") continue;
    const payload = node.payload as { what?: unknown } | undefined;
    const label = typeof payload?.what === "string" ? payload.what : node.label;
    if (normalize(label) === target) return true;
  }
  return false;
}

// A node has a retrievable body if it is a result (observation/check) or carries inline
// output / an outputRef; an action/goal/etc. has none, so `query` of it returns only the
// node's row, not a body.
function hasBody(state: State, id: string): boolean {
  const node = state.nodes.get(id);
  if (node === undefined) return false;
  if (node.kind === "observation" || node.kind === "check") return true;
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

// A plan "carries a check" when it has at least one checkable step: an action, or an
// objective sub-goal. A plan of only epistemic (subjective) stages — reproduce/locate —
// is not complete, because the fix stage is still to come, so growing it must stay legal.
function planCarriesCheck(state: State, items: readonly string[]): boolean {
  return items.some((id) => {
    const node = state.nodes.get(id);
    if (node?.kind === "action") return true;
    return node?.kind === "goal" && goalPayload(state, id)?.done_when.kind === "objective";
  });
}

// The concrete move the logos expects at the current focus, computed from the same
// frontier as `applicable`/`checkReady`. A wrong-target/wrong-operator refusal names it,
// so the model is told not only why it was refused but what to do instead — the engine
// states the frontier, the doxa still has to propose the move (docs/ir_semantics §4.2).
function focusHint(state: State): string | undefined {
  const focus = currentGoalId(state);
  if (focus === undefined) return undefined;
  const node = state.nodes.get(focus);
  if (node?.kind === "request") return "interpret the request: create_goal";
  if (node?.kind !== "goal") return undefined;
  const payload = goalPayload(state, focus);
  const plan = planOf(state, focus);
  const items = plan === undefined ? [] : childrenOf(state, plan);
  const cursor = cursorOf(state, focus);
  const done = cursor === undefined || items.length === 0 || cursor >= items.length;
  if (!done) {
    const first = firstUnfulfilledItem(state, focus);
    const firstNode = first !== undefined ? state.nodes.get(first) : undefined;
    if (first === undefined) return undefined;
    return firstNode?.kind === "action"
      ? `apply the next plan item: ${firstNode.label}`
      : `descend into the next plan item: ${first}`;
  }
  if (payload?.done_when.kind === "objective") return `check it: apply run {target: "${focus}"}`;
  if (payload?.done_when.kind === "subjective") return `close it: complete {goal: "${focus}"}`;
  return undefined;
}

export function classify(
  proposal: Proposal,
  state: State,
  held: readonly string[] = [],
  queried: readonly string[] = [],
): Classification {
  const action = proposal.action;

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
    if (!doneWhenOk(action.done_when)) return reject("empty_done_when");
    if (!planOk(action.plan)) return reject("empty_plan");
    if (action.plan?.some((item) => item.kind === "goal" && item.what.trim() === "")) {
      return reject("empty_item");
    }
    const current = currentGoalId(state);
    if (current === undefined) return reject("no_current_goal");
    const required = revisionContext(state, current);
    const revises = [...new Set(action.revises ?? [])];
    if (required !== null) {
      if (revises.length !== required.length || !required.every((id) => revises.includes(id))) {
        return reject(
          `missing_revision: list every failed option of ${current} in revises: expected [${required.join(", ")}]`,
        );
      }
    } else if (revises.length > 0) {
      return reject(
        `unknown_revision: the current point ${current} is not refuted; revises apply only then (drop revises; to supersede a refuted plan item, add a new item instead)`,
      );
    }
    if (repeatOfFailed(state, required ?? [], action.what)) {
      return reject("repeat_hypothesis");
    }
    // An objective goal whose plan already carries a fulfilled check step must be
    // checked, not grown. A plan of only epistemic stages (no action, no objective
    // sub-goal) may still grow — otherwise the fix stage could never be added after
    // reproduce/locate are done (docs/ir_semantics_ru.md §4.2).
    const currentNode = state.nodes.get(current);
    const payload = goalPayload(state, current);
    const plan = planOf(state, current);
    if (
      currentNode?.kind === "goal" &&
      predicateOf(state, current) === "open" &&
      payload?.done_when.kind === "objective" &&
      plan !== undefined
    ) {
      const items = childrenOf(state, plan);
      if (items.length > 0 && items.every((id) => itemSucceeded(state, id)) && planCarriesCheck(state, items)) {
        return reject(
          `all plan items are fulfilled; check this goal (apply run with target "${current}"), do not grow the plan`,
        );
      }
    }
    return accept;
  }

  if (action.operator === "complete") {
    const goalId = action.goal ?? currentGoalId(state);
    if (goalId === undefined) return reject("no_current_goal");
    const goal = state.nodes.get(goalId);
    if (goal === undefined || goal.kind !== "goal") return reject("invalid_goal");
    if (goalId === state.rootId) return reject("root_not_completable");
    const current = currentGoalId(state);
    if (goalId !== current) {
      const hint = focusHint(state);
      return reject(
        `not_current_goal: complete acts on the node in focus (${current ?? "none"}), not ${goalId}; ${hint ?? `close ${current ?? "it"} first`} — the traversal returns to the parent once it closes`,
      );
    }
    const payload = goalPayload(state, goalId);
    if (payload === undefined || payload.done_when.kind !== "subjective") {
      return reject(
        `objective_goal_needs_check: goal ${goalId} is objective; settle it with a check (apply run with target "${goalId}"), not complete`,
      );
    }
    return accept;
  }

  // action.operator === "apply"
  const apply = action.action;
  // A poll of a background job carries only the job id, and reads new state each time,
  // so it is never a repeat: accept it outright (docs/tools.md §4.7).
  if (apply.tool === "run" && apply.job !== undefined) {
    if (apply.command !== undefined || apply.target !== undefined || apply.background === true) {
      return reject('job_poll: poll a background job with { tool: "run", job } alone');
    }
    return accept;
  }
  if (apply.tool === "run" && apply.background === true && apply.target !== undefined) {
    return reject("background_target: a check must run to a verdict; do not background a check");
  }
  if (
    apply.tool === "run" &&
    apply.target === undefined &&
    apply.background !== true &&
    (apply.command ?? "").trim() === ""
  ) {
    return reject("run needs a command or an objective target to check");
  }
  if (
    apply.tool === "run" &&
    apply.background === true &&
    (apply.command ?? "").trim() === ""
  ) {
    return reject("background_run: background needs a command");
  }
  if (apply.tool === "run" && apply.target !== undefined) {
    const target = state.nodes.get(apply.target);
    if (target === undefined || target.kind !== "goal") return reject("invalid_target");
    const payload = goalPayload(state, apply.target);
    if (payload === undefined || payload.done_when.kind !== "objective") {
      return reject(
        `subjective_goal_needs_complete: goal ${apply.target} is subjective; close it with complete {goal:"${apply.target}"}, then check an objective goal`,
      );
    }
    if (apply.command !== undefined && apply.command !== payload.done_when.command) {
      return reject(
        `target ${apply.target} is an objective goal; its check runs its own command "${payload.done_when.command}" — drop "command" (it is ignored) or pass exactly that`,
      );
    }
    const current = currentGoalId(state);
    if (apply.target !== current) {
      const hint = focusHint(state);
      return reject(
        `not_current_goal: a check acts on the node in focus (${current ?? "none"}), not ${apply.target}; ${hint ?? `settle ${current ?? "the focus"} first`} — the traversal returns to the parent once it closes`,
      );
    }
  }

  // A repeated command with the same inputs and an unchanged world is a repeat; the
  // result already exists under an id, so the model must retrieve it (query) instead of
  // re-running. Applies to `read`/`grep` (same window/scope) and to `run` (below).
  if (apply.tool === "read" || apply.tool === "grep") {
    const found = latestAction(state, commandOf(apply));
    if (found !== undefined && state.lastMutationSeq < found.seq) {
      return reject(repeatReason(resultId(state, found.id), held));
    }
  }

  if (apply.tool === "run") {
    let runCommand = apply.command ?? "";
    if (apply.target !== undefined) {
      const payload = goalPayload(state, apply.target);
      if (payload?.done_when.kind === "objective") runCommand = payload.done_when.command;
    }
    const signature = `${runCommand}\u0000${apply.target ?? ""}`;
    const found = latestAction(state, signature);
    if (found !== undefined && state.lastMutationSeq < found.seq) {
      const prior = state.nodes.get(resultId(state, found.id));
      const verdict = (prior?.payload as { verdict?: unknown } | undefined)?.verdict;
      // A timeout brought no knowledge: an identical re-check after `inconclusive` is not
      // a repeat, so the model may retry the same check at the same node (§4.2, invariant 23).
      if (verdict !== "inconclusive") {
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

  return accept;
}
