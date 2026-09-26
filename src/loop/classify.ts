import type { State } from "../ir/graph";
import type { Proposal } from "../llm/schemas";

export type Category = "derivable" | "cited" | "hypothesis" | "rejected";

export interface Classification {
  category: Category;
  accept: boolean;
  reason?: string;
}

function forbiddenPatterns(state: State): string[] {
  const patterns: string[] = [];
  for (const node of state.nodes.values()) {
    if (node.kind !== "constraint") continue;
    const payload = node.payload as { forbid?: unknown } | undefined;
    if (payload && Array.isArray(payload.forbid)) {
      for (const pattern of payload.forbid) {
        if (typeof pattern === "string") patterns.push(pattern);
      }
    }
  }
  return patterns;
}

function matches(pattern: string, path: string): boolean {
  try {
    return new RegExp(pattern).test(path);
  } catch {
    return false;
  }
}

export function classify(proposal: Proposal, state: State): Classification {
  const action = proposal.action;

  if (action.tool === "edit") {
    for (const pattern of forbiddenPatterns(state)) {
      if (matches(pattern, action.path)) {
        return {
          category: "rejected",
          accept: false,
          reason: `constraint_violation:${pattern}`,
        };
      }
    }
    return { category: "derivable", accept: true };
  }

  if (action.tool === "track") {
    if (action.label.trim() === "") {
      return { category: "rejected", accept: false, reason: "empty_label" };
    }
    return { category: "hypothesis", accept: true };
  }

  return { category: "derivable", accept: true };
}
