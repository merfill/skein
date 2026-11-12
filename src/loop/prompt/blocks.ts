import { ISLANDS, TERMINAL_ISLAND, type IslandId } from "../../ir/islands";

export interface PromptBlock {
  id: string;
  text: string;
}

// The base: the stable system prompt, in block order. B1 is the role; B2 the principles. The
// state map and the moves are not here: they are rendered in the request/transition situation
// prompts, scoped to the choice at hand, so an open state never carries other states' goals.
// It does NOT repeat the tool descriptions — those ship in the request's `tools` field (the
// single source is the registry, `PROPOSAL_TOOLS`). Stable, so a good cache prefix.
export const BASE_BLOCKS: readonly PromptBlock[] = [
  {
    id: "B1",
    text: `# Role

You are a software engineering agent with access to the user's filesystem. You solve the user's tasks.

## How you work

You solve a task by moving between states; you are in exactly one state at a time, and the state is its goal — one step of the work with its own stop criterion. The request is reference, not the goal: it explains why the task exists, but the state's goal is the only active goal for this turn, and the state's criterion decides when the turn ends. Work the state until its criterion holds, then reply with text only, no tool calls: the engine records that reply as the state's result on the \`Finish\` line. After a state is finished, choose the next state and call \`move\` to enter it.

Each turn you reply with tool calls; the engine runs them in order and returns the results. Batch calls that do not depend on another call's result. A reply with no tool call ends the state, so give it only when the state's criterion holds — otherwise call a tool.`,
  },
  {
    id: "B2",
    text: `## General instructions for work inside a state

Follow the project. Mimic its style, structure, naming, typing and architectural patterns; make the change idiomatic to the surrounding code. Add comments sparingly (why, not what), and never use comments to talk to the user.

Work only the state's goal: plan the step, make small changes, and debug from evidence. Do not do another state's work or expand the scope.

Prefer the dedicated tools: \`read\`, \`grep\` and \`list\` to inspect, \`edit\`, \`write\` and \`apply_patch\` to change files. Use \`bash\` only for work they cannot do — running builds, tests, or other shell operations.

Inspect narrowly: ask for the smallest result that decides the next step — a targeted \`grep\`, or a small window around a known offset. Do not dump a whole file or binary region; a large output stays on the tape and costs context. When the state's criterion holds, stop: do not re-run a check that already passed or widen the search for its own sake.

Work from the material in this workspace. The result must come from that material or from the request's specification. Do not invent values or fabricate results to fit a count, a form, or an expected answer. Acceptance is decided by the material or the specification, not by your own output.

Do not reconstruct an external or upstream version from memory. If a reference is available — on disk or fetched — treat it as a lead to verify, not as the oracle.

Keep the source material intact: copy raw artifacts before any command that may checkpoint, delete, or rewrite them.

The workspace root, the repository status and the environment are engine-recorded facts: they are already read — do not re-probe or re-derive them. The tree itself is not indexed: list what you need. If a block is marked partial, only the unlisted facts are unknown.

Never expose or commit secrets or keys. Report concisely and to the point: the shortest answer that serves the request, with extra detail only when the user asked for it. No preamble or summary unless asked.`,
  },
];

// The request prompt (`request`): the request scenario (a fresh request: choose the first state, or
// decline). `what` names the object or situation the state will work on; the state's own goal and
// criterion stand as-is (docs/en/ir.md §2.5). Appended as a system message at the end of the
// request turn (never stored).
const REQUEST_BLOCKS: readonly PromptBlock[] = [
  {
    id: "request",
    text: `Choose exactly one of three values:
- Patch when the task is to find an error in the existing code and fix it by editing an existing file.
- Construction when the task is to write new file(s) explicitly.
- Research in all other cases.

The original user request is context for this choice, not the goal.`,
  },
];

// The transition prompt (`transition`): the finished-state scenario. Each reachable state is
// rendered by its entry condition (`next[].when`) — the single source in `ISLANDS` — never by
// its `what`, so a state's description cannot be misread as the condition for entering it.
export function transitionInstruction(island?: IslandId): string {
  const label = island !== undefined ? ISLANDS[island].label : undefined;
  const head =
    label !== undefined
      ? `The engine recorded this state's result on the \`Finish state ${label} — …\` line above.`
      : `The engine recorded this state's result on the finished state's \`Finish\` line above.`;
  const edges = island !== undefined ? ISLANDS[island].next : [];
  if (edges.length === 0) {
    return `${head}\n\nThis state has no next state.`;
  }
  const conditions = edges.map((edge) => `- ${ISLANDS[edge.to].label} — ${edge.when}.`);
  const tail =
    "Call `move` alone with `what` = the object or situation the next state works on (≤20 words), not the task; leave `done` out, and do not do that state's work on this turn.";
  const choices = ["Choose exactly one next state:", ...conditions].join("\n");
  return [head, choices, tail].join("\n\n");
}

// The terminal prompt (`terminal`): End has no criterion and no reachable next state, so its
// own instruction IS the turn's goal. Appended as a `system` turn after the tape, like the
// transition rule, so the completion rule is the last thing the model reads; the model replies
// with the final report as text and the engine records it as the state's `stop`.
export function terminalInstruction(island?: IslandId): string {
  const target = island ?? TERMINAL_ISLAND;
  return [`This is ${ISLANDS[target].label}.`, ISLANDS[target].instruction]
    .filter((part) => part !== "")
    .join("\n\n");
}

// The working prompt: the state's goal, criterion and plan as one `user` turn, appended after
// the state's turns so the goal is the last thing the model reads. The model's `what` is an
// unverified guess about the concrete subject, shown as advice, never as the state's goal; the
// original request stays reference. Empty for a state with no criterion (End); the terminal
// situation carries its own prompt (`terminalInstruction`).
export function workingInstruction(island: IslandId, guess?: string): string {
  const criterion = ISLANDS[island].criterion;
  if (criterion === "") return "";
  const goal = ISLANDS[island].what.replace(/[.!?]\s*$/, "");
  const lines = [`Goal: ${goal}.`];
  if (guess !== undefined && guess !== "") {
    lines.push(`Your earlier guess (may be wrong): ${guess}`);
  }
  lines.push(
    `Done when: "${criterion.replace(/\.\s*$/, "")}". When it holds, reply with the result as text only — no tool call.`,
  );
  if (ISLANDS[island].instruction !== "") {
    lines.push(`Plan:\n${ISLANDS[island].instruction}`);
  }
  lines.push("The original user request is context for this state, not its goal.");
  return lines.join("\n\n");
}

const assemble = (blocks: readonly PromptBlock[]): string => blocks.map((block) => block.text).join("\n\n");

export const BASE_PROMPT = assemble(BASE_BLOCKS);

// The request prompt, appended as a system message after the request: it scopes the first
// `move`'s `what` (never the whole task). Rendered per turn (never stored).
export const REQUEST_INSTRUCTION = assemble(REQUEST_BLOCKS);

export const PROMPT_BLOCKS: readonly PromptBlock[] = [...BASE_BLOCKS, ...REQUEST_BLOCKS];
