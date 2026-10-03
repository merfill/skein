import { forbiddenConstraints, matchesPath } from "../ir/constraints";
import {
  alternativesOf,
  childrenOf,
  currentVersion,
  predicateOf,
  type State,
} from "../ir/graph";
import { currentGoalId, goalPayload } from "../ir/traversal";
import type { DoneWhen } from "../ir/types";
import type { PlanItem, Proposal } from "../llm/schemas";

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

export function classify(proposal: Proposal, state: State): Classification {
  const action = proposal.action;

  if (action.operator === "query") return accept;

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
        return reject("missing_revision");
      }
    } else if (revises.length > 0) {
      return reject("unknown_revision");
    }
    if (repeatOfFailed(state, required ?? [], action.what)) {
      return reject("repeat_hypothesis");
    }
    return accept;
  }

  if (action.operator === "complete") {
    const goalId = action.goal ?? currentGoalId(state);
    if (goalId === undefined) return reject("no_current_goal");
    const goal = state.nodes.get(goalId);
    if (goal === undefined || goal.kind !== "goal") return reject("invalid_goal");
    if (goalId === state.rootId) return reject("root_not_completable");
    const payload = goalPayload(state, goalId);
    if (payload === undefined || payload.done_when.kind !== "subjective") {
      return reject("objective_goal_needs_check");
    }
    return accept;
  }

  // action.operator === "apply"
  const apply = action.action;
  if (apply.tool === "run" && apply.target !== undefined) {
    const target = state.nodes.get(apply.target);
    if (target === undefined || target.kind !== "goal") return reject("invalid_target");
    const payload = goalPayload(state, apply.target);
    if (payload === undefined || payload.done_when.kind !== "objective") {
      return reject("subjective_goal_needs_complete");
    }
  }

  // Reading and searching are idempotent and do not change the world, so a re-read or
  // re-search is never a repeat (tools contract): only `run` is subject to dedup.
  if (apply.tool === "run") {
    let runCommand = apply.command;
    if (apply.target !== undefined) {
      const payload = goalPayload(state, apply.target);
      if (payload?.done_when.kind === "objective") runCommand = payload.done_when.command;
    }
    const signature = `${runCommand}\u0000${apply.target ?? ""}`;
    let latest: number | undefined;
    for (const node of state.nodes.values()) {
      if (node.kind !== "action" || predicateOf(state, node.id) !== "executed") continue;
      const payload = node.payload as { command?: unknown; signature?: unknown } | undefined;
      const nodeSignature =
        typeof payload?.signature === "string"
          ? payload.signature
          : typeof payload?.command === "string"
            ? payload.command
            : undefined;
      if (nodeSignature !== signature) continue;
      if (latest === undefined || node.seq > latest) latest = node.seq;
    }
    if (latest !== undefined && state.lastMutationSeq < latest) {
      return reject("repeated_action");
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
