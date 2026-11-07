// The islands of work a goal can be entered in — a closed vocabulary, single-sourced the way
// `FRAGMENT` was (docs/en/system_prompt.md). `ISLAND_IDS` is the source of truth for
// the `move` tool's `state` enum (`src/llm/schemas.ts`) and `START_ISLAND_IDS` for the request's
// startable states, so the model's call contract and the prompt map cannot drift. A goal's
// `state` is authored by the doxa at `create_goal` and never changes; it is a label, never a
// gate (docs/en/ir.md §2.5, §8).

export const ISLAND_IDS = [
  "research",
  "patch",
  "construction",
  "verification",
  "end",
] as const;

export type IslandId = (typeof ISLAND_IDS)[number];

// Every island is live; the request starts directly in the work. Kept as a named alias so the
// `move` surface and the request stay explicit.
export const LIVE_ISLAND_IDS = ISLAND_IDS;

export type LiveIslandId = (typeof LIVE_ISLAND_IDS)[number];

// The states a fresh request can start in. There is no START node in the graph, so the list is
// explicit: a request moves directly into the work.
export const START_ISLAND_IDS: readonly LiveIslandId[] = ["patch", "research", "construction"];

// A general-unit work segment is not a coding island; it is one generic state in the IR.
export const GENERAL_STATE = "general" as const;
export type StateId = IslandId | typeof GENERAL_STATE;

export interface Island {
  id: IslandId;
  label: string;
  // What the state is: the kind of work done here (a predicate, not a step).
  what: string;
  // The state of knowledge that shows you are done here.
  criterion: string;
  // How to act in this state — the engine's instruction. Rendered in the per-turn working
  // prompt as the `Plan`, after the state's goal and criterion.
  instruction: string;
  // The apply-tools admissible in this state (native names). The model surface is bound from it
  // (`toolNamesFor`), so a state only offers the tools that belong to its work: Patch changes an
  // existing artifact, Research writes a derived result, Construction builds a new artifact.
  // The island still never closes a state and never gates a `move` — it delimits the ACTION
  // surface only (docs/en/ir.md §2.5).
  applies: readonly string[];
  // The transitions out of this state: a target and the precondition ("when"). A floating or
  // terminal state carries none (docs/en/system_prompt.md §4.3).
  next: readonly { to: IslandId; when: string }[];
}

// The tool sets a state's `applies` is drawn from. The write-class belongs to the productive
// states only — Patch (existing artifact), Research (derived output), Construction (new
// artifact); inspection states never get it.
const INSPECT: readonly string[] = ["read", "grep", "list", "bash", "webfetch"];
const WRITE: readonly string[] = ["edit", "write", "apply_patch"];
const PATCH_TOOLS: readonly string[] = [...INSPECT, ...WRITE];
const RECOVER_TOOLS: readonly string[] = [...INSPECT, "write"];
const CONSTRUCT_TOOLS: readonly string[] = [...INSPECT, ...WRITE];

