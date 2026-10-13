// The islands of work a goal can be entered in — a closed vocabulary, single-sourced the way
// `FRAGMENT` was (docs/prompt_state_machine_concept.md). `ISLAND_IDS` is the source of truth:
// the `create_goal` tool's `state` enum expands from it (`src/llm/schemas.ts`), and the base
// prompt renders the state graph, the per-state instructions and their transitions from
// `ISLANDS` (`src/loop/prompt/blocks.ts`), so the model's call contract and the prompt map
// cannot drift. A goal's `state` is authored by the doxa at `create_goal` and never changes; it
// is a label, never a gate (docs/ir_semantics.md §2.5, §8).

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
  // What the state is: the kind of work done here (a predicate, not a step).
  what: string;
  // The state of knowledge that shows you are done here.
  criterion: string;
  // The relief: constraints relevant here (one behavior each).
  relief: string;
  // The transitions out of this state: a target and the precondition ("when"). A floating or
  // terminal state carries none (docs/prompt_state_machine_concept.md §4.3).
  next: readonly { to: IslandId; when: string }[];
}

export const ISLANDS: Record<IslandId, Island> = {
  reconnaissance: {
    id: "reconnaissance",
    label: "Reconnaissance",
    what: "build the project map: the entry point, how it builds and runs, where the relevant code and data are",
    criterion: "the entry point, the build/test commands and the files the change touches are known",
    relief:
      "batch independent reads/greps; wide first, then narrow; at most two rounds of inspection, then move",
    next: [
      { to: "reproduction", when: "there is a command that fails observably" },
      { to: "localization", when: "the cause is findable by reading" },
      { to: "design", when: "a feature or many edits" },
    ],
  },
  reproduction: {
    id: "reproduction",
    label: "Reproduction",
    what: "obtain an observable failure tied to the goal",
    criterion: "a command fails observably and the failure is the goal's, not the environment's",
    relief: "tell \"not found\" from \"not built\"; if the failure is environmental, move to Environment triage",
    next: [{ to: "localization", when: "the failure is the goal's, not the environment's" }],
  },
  localization: {
    id: "localization",
    label: "Localization",
    what: "find the exact cause: the file, the line and the expression, or the missing symbol/contract",
    criterion: "you can name the file, the line and the exact change to make",
    relief:
      "if the target lines are already on the tape, name the exact replacement and edit now — do not re-read or re-derive; read only what you still need; move to Patch in the same move",
    next: [
      { to: "patch", when: "the file, the line and the exact change are named" },
      { to: "reference", when: "external truth is needed (an upstream change, docs)" },
      { to: "design", when: "the change spans many edits" },
    ],
  },
  reference: {
    id: "reference",
    label: "Reference",
    what: "obtain external truth — an upstream change, a diff, documentation",
    criterion: "the reference is on disk, or one attempt failed and you derive it yourself",
    relief: "at most one fetch; an unavailable reference is a fact, not a reason to retry",
    next: [
      { to: "localization", when: "the reference refined your derivation" },
      { to: "patch", when: "the reference confirms the change" },
    ],
  },
  design: {
    id: "design",
    label: "Design",
    what: "choose the approach and the sequence; for a design, the interface/structure",
    criterion: "the set of changes, or the sequence, is concrete and its first item is executable now",
    relief: "the first item is a literal action, not a description; plan no more than the task needs — a single edit needs no design",
    next: [{ to: "patch", when: "the first item is executable now" }],
  },
  patch: {
    id: "patch",
    label: "Patch",
    what: "make the change",
    criterion: "the exact change is in the workspace",
    relief: "edit for a targeted change; oldString must be unique; after the edit, verify — do not re-read the file you just changed",
    next: [{ to: "verification", when: "the change is in the workspace" }],
  },
  verification: {
    id: "verification",
    label: "Verification",
    what: "confirm the change with the acceptance command/tests",
    criterion: "the acceptance command that failed now passes",
    relief:
      "run builds/tests in the foreground; never repeat a failed command — on failure change the approach and return to Localization with the new evidence; do not re-verify what passed",
    next: [
      { to: "handoff", when: "the acceptance command passes" },
      { to: "localization", when: "it fails: go back with the new evidence (corrective cycle)" },
    ],
  },
  env_triage: {
    id: "env_triage",
    label: "Environment triage",
    what: "tell an environmental failure (missing config/deps) from a failure of the goal",
    criterion:
      "the failure is named as environmental or the goal's, and the environment is prepared if it is environmental",
    relief: "building the project is setup, not the defect; this is a detour — return to the state you came from",
    next: [],
  },
  handoff: {
    id: "handoff",
    label: "Hand-off",
    what: "close the work",
    criterion: "the goal is closed with `stop`",
    relief: "call `stop` now — the work is verified; do not re-verify and do not start new work",
    next: [],
  },
};

export const ISLAND_ORDER: readonly IslandId[] = ISLAND_IDS;

export function isIsland(value: string): value is IslandId {
  return (ISLAND_IDS as readonly string[]).includes(value);
}
