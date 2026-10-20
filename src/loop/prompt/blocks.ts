import { ISLAND_ORDER, ISLANDS, TERMINAL_ISLAND, type IslandId } from "../../ir/islands";

export interface PromptBlock {
  id: string;
  text: string;
}

// The transitions, rendered from the single island list (src/ir/islands.ts): each state's
// outgoing edges with their precondition, grouped by source. Branches are several lines; the
// corrective cycle (verification → localization) is explicit
// (docs/prompt_state_machine_concept.md §4.3).
const TRANSITIONS = (() => {
  const lines: string[] = [];
  for (const id of ISLAND_ORDER) {
    const island = ISLANDS[id];
    for (const edge of island.next) {
      lines.push(`- ${island.label} → ${ISLANDS[edge.to].label} — ${edge.when}.`);
    }
  }
  lines.push("Finish is terminal: move there when the work is done and `stop`.");
  return lines.join("\n");
})();

// The states, rendered from the island list (single source): each is a goal (`what`) and the
// knowledge that closes it (`done`). The base prompt carries the whole set, once.
// The states are the map: each is its kind of work (`what`). The stop criterion is NOT here —
// it is delivered per turn in the focused state's hint (see `turnInstruction`), so it appears
// once, at the highest recency, and never duplicates the map.
const STATES = ISLAND_ORDER.map((id) => `- ${ISLANDS[id].label} — ${ISLANDS[id].what}.`).join("\n");

// The states a request can start in, shown in the request hint. There is no START node in the
// graph, so the list is explicit: add a state here to offer it at the request. Orientation is
// the only start: every path begins by mapping the material and the acceptance.
const START_ISLANDS: readonly IslandId[] = ["orientation"];
const renderStates = (ids: readonly IslandId[]): string =>
  ids.map((id) => `- ${ISLANDS[id].label} — ${ISLANDS[id].what}.`).join("\n");
const START_STATES = renderStates(START_ISLANDS);

// How to set the state's `notes` at the request — the state's goal and criterion are its own
// (from the island); the request only contributes presumptions to verify. At a transition the
// source is the state you just finished (its `Finish` line); the request is the overall context.
const REQUEST_NOTES =
  "Take the state's own goal as it stands — do not fold the request into `what`; leave `done` out " +
  "(the state's default criterion applies). `notes` = what the request presumes about this state, " +
  "in the context of the material (the area, files, records, or the acceptance it points to) — " +
  "carried in as an assumption to verify against the material, since the request may be wrong. " +
  "The environment and material facts are the engine's; do not repeat them in `notes`. One short " +
  "line — up to ~20 words.";

// S1 — the base contract: who the agent is and the output discipline. It does NOT repeat the
// tool descriptions — those ship in the request's `tools` field (the single source is the
// registry, `PROPOSAL_TOOLS`). Stable, so a good cache prefix.
export const BASE_BLOCKS: readonly PromptBlock[] = [
  {
    id: "B4",
    text: `You are always in exactly one state; the state is its goal.

States:
${STATES}

Work the state — your tool calls are its steps — until its goal is reached, then \`stop\`. The engine returns you to it; then \`move\` to the next state its transitions name; when they lead to Finish, \`move\` there and \`stop\` to end the request.

Transitions — move on as soon as the condition holds:
${TRANSITIONS}

The result must come from the source material or the request's specification. Do not synthesize, invent, or reconstruct values or artifacts to satisfy a count, a form, or an expected answer. A check that only reads your own output is not acceptance: compare against the source or specification.`,
  },
];

// S2 — the request scenario (a fresh request: choose the first state, or decline). It carries the
// request's presumptions into the state as `notes`; the state's own goal and criterion stand as-is
// (docs/ir_semantics.md §2.5). Appended as a system message at the end of the request turn
// (never stored).
const REQUEST_BLOCKS: readonly PromptBlock[] = [
  {
    id: "B6",
    text: `Choose the state to start in from the user's request: call \`move\` to enter it, or \`decline\` if the request admits no such state.

Startable states:
${START_STATES}

${REQUEST_NOTES}`,
  },
];

// S3 — the fresh-state scenario (plan): give the state's first plan item.
const MOVE_BLOCKS: readonly PromptBlock[] = [
  {
    id: "B7",
    text:
      `Call a tool — the action that advances the goal above. If the state's goal already ` +
      `holds from its entry and the request, \`stop\` now. Work on the material without ` +
      `consuming it: copy raw artifacts before any command that may checkpoint, delete, or ` +
      `rewrite them.`,
  },
];

// S4 — the open-state scenario (working): work the state, then stop it.
const GOAL_BLOCKS: readonly PromptBlock[] = [
  {
    id: "B8",
    text: `Work the state, then stop it. When its goal is reached, \`stop\` — do not re-check, do not over-work.
- A failed step: try a different action, never repeat it.
- To leave the state you must \`stop\` first; a \`move\` while it is open is refused.`,
  },
];

