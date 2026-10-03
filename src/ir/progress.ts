import { predicateOf, type State } from "./graph";

// A semantic progress key: new knowledge is a changed goal predicate, a new mutation,
// a new distinct observation/check, or a new distinct negative signature. Observations
// and checks are keyed by content (kind + command/label), not by node id, and repeated
// failures/refusals collapse, so a loop of identical or uninformative moves does not
// reset the stall counter (§2.7–§2.8).
export function knowledgeKey(state: State): string {
  const parts = new Set<string>();
  for (const node of state.nodes.values()) {
    if (node.kind === "observation" || node.kind === "check") {
      parts.add(`${node.kind}:${node.label}`);
    } else if (node.kind === "action") {
      const payload = node.payload as { command?: unknown } | undefined;
      const command = typeof payload?.command === "string" ? payload.command : node.label;
      parts.add(`action:${command}:${predicateOf(state, node.id)}`);
    } else {
      parts.add(`${node.id}:${predicateOf(state, node.id)}`);
    }
  }
  for (const [ref, version] of state.mutated) parts.add(`mut:${ref}@${version}`);
  for (const rejection of state.rejections) {
    parts.add(`ref:${rejection.tool}\u0000${rejection.target}\u0000${rejection.reason}`);
  }
  return [...parts].sort().join("|");
}
