import { ISLAND_ORDER, ISLANDS, type IslandId } from "../../ir/islands";
import type { Situation } from "../../ir/project";

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

// The states a request can start in, shown in the request hint.
const INITIAL_ISLANDS: readonly IslandId[] = ["orientation", "localization"];
const INITIAL_STATES = INITIAL_ISLANDS.map(
  (id) => `- ${ISLANDS[id].label} — ${ISLANDS[id].what}.`,
).join("\n");

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
    text: `Choose the state to start in from the user's request: call \`move\` to enter it, or \`decline\` if the request admits no such state.

Startable states:
${INITIAL_STATES}`,
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

// S5 — the finished-state scenario: the state's work is closed; the tape above carries the
// record (each finished state is a `Start state` / goal / `Finish state` triple). The hint only
// points at it — the history is short and does not need restating.
const TRANSITION_BLOCKS: readonly PromptBlock[] = [
  {
    id: "B9",
    text: `The states you have finished are above — read them. Choose the next state and \`move\` to it; if the work is done, \`move\` to Finish and \`stop\` there.`,
  },
];

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
      ? `The state is done when "${criterion.replace(/\.\s*$/, "").replace(/^./, (char) => char.toLowerCase())}".`
      : `The state is done when its goal holds.`;
  return (
    `${lead} Before acting, decide: if that already holds, call \`stop\` and nothing else — do ` +
    `not read or list more, do not look ahead, and do not do the next state's work. Otherwise ` +
    `take the single next step.`
  );
}

export const NODE_INSTRUCTIONS: Record<Exclude<Situation, "request">, string> = {
  plan: assemble(MOVE_BLOCKS),
  working: assemble(GOAL_BLOCKS),
  transition: assemble(TRANSITION_BLOCKS),
  terminal: assemble(TERMINAL_BLOCKS),
};

export const PROMPT_BLOCKS: readonly PromptBlock[] = [
  ...BASE_BLOCKS,
  ...REQUEST_BLOCKS,
  ...MOVE_BLOCKS,
  ...GOAL_BLOCKS,
  ...TRANSITION_BLOCKS,
  ...TERMINAL_BLOCKS,
];
