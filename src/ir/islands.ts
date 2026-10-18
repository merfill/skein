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
    what: "map the material and how success is judged",
    criterion:
      "the material is known — what exists (files, records, images, a repository) — and how " +
      "success is judged (an in-workspace command, an external verifier, or declared constraints); " +
      "whether it is under version control is noted when relevant",
    instruction:
      "Inspect the material with the search tools: what exists (files, records, images, a " +
      "repository) and how success is judged (a command, an external verifier, or declared " +
      "constraints). Do not hunt the target, reproduce the failure, or compare with an external " +
      "reference.",
    hint:
      "Establish the root of the material with `pwd` (or a command that prints it), not from the " +
      "request or documentation; map what exists and how success is judged. Do not hunt the target.",
    applies: INSPECT,
    next: [{ to: "localization", when: "the material is mapped and the acceptance is known" }],
  },
  localization: {
    id: "localization",
    label: "Localization",
    what: "find the target in the material",
    criterion:
      "the target is named — the file, record, image, or function — with the coordinates or " +
      "extent that identify it, and the sibling material is ruled out",
    instruction:
      "Inspect the material: find the target and distinguish it from its siblings — the other " +
      "files, records, loops, or candidates of the same shape. A difference in shape, advance, " +
      "encoding, or bytes is the signal. Name the target and its coordinates or extent. Do not " +
      "prove it, do not change it, and do not compare with an external reference.",
    hint:
      "Name the target and its coordinates or extent, and say why the sibling material is not it. " +
      "When that is named, stop — do not prove the target or re-read the whole material. Do not " +
      "change it.",
    applies: INSPECT,
    next: [{ to: "patch", when: "the target is named and its siblings are ruled out" }],
  },
  patch: {
    id: "patch",
    label: "Patch",
    what: "make the change the goal names",
    criterion: "the change is made from the located material and its result has the declared form",
    instruction:
      "Apply the located change. If the result has a declared form (path, length, format), " +
      "produce it and check that form in the same step.",
    hint:
      "Make the change the target names; do not relocate the target. If a `Previous failed attempt` " +
      "block is present, do not repeat that change; apply a different one. If the change produces a " +
      "value or artifact with a declared form, print it and check the form in the same step — a wrong " +
      "result is caught here. Do not re-verify the diagnosis. The change must be derived from the " +
      "located material: do not synthesize values or artifacts to satisfy the declared form.",
    applies: PATCH_TOOLS,
    next: [{ to: "verification", when: "the change is made from the located material and its result has the declared form" }],
  },
  verification: {
    id: "verification",
    label: "Verification",
    what: "check the change against the goal's acceptance",
    criterion: "the acceptance holds: the acceptance command passes, or every declared constraint holds, and the result is derived from the source material, not synthesized",
    instruction:
      "Run the acceptance command if the workspace has one; otherwise check the declared " +
      "constraints. Read the actual result.",
    hint:
      "Run the acceptance command if the workspace has one; otherwise check the declared " +
      "constraints. If it passes, `stop`. If it fails, `stop`; choose the next state: `patch` when " +
      "the object you located (the file, record, image, or function) is still the material the " +
      "change must use, and the failure is in the produced change or result — its value, length, " +
      "format, span, or assembly. Re-reading or re-assembling the same object is part of the change, " +
      "not a new localization. `localization` only when the object itself is not found, or the " +
      "failure points to a different object. A wrong length, format, value, byte span, or an " +
      "incomplete-looking fragment is not a different object. A check that only reads your own output " +
      "is not acceptance: compare the result against the source material, not just its count or " +
      "form; do not accept synthesized data. " +
      "`why` = a literal retelling of the failure: the command or constraint, its exit status and " +
      "the actual output (quote the first real error, not the whole tail). Do not interpret the " +
      "code, do not propose a fix, and do not say whether the change is wrong. If it could not run " +
      "because the environment is not ready — wrong working directory, missing testsuite/build " +
      "artifacts, or `ocamltest` missing — do not stop: fix the environment and retry.",
    applies: INSPECT,
    next: [
      { to: "finish", when: "the acceptance holds" },
      { to: "patch", when: "it fails but the located object still holds — the failure is in the change or result (value, length, format, span, assembly)" },
      { to: "localization", when: "it fails and the object itself is in doubt — not found, or the failure points to a different object" },
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
