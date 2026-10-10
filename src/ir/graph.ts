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
    if (edge.kind === "plan" && edge.from === goalId) return edge.to;
  }
  return undefined;
}

// The goal a request is interpreted as (`goal` edge). The interpretation is fixed for
// now (one goal), so there is at most one (docs/plans/request_goal_plan.md).
export function goalOf(state: State, requestId: string): string | undefined {
  for (const edge of state.edges.values()) {
    if (edge.kind === "goal" && edge.from === requestId) return edge.to;
  }
  return undefined;
}

// The item that owns a node as one of its alternatives (`alts` edge), if any. An action or
// sub-goal belongs to exactly one item (docs/ir_revision.md §2.2).
export function itemOf(state: State, nodeId: string): string | undefined {
  for (const edge of state.edges.values()) {
    if (edge.kind === "alts" && edge.to === nodeId) return edge.from;
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

// The `stop` node a goal is closed by (`stop` relation, goal → stop), if any. This is a
// control fact (the arm is done), not truth. The closure (and its `why`) lives on the goal;
// it is no longer a plan item (docs/ir_revision.md §2.2).
export function stopOf(state: State, goalId: string): string | undefined {
  for (const edge of state.edges.values()) {
    if (edge.kind === "stop" && edge.from === goalId) return edge.to;
  }
  return undefined;
}

export function hasStopped(state: State, goalId: string): boolean {
  return stopOf(state, goalId) !== undefined;
}

// The request's `unactionable` node, if the doxa declined to formulate a goal for it
// (`unactionable` relation). A declined request is terminal (docs/plans/request_goal_plan.md).
export function unactionableOf(state: State, requestId: string): string | undefined {
  for (const edge of state.edges.values()) {
    if (edge.kind === "unactionable" && edge.from === requestId) return edge.to;
  }
  return undefined;
}

// An action bypassed by a newer alternative of its own item (a revised step).
export function actionSuperseded(state: State, actionId: string): boolean {
  const item = itemOf(state, actionId);
  if (item === undefined) return false;
  const current = lastChild(state, item);
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
    if (edge.kind === "result" || edge.kind === "mutates") return true;
  }
  return false;
}

// The outcome of an action (docs/ir_revision.md §4): a command that mutated a file is a
// success; otherwise its result observation decides — `failed: true` is a failure, a
// non-zero `exitCode` is a failure (a missing `exitCode` is a timeout, no verdict), and a
// read/grep/list result is a success. An unexecuted action is not a success.
export function actionSucceeded(state: State, actionId: string): boolean {
  let hasMutates = false;
  let result: Node | undefined;
  for (const edge of state.edges.values()) {
    if (edge.from !== actionId) continue;
    if (edge.kind === "mutates") hasMutates = true;
    if (edge.kind === "result") {
      const child = state.nodes.get(edge.to);
      if (child !== undefined && (result === undefined || child.seq > result.seq)) result = child;
    }
  }
  if (hasMutates) return true;
  if (result === undefined) return false;
  const payload = result.payload as { failed?: unknown; exitCode?: unknown } | undefined;
  if (payload?.failed === true) return false;
  if (typeof payload?.exitCode === "number") return payload.exitCode === 0;
  return true;
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
      // Ordered children: a plan's items (`items`) and an item's alternatives (`alts`).
      if (event.edge.kind === "items" || event.edge.kind === "alts") {
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
