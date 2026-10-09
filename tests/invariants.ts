import type { Event } from "../src/ir/events";
import { criterionPass, fold } from "../src/ir/graph";

/** Invariant: `achieved` needs a criterion run that exited 0. */
export function achievedWithoutCheck(events: readonly Event[]): string[] {
  const state = fold(events);
  const violations: string[] = [];
  for (const node of state.nodes.values()) {
    if (node.kind !== "goal") continue;
    if (!criterionPass(state, node.id)) continue;
    let pass = false;
    for (const obs of state.nodes.values()) {
      if (obs.kind !== "observation") continue;
      const payload = obs.payload as { target?: unknown; exitCode?: unknown } | undefined;
      if (payload?.target === node.id && payload.exitCode === 0) pass = true;
    }
    if (!pass) violations.push(node.id);
  }
  return violations;
}

/** Invariant: every non-root goal is bound by a `has_goal` (the request's interpretation)
 * or an `item` edge of a plan/alternatives. */
export function unboundGoals(events: readonly Event[]): string[] {
  const state = fold(events);
  const bound = new Set<string>();
  for (const edge of state.edges.values()) {
    if ((edge.kind === "item" || edge.kind === "has_goal") && state.nodes.get(edge.to)?.kind === "goal") {
      bound.add(edge.to);
    }
  }
  const violations: string[] = [];
  for (const node of state.nodes.values()) {
    if (node.kind !== "goal") continue;
    if (node.id === state.rootId) continue;
    if (!bound.has(node.id)) violations.push(node.id);
  }
  return violations;
}

/** Invariant: structural edges (`has_plan`, `has_goal`, `item`, `has_alternatives`,
 * `no_goal`) form a DAG — no cycles. */
export function structuralCycle(events: readonly Event[]): boolean {
  const state = fold(events);
  const kinds = new Set(["has_plan", "has_goal", "item", "has_alternatives", "no_goal"]);
  const adjacency = new Map<string, string[]>();
  for (const edge of state.edges.values()) {
    if (!kinds.has(edge.kind)) continue;
    const list = adjacency.get(edge.from);
    if (list) list.push(edge.to);
    else adjacency.set(edge.from, [edge.to]);
  }
  const visiting = new Set<string>();
  const done = new Set<string>();
  const dfs = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (done.has(id)) return false;
    visiting.add(id);
    for (const next of adjacency.get(id) ?? []) {
      if (dfs(next)) return true;
    }
    visiting.delete(id);
    done.add(id);
    return false;
  };
  for (const id of state.nodes.keys()) {
    if (dfs(id)) return true;
  }
  return false;
}
