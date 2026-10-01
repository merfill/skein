import { invalidatedClaimIds, type RejectionRecord, type State } from "./graph";
import { NODE_KINDS, type Node, type NodeKind, type Status } from "./types";

export { invalidatedClaimIds };

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
  tail?: number;
  budget?: { turn: number; maxTurns: number };
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

function refusalLines(state: State, tail: number): string[] {
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
    .slice(0, tail)
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
  const tail = options.tail ?? 6;
  const nodes = [...state.nodes.values()];
  const stale = staleRefs(state);
  const statusOf = (id: string): Status | undefined =>
    state.statuses.get(id) ?? state.edgeStatuses.get(id);

  const openClaimNodes = nodes
    .filter((node) => node.kind === "claim" && statusOf(node.id) === "open")
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
    .filter((node) => node.kind === "decision" && statusOf(node.id) === "active")
    .sort(bySeqDesc)
    .map((node) => ({ id: node.id, label: node.label, over: overOf(node.id) }));

  const subgoals = nodes
    .filter((node) => node.kind === "subgoal" && statusOf(node.id) === "open")
    .sort(bySeqDesc)
    .slice(0, tail)
    .map((node) => ({ id: node.id, label: node.label }));

  const achievedSubgoals = nodes
    .filter((node) => node.kind === "subgoal" && statusOf(node.id) === "achieved")
    .sort(bySeqDesc)
    .slice(0, tail)
    .map((node) => `${node.id}: ${node.label}`);

  const lastAction = nodes
    .filter((node) => node.kind === "action")
    .sort(bySeqDesc)[0];

  const observations = latestObservationPerClaim(state, openClaimNodes);

  const invalidated = invalidatedClaimIds(state);

  const verifiedClaims = nodes
    .filter((node) => node.kind === "claim" && statusOf(node.id) === "verified")
    .sort(bySeqDesc);

  const verified = verifiedClaims
    .filter((node) => !invalidated.has(node.id))
    .slice(0, tail)
    .map((node) => `${node.id}: ${node.label}`);

  const invalidatedLines = verifiedClaims
    .filter((node) => invalidated.has(node.id))
    .map((node) => `${node.id}: ${node.label}`);

  const rejected = nodes
    .filter((node) => {
      const status = statusOf(node.id);
      return status === "refuted" || status === "superseded";
    })
    .map((node) => `${node.id}: ${node.label}`);

  const refusals = refusalLines(state, tail);

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
    recent: [...nodes].sort(bySeqDesc).slice(0, tail).map((node) => ({
      id: node.id,
      kind: node.kind,
      label: node.label,
    })),
  };

  const recent = [...(options.recent ?? [])].slice(-tail);

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