export const ISLANDS: Record<IslandId, Island> = {
  research: {
    id: "research",
    label: "Research",
    what: "solve a situation: derive the required result from the material or the specification",
    criterion:
      "the task's required result exists in its declared form, is derived from the material or " +
      "the specification, and matches what the material or the request contains.",
    instruction:
      "Work from the material, not from its appearance: a read-only check on a copy is allowed " +
      "and preferred over guessing, and the material confirms the result. The material is " +
      "evidence — change it only where the task says to (repair the damaged file, clean the " +
      "repository); otherwise write the result beside it. The workspace root, the repository " +
      "status and the environment are in the tape: they are already read. When the required " +
      "result exists and matches the material, reply with it as text only.",
    applies: RECOVER_TOOLS,
    next: [
      {
        to: "end",
        when: "the required result exists in its declared form and matches the material or the request",
      },
      {
        to: "patch",
        when: "the work is a code defect not yet located or fixed",
      },
    ],
  },
  patch: {
    id: "patch",
    label: "Patch",
    what: "find the defect in the existing artifact and make the change it needs",
    criterion: "the plan is complete: the error is found and fixed",
    instruction:
      "1. Find the file with the coordinates and the cause of the error.\n" +
      "2. Fix the error and stop with a report about it.",
    applies: PATCH_TOOLS,
    next: [
      {
        to: "verification",
        when: "the change is applied, and the edited lines read back",
      },
      {
        to: "research",
        when: "the work turns out to be a situation, not a defect to locate and fix",
      },
    ],
  },
  construction: {
    id: "construction",
    label: "Construction",
    what: "build the new artifact from the specification or the material's behaviour",
    criterion:
      "the artifact exists, is derived from the specification or the material's behaviour, and " +
      "the acceptance check passes",
    instruction:
      "Build the artifact from the specification the request declares, or from the behaviour of " +
      "the program it names. Check it on representative inputs and fix it until the check " +
      "passes. The material stays unchanged.",
    applies: CONSTRUCT_TOOLS,
    next: [
      {
        to: "end",
        when: "the artifact exists, is derived from the specification or the material's behaviour, and the acceptance check passes",
      },
      {
        to: "research",
        when: "the check failed for a method reason: the method or specification did not hold",
      },
    ],
  },
  verification: {
    id: "verification",
    label: "Verification",
    what: "check the changed artifact against the goal's acceptance",
    criterion:
      "the acceptance holds: the acceptance command passes, or every declared constraint holds, " +
      "and the result is derived from the source material, not synthesized",
    instruction:
      "Run the acceptance command if the workspace has one; otherwise check the declared " +
      "constraints, and read the output itself — a zero exit status is not proof that the check " +
      "passed. The acceptance is the one the request declares: do not substitute a criterion of " +
      "your own. Do not change the artifact here, not with an edit and not with a shell command. " +
      "If the check could not run because the environment is not ready — wrong working directory, " +
      "missing build or test artifacts — fix the environment and retry.\n\n" +
      "If it passes, close the state. If it fails, close it too and put the failure in the " +
      "result: the command or constraint, its exit status, and the first real error, quoted. Do " +
      "not interpret the code and do not propose a fix — that is the next state's work.",
    applies: INSPECT,
    next: [
      { to: "end", when: "the required result exists, and the acceptance holds" },
      { to: "patch", when: "the acceptance fails" },
    ],
  },
  end: {
    id: "end",
    label: "End",
    what: "complete the request",
    criterion: "",
    instruction:
      "The work is done; complete the request. Reply with the final report as text only, with no " +
      "tool calls.\n\n" +
      "Read the tape — the request, the states the task passed, what each of them did, the files " +
      "it changed, and how the result was checked — and write the report from those records in " +
      "GitHub-flavored Markdown: what was done and where, how it was verified, and what is still " +
      "open. Your reply is shown to the user as-is.",
    applies: [],
    next: [],
  },
};

export const ISLAND_ORDER: readonly IslandId[] = LIVE_ISLAND_IDS;

// The state's description, shown ONCE when the state is entered (a `system` turn on the tape):
// what the state is and the knowledge that closes it. The doxa's concretized `what`/`done`
// (carried on the `move`) override the island's generic text when present.
export function stateDescription(island: Island, what?: string, done?: string): string {
  const goal = what !== undefined && what !== "" ? what : island.what;
  const criterion = done !== undefined && done !== "" ? done : island.criterion;
  const lines = [`State: ${island.label} — ${goal}.`];
  if (criterion !== "") lines.push(`Done: ${criterion}.`);
  return lines.join("\n");
}

// The terminal state: reaching it is the sign of the end; it carries no goal and is closed
// directly by the doxa's text reply (recorded as `stop`).
export const TERMINAL_ISLAND: IslandId = "end";

export function isTerminalIsland(value: string): boolean {
  return value === TERMINAL_ISLAND;
}

export function isIsland(value: string): value is IslandId {
  return (LIVE_ISLAND_IDS as readonly string[]).includes(value);
}
