import type { State } from "./graph";
import type { NodeKind } from "./types";

const PROGRESS_KINDS = new Set<NodeKind>([
  "claim",
  "subgoal",
  "decision",
  "check",
  "file",
  "symbol",
  "test",
]);

export function knowledgeKey(state: State): string {
  const parts: string[] = [];
  for (const node of state.nodes.values()) {
    if (!PROGRESS_KINDS.has(node.kind)) continue;
    const status = state.statuses.get(node.id) ?? "";
    parts.push(`${node.id}:${status}`);
  }
  parts.sort();
  return parts.join("|");
}
