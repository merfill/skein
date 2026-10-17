// The islands of work a goal can be entered in — a closed vocabulary, single-sourced the way
// `FRAGMENT` was (docs/prompt_state_machine_concept.md). `ISLAND_IDS` is the source of truth:
// the `create_goal` tool's `state` enum expands from it (`src/llm/schemas.ts`), and the base
// prompt renders the state graph, the per-state instructions and their transitions from
// `ISLANDS` (`src/loop/prompt/blocks.ts`), so the model's call contract and the prompt map
// cannot drift. A goal's `state` is authored by the doxa at `create_goal` and never changes; it
// is a label, never a gate (docs/ir_semantics.md §2.5, §8).

export const ISLAND_IDS = [
  "orientation",
  "localization",
  "patch",
  "verification",
  "finish",
] as const;

export type IslandId = (typeof ISLAND_IDS)[number];

export interface Island {
  id: IslandId;
  label: string;
  // What the state is: the kind of work done here (a predicate, not a step).
  what: string;
  // The state of knowledge that shows you are done here.
  criterion: string;
  // How to act in this state — the engine's instruction, rendered once when the state is entered.
  instruction: string;
  // The per-turn hint for an open state: what to do or avoid in THIS state. `turnInstruction`
  // places it after the state's criterion and before the shared closure rule. It is not the
  // state's goal (`what`) and not the one-time `instruction`.
  hint: string;
  // The apply-tools admissible in this state (native names). The model surface is bound from it
  // (`toolNamesFor`), so a state only offers the tools that belong to its work: the write-class
  // (`edit`/`write`/`apply_patch`) lives in Patch alone. The island still never closes a state
  // and never gates a `move` — it delimits the ACTION surface only (docs/ir_semantics.md §2.5).
  applies: readonly string[];
  // The transitions out of this state: a target and the precondition ("when"). A floating or
  // terminal state carries none (docs/prompt_state_machine_concept.md §4.3).
  next: readonly { to: IslandId; when: string }[];
}

// The tool sets a state's `applies` is drawn from. The write-class belongs to Patch alone; the
// inspection/run set is shared for now (per-state pruning of `bash`/`webfetch` is deferred).
const INSPECT: readonly string[] = ["read", "grep", "list", "bash", "webfetch"];
const WRITE: readonly string[] = ["edit", "write", "apply_patch"];
const PATCH_TOOLS: readonly string[] = [...INSPECT, ...WRITE];

export const ISLANDS: Record<IslandId, Island> = {
  orientation: {
    id: "orientation",
    label: "Orientation",
    what: "map the project — its repository root, how it is built and how it is checked",
    criterion:
      "the repository root, the build and acceptance commands (or that the project has none), " +
      "and whether the project is under version control are known",
    instruction:
      "Explore the repository with the search tools: read the project's documentation (README, HACKING) " +
      "to find the repository root, how it is built, and how it is checked. Do not hunt the defect, " +
      "reproduce the failure, or compare with an upstream reference.",
    hint:
      "Establish the absolute repository root with `pwd` (or a command that prints it), not from the " +
      "request or documentation; map how the project is built and checked. Do not hunt the defect.",
    applies: INSPECT,
    next: [{ to: "localization", when: "the project is mapped" }],
  },
  localization: {
    id: "localization",
    label: "Localization",
    what: "find the failure in the code",
    criterion: "the file(s) of the suspected defect are named, with the coordinates or not",
    instruction:
      "Read the suspect code and compare it with its siblings — the other loops that walk the " +
      "same structure (the same pools or heap); a different advance or encoding there is the signal. " +
      "Name the file(s) and lines. Do not prove the defect, apply a fix, or compare with an upstream reference.",
    hint:
      "Name the file(s) and the line; compare the suspect code with the sibling walkers of the same " +
      "structure. Do not apply the fix or edit the tree.",
    applies: INSPECT,
    next: [{ to: "patch", when: "the coordinates are named" }],
  },
  patch: {
    id: "patch",
    label: "Patch",
    what: "apply the located fix",
    criterion: "the fix is applied in the workspace",
    instruction: "Apply the located fix in the workspace — the minimal change.",
    hint:
      "Apply only the change named in the `Finish state Localization` line; edit that line. Do not " +
      "substitute a different line, remove an existing step, or edit sibling walkers. If a " +
      "`Previous failed attempt` block is present, do not repeat that change; apply a different one.",
    applies: PATCH_TOOLS,
    next: [{ to: "verification", when: "the fix is applied in the workspace" }],
  },
  verification: {
    id: "verification",
    label: "Verification",
    what: "confirm the fix by running the request's acceptance command",
    criterion: "the request's acceptance command now passes",
    instruction: "Run the request's acceptance command and read its result.",
    hint:
      "Run the request's acceptance command and read its result. If it passes, `stop`. If it ran " +
      "and failed (build or tests), `stop`; choose the next state: `patch` when the Localization " +
      "coordinates still hold and only the change failed, `localization` when the failure puts the " +
      "diagnosis in doubt. `why` = a literal retelling of the failure: the command, its exit status, " +
      "and the actual error/output (quote the first real error, not the whole tail). Do not " +
      "interpret the code, do not propose a fix, and do not say whether the patch is wrong. If it " +
      "could not run because the environment is not " +
      "ready — wrong working directory, missing testsuite/build artifacts, or `ocamltest` missing — " +
      "do not stop: fix the environment and retry.",
    applies: INSPECT,
    next: [
      { to: "finish", when: "the acceptance command passes" },
      { to: "patch", when: "it fails but the localization coordinates still hold — only the change was wrong" },
      { to: "localization", when: "it fails and the diagnosis is in doubt" },
    ],
  },
  finish: {
    id: "finish",
    label: "Finish",
    what: "finish the request",
    criterion: "",
    instruction: "The work is done; finish the request.",
    hint: "Call `stop` now to end the request.",
    applies: [],
    next: [],
  },
};

export const ISLAND_ORDER: readonly IslandId[] = ISLAND_IDS;

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

// The terminal state: reaching it is the sign of the end; it carries no goal and accepts
// `stop` directly (docs/plans/archive/state_protocol_plan.md §2, §6.7).
export const TERMINAL_ISLAND: IslandId = "finish";

export function isTerminalIsland(value: string): boolean {
  return value === TERMINAL_ISLAND;
}

export function isIsland(value: string): value is IslandId {
  return (ISLAND_IDS as readonly string[]).includes(value);
}
