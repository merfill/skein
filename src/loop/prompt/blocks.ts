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
const STATES = ISLAND_ORDER.map((id) => {
  const island = ISLANDS[id];
  const done = island.criterion !== "" ? ` Done: ${island.criterion}.` : "";
  return `- ${island.label} — ${island.what}.${done}`;
}).join("\n");

// The states a request can start in, shown in the request hint. There is no START node in the
// graph, so the list is explicit: add a state here to offer it at the request.
const START_ISLANDS: readonly IslandId[] = ["orientation", "localization"];
const renderStates = (ids: readonly IslandId[]): string =>
  ids.map((id) => `- ${ISLANDS[id].label} — ${ISLANDS[id].what}.`).join("\n");
const START_STATES = renderStates(START_ISLANDS);

// How to set the state's `what`/`done` — the source differs by situation. At the request there is
// no previous state, so the goal is the request concretized onto the state you enter. At a
// transition the source is the state you just finished (its `Finish` line): the new goal carries
// its result forward; the request is only the overall context.
const REQUEST_WHAT_DONE =
  "Set `what` and `done` for this request: `what` = the request's goal for the state you enter " +
  "— name the specific failure, area or file the request points to; `done` = the knowledge that " +
  "closes THAT state for this request. One short sentence each — up to ~20 words; do not restate " +
  "the whole task, but carry the request's specifics.";

// S1 — the base contract: who the agent is and the output discipline. It does NOT repeat the
// tool descriptions — those ship in the request's `tools` field (the single source is the
// registry, `PROPOSAL_TOOLS`). Stable, so a good cache prefix.
export const BASE_BLOCKS: readonly PromptBlock[] = [
  {
    id: "B0",
    text: `You are a coding agent. You work in a small set of states — each a step of the work with its own goal — and the engine records your moves. Each turn you reply with tool calls; the engine runs them in order and returns the results. Batch calls that do not depend on another call's result.`,
  },
  {
    id: "B4",
    text: `You are always in exactly one state; the state is its goal.

States:
${STATES}

Work the state — your tool calls are its steps — until its goal is reached, then \`stop\`. The engine returns you to it; then \`move\` to the next one, or to Finish and \`stop\` to end the request.

Transitions — move on as soon as the condition holds:
${TRANSITIONS}`,
  },
  {
    id: "B19",
    text: `The workspace is the source of truth: read the code and run it to see what happens. Do not look for a change history.`,
  },
];

// S2 — the request scenario (a fresh request: choose the first state, or decline). It scopes
// `what`: the goal of the state you enter, never the whole task — so an Orientation goal cannot
// absorb the bug-hunt the request mentions (docs/ir_semantics.md §2.5). Rendered as a system
// message right after the request, per turn (never stored).
const REQUEST_BLOCKS: readonly PromptBlock[] = [
  {
    id: "B6",
    text: `Choose the state to start in from the user's request (the previous message): call \`move\` to enter it, or \`decline\` if the request admits no such state.

Startable states:
${START_STATES}

${REQUEST_WHAT_DONE}`,
  },
];

// S3 — the fresh-state scenario (plan): give the state's first plan item.
const MOVE_BLOCKS: readonly PromptBlock[] = [
  {
    id: "B7",
    text: `Call a tool — the action that advances the goal above.`,
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

// S5 — the finished-state scenario: the tape above carries the record (each finished state is a
// `Start state` / goal / `Finish state` triple) and the user's request. The hint points the doxa
// at the JUST-FINISHED state's `Finish` line as the source of the new state's what/done (the
// request is only context), and names the states reachable from the focused one. Dynamic, like
// `turnInstruction`.
export function transitionInstruction(island?: IslandId): string {
  const targets = island !== undefined ? ISLANDS[island].next.map((edge) => edge.to) : [];
  const candidates = [...new Set<IslandId>([...targets, TERMINAL_ISLAND])];
  const label = island !== undefined ? ISLANDS[island].label : undefined;
  const head =
    label !== undefined
      ? `Your result is the line \`Finish state ${label} — …\` above — read it.`
      : `Your result is the finished state's \`Finish\` line above — read it.`;
  return [
    `${head} From it and the user's request, choose the next state: call \`move\` to enter it; if the work is done, \`move\` to Finish and \`stop\` there.`,
    `Next states${label !== undefined ? ` from ${label}` : ""}:\n${renderStates(candidates)}`,
    `Set \`what\`/\`done\` from that result: \`what\` = the concrete continuation of the state you just finished — the failure, area or file its \`Finish\` line names; \`done\` = the knowledge that closes THIS state. One short sentence each — up to ~20 words.`,
  ].join("\n\n");
}

// S6 — the terminal scenario: stop to finish the request.
const TERMINAL_BLOCKS: readonly PromptBlock[] = [
  {
    id: "B10",
    text: `This is Finish. Call \`stop\` now to end the request.`,
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
export function turnInstruction(island?: IslandId, done?: string): string {
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
  return `${lead} When it holds, \`stop\` — and nothing else; do not over-work the state.`;
}

export const NODE_INSTRUCTIONS: Record<"plan" | "working" | "terminal", string> = {
  plan: assemble(MOVE_BLOCKS),
  working: assemble(GOAL_BLOCKS),
  terminal: assemble(TERMINAL_BLOCKS),
};

export const PROMPT_BLOCKS: readonly PromptBlock[] = [
  ...BASE_BLOCKS,
  ...REQUEST_BLOCKS,
  ...MOVE_BLOCKS,
  ...GOAL_BLOCKS,
  ...TERMINAL_BLOCKS,
];
