import { FRAGMENT } from "./fragment";
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

export const MODES = ["explore", "act", "check", "revise"] as const;
export type Mode = (typeof MODES)[number];

export function deriveMode(state: State): Mode {
  const topId = state.branch[state.branch.length - 1];
  const top = topId !== undefined ? state.nodes.get(topId) : undefined;
  if (top !== undefined) {
    return top.kind === "claim" ? claimMode(state, top) : "explore";
  }

  const reachable = reachableFromGoal(state);
  let newest: Node | undefined;
  for (const node of state.nodes.values()) {
    if (node.kind !== "claim") continue;
    if (!reachable.has(node.id)) continue;
    if (newest === undefined || node.seq > newest.seq) newest = node;
  }
  return newest === undefined ? "explore" : claimMode(state, newest);
}

function claimMode(state: State, claim: Node): Mode {
  const status = state.statuses.get(claim.id);
  if (status === "refuted") return "revise";
  if (status !== "open") return "explore";
  for (const node of state.nodes.values()) {
    if (node.kind !== "action" || !node.label.startsWith("edit ")) continue;
    if (node.seq > claim.seq) return "check";
  }
  return "act";
}

function parentId(state: State, node: Node): string | undefined {
  for (const edge of state.edges.values()) {
    if (edge.kind === "supports" && edge.from === node.id) return edge.to;
    if (edge.kind === "justifies" && edge.from === node.id) return edge.to;
    if (edge.kind === "decomposes" && edge.to === node.id) return edge.from;
  }
  return undefined;
}

function ancestorChain(state: State, focus: string): Set<string> {
  const chain = new Set<string>();
  let current: string | undefined = focus;
  while (current !== undefined && !chain.has(current)) {
    chain.add(current);
    const node = state.nodes.get(current);
    if (node === undefined || node.kind === "goal") break;
    current = parentId(state, node);
  }
  if (state.goalId !== undefined) chain.add(state.goalId);
  return chain;
}

