import type { Event } from "./events";
import type { HypothesisPayload, HypothesisVerdictPayload, Edge, Node, WitnessEntry } from "./types";

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
  // Ordered children: a request's states (`move`), a state's turns (`turn`), and a
  // hypothesis's sub-hypotheses (`hypothesis`).
  children: Map<string, string[]>;
  rejections: RejectionRecord[];
  // The node in focus when each node was added, keyed by node id; derived during
  // fold. Scopes negative records to the traversal branch (§2.8).
  focusOf: Map<string, string>;
  // Full traversal stack of goals, root first; `descend`/`return` fold into it.
  branch: string[];
  // Latest mutated version and first observed version per ref
  mutated: Map<string, string>;
  observed: Map<string, string>;
  // How many times a state island was entered through `move`.
  stateEntries: Map<string, number>;
  // Patch moves whose files the engine restored after a failed Verification.
  reverted: Set<string>;
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
    stateEntries: new Map(),
    reverted: new Set(),
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

// The turns container of a state (`turns` relation, move → turns), if any.
export function turnsOf(state: State, moveId: string): string | undefined {
  for (const edge of state.edges.values()) {
    if (edge.kind === "turns" && edge.from === moveId) return edge.to;
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

// The `inquiry` unit's hypotheses, in append order. A hypothesis is open until a
// `hypothesis_verdict` node with its id exists; the open hypotheses of a well-formed unit
// always form one path.
export function hypothesisNodes(state: State): Node[] {
  return [...state.nodes.values()]
    .filter((node) => node.kind === "hypothesis")
    .sort((a, b) => a.seq - b.seq);
}

export function hypothesisPayloadOf(state: State, hypothesisId: string): HypothesisPayload | undefined {
  for (const node of state.nodes.values()) {
    if (node.kind !== "hypothesis") continue;
    const payload = node.payload as HypothesisPayload | undefined;
    if (payload?.hypothesisId === hypothesisId) return payload;
  }
  return undefined;
}

export function hypothesisNodeOf(state: State, hypothesisId: string): Node | undefined {
  return hypothesisNodes(state).find(
    (node) => (node.payload as HypothesisPayload | undefined)?.hypothesisId === hypothesisId,
  );
}

export function hypothesisVerdictOf(state: State, hypothesisId: string): HypothesisVerdictPayload | undefined {
  for (const node of state.nodes.values()) {
    if (node.kind !== "hypothesis_verdict") continue;
    const payload = node.payload as HypothesisVerdictPayload | undefined;
    if (payload?.hypothesisId === hypothesisId) return payload;
  }
  return undefined;
}

// The engine-owned formula H, if the unit has one.
export function formulaNode(state: State): Node | undefined {
  for (const node of state.nodes.values()) {
    if (node.kind === "formula") return node;
  }
  return undefined;
}

// The closure of H, if the model has closed the goal.
export function goalVerdictOf(state: State): Node | undefined {
  for (const node of state.nodes.values()) {
    if (node.kind === "goal_verdict") return node;
  }
  return undefined;
}

// The open hypotheses form one path from a root conjunct to the active leaf. A hypothesis is
// open until a `hypothesis_verdict` node with its id exists.
export function openHypothesisNodes(state: State): Node[] {
  return hypothesisNodes(state).filter((node) => {
    const payload = node.payload as HypothesisPayload | undefined;
    return payload !== undefined && hypothesisVerdictOf(state, payload.hypothesisId) === undefined;
  });
}

// A hypothesis's parent node: the `hypothesis` edge into it (H or another hypothesis). Root
// conjuncts hang off H.
export function hypothesisParentOf(state: State, hypothesisId: string): Node | undefined {
  const node = hypothesisNodeOf(state, hypothesisId);
  if (node === undefined) return undefined;
  for (const edge of state.edges.values()) {
    if (edge.kind === "hypothesis" && edge.to === node.id) return state.nodes.get(edge.from);
  }
  return undefined;
}

// The sub-hypotheses opened under a hypothesis, in append order. Actions are not here: they
// stay in the request's linear turns container and are bound by `hypothesisId`.
export function hypothesisChildrenOf(state: State, hypothesisId: string): Node[] {
  const node = hypothesisNodeOf(state, hypothesisId);
  if (node === undefined) return [];
  return childrenOf(state, node.id)
    .map((id) => state.nodes.get(id))
    .filter((child): child is Node => child?.kind === "hypothesis");
}

// The actions recorded under a hypothesis id, in append order.
export function hypothesisActionsOf(state: State, hypothesisId: string): Node[] {
  const actions: Node[] = [];
  for (const node of state.nodes.values()) {
    if (node.kind !== "action") continue;
    const payload = node.payload as
      | { hypothesisId?: unknown; call?: { name?: unknown } }
      | undefined;
    if (payload?.hypothesisId !== hypothesisId) continue;
    // The hypothesis tools carry a hypothesis id but are protocol, not work under it.
    const callName = payload.call?.name;
    if (
      callName === "open_hypothesis" ||
      callName === "close_hypothesis" ||
      callName === "close_goal"
    ) {
      continue;
    }
    actions.push(node);
  }
  return actions.sort((a, b) => a.seq - b.seq);
}

export type HypothesisMode = "undecided" | "work" | "formula" | "mixed";

// The mode is fixed by the first child: actions make a work leaf, sub-hypotheses make a
// formula. A node with no children is undecided; mixing both kinds is malformed.
export function hypothesisMode(state: State, hypothesisId: string): HypothesisMode {
  const hasActions = hypothesisActionsOf(state, hypothesisId).length > 0;
  const hasChildren = hypothesisChildrenOf(state, hypothesisId).length > 0;
  if (hasActions && hasChildren) return "mixed";
  if (hasChildren) return "formula";
  if (hasActions) return "work";
  return "undecided";
}

// The active hypothesis: the deepest open node. The open set is a single path, so the active
// node is the one open hypothesis with no open child.
export function activeHypothesis(state: State): HypothesisPayload | undefined {
  const open = openHypothesisNodes(state);
  if (open.length === 0) return undefined;
  const openIds = new Set(open.map((node) => node.id));
  const deepest = open.filter((node) => {
    const payload = node.payload as HypothesisPayload;
    return hypothesisChildrenOf(state, payload.hypothesisId).every((child) => !openIds.has(child.id));
  });
  const node = deepest[deepest.length - 1] ?? open[open.length - 1];
  return node?.payload as HypothesisPayload | undefined;
}

export function activeHypothesisId(state: State): string | undefined {
  return activeHypothesis(state)?.hypothesisId;
}

// The open path from a root conjunct to the active hypothesis (root first). Empty when
// nothing is open.
export function activeHypothesisPath(state: State): HypothesisPayload[] {
  const active = activeHypothesis(state);
  if (active === undefined) return [];
  const path: HypothesisPayload[] = [];
  let current: Node | undefined = hypothesisNodeOf(state, active.hypothesisId);
  while (current !== undefined && current.kind === "hypothesis") {
    const payload = current.payload as HypothesisPayload;
    path.push(payload);
    current = hypothesisParentOf(state, payload.hypothesisId);
  }
  return path.reverse();
}

export function hypothesisOpenSeq(state: State, hypothesisId: string): number | undefined {
  return hypothesisNodeOf(state, hypothesisId)?.seq;
}

// The `stop` node a state is closed by (`stop` relation, move → stop), if any. This is a
// control fact (the arm is done), not truth. The closure (and its `why`) lives on the state's
// `move`; it is not a turn (docs/en/ir.md §2.2).
export function stopOf(state: State, moveId: string): string | undefined {
  for (const edge of state.edges.values()) {
    if (edge.kind === "stop" && edge.from === moveId) return edge.to;
  }
  return undefined;
}

export function hasStopped(state: State, moveId: string): boolean {
  return stopOf(state, moveId) !== undefined;
}

// The request's `unactionable` node, if the model declined to formulate a goal for it
// (`unactionable` relation). A declined request is terminal.
export function unactionableOf(state: State, requestId: string): string | undefined {
  for (const edge of state.edges.values()) {
    if (edge.kind === "unactionable" && edge.from === requestId) return edge.to;
  }
  return undefined;
}

// The last child of a container: the LAST appended node (order = append order). Used for the
// request's current state (`move`) and the focused state's latest turn.
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

// The outcome of an action (docs/en/ir.md §4): a command that mutated a file is a
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
    stateEntries: new Map(base.stateEntries),
    reverted: new Set(base.reverted),
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
      }
      if (event.node.kind === "move") {
        const raw = (event.node.payload as { state?: unknown } | undefined)?.state;
        const island = typeof raw === "string" ? (raw === "finish" ? "end" : raw) : undefined;
        if (island !== undefined) {
          state.stateEntries.set(island, (state.stateEntries.get(island) ?? 0) + 1);
        }
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
      // Ordered children: a request's states (`move`), a state's turns (`turn`), and a
      // hypothesis's sub-hypotheses (`hypothesis`).
      if (
        event.edge.kind === "move" ||
        event.edge.kind === "turn" ||
        event.edge.kind === "hypothesis"
      ) {
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
    case "revert": {
      for (const file of event.files) state.mutated.set(file.ref, file.version);
      state.reverted.add(event.patchMoveId);
      state.lastMutationSeq = state.seq;
      break;
    }
    case "rollback": {
      // The world was restored outside the tree; the journal keeps the fact. The restored
      // versions are re-observed by `reconcile` on the next projection.
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
