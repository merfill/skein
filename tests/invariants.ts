import type { Event } from "../src/ir/events";
import { fold } from "../src/ir/graph";

/** Invariant: a state is closed only by the doxa's `stop` — every `stop` relation must
 * target a `stop` node. */
export function achievedWithoutCheck(events: readonly Event[]): string[] {
  const state = fold(events);
  const violations: string[] = [];
  for (const edge of state.edges.values()) {
    if (edge.kind !== "stop") continue;
    if (state.nodes.get(edge.to)?.kind !== "stop") violations.push(edge.from);
  }
  return violations;
}

/** Invariant: structural edges (`plan`, `items`, `alts`, `unactionable`) form a DAG — no
 * cycles. */
export function structuralCycle(events: readonly Event[]): boolean {
  const state = fold(events);
  const kinds = new Set(["plan", "items", "alts", "unactionable"]);
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