// The state-specific transition rule: the hint of the finished state is not visible on the
// transition turn, so the rule that decides among its reachable states lives here.
function transitionRule(island?: IslandId): string[] {
  switch (island) {
    case "orientation":
      return [
        "Choose Localization only when the deliverable is a change to an existing artifact and the next work is to name it or its cause — a file, function, record, image, or commit. A source that exists is not automatically the target: choose Research when the deliverable is a new artifact built from a specification or source behaviour, hidden/encoded/deleted data, a situation, or a method.",
      ];
    case "localization":
      return [
        "Choose Patch when the target is named, its siblings are ruled out, and a suspected cause is named; mark the cause unverified.",
      ];
    case "recovery":
      return [
        "Choose Finish only when the output is derived from the source and the source's own integrity/consistency check passes. If no candidate was accepted, or the check could not decide, choose Research. If the source was the wrong object, choose Localization. If the recovered material must now be applied as a change to an existing artifact, choose Patch.",
      ];
    case "construction":
      return [
        "Choose Finish only when the artifact is derived from the specification or the source's behaviour and the acceptance check passes. If the check failed because the method or specification did not hold, choose Research. If the source or input was wrong, choose Localization.",
      ];
    case "verification":
      return [
        "After a failed acceptance, choose Patch by default: the located object is still the material, and the failure is in the produced change or result (value, length, format, span, assembly). Choose Localization only when the failure names a different object (a different file, function, record, or image), or the object was not found; a change that did not fix the symptom is not enough.",
      ];
    default:
      return [];
  }
}

// S5 — the finished-state scenario: the tape above carries the record (each finished state is a
// `Start state` / goal / `Finish state` triple) and the user's request. The hint names the states
// reachable from the focused one and carries the request's presumptions into the next state as
// `notes` — the next state's OWN goal stands as-is (never carried from the `Finish` line).
// Dynamic, like `turnInstruction`.
export function transitionInstruction(island?: IslandId): string {
  const targets = island !== undefined ? ISLANDS[island].next.map((edge) => edge.to) : [];
  const candidates = [...new Set<IslandId>(targets)];
  const canFinish = candidates.includes(TERMINAL_ISLAND);
  const label = island !== undefined ? ISLANDS[island].label : undefined;
  const head =
    label !== undefined
      ? `Your result is the line \`Finish state ${label} — …\` above — read it.`
      : `Your result is the finished state's \`Finish\` line above — read it.`;
  return [
    `${head} From it and the user's request, choose the next state: call \`move\` to enter it.${canFinish ? " If the work is done, `move` to Finish and `stop` there." : ""}`,
    `Next states${label !== undefined ? ` from ${label}` : ""}:\n${renderStates(candidates)}`,
    ...transitionRule(island),
    `Take the next state's own goal as it stands — do not fold the finished state's result or the request into \`what\`; leave \`done\` out (the state's default criterion applies). \`notes\` = what the request and the just-finished result presume about this state — carried in as assumptions to verify against the material. One short line — up to ~20 words.`,
  ].join("\n\n");
}

// S6 — the terminal scenario: stop to finish the request.
const TERMINAL_BLOCKS: readonly PromptBlock[] = [
  {
    id: "B10",
    text: `This is Finish. ${ISLANDS.finish.hint}`,
  },
];

const assemble = (blocks: readonly PromptBlock[]): string => blocks.map((block) => block.text).join("\n\n");

export const BASE_PROMPT = assemble(BASE_BLOCKS);

// The request-step instruction, appended as a system message after the request: it scopes the
// first `move`'s `what` (never the whole task). Rendered per turn (never stored), like the
// open-state nudge below.
export const REQUEST_INSTRUCTION = assemble(REQUEST_BLOCKS);

// The recency nudge on an open state, appended last each turn: when the state's criterion
// holds the doxa MUST close it (`stop`), and it must not keep acting. It restates the current
// state's criterion (concretized `done`, island fallback) so the doxa does not have to recall
// the one-time state description far up the tape.
// The per-turn tail: conduct (the state's own hint), the concretized goal, the done criterion,
// then the closure. Ordered conduct → goal → stop: the state's own behavior sits at the top of
// the tail and the stop criterion stays last.
function stateTail(island?: IslandId, done?: string, what?: string): string {
  const criterion =
    done !== undefined && done !== ""
      ? done
      : island !== undefined
        ? ISLANDS[island].criterion
        : "";
  const lead =
    criterion !== ""
      ? `This state's done criterion: "${criterion.replace(/\.\s*$/, "")}".`
      : `This state is done when its goal holds.`;
  const conduct = island !== undefined ? ISLANDS[island].hint : "";
  const goal =
    what !== undefined && what !== ""
      ? what
      : island !== undefined
        ? ISLANDS[island].what
        : "";
  return [
    conduct,
    goal !== "" ? `what: ${goal}` : "",
    lead,
    "When it holds, `stop` — and nothing else. Do not over-work the state, and do not do another state's work. Keep the source material intact: copy raw artifacts before any command that may checkpoint, delete, or rewrite them.",
  ]
    .filter((part) => part !== "")
    .join(" ");
}

export function turnInstruction(island?: IslandId, done?: string, what?: string): string {
  return stateTail(island, done, what);
}

export const NODE_INSTRUCTIONS: Record<"plan" | "working" | "terminal", string> = {
  plan: assemble(MOVE_BLOCKS),
  working: assemble(GOAL_BLOCKS),
  terminal: assemble(TERMINAL_BLOCKS),
};

// The plan turn is the state's first action: the generic "call a tool" plus the same state
// hint the working turns carry, so the state's own guidance is present when the first action
// is chosen.
export function planInstruction(island?: IslandId, done?: string, what?: string): string {
  if (island === undefined) return NODE_INSTRUCTIONS.plan;
  return `${NODE_INSTRUCTIONS.plan}\n\n${stateTail(island, done, what)}`;
}

export const PROMPT_BLOCKS: readonly PromptBlock[] = [
  ...BASE_BLOCKS,
  ...REQUEST_BLOCKS,
  ...MOVE_BLOCKS,
  ...GOAL_BLOCKS,
  ...TERMINAL_BLOCKS,
];
