import type { Event } from "../src/ir/events";
import { checkHasUnder, fold, predicateOf } from "../src/ir/graph";

/** Invariant: `achieved` needs a passing check without assumptions;
 * `achieved_under` needs a passing check with `under` or a `complete`. */
export function achievedWithoutCheck(events: readonly Event[]): string[] {
  const state = fold(events);
  const violations: string[] = [];
  for (const node of state.nodes.values()) {
    if (node.kind !== "goal") continue;
    const predicate = predicateOf(state, node.id);
    if (predicate !== "achieved" && predicate !== "achieved_under") continue;

    let pass = false;
    let under = false;
    let complete = false;
    for (const edge of state.edges.values()) {
      if (edge.kind === "verifies" && edge.to === node.id) {
        const check = state.nodes.get(edge.from);
        const payload = check?.payload as { verdict?: unknown } | undefined;
        if (payload?.verdict === "pass") {
          pass = true;
          if (checkHasUnder(state, edge.from)) under = true;
        }
      }
      if (edge.kind === "closes" && edge.to === node.id) complete = true;
    }
    if (predicate === "achieved" && !pass) violations.push(node.id);
    if (predicate === "achieved_under" && !(complete || (pass && under))) {
      violations.push(node.id);
    }
  }
  return violations;
}

/** Invariant: every non-root goal is an item of a plan or alternatives. */
export function unboundGoals(events: readonly Event[]): string[] {
  const state = fold(events);
  const bound = new Set<string>();
  for (const edge of state.edges.values()) {
    if (edge.kind === "item" && state.nodes.get(edge.to)?.kind === "goal") {
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

/** Invariant: structural edges (`has_plan`, `item`, `has_alternatives`,
 * `chosen`) form a forest — no cycles. */
export function structuralCycle(events: readonly Event[]): boolean {
  const state = fold(events);
  const kinds = new Set(["has_plan", "item", "has_alternatives", "chosen"]);
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
