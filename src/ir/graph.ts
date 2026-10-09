import type { Event } from "./events";
import type { Edge, Node, WitnessEntry } from "./types";

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

export function planOf(state: State, goalId: string): string | undefined {
  for (const edge of state.edges.values()) {
    if (edge.kind === "has_plan" && edge.from === goalId) return edge.to;
  }
  return undefined;
}

// The goal a request is interpreted as (`has_goal` edge). The interpretation is fixed for
// now (one goal), so there is at most one (docs/plans/request_goal_plan.md).
export function goalOf(state: State, requestId: string): string | undefined {
  for (const edge of state.edges.values()) {
    if (edge.kind === "has_goal" && edge.from === requestId) return edge.to;
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

export function witnessOf(state: State, nodeId: string): WitnessEntry[] | undefined {
  const payload = state.nodes.get(nodeId)?.payload as { witness?: WitnessEntry[] } | undefined;
  return payload?.witness;
}

// A goal the doxa has finished: it has an outgoing `has_stopped` edge to a stop node.
// This is a control fact (the arm is done), not truth.
// The edge points goal → stop (like `has_plan`), so from a goal one can always tell it is
// finished and follow the edge to the stop node (and its why / arm history).
export function hasStopped(state: State, goalId: string): boolean {
  for (const edge of state.edges.values()) {
    if (edge.kind === "has_stopped" && edge.from === goalId) return true;
  }
  return false;
}

// The request's `unactionable` node, if the doxa declined to formulate a goal for it
// (`no_goal` edge). A declined request is terminal (docs/plans/request_goal_plan.md).
export function unactionableOf(state: State, requestId: string): string | undefined {
  for (const edge of state.edges.values()) {
    if (edge.kind === "no_goal" && edge.from === requestId) return edge.to;
  }
  return undefined;
}

// An action bypassed by a newer alternative of its own container (a revised step).
export function actionSuperseded(state: State, actionId: string): boolean {
  const alt = alternativesOf(state, actionId);
  if (alt === undefined) return false;
  const current = lastChild(state, alt);
  return current !== undefined && current !== actionId;
}

// The current option of a container: the LAST child (order = append order). There is no
// `chosen` edge — the last item added is the current one (docs/plans/request_goal_plan.md).
export function lastChild(state: State, containerId: string): string | undefined {
  const ids = state.children.get(containerId);
  return ids !== undefined && ids.length > 0 ? ids[ids.length - 1] : undefined;
}

export function actionExecuted(state: State, actionId: string): boolean {
  for (const edge of state.edges.values()) {
    if (edge.from !== actionId) continue;
    if (edge.kind === "produces" || edge.kind === "mutates") return true;
  }
  return false;
}

export function fold(events: readonly Event[], base: State = emptyState()): State {
  const state: State = {
    nodes: new Map(base.nodes),
    edges: new Map(base.edges),
    children: new Map([...base.children].map(([key, value]) => [key, [...value]])),
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
  }
}
