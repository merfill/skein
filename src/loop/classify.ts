import { forbiddenConstraints, matchesPath } from "../ir/constraints";
import { isAvailableCapability } from "../ir/fragment";
import type { State } from "../ir/graph";
import { deriveMode } from "../ir/project";
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

function isReadGrounded(state: State, cite: string): boolean {
  const ids = state.nodes.has(cite) ? [cite] : [`file:${cite}`];
  for (const id of ids) {
    const node = state.nodes.get(id);
    if (!node) continue;
    if (node.kind === "observation") {
      const payload = node.payload as { ref?: unknown } | undefined;
      if (typeof payload?.ref === "string") return true;
    }
    if (node.kind === "file") {
      for (const edge of state.edges.values()) {
        if (
          edge.kind === "locates" &&
          edge.provenance.kind === "read" &&
          edge.provenance.ref === id
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

export function classify(proposal: Proposal, state: State): Classification {
  const action = proposal.action;

  if (action.tool === "edit") {
    for (const { id, pattern } of forbiddenConstraints(state)) {
      if (matchesPath(pattern, action.path)) {
        return reject(`constraint_violation:${pattern}`, id);
      }
    }
    const mode = deriveMode(state);
    if (mode === "explore" || mode === "revise") {
      return reject("no_open_hypothesis");
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
      if (action.cite !== undefined) {
        if (!isReadGrounded(state, action.cite)) return reject("invalid_cite");
        return { category: "cited", accept: true };
      }
    }
    return { category: "hypothesis", accept: true };
  }

  if (action.tool === "abstain") {
    const missing = action.missing.trim().toLowerCase();
    if (missing === "") return reject("empty_missing");
    if (isAvailableCapability(missing)) return reject("capability_available");
    return { category: "derivable", accept: true };
  }

  return { category: "derivable", accept: true };
}
