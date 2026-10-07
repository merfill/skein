import type { Event } from "./events";
import type { Edge, GoalPayload, Node, Predicate, WitnessEntry } from "./types";

export interface RejectionRecord {
  seq: number;
  turn: number;
  tool: string;
  target: string;
  reason: string;
  constraintId?: string;
  // The node in focus when the refusal was recorded; scopes the negative history
  // to the traversal branch (§2.8).
  focus: string;
}

export interface State {
  nodes: Map<string, Node>;
  edges: Map<string, Edge>;
  // Ordered children of plan/alternatives containers, from `item` event order.
  children: Map<string, string[]>;
  // Derived predicates (§2.5); never a stored field.
  predicates: Map<string, Predicate>;
  rejections: RejectionRecord[];
  // The node in focus when each node was added, keyed by node id; derived during
  // fold. Scopes negative records to the traversal branch (§2.8).
  focusOf: Map<string, string>;
  // Full traversal stack of goals, root first; `descend`/`return` fold into it.
  branch: string[];
  // world state: latest mutated version and first observed version per ref
  mutated: Map<string, string>;
  observed: Map<string, string>;
  lastMutationSeq: number;
  rootId?: string;
  seq: number;
}

export function emptyState(): State {
  return {
    nodes: new Map(),
    edges: new Map(),
    children: new Map(),
    predicates: new Map(),
    rejections: [],
    focusOf: new Map(),
    branch: [],
    mutated: new Map(),
    observed: new Map(),
    lastMutationSeq: 0,
    seq: 0,
  };
}

export function currentFocus(state: State): string | undefined {
  return state.branch[state.branch.length - 1] ?? state.rootId;
}

export function currentVersion(state: State, ref: string): string | undefined {
  return state.mutated.get(ref) ?? state.observed.get(ref);
}

export function predicateOf(state: State, id: string): Predicate {
  return state.predicates.get(id) ?? "open";
}

export function planOf(state: State, goalId: string): string | undefined {
  for (const edge of state.edges.values()) {
    if (edge.kind === "has_plan" && edge.from === goalId) return edge.to;
  }
  return undefined;
}

export function alternativesOf(state: State, goalId: string): string | undefined {
  for (const edge of state.edges.values()) {
    if (edge.kind === "has_alternatives" && edge.from === goalId) return edge.to;
  }
  return undefined;
}

export function childrenOf(state: State, containerId: string): string[] {
  return state.children.get(containerId) ?? [];
}

export function checkHasUnder(state: State, checkId: string): boolean {
  for (const edge of state.edges.values()) {
    if (edge.kind === "under" && edge.from === checkId) return true;
  }
  return false;
}

export function witnessOf(state: State, checkId: string): WitnessEntry[] | undefined {
  const payload = state.nodes.get(checkId)?.payload as { witness?: WitnessEntry[] } | undefined;
  return payload?.witness;
}

export function checkIsStale(state: State, checkId: string): boolean {
  const witness = witnessOf(state, checkId);
  if (witness === undefined) return false;
  return witness.some((entry) => currentVersion(state, entry.ref) !== entry.version);
}

export function latestClosingCheck(state: State, goalId: string): Node | undefined {
  let latest: Node | undefined;
  for (const edge of state.edges.values()) {
    if (edge.kind !== "verifies" || edge.to !== goalId) continue;
    const check = state.nodes.get(edge.from);
    if (check === undefined || check.kind !== "check") continue;
    if (latest === undefined || check.seq > latest.seq) latest = check;
  }
  return latest;
}

// The current chosen option of a container is the target of the latest `chosen`
// edge (Map iteration follows insertion order, i.e. journal order).
export function latestChosen(state: State, containerId: string): string | undefined {
  let chosen: string | undefined;
  for (const edge of state.edges.values()) {
    if (edge.kind === "chosen" && edge.from === containerId) chosen = edge.to;
  }
  return chosen;
}

function isUnselectedVariant(state: State, goalId: string): boolean {
  for (const [containerId, ids] of state.children) {
    if (!ids.includes(goalId)) continue;
    const container = state.nodes.get(containerId);
    if (container === undefined || container.kind !== "alternatives") continue;
    const chosen = latestChosen(state, containerId);
    if (chosen !== undefined) return chosen !== goalId;
  }
  return false;
}

function requestPredicate(state: State, requestId: string): Predicate {
  const alt = alternativesOf(state, requestId);
  if (alt === undefined) return "open";
  const chosen = latestChosen(state, alt);
  if (chosen === undefined) return "open";
  const predicate = goalPredicate(state, chosen);
  return predicate === "achieved" || predicate === "achieved_under" ? "addressed" : "open";
}

