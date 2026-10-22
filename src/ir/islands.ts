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
  "research",
  "patch",
  "recovery",
  "construction",
  "verification",
  "end",
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
  // (`toolNamesFor`), so a state only offers the tools that belong to its work: Patch changes an
  // existing artifact, Recovery writes only the output/search script, Construction builds a new
  // artifact. The island still never closes a state and never gates a `move` — it delimits the
  // ACTION surface only (docs/ir_semantics.md §2.5).
  applies: readonly string[];
  // The transitions out of this state: a target and the precondition ("when"). A floating or
  // terminal state carries none (docs/prompt_state_machine_concept.md §4.3).
  next: readonly { to: IslandId; when: string }[];
}

// The tool sets a state's `applies` is drawn from. The write-class belongs to the productive
// states only — Patch (existing artifact), Recovery (output/search script), Construction (new
// artifact); inspection states never get it.
const INSPECT: readonly string[] = ["read", "grep", "list", "bash", "webfetch"];
const WRITE: readonly string[] = ["edit", "write", "apply_patch"];
const PATCH_TOOLS: readonly string[] = [...INSPECT, ...WRITE];
const RECOVER_TOOLS: readonly string[] = [...INSPECT, "write"];
const CONSTRUCT_TOOLS: readonly string[] = [...INSPECT, ...WRITE];

const LOCALIZATION_CRITERION =
  "the target is named — the file, record, image, or function — with the coordinates or " +
  "extent that identify it; its siblings are ruled out; and a suspected cause is named — the " +
  "expression, step, or encoding that looks wrong and the rule or invariant it breaks — " +
  "marked unverified";

