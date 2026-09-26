import type { Event } from "../src/ir/events";
import { fold } from "../src/ir/graph";

/** Invariant: a claim may be `verified` only if a passing check named it. */
export function verifiedWithoutCheck(events: readonly Event[]): string[] {
  const state = fold(events);
  const checked = new Set<string>();
  for (const event of events) {
    if (event.type === "record_check" && event.verdict === "pass") {
      for (const id of event.claimIds) checked.add(id);
    }
  }
  const violations: string[] = [];
  for (const node of state.nodes.values()) {
    if (
      node.kind === "claim" &&
      state.statuses.get(node.id) === "verified" &&
      !checked.has(node.id)
    ) {
      violations.push(node.id);
    }
  }
  return violations;
}
