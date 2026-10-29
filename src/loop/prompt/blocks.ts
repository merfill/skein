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
  lines.push("End is terminal.");
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

// How to set the state's `what` at the request: the state's goal and criterion are its own
// (from the island); the request only names the object or situation the state will work on.
const REQUEST_WHAT =
  "`what` names the object or situation this state will work on — one short phrase, up to ~20 " +
  "words; do not restate the request or the task. Leave `done` out: the state's own criterion applies.";

// The base: the stable system prompt, in block order. B1 is the role; B2 the principles; B3
// the state map; B4 the moves (transitions). It does NOT repeat the tool descriptions — those
// ship in the request's `tools` field (the single source is the registry, `PROPOSAL_TOOLS`).
// Stable, so a good cache prefix.
export const BASE_BLOCKS: readonly PromptBlock[] = [
  {
    id: "B1",
    text: `# Role

You are a software engineering agent with access to the user's filesystem. You solve the user's tasks.

## How you work

You solve a task by moving between states; you are in exactly one state at a time, and the state is its goal — one step of the work with its own stop criterion. Work the state until its criterion holds, then call \`stop\`: it ends the state and records its result as the \`Finish\` line. After a state is stopped, choose the next state and call \`move\` to enter it.

Each turn you reply with tool calls; the engine runs them in order and returns the results. Batch calls that do not depend on another call's result.`,
  },
  {
    id: "B2",
    text: `## General instructions for work inside a state

Follow the project. Mimic its style, structure, naming, typing and architectural patterns; make the change idiomatic to the surrounding code. Add comments sparingly (why, not what), and never use comments to talk to the user.

Work only the state's goal: plan the step, make small changes, and debug from evidence. Do not do another state's work or expand the scope.

Work from the material in this workspace. The result must come from that material or from the request's specification. Do not invent values or fabricate results to fit a count, a form, or an expected answer. Acceptance is decided by the material or the specification, not by your own output.

The workspace map and the environment are engine-recorded facts: they are already read — do not re-probe, re-list, or re-derive them. If a block is marked partial, only the unlisted facts are unknown.

Never expose or commit secrets or keys. Report concisely; no preamble or summary unless asked.`,
  },
  {
    id: "B3",
    text: `## States\n\n**These are descriptions of the states; do not use them as instructions inside a state.**\n\nStates:\n${STATES}`,
  },
  {
    id: "B4",
    text: `## Transitions\n\n**These are descriptions of the transitions; use them only to choose the next state after the current state is stopped — they are not instructions inside a state.**\n\nTransitions — move on as soon as the condition holds:\n${TRANSITIONS}`,
  },
];

// The request prompt (`request`): the request scenario (a fresh request: choose the first state, or
// decline). `what` names the object or situation the state will work on; the state's own goal and
// criterion stand as-is (docs/ir_semantics.md §2.5). Appended as a system message at the end of the
// request turn (never stored).
const REQUEST_BLOCKS: readonly PromptBlock[] = [
  {
    id: "request",
    text: `Choose the state to start in from the user's request: call \`move\` to enter it, or \`decline\` if the request admits no such state.

Startable states:
${START_STATES}

${REQUEST_WHAT}`,
  },
];

// The state-specific transition rule: the hint of the finished state is not visible on the
// transition turn, so the rule that decides among its reachable states lives here.
function transitionRule(island?: IslandId): string[] {
  switch (island) {
    case "orientation":
      return [
        "Move to Localization when the request is to find an error in existing code or files.",
        "Move to Construction when the request fully specifies the new artifact — you can write it now.",
        "Otherwise move to Research.",
      ];
    case "localization":
      return [
        "Choose Patch when the target is named and a cause is suspected.",
        "Choose Research only when the work is a situation, not a code defect to locate.",
      ];
    case "research":
      return [
        "Choose Localization when the work is a code defect to locate.",
      ];
    case "recovery":
      return [
        "Choose End only when the output exists in its declared form, is derived from the material, and matches what the material contains. Otherwise choose Research — the method failed or the output does not match the material.",
      ];
    case "construction":
      return [
        "Choose End only when the artifact is derived from the specification or the material's behaviour and the acceptance check passes. If the check failed because the method or specification did not hold, choose Research.",
      ];
    case "verification":
      return [
        "After a failed acceptance, choose Patch by default: the located object is still the material, and the failure is in the produced change or result (value, length, format, span, assembly). Choose Localization only when the failure names a different object (a different file, function, record, or image), or the object was not found; a change that did not fix the symptom is not enough.",
      ];
    default:
      return [];
  }
}

