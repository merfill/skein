import { forbiddenConstraints, matchesPath } from "../ir/constraints";
import type { State } from "../ir/graph";
import type { NodeKind } from "../ir/types";
import type { Proposal } from "../llm/schemas";

export type Category = "derivable" | "cited" | "hypothesis" | "rejected";

export interface Classification {
  category: Category;
  accept: boolean;
  reason?: string;
  constraintId?: string;
}

const BINDING_PARENTS = new Set<NodeKind>(["goal", "subgoal"]);

function reject(reason: string, constraintId?: string): Classification {
  return {
    category: "rejected",
    accept: false,
    reason,
    ...(constraintId !== undefined ? { constraintId } : {}),
  };
}

function validParent(state: State, parent: string): boolean {
  const node = state.nodes.get(parent);
  return node !== undefined && BINDING_PARENTS.has(node.kind);
}

export function classify(proposal: Proposal, state: State): Classification {
  const action = proposal.action;

  if (action.tool === "edit") {
    for (const { id, pattern } of forbiddenConstraints(state)) {
      if (matchesPath(pattern, action.path)) {
        return reject(`constraint_violation:${pattern}`, id);
      }
    }
    return { category: "derivable", accept: true };
  }

  if (action.tool === "decompose" || action.tool === "decide") {
    if (action.label.trim() === "") return reject("empty_label");
    if (!validParent(state, action.parent)) return reject("invalid_parent");
    if (
      action.tool === "decide" &&
      (action.alternatives ?? []).some((alternative) => alternative === action.label)
    ) {
      return reject("alternative_equals_label");
    }
    return { category: "hypothesis", accept: true };
  }

  if (action.tool === "track") {
    if (action.label.trim() === "") return reject("empty_label");
    if (action.kind === "claim") {
      if (action.parent === undefined || action.parent.trim() === "") {
        return reject("missing_parent");
      }
      if (!validParent(state, action.parent)) return reject("invalid_parent");
    }
    return { category: "hypothesis", accept: true };
  }

  return { category: "derivable", accept: true };
}
