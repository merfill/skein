import { invalidatedClaimIds, type RejectionRecord, type State } from "./graph";
import { NODE_KINDS, type EdgeKind, type Node, type NodeKind, type Status } from "./types";

export { invalidatedClaimIds };

const PATH_EDGE_KINDS = new Set<EdgeKind>([
  "decomposes",
  "justifies",
  "chosen_over",
  "supports",
]);

export function reachableFromGoal(state: State): Set<string> {
  const out = new Set<string>();
  if (state.goalId === undefined) return out;
  const adjacency = new Map<string, string[]>();
  const link = (from: string, to: string): void => {
    const list = adjacency.get(from);
    if (list) list.push(to);
    else adjacency.set(from, [to]);
  };
  for (const edge of state.edges.values()) {
    if (!PATH_EDGE_KINDS.has(edge.kind)) continue;
    link(edge.from, edge.to);
    link(edge.to, edge.from);
  }
  const queue = [state.goalId];
  out.add(state.goalId);
  while (queue.length > 0) {
    const id = queue.pop();
    if (id === undefined) continue;
    for (const next of adjacency.get(id) ?? []) {
      if (out.has(next)) continue;
      out.add(next);
      queue.push(next);
    }
  }
  return out;
}

export interface Turn {
  seq: number;
  kind: "proposal" | "tool";
  text: string;
}

export interface IndexEntry {
  id: string;
  kind: NodeKind;
  label: string;
}

export interface Context {
  header: {
    goal: Node | null;
    constraints: Node[];
    budget?: { turn: number; maxTurns: number; remaining: number };
  };
  frontier: {
    subgoals: { id: string; label: string }[];
    achievedSubgoals: string[];
    claims: { id: string; label: string; supports?: string }[];
    decisions: { id: string; label: string; over: string[] }[];
    lastAction?: Node;
    observations: Node[];
    verified: string[];
    invalidated: string[];
    rejected: string[];
    refusals: string[];
  };
  artifacts: { id: string; label: string; stale: boolean }[];
  index: { counts: Partial<Record<NodeKind, number>>; recent: IndexEntry[] };
  recent: Turn[];
}

export interface ProjectOptions {
  recent?: readonly Turn[];
  recentBudget?: number;
  indexWindow?: number;
  budget?: { turn: number; maxTurns: number };
}

export const DEFAULT_RECENT_BUDGET = 6000;
export const DEFAULT_INDEX_WINDOW = 10;

// The flow is the one section that carries raw tool output, so it is bounded by
// characters rather than by a list length: keep turns newest-first while they
// fit the budget, and always keep the newest turn (clipped upstream) even alone.
function recentFlow(turns: readonly Turn[], budget: number): Turn[] {
  const out: Turn[] = [];
  let total = 0;
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    if (turn === undefined) continue;
    if (out.length > 0 && total + turn.text.length > budget) break;
    out.unshift(turn);
    total += turn.text.length;
  }
  return out;
}

function bySeqDesc(a: Node, b: Node): number {
  return b.seq - a.seq;
}

function latestObservationPerClaim(state: State, claims: readonly Node[]): Node[] {
  const out: Node[] = [];
  for (const claim of claims) {
    let best: Node | undefined;
    for (const edge of state.edges.values()) {
      if (edge.to !== claim.id || edge.kind !== "verifies") continue;
      const observation = state.nodes.get(edge.from);
      if (!observation || observation.kind !== "observation") continue;
      if (best === undefined || observation.seq > best.seq) best = observation;
    }
    if (best !== undefined) out.push(best);
  }
  return out;
}

function formatRefusal(rejection: RejectionRecord): string {
  const owner = rejection.constraintId ? ` (${rejection.constraintId})` : "";
  return `${rejection.tool} ${rejection.target} — ${rejection.reason}${owner}`;
}

function refusalLines(state: State): string[] {
  const bySignature = new Map<string, { line: string; count: number; seq: number }>();
  for (const rejection of state.rejections) {
    const signature = `${rejection.tool}\u0000${rejection.target}\u0000${rejection.reason}`;
    const existing = bySignature.get(signature);
    if (existing) {
      existing.count += 1;
      if (rejection.seq >= existing.seq) {
        existing.seq = rejection.seq;
        existing.line = formatRefusal(rejection);
      }
      continue;
    }
    bySignature.set(signature, {
      line: formatRefusal(rejection),
      count: 1,
      seq: rejection.seq,
    });
  }
  return [...bySignature.values()]
    .sort((a, b) => b.seq - a.seq)
    .map((entry) => (entry.count > 1 ? `${entry.line} ×${entry.count}` : entry.line));
}

