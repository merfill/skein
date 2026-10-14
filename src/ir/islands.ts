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
  // The directive: the imperative for this state — what to DO here, in one line (an active
  // instruction, not a passive constraint). Shown in the state description; the running state
  // also rides the observation instruction.
  directive: string;
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
    directive:
      "Read wide, then narrow — at most two rounds of inspection — then move on. Do not derive the cause here; that is the next state's job.",
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
    directive:
      "Reproduce the failure now — run the acceptance command and read the error. If it fails for environmental reasons (missing config/deps), move to Environment triage; otherwise move to Localization.",
    next: [{ to: "localization", when: "the failure is the goal's, not the environment's" }],
  },
  localization: {
    id: "localization",
    label: "Localization",
    what: "find the exact cause: the file, the line and the expression, or the missing symbol/contract",
    criterion: "you can name the file, the line and the exact change to make",
    directive:
      "Name the file, the line and the exact replacement from what is already on the tape, and make the edit this turn — do not re-read or re-derive, and do not fetch to confirm. If one fact is genuinely missing, read exactly that, then edit.",
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
    directive:
      "Fetch the reference once. If it fails or does not fit the version, stop fetching — derive the change yourself and move to Patch.",
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
    directive:
      "State the changes and their order now, and make the first item executable. Plan no more than the task needs — a single edit needs no design.",
    next: [{ to: "patch", when: "the first item is executable now" }],
  },
  patch: {
    id: "patch",
    label: "Patch",
    what: "make the change",
    criterion: "the exact change is in the workspace",
    directive:
      "Make the change now with a single `edit` (make `oldString` unique). After it lands, move to Verification — do not re-read the file you changed.",
    next: [{ to: "verification", when: "the change is in the workspace" }],
  },
  verification: {
    id: "verification",
    label: "Verification",
    what: "confirm the change with the acceptance command/tests",
    criterion: "the acceptance command that failed now passes",
    directive:
      "Run the acceptance command in the foreground. On failure, change the approach and go back to Localization with the new evidence — never repeat the same failed command. Do not re-verify what already passed.",
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
    directive:
      "Decide now whether the failure is environmental or the goal's. Prepare the environment if it is environmental, then return to the state you came from.",
    next: [],
  },
  handoff: {
    id: "handoff",
    label: "Hand-off",
    what: "close the work",
    criterion: "the goal is closed with `stop`",
    directive:
      "Call `stop` now — the work is verified. Do not start new work and do not re-verify.",
    next: [],
  },
};

export const ISLAND_ORDER: readonly IslandId[] = ISLAND_IDS;

// The state's description, shown ONCE when the state is entered (a `system` turn on the tape):
// what the state is, the knowledge that closes it, and the directive — the imperative for what
// to DO here. The directive is active (an instruction, not a passive constraint): a passive
// description did not change behaviour in the replay experiment
// (docs/plans/prompt_stall_investigation_ru.md §6).
export function stateDescription(island: Island): string {
  return `State: ${island.label} — ${island.what}.\nDone when: ${island.criterion}.\nNow: ${island.directive}`;
}

// The terminal state: reaching it is the sign of the end; it carries no goal and accepts
// `stop` directly (docs/plans/state_protocol_plan.md §2, §6.7).
export const TERMINAL_ISLAND: IslandId = "handoff";

export function isTerminalIsland(value: string): boolean {
  return value === TERMINAL_ISLAND;
}

export function isIsland(value: string): value is IslandId {
  return (ISLAND_IDS as readonly string[]).includes(value);
}