function goalPredicate(state: State, goalId: string): Predicate {
  const check = latestClosingCheck(state, goalId);
  let closure: Predicate = "open";
  if (check !== undefined) {
    const payload = check.payload as { verdict?: unknown } | undefined;
    const verdict = payload?.verdict;
    if (verdict === "pass") {
      closure = checkHasUnder(state, check.id) ? "achieved_under" : "achieved";
    } else if (verdict === "fail") {
      closure = "refuted";
    } else {
      closure = "open";
    }
  }
  if (closure === "refuted") return "refuted";
  if (isUnselectedVariant(state, goalId)) return "abandoned";
  return closure;
}

function actionExecuted(state: State, actionId: string): boolean {
  for (const edge of state.edges.values()) {
    if (edge.from !== actionId) continue;
    if (edge.kind === "produces" || edge.kind === "mutates") return true;
  }
  return false;
}

function actionSuperseded(state: State, actionId: string): boolean {
  const alt = alternativesOf(state, actionId);
  if (alt === undefined) return false;
  const chosen = latestChosen(state, alt);
  return chosen !== undefined && chosen !== actionId;
}

// A plan item is successfully settled: an action executed, a goal achieved, or the chosen
// option of its alternatives settled. Mirrors `itemSucceeded` in traversal, but lives here
// so `fold` can use it without an import cycle.
function itemSettled(state: State, itemId: string): boolean {
  const node = state.nodes.get(itemId);
  if (node === undefined) return false;
  if (node.kind === "action") return actionExecuted(state, itemId);
  if (node.kind !== "goal") return false;
  const self = goalPredicate(state, itemId);
  if (self === "achieved" || self === "achieved_under") return true;
  const alt = alternativesOf(state, itemId);
  if (alt === undefined) return false;
  const chosen = latestChosen(state, alt);
  if (chosen === undefined || chosen === itemId) return false;
  const option = state.nodes.get(chosen);
  if (option?.kind === "action") return actionExecuted(state, chosen);
  if (option?.kind === "goal") {
    const predicate = goalPredicate(state, chosen);
    return predicate === "achieved" || predicate === "achieved_under";
  }
  return false;
}

function ownerGoalOfPlan(state: State, planId: string): string | undefined {
  for (const edge of state.edges.values()) {
    if (edge.kind === "has_plan" && edge.to === planId) return edge.from;
  }
  return undefined;
}

// Logos closure: a passing objective check verifies every plan ancestor of its goals whose
// criterion (done_when.command) is identical, once the rest of that ancestor's plan is
// settled. The move is deterministic and carries the check's provenance, so a single check
// at the bottom closes the whole chain above — no extra doxa turn
// (docs/plans/step_reduction_plan.md, §3).
function closeAncestors(state: State): void {
  for (const [checkId, node] of state.nodes) {
    if (node.kind !== "check") continue;
    const payload = node.payload as { command?: unknown; verdict?: unknown } | undefined;
    if (payload?.verdict !== "pass" || typeof payload.command !== "string") continue;
    const command = payload.command;
    const seeds: string[] = [];
    for (const edge of state.edges.values()) {
      if (edge.kind === "verifies" && edge.from === checkId) seeds.push(edge.to);
    }
    const visited = new Set(seeds);
    const queue = [...seeds];
    while (queue.length > 0) {
      const child = queue.shift() as string;
      for (const [planId, items] of state.children) {
        if (!items.includes(child)) continue;
        if (state.nodes.get(planId)?.kind !== "plan") continue;
        const owner = ownerGoalOfPlan(state, planId);
        if (owner === undefined || visited.has(owner)) continue;
        const goal = state.nodes.get(owner);
        if (goal?.kind !== "goal") continue;
        const doneWhen = (goal.payload as GoalPayload | undefined)?.done_when;
        if (doneWhen?.kind !== "objective" || doneWhen.command !== command) continue;
        if (!items.every((id) => id === child || itemSettled(state, id))) continue;
        const edgeId = `${checkId}:c:${owner}`;
        if (!state.edges.has(edgeId)) {
          state.edges.set(edgeId, {
            id: edgeId,
            from: checkId,
            to: owner,
            kind: "verifies",
            provenance: { kind: "check", command, verdict: "pass" },
          });
        }
        visited.add(owner);
        queue.push(owner);
      }
    }
  }
}

function derivePredicates(state: State): void {
  state.predicates = new Map();
  for (const node of state.nodes.values()) {
    let predicate: Predicate = "open";
    if (node.kind === "request") predicate = requestPredicate(state, node.id);
    else if (node.kind === "goal") predicate = goalPredicate(state, node.id);
    else if (node.kind === "action" && actionExecuted(state, node.id)) predicate = "executed";
    else if (node.kind === "action" && actionSuperseded(state, node.id)) predicate = "abandoned";
    state.predicates.set(node.id, predicate);
  }
}

