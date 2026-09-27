import { forbiddenPatterns, matchesPath } from "../ir/constraints";
import type { State } from "../ir/graph";
import type { Proposal } from "../llm/schemas";

export type Category = "derivable" | "cited" | "hypothesis" | "rejected";

export interface Classification {
  category: Category;
  accept: boolean;
  reason?: string;
}

export function classify(proposal: Proposal, state: State): Classification {
  const action = proposal.action;

  if (action.tool === "edit") {
    for (const pattern of forbiddenPatterns(state)) {
      if (matchesPath(pattern, action.path)) {
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