// The transition prompt (`transition`): the finished-state scenario: the tape above carries the
// record (each finished state is a `Start state` / `Finish state` pair) and the user's request.
// The hint names the states reachable from the focused one; the next state's OWN goal stands
// as-is (never carried from the `Finish` line). Dynamic, like `turnInstruction`.
export function transitionInstruction(island?: IslandId): string {
  const targets = island !== undefined ? ISLANDS[island].next.map((edge) => edge.to) : [];
  const candidates = [...new Set<IslandId>(targets)];
  const canFinish = candidates.includes(TERMINAL_ISLAND);
  const label = island !== undefined ? ISLANDS[island].label : undefined;
  const head =
    label !== undefined
      ? `Your result is the line \`Finish state ${label} — …\` above — read it.`
      : `Your result is the finished state's \`Finish\` line above — read it.`;
  const reachable =
    label !== undefined
      ? `Only these states are reachable from ${label} — choose one of them.`
      : `Only these states are reachable — choose one of them.`;
  const tail = [
    "Choose the next state only. Do not design, derive, or solve that state's work on this turn; its tools and instruction come after the move.",
    `Call \`move\` alone. Set \`what\` to the object or situation the next state will work on — the artifact, record, or situation, not the task — in one short phrase, up to ~20 words. Do not restate the request, the finished state's result, or the plan. Leave \`done\` out: the state's own criterion applies.`,
  ];
  if (island === "orientation") {
    return [
      `${head} From it and the user's request, move to the next state: call \`move\` to enter it.`,
      `Next states: ${candidates.map((id) => ISLANDS[id].label).join(", ")}.`,
      ...transitionRule(island),
      ...tail,
    ].join("\n\n");
  }
  return [
    `${head} From it and the user's request, choose the next state: call \`move\` to enter it.${canFinish ? " If the work is done, \`move\` to End." : ""}`,
    `Next states${label !== undefined ? ` from ${label}` : ""}:\n${renderStates(candidates)}`,
    reachable,
    ...transitionRule(island),
    ...tail,
  ].join("\n\n");
}

const assemble = (blocks: readonly PromptBlock[]): string => blocks.map((block) => block.text).join("\n\n");

export const BASE_PROMPT = assemble(BASE_BLOCKS);

// The request prompt, appended as a system message after the request: it scopes the first
// `move`'s `what` (never the whole task). Rendered per turn (never stored).
export const REQUEST_INSTRUCTION = assemble(REQUEST_BLOCKS);

// The plan prompt: the state's first step. The per-turn tail below follows it.
const MOVE_INSTRUCTION =
  "Call a tool — the action that advances the goal above. If the state's goal already holds " +
  "from its entry and the request, `stop` now. Work on the material without consuming it: copy " +
  "raw artifacts before any command that may checkpoint, delete, or rewrite them.";

// The per-turn tail of an open state, appended last on `plan`/`working`: conduct (the state's
// own hint), the done criterion, then the closure. The state's goal is the hand-written one on
// the tape; the doxa's `what` is only a guess and never enters the tail. Blocks are separated by
// blank lines. Rendered per turn (never stored), so the next turn's tape is rebuilt without it.
function stateTail(island?: IslandId, done?: string): string {
  const criterion =
    done !== undefined && done !== ""
      ? done
      : island !== undefined
        ? ISLANDS[island].criterion
        : "";
  const lead =
    criterion !== ""
      ? `Done when: "${criterion.replace(/\.\s*$/, "")}".`
      : `Done when its goal holds.`;
  const conduct = island !== undefined ? ISLANDS[island].hint : "";
  return [
    conduct,
    lead,
    "When it holds, `stop` — and nothing else. Do not over-work the state, and do not do another state's work. Keep the source material intact: copy raw artifacts before any command that may checkpoint, delete, or rewrite them.",
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

export function turnInstruction(island?: IslandId, done?: string): string {
  return stateTail(island, done);
}

export function planInstruction(island?: IslandId, done?: string): string {
  if (island === undefined) return MOVE_INSTRUCTION;
  return `${MOVE_INSTRUCTION}\n\n${stateTail(island, done)}`;
}

export const NODE_INSTRUCTIONS = {
  terminal: `This is End. ${ISLANDS[TERMINAL_ISLAND].hint}`,
};

export const PROMPT_BLOCKS: readonly PromptBlock[] = [...BASE_BLOCKS, ...REQUEST_BLOCKS];