function activeFocus(state: State, reachable: ReadonlySet<string>): string | undefined {
  let focus: Node | undefined;
  for (const node of state.nodes.values()) {
    if (node.kind !== "claim" && node.kind !== "subgoal") continue;
    if (state.statuses.get(node.id) !== "open") continue;
    if (!reachable.has(node.id)) continue;
    if (focus === undefined || node.seq > focus.seq) focus = node;
  }
  return focus?.id;
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
    mode: Mode;
    fragment: { id: string; label: string }[];
    budget?: { turn: number; maxTurns: number; remaining: number };
  };
  frontier: {
    subgoals: { id: string; label: string }[];
    achievedSubgoals: string[];
    claims: { id: string; label: string; supports?: string }[];
    facts: { id: string; label: string; cite: string; supports?: string }[];
    decisions: { id: string; label: string; over: string[] }[];
    backtrack: { id: string; label: string; kind: NodeKind }[];
    lastAction?: Node;
    observations: Node[];
    verified: string[];
    invalidated: string[];
    revisions: string[];
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

  const focusId = state.branch[state.branch.length - 1] ?? activeFocus(state, reachable);
  const branch = new Set<string>(
    focusId !== undefined
      ? ancestorChain(state, focusId)
      : state.goalId !== undefined
        ? [state.goalId]
        : [],
  );
  const inBranch = (id: string): boolean => branch.has(id);
  const parentInBranch = (node: Node): boolean => {
    const parent = parentId(state, node);
    return parent !== undefined && branch.has(parent);
  };

  const activeClaimNodes = openClaimNodes.filter(
    (node) => inBranch(node.id) || parentInBranch(node),
  );

  const supportsOf = (claimId: string): string | undefined => {
    for (const edge of state.edges.values()) {
      if (edge.kind === "supports" && edge.from === claimId) return edge.to;
    }
    return undefined;
  };

  const citeOf = (id: string): string | undefined => {
    const payload = state.nodes.get(id)?.payload as { cite?: unknown } | undefined;
    return typeof payload?.cite === "string" && payload.cite.trim() !== ""
      ? payload.cite
      : undefined;
  };

  const claims = activeClaimNodes.flatMap((node) => {
    if (citeOf(node.id) !== undefined) return [];
    const supports = supportsOf(node.id);
    return [{ id: node.id, label: node.label, ...(supports !== undefined ? { supports } : {}) }];
  });

  const facts = activeClaimNodes.flatMap((node) => {
    const cite = citeOf(node.id);
    if (cite === undefined) return [];
    const supports = supportsOf(node.id);
    return [
      {
        id: node.id,
        label: node.label,
        cite,
        ...(supports !== undefined ? { supports } : {}),
      },
    ];
  });

  const overOf = (decisionId: string): string[] => {
    const out: string[] = [];
    for (const edge of state.edges.values()) {
      if (edge.kind === "chosen_over" && edge.from === decisionId) out.push(edge.to);
    }
    return out;
  };

  const decisions = nodes
    .filter(
      (node) =>
        node.kind === "decision" &&
        statusOf(node.id) === "active" &&
        onPath(node.id) &&
        (inBranch(node.id) || parentInBranch(node)),
    )
    .sort(bySeqDesc)
    .map((node) => ({ id: node.id, label: node.label, over: overOf(node.id) }));

  const subgoals = nodes
    .filter(
      (node) =>
        node.kind === "subgoal" &&
        statusOf(node.id) === "open" &&
        onPath(node.id) &&
        inBranch(node.id),
    )
    .sort(bySeqDesc)
    .map((node) => ({ id: node.id, label: node.label }));

  const activeIds = new Set<string>([
    ...subgoals.map((entry) => entry.id),
    ...activeClaimNodes.map((node) => node.id),
    ...decisions.map((entry) => entry.id),
  ]);

  const backtrack = nodes
    .filter((node) => {
      if (!onPath(node.id)) return false;
      if (node.kind !== "subgoal" && node.kind !== "claim") return false;
      if (statusOf(node.id) !== "open") return false;
      return !activeIds.has(node.id);
    })
    .sort(bySeqDesc)
    .map((node) => ({ id: node.id, label: node.label, kind: node.kind }));

  const achievedSubgoals = nodes
    .filter((node) => node.kind === "subgoal" && statusOf(node.id) === "achieved" && onPath(node.id))
    .sort(bySeqDesc)
    .map((node) => `${node.id}: ${node.label}`);

  const lastAction = nodes
    .filter((node) => node.kind === "action")
    .sort(bySeqDesc)[0];

  const observations = latestObservationPerClaim(state, activeClaimNodes);

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

  const revisions = verifiedClaims
    .filter((node) => invalidated.has(node.id))
    .map((node) => {
      for (const edge of state.edges.values()) {
        if (edge.kind !== "verifies" || edge.to !== node.id) continue;
        if (state.edgeStatuses.get(edge.id) !== "stale") continue;
        const check = state.nodes.get(edge.from);
        const payload = check?.payload as { command?: unknown } | undefined;
        const command = typeof payload?.command === "string" ? payload.command : undefined;
        return command !== undefined
          ? `${node.id}: ${node.label} — verification after "${command}" no longer holds`
          : `${node.id}: ${node.label} — verification no longer holds`;
      }
      return `${node.id}: ${node.label} — verification no longer holds`;
    });

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
    header: {
      goal,
      constraints,
      mode: deriveMode(state),
      fragment: FRAGMENT.map((capability) => ({ id: capability.id, label: capability.label })),
      ...(budget !== undefined ? { budget } : {}),
    },
    frontier: {
      subgoals,
      achievedSubgoals,
      claims,
      facts,
      decisions,
      backtrack,
      lastAction,
      observations,
      verified,
      invalidated: invalidatedLines,
      revisions,
      rejected,
      refusals,
    },
    artifacts,
    index,
    recent,
  };
}