export const ISLANDS: Record<IslandId, Island> = {
  orientation: {
    id: "orientation",
    label: "Orientation",
    what: "know the task's inputs and how success is judged",
    criterion:
      "the workspace root and its top-level entries are known; the repository status is noted; " +
      "and the acceptance is named from the request — an in-workspace command, an external " +
      "verifier, or declared constraints",
    instruction:
      "Read the request and the workspace map: root, repository status, top-level entries. Name " +
      "the acceptance as the request declares it. If the request and the map already name the " +
      "inputs and the acceptance, `stop`.",
    hint:
      "The workspace map is the index; the request is the acceptance. Do not go inside " +
      "entries, check paths, or inspect build state, configs, history, or contents — those " +
      "belong to the next state. Even if the request points to a file, do not open it here: " +
      "the acceptance is already named; file contents belong to the next state.",
    applies: INSPECT,
    next: [
      {
        to: "localization",
        when: "the request requires finding an artifact — a code defect, a file, a record, an image, or a commit",
      },
      {
        to: "research",
        when: "the request is a situation or a method and no artifact is the target — hidden data, legacy behaviour, a specification, or a synthesis",
      },
    ],
  },
  localization: {
    id: "localization",
    label: "Localization",
    what: "find the target in the material",
    criterion: LOCALIZATION_CRITERION,
    instruction:
      "Find the target in the material — the file, record, image, or function — and name its " +
      "coordinates or extent. Before inspecting, think about what the code is supposed to do " +
      "from the user's request, the workspace map (filesystem facts), the environment (available " +
      "tools), and the filenames; use that to choose which files and symbols to inspect. For " +
      "shell work, use only the tools the environment lists; missing ones are unavailable. " +
      "Distinguish it from its siblings by shape, code, or signature. Name the target, say why " +
      "the siblings are not it, and name a suspected cause: the expression, step, or encoding " +
      "that looks wrong and the rule or invariant it breaks. Mark the cause unverified. Do not " +
      "change the target.",
    hint:
      "Start from the workspace map (filesystem facts) and the environment (available tools). " +
      "Think about what the code is supposed to do from the filenames and the directory " +
      "structure: list the relevant directories and choose the candidate files by name — the " +
      "implementation and the definitions or headers it uses — then inspect those. Work from " +
      "the file you are reading: its own comments and the neighbouring code are the evidence. " +
      "Find the sibling that performs the same traversal or operation — the neighbouring loop " +
      "or function — and follow its pattern. A suspected cause is enough to stop — do not look " +
      "for a different bug. criterion: \"" + LOCALIZATION_CRITERION + "\".",
    applies: INSPECT,
    next: [
      {
        to: "patch",
        when: "the target is named and a cause is suspected",
      },
    ],
  },
  research: {
    id: "research",
    label: "Research",
    what: "investigate the situation and establish the method",
    criterion:
      "the situation is explained — what happened, what the source does, or what must be built — " +
      "and the method's steps and the check that will decide success are named: what to search, " +
      "decode, crack, or build, and which property decides a candidate — the source's own " +
      "(checksum, hash, container metadata, structural invariant, known records) when there is a " +
      "source, otherwise the specification's acceptance. Name the steps and the check; the " +
      "derivation, the search, and the build belong to the productive state.",
    instruction:
      "Inspect the material with the search tools and read the source the request names. Explain " +
      "the situation: what happened, what the source does, or what must be built. Then name the " +
      "method and the check the source itself provides — what to search, decode, crack, or " +
      "implement, and which source-internal property decides a candidate. The method is a plan, " +
      "not its execution: do not build the parser, the cracker, or the deliverable here. Identify " +
      "the format from the source's own signatures, not from its head or its entropy: structures " +
      "can sit at any offset. Work on a copy in /tmp: opening a source with its own tool (a " +
      "database, an archive, an index) can rewrite it — checkpoint, truncate, or delete a " +
      "companion file — so never open the original. A probe is only for a signature scan or a " +
      "check you cannot establish by reading; write it once under /tmp. Do not change the " +
      "material and do not compare with an external reference.",
    hint:
      "Name the situation, the method's steps, and the check; do not derive, crack, decode, or " +
      "build anything here — the productive state does that. A candidate merely present in the " +
      "bytes, or merely matching the declared form, is not a check. Say what the source IS: its " +
      "format or container, from its own signatures — an unidentified source is an open " +
      "situation, not a method. A binary source can hide its structures at any offset: scan the " +
      "whole source for known signatures instead of judging it by its head or its entropy. The " +
      "tape already holds what you observed: do not re-read or re-derive it. If the request fully " +
      "specifies the artifact and nothing is unknown, do not design the artifact on the way out — " +
      "thinking it through here is doing the next state's work. Mark coordinates approximate " +
      "unless the bytes confirmed them. The workspace map and the `Finish state Orientation` line " +
      "are the map; do not re-map.",
    applies: INSPECT,
    next: [
      {
        to: "recovery",
        when: "the hidden, encoded, or deleted data must be reconstructed from the source",
      },
      {
        to: "construction",
        when: "a new artifact or program must be built from the specification or the source's behaviour",
      },
    ],
  },
  patch: {
    id: "patch",
    label: "Patch",
    what: "make the named change to the artifact",
    criterion: "the change is applied to the located artifact from the located material, and its result has the declared form",
    instruction:
      "Apply the change the located material names. If the result has a declared form (path, " +
      "length, format), produce it and check that form in the same step. Do not relocate the " +
      "artifact or re-derive the cause.",
    hint:
      "The cause is the one the previous state's `Finish` line names — apply the change it " +
      "implies. Do not re-derive the cause or choose a different one. Read the definition of " +
      "every symbol the change uses — the file that defines it, not a usage — and the sibling " +
      "the line cites; use them only to confirm the change. If the result has a declared form, " +
      "print it and check it in the same step; do not synthesize values or artifacts to satisfy " +
      "the form.",
    applies: PATCH_TOOLS,
    next: [
      {
        to: "verification",
        when: "the change is applied to the located artifact from the located material and its result has the declared form",
      },
    ],
  },
  recovery: {
    id: "recovery",
    label: "Recovery",
    what: "recover the required result from the source",
    criterion:
      "the required output exists, is derived from the source, and the source's own " +
      "integrity/consistency check passes — a match to the declared form or mere presence in the " +
      "source is not enough",
    instruction:
      "Reconstruct the hidden data from the source. You may and should create and modify files: " +
      "write the search script, the required output, and any scratch copies you need. Keep the " +
      "source itself read-only — work on copies or decoded copies; do not edit the source. Use " +
      "the method and the source check Research named; do not re-derive the container structure. " +
      "Keep the script minimal. Run it in place. Do not synthesize values.",
    hint:
      "Apply the method Research named; do not re-discover the source structure. The source stays " +
      "read-only; create and change the script, output, and scratch copies. Search with a script, " +
      "not by hand: enumerate candidates or decodings and keep only those that pass the source's " +
      "own check. A candidate that matches only the declared form is not accepted. Include a " +
      "negative control: a wrong candidate that fits the form must be rejected. Do not fabricate.",
    applies: RECOVER_TOOLS,
    next: [
      {
        to: "end",
        when: "the required output exists, is derived from the source, and the source's own integrity/consistency check passes",
      },
      {
        to: "research",
        when: "the method or the source check failed — no candidate was accepted, or the check cannot decide",
      },
    ],
  },
  construction: {
    id: "construction",
    label: "Construction",
    what: "build the new artifact from the specification or source behaviour",
    criterion:
      "the artifact exists, is derived from the specification or the source's behaviour, and the " +
      "acceptance check — the declared form, or the source behaviour on representative inputs — " +
      "passes",
    instruction:
      "Build the artifact from the request's specification. When the request names a source " +
      "program or artifact to modernize or translate, its behaviour is the specification. Write " +
      "an acceptance check — a test harness, a differential run, or the declared form — run it, " +
      "and fix the artifact until it passes. Do not modify the source.",
    hint:
      "Do not repair the source. Check the artifact against the specification or the source's " +
      "behaviour on representative inputs; a file that merely exists is not done. If the check " +
      "fails, fix the artifact.",
    applies: CONSTRUCT_TOOLS,
    next: [
      {
        to: "end",
        when: "the artifact exists, is derived from the specification or source behaviour, and the acceptance check passes",
      },
      {
        to: "research",
        when: "the method or specification did not hold — the check failed for a method reason",
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
      "constraints. Read the actual result. Do not write the acceptance or change the artifact.",
    hint:
      "Run the acceptance command if the workspace has one; otherwise check the declared " +
      "constraints, and read the actual result. Do not change the artifact here — not with an " +
      "edit, not with a shell command. A check that only reads your own output is not " +
      "acceptance: compare the result against the source material. If it could not run because " +
      "the environment is not ready — wrong working directory or missing build/test artifacts — " +
      "fix the environment and retry.",
    applies: INSPECT,
    next: [
      { to: "end", when: "the acceptance holds" },
      { to: "patch", when: "it fails but the located object still holds — the failure is in the change or result (value, length, format, span, assembly)" },
      { to: "localization", when: "it fails and the object itself is in doubt — not found, or the failure points to a different object" },
    ],
  },
  end: {
    id: "end",
    label: "End",
    what: "complete the request",
    criterion: "",
    instruction: "The work is done; complete the request.",
    hint: "Call `stop` when the request is complete.",
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
export const TERMINAL_ISLAND: IslandId = "end";

export function isTerminalIsland(value: string): boolean {
  return value === TERMINAL_ISLAND;
}

export function isIsland(value: string): value is IslandId {
  return (ISLAND_IDS as readonly string[]).includes(value);
}
