import type { State } from "./graph";
import type { Node, NodeKind, Status } from "./types";

export interface Turn {
  seq: number;
  kind: "proposal" | "tool";
  text: string;
}

export interface Context {
  header: { goal: Node | null; constraints: Node[] };
  frontier: {
    claims: Node[];
    decisions: Node[];
    lastAction?: Node;
    observations: Node[];
    verified: string[];
    invalidated: string[];
    rejected: string[];
  };
  artifacts: { id: string; label: string; stale: boolean }[];
  index: { id: string; kind: NodeKind; label: string }[];
  recent: Turn[];
}

export interface ProjectOptions {
  recent?: readonly Turn[];
  tail?: number;
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

export function invalidatedClaimIds(state: State): Set<string> {
  const hasLive = new Set<string>();
  const staleOnly = new Set<string>();
  for (const edge of state.edges.values()) {
    if (edge.kind !== "verifies") continue;
    if (state.edgeStatuses.get(edge.id) === "stale") staleOnly.add(edge.to);
    else hasLive.add(edge.to);
  }
  const out = new Set<string>();
  for (const id of staleOnly) {
    if (!hasLive.has(id)) out.add(id);
  }
  return out;
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

  const claims = nodes
    .filter((node) => node.kind === "claim" && statusOf(node.id) === "open")
    .sort(bySeqDesc);

  const decisions = nodes
    .filter((node) => node.kind === "decision" && statusOf(node.id) === "active")
    .sort(bySeqDesc);

  const lastAction = nodes
    .filter((node) => node.kind === "action")
    .sort(bySeqDesc)[0];

  const observations = latestObservationPerClaim(state, claims);

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

  const artifacts = nodes
    .filter((node) => node.space === "artifact")
    .map((node) => ({ id: node.id, label: node.label, stale: stale.has(node.id) }));

  const index = nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    label: node.label,
  }));

  const recent = [...(options.recent ?? [])].slice(-tail);

  const goal = state.goalId !== undefined ? state.nodes.get(state.goalId) ?? null : null;
  const constraints = nodes.filter((node) => node.kind === "constraint");

  return {
    header: { goal, constraints },
    frontier: {
      claims,
      decisions,
      lastAction,
      observations,
      verified,
      invalidated: invalidatedLines,
      rejected,
    },
    artifacts,
    index,
    recent,
  };
}
