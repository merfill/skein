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
  // How to act in this state — the engine's instruction, rendered once when the state is entered.
  instruction: string;
  // The per-turn hint for an open state: what to do or avoid in THIS state. `turnInstruction`
  // places it after the state's criterion and before the shared closure rule. It is not the
  // state's goal (`what`) and not the one-time `instruction`.
  hint: string;
  // The apply-tools admissible in this state (native names). The model surface is bound from it
  // (`toolNamesFor`), so a state only offers the tools that belong to its work: Patch changes an
  // existing artifact, Recovery writes the output and scratch copies, Construction builds a new
  // artifact. The island still never closes a state and never gates a `move` — it delimits the
  // ACTION surface only (docs/ir_semantics.md §2.5).
  applies: readonly string[];
  // The transitions out of this state: a target and the precondition ("when"). A floating or
  // terminal state carries none (docs/prompt_state_machine_concept.md §4.3).
  next: readonly { to: IslandId; when: string }[];
}

// The tool sets a state's `applies` is drawn from. The write-class belongs to the productive
// states only — Patch (existing artifact), Recovery (output/scratch copies), Construction (new
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
    what: "name the workspace root, its top-level entries, the repository status, and the acceptance the request declares",
    criterion:
      "the workspace root and its top-level entries are known; the repository status is noted; " +
      "and the acceptance is named from the request — an in-workspace command, an external " +
      "verifier, or declared constraints",
    instruction:
      "Read the workspace map: root, repository status, top-level entries. The request is only " +
      "the source of the acceptance — name it as the request declares it; do not restate, " +
      "interpret, or solve the task. This state only reads the map: do not create or modify " +
      "files. If the map and the request already name those, `stop` now. Do not list inside the " +
      "entries, verify build targets or paths, read file contents, or inspect history or data " +
      "formats — those belong to the next state.",
    hint:
      "The map is the index; the request names the acceptance. Name them; do not restate the " +
      "task or work on it. Do not list inside entries, check paths, or inspect build state, " +
      "configs, history, or contents.",
    applies: INSPECT,
    next: [
      {
        to: "localization",
        when: "the request is to find an error in existing code or files",
      },
      {
        to: "research",
        when: "the request is a situation: not an error in code and not a fully specified new artifact",
      },
      {
        to: "construction",
        when: "the request fully specifies the new artifact — it can be written now",
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
      "implementation and the definitions or headers it uses — then inspect those. Compare the " +
      "target with the sibling that performs the same traversal or operation — the neighbouring " +
      "loop or function — and use its pattern as the reference. A suspected cause is enough to " +
      "stop — do not look for a different bug.",
    applies: INSPECT,
    next: [
      {
        to: "patch",
        when: "the target is named and a cause is suspected",
      },
      {
        to: "research",
        when: "the work is a situation, not a code defect to locate",
      },
    ],
  },
  research: {
    id: "research",
    label: "Research",
    what: "investigate the situation and establish the method",
    criterion:
      "the situation is explained — what happened, what the source does, or what must be built — " +
      "and the method is named: the steps that will produce the result. The work itself belongs " +
      "to the productive state.",
    instruction:
      "Explain the situation: what happened, what the source does, or what must be built. Name " +
      "the method for this work — the steps that will produce the result — but do not carry it " +
      "out here; the productive state does that. The workspace map and the environment are " +
      "recorded facts: they are already read — do not re-probe or re-list them. Leave the " +
      "material as you found it.",
    hint:
      "Explain the situation and name the method; do not do the work here — the productive state " +
      "does that. Identify the source from its content, not from its appearance. Do not change " +
      "the material; if a tool might change it, work on a copy.\n\n" +
      "The tape already holds what you observed; the workspace map and the environment are " +
      "recorded facts. Do not re-read, re-probe, or re-list them.\n\n" +
      "If the request fully specifies the result and nothing is unknown, do not design it here — " +
      "that is the next state's work.",
    applies: INSPECT,
    next: [
      {
        to: "recovery",
        when: "the hidden, encoded, or deleted data must be reconstructed from the material",
      },
      {
        to: "construction",
        when: "a new artifact or program must be built from the specification or the material's behaviour",
      },
      {
        to: "localization",
        when: "the work is a code defect to locate",
      },
    ],
  },
  patch: {
    id: "patch",
    label: "Patch",
    what: "make the named change to the artifact",
    criterion:
      "the change is complete — the located artifact and every other file the task needs are " +
      "created or updated — and the result has the declared form",
    instruction:
      "Apply the change the located material names. The change includes every other file the " +
      "task needs, created or updated. If the result has a declared form (path, length, format), " +
      "produce it and check that form in the same step. Do not relocate the artifact or " +
      "re-derive the cause. Do not defer a required file to another state.",
    hint:
      "The cause is the one the previous state's `Finish` line names — apply the change it " +
      "implies. The change includes every other file the task needs; do not defer a required " +
      "file to another state. Do not re-derive the cause or choose a different one. Read the " +
      "definition of every symbol the change uses — the file that defines it, not a usage — and " +
      "the sibling the line cites; use them only to confirm the change. If the result has a " +
      "declared form, print it and check it in the same step; derive its values from the " +
      "material — do not fabricate them.",
    applies: PATCH_TOOLS,
    next: [
      {
        to: "verification",
        when:
          "the change is complete — the located artifact and every other file the task needs " +
          "are created or updated — and the result has the declared form",
      },
    ],
  },
  recovery: {
    id: "recovery",
    label: "Recovery",
    what: "recover the required output from the material",
    criterion:
      "the required output exists in its declared form, is derived from the material, and " +
      "matches what the material contains",
    instruction:
      "Reconstruct the required output from the material. Create the output and any working " +
      "copies; keep the material read-only.",
    hint:
      "Keep the material read-only; write the required output and working copies. Do not " +
      "fabricate. If a tool is missing, fix the environment before replacing it.",
    applies: RECOVER_TOOLS,
    next: [
      {
        to: "end",
        when: "the required output exists in its declared form, is derived from the material, and matches what the material contains",
      },
      {
        to: "research",
        when: "the method failed, or the output does not match the material",
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
      "Build the artifact from the specification. When the request names a program or artifact " +
      "whose behaviour is the specification, use that behaviour. Write and run an acceptance " +
      "check; fix the artifact until it passes. Leave the material unchanged.",
    hint:
      "Check the artifact against the specification or the material's behaviour on representative " +
      "inputs. The artifact must pass the check; if it fails, fix the artifact.",
    applies: CONSTRUCT_TOOLS,
    next: [
      {
        to: "end",
        when: "the artifact exists, is derived from the specification or the material's behaviour, and the acceptance check passes",
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
    hint:
      "Call `stop` when the request is complete; the finished state's check is the verification — " +
      "do not re-verify here.",
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
