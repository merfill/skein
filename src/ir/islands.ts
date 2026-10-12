// The islands of work a goal can be entered in — a closed vocabulary, single-sourced the way
// `FRAGMENT` is (docs/prompt_state_machine_concept.md). `ISLAND_IDS` is the source of truth:
// the `create_goal` tool's `state` enum expands from it (`src/llm/schemas.ts`), and the base
// prompt renders the descriptions from `ISLANDS` (`src/loop/prompt/blocks.ts`), so the model's
// call contract and the prompt map cannot drift. A goal's `state` is authored by the doxa at
// `create_goal` and never changes; it is a label, never a gate (docs/ir_semantics.md §2.5, §8).

export const ISLAND_IDS = [
  "reconnaissance",
  "localization",
  "reproduction",
  "reference",
  "design",
  "patch",
  "verification",
  "env_triage",
  "handoff",
] as const;

export type IslandId = (typeof ISLAND_IDS)[number];

export interface Island {
  id: IslandId;
  label: string;
  // The state of knowledge that shows you are done here (a predicate, not a step).
  criterion: string;
  // The relief: constraints relevant here (one behavior each).
  relief: string;
  // The states a transition leads to (a precondition, not an order).
  next: readonly IslandId[];
}

export const ISLANDS: Record<IslandId, Island> = {
  reconnaissance: {
    id: "reconnaissance",
    label: "Reconnaissance",
    criterion:
      "you know the entry point, the build and test commands and the relevant paths",
    relief: "batch independent reads/greps; wide first, then narrow",
    next: ["reproduction", "localization", "design"],
  },
  reproduction: {
    id: "reproduction",
    label: "Reproduction",
    criterion:
      "a command fails observably and the failure is the goal's, not the environment's",
    relief: "tell \"not found\" from \"not built\"",
    next: ["localization"],
  },
  localization: {
    id: "localization",
    label: "Localization",
    criterion:
      "you can name the file, the line and the exact change to make (or the missing symbol/contract)",
    relief:
      "do not recall code — read it; the moment the change is named, patch now; if the target lines are already on the tape, name the exact replacement and edit, do not re-derive",
    next: ["patch", "reference", "design"],
  },
  reference: {
    id: "reference",
    label: "Reference",
    criterion:
      "the reference is on disk and usable, or the attempts are exhausted and you derive it yourself",
    relief:
      "an unavailable reference is a fact, not a reason to retry; keep a small budget",
    next: ["localization", "patch"],
  },
  design: {
    id: "design",
    label: "Design",
    criterion:
      "the set of changes, or the sequence, is concrete and its first item is executable now",
    relief: "the first item is a literal action, not a description",
    next: ["patch"],
  },
  patch: {
    id: "patch",
    label: "Patch",
    criterion: "the exact change is in the workspace",
    relief: "edit for a targeted change; oldString must be unique",
    next: ["verification"],
  },
  verification: {
    id: "verification",
    label: "Verification",
    criterion: "the acceptance command that failed now passes",
    relief:
      "do not re-verify what passed; do not repeat a failed command — change the approach; run builds/tests in the foreground",
    next: ["handoff", "localization"],
  },
  env_triage: {
    id: "env_triage",
    label: "Environment triage",
    criterion:
      "you have named the failure as environmental or the goal's, and prepared the environment if it is environmental",
    relief: "building the project is setup, not the defect",
    next: ["reconnaissance", "reproduction", "localization", "patch", "verification"],
  },
  handoff: {
    id: "handoff",
    label: "Hand-off",
    criterion: "the work is verified and closed with stop",
    relief: "do not close before verification",
    next: [],
  },
};

export const ISLAND_ORDER: readonly IslandId[] = ISLAND_IDS;

export function isIsland(value: string): value is IslandId {
  return (ISLAND_IDS as readonly string[]).includes(value);
}