function staleRefs(state: State): Set<string> {
  const refs = new Set<string>();
  for (const [edgeId, status] of state.edgeStatuses) {
    if (status !== "stale") continue;
    const provenance = state.edges.get(edgeId)?.provenance;
    if (provenance?.kind === "read") refs.add(provenance.ref);
  }
  return refs;
}

export function project(state: State, options: ProjectOptions = {}): Context {
  const recentBudget = options.recentBudget ?? DEFAULT_RECENT_BUDGET;
  const indexWindow = options.indexWindow ?? DEFAULT_INDEX_WINDOW;
  const nodes = [...state.nodes.values()];
  const stale = staleRefs(state);
  const statusOf = (id: string): Status | undefined =>
    state.statuses.get(id) ?? state.edgeStatuses.get(id);
  const reachable = reachableFromGoal(state);
  const onPath = (id: string): boolean => reachable.has(id);

  const openClaimNodes = nodes
    .filter((node) => node.kind === "claim" && statusOf(node.id) === "open" && onPath(node.id))
    .sort(bySeqDesc);

  const supportsOf = (claimId: string): string | undefined => {
    for (const edge of state.edges.values()) {
      if (edge.kind === "supports" && edge.from === claimId) return edge.to;
    }
    return undefined;
  };

  const claims = openClaimNodes.map((node) => {
    const supports = supportsOf(node.id);
    return { id: node.id, label: node.label, ...(supports !== undefined ? { supports } : {}) };
  });

  const overOf = (decisionId: string): string[] => {
    const out: string[] = [];
    for (const edge of state.edges.values()) {
      if (edge.kind === "chosen_over" && edge.from === decisionId) out.push(edge.to);
    }
    return out;
  };

  const decisions = nodes
    .filter((node) => node.kind === "decision" && statusOf(node.id) === "active" && onPath(node.id))
    .sort(bySeqDesc)
    .map((node) => ({ id: node.id, label: node.label, over: overOf(node.id) }));

  const subgoals = nodes
    .filter((node) => node.kind === "subgoal" && statusOf(node.id) === "open" && onPath(node.id))
    .sort(bySeqDesc)
    .map((node) => ({ id: node.id, label: node.label }));

  const achievedSubgoals = nodes
    .filter((node) => node.kind === "subgoal" && statusOf(node.id) === "achieved" && onPath(node.id))
    .sort(bySeqDesc)
    .map((node) => `${node.id}: ${node.label}`);

  const lastAction = nodes
    .filter((node) => node.kind === "action")
    .sort(bySeqDesc)[0];

  const observations = latestObservationPerClaim(state, openClaimNodes);

  const invalidated = invalidatedClaimIds(state);

  const verifiedClaims = nodes
    .filter((node) => node.kind === "claim" && statusOf(node.id) === "verified" && onPath(node.id))
    .sort(bySeqDesc);

  const verified = verifiedClaims
    .filter((node) => !invalidated.has(node.id))
    .map((node) => `${node.id}: ${node.label}`);

  const invalidatedLines = verifiedClaims
    .filter((node) => invalidated.has(node.id))
    .map((node) => `${node.id}: ${node.label}`);

  const rejected = nodes
    .filter((node) => {
      const status = statusOf(node.id);
      return (status === "refuted" || status === "superseded") && onPath(node.id);
    })
    .map((node) => `${node.id}: ${node.label}`);

  const refusals = refusalLines(state);

  const artifacts = nodes
    .filter((node) => node.space === "artifact")
    .map((node) => ({ id: node.id, label: node.label, stale: stale.has(node.id) }));

  const tally = new Map<NodeKind, number>();
  for (const node of nodes) tally.set(node.kind, (tally.get(node.kind) ?? 0) + 1);
  const counts: Partial<Record<NodeKind, number>> = {};
  for (const kind of NODE_KINDS) {
    const count = tally.get(kind);
    if (count !== undefined) counts[kind] = count;
  }

  const index = {
    counts,
    recent: [...nodes].sort(bySeqDesc).slice(0, indexWindow).map((node) => ({
      id: node.id,
      kind: node.kind,
      label: node.label,
    })),
  };

  const recent = recentFlow(options.recent ?? [], recentBudget);

  const goal = state.goalId !== undefined ? state.nodes.get(state.goalId) ?? null : null;
  const constraints = nodes.filter((node) => node.kind === "constraint");

  const budget =
    options.budget === undefined
      ? undefined
      : {
          turn: options.budget.turn,
          maxTurns: options.budget.maxTurns,
          remaining: Math.max(0, options.budget.maxTurns - options.budget.turn),
        };

  return {
    header: { goal, constraints, ...(budget !== undefined ? { budget } : {}) },
    frontier: {
      subgoals,
      achievedSubgoals,
      claims,
      decisions,
      lastAction,
      observations,
      verified,
      invalidated: invalidatedLines,
      rejected,
      refusals,
    },
    artifacts,
    index,
    recent,
  };
}