export function fold(events: readonly Event[], base: State = emptyState()): State {
  const state: State = {
    nodes: new Map(base.nodes),
    edges: new Map(base.edges),
    children: new Map([...base.children].map(([key, value]) => [key, [...value]])),
    predicates: new Map(base.predicates),
    rejections: [...base.rejections],
    focusOf: new Map(base.focusOf),
    branch: [...base.branch],
    mutated: new Map(base.mutated),
    observed: new Map(base.observed),
    lastMutationSeq: base.lastMutationSeq,
    rootId: base.rootId,
    seq: base.seq,
  };

  for (const event of events) applyEvent(state, event);

  derivePredicates(state);
  closeAncestors(state);
  derivePredicates(state);

  return state;
}

function applyEvent(state: State, event: Event): void {
  state.seq += 1;

  switch (event.type) {
    case "add_node": {
      state.nodes.set(event.node.id, event.node);
      if (event.node.kind === "request") {
        state.rootId = event.node.id;
        state.branch = [event.node.id];
      } else if (event.node.kind === "goal" && state.rootId === undefined) {
        state.rootId = event.node.id;
        state.branch = [event.node.id];
      }
      const focus = currentFocus(state);
      if (focus !== undefined) state.focusOf.set(event.node.id, focus);
      if (event.node.kind === "observation") {
        const payload = event.node.payload as { ref?: unknown; version?: unknown } | undefined;
        if (
          typeof payload?.ref === "string" &&
          typeof payload.version === "string" &&
          !state.observed.has(payload.ref)
        ) {
          state.observed.set(payload.ref, payload.version);
        }
      }
      break;
    }
    case "add_edge": {
      state.edges.set(event.edge.id, event.edge);
      if (event.edge.kind === "item") {
        const list = state.children.get(event.edge.from);
        if (list) list.push(event.edge.to);
        else state.children.set(event.edge.from, [event.edge.to]);
      }
      break;
    }
    case "descend": {
      if (state.branch[state.branch.length - 1] !== event.node) state.branch.push(event.node);
      break;
    }
    case "return": {
      if (state.branch.length > 1) state.branch.pop();
      break;
    }
    case "mutate": {
      state.mutated.set(event.ref, event.version);
      state.lastMutationSeq = state.seq;
      break;
    }
    case "record_rejection": {
      state.rejections.push({
        seq: state.seq,
        turn: event.turn,
        tool: event.tool,
        target: event.target,
        reason: event.reason,
        constraintId: event.constraintId,
        focus: currentFocus(state) ?? "",
      });
      break;
    }
    case "record_check": {
      const checkId = event.id ?? `chk:${state.seq}`;
      if (!state.nodes.has(checkId)) {
        state.nodes.set(checkId, {
          id: checkId,
          space: "work",
          kind: "check",
          label: event.command,
          payload: {
            command: event.command,
            verdict: event.verdict,
            output: event.output,
            actor: event.actor ?? "arbiter",
            ...(event.outputRef !== undefined ? { outputRef: event.outputRef } : {}),
            ...(event.error !== undefined ? { error: event.error } : {}),
            ...(event.errorRef !== undefined ? { errorRef: event.errorRef } : {}),
            ...(event.signal !== undefined ? { signal: event.signal } : {}),
            ...(event.core !== undefined ? { core: event.core } : {}),
            ...(event.backtrace !== undefined ? { backtrace: event.backtrace } : {}),
            ...(event.backtraceError !== undefined
              ? { backtraceError: event.backtraceError }
              : {}),
            ...(event.witness !== undefined ? { witness: event.witness } : {}),
          },
          seq: state.seq,
        });
        const focus = currentFocus(state);
        if (focus !== undefined) state.focusOf.set(checkId, focus);
      }
      event.targets.forEach((target, index) => {
        const edgeId = `${checkId}:v:${index}`;
        if (state.edges.has(edgeId)) return;
        state.edges.set(edgeId, {
          id: edgeId,
          from: checkId,
          to: target,
          kind: "verifies",
          provenance: {
            kind: "check",
            command: event.command,
            verdict: event.verdict,
            ...(event.outputRef !== undefined ? { outputRef: event.outputRef } : {}),
          },
        });
      });
      (event.under ?? []).forEach((assumption, index) => {
        const edgeId = `${checkId}:u:${index}`;
        if (state.edges.has(edgeId)) return;
        state.edges.set(edgeId, {
          id: edgeId,
          from: checkId,
          to: assumption,
          kind: "under",
          provenance: { kind: "llm" },
        });
      });
      break;
    }
  }
}
