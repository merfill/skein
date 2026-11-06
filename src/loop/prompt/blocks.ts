import { ISLANDS, TERMINAL_ISLAND, type IslandId } from "../../ir/islands";

export interface PromptBlock {
  id: string;
  text: string;
}

const renderStates = (ids: readonly IslandId[]): string =>
  ids.map((id) => `- ${ISLANDS[id].label} — ${ISLANDS[id].what}.`).join("\n");

// The legacy Orientation transition rule. The request now states its own routing literally.
const START_RULE: readonly string[] = [
  "Move to Patch when the task is to find an error in the existing code and fix it by editing an existing file.",
  "Move to Construction when the task is to write new file(s) explicitly.",
  "Otherwise move to Research.",
];

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

Never expose or commit secrets or keys. Report concisely; no preamble or summary unless asked.`,
  },
];

// The request prompt (`request`): the request scenario (a fresh request: choose the first state, or
// decline). `what` names the object or situation the state will work on; the state's own goal and
// criterion stand as-is (docs/ir_semantics.md §2.5). Appended as a system message at the end of the
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

// The state-specific transition rule: the finished state's own instruction is not visible on
// the transition turn, so the rule that decides among its reachable states lives here.
function transitionRule(island?: IslandId): string[] {
  switch (island) {
    case "orientation":
      return [...START_RULE];
    case "research":
      return [
        "Choose End when the required result exists in its declared form and matches the material or the request.",
        "Choose Patch when the work is a code defect to locate and fix.",
      ];
    case "recovery":
      return [
        "Choose End only when the output exists in its declared form, is derived from the material, and matches what the material contains. Otherwise choose Research — the method failed or the output does not match the material.",
      ];
    case "construction":
      return [
        "Choose End only when the artifact is derived from the specification or the material's behaviour and the acceptance check passes. If the check failed because the method or specification did not hold, choose Research.",
      ];
    case "patch":
      return [
        "Choose Verification when the change is applied — the differing expression is at the target, and the edited lines read back.",
        "Choose Research only when the work turns out to be a situation, not a defect to locate and fix.",
      ];
    case "verification":
      return [
        "When the acceptance holds, choose End.",
        "When it fails, choose Patch: the result you just wrote names the failure, and the cause and the change are revised there.",
      ];
    default:
      return [];
  }
}

// The transition prompt (`transition`): the finished-state scenario: the tape above carries the
// record (each finished state is a `Start state` / `Finish state` pair) and the user's request.
// The rule names the states reachable from the focused one; the next state's OWN goal stands
// as-is (never carried from the `Finish` line).
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

// The working prompt: the state's goal, criterion and plan as one `user` turn, appended after
// the state's turns so the goal is the last thing the model reads. The doxa's `what` is an
// unverified guess about the concrete subject, shown as advice, never as the state's goal; the
// original request stays reference. Empty for a state with no criterion (End).
export function workingInstruction(island: IslandId, guess?: string, done?: string): string {
  const criterion = done !== undefined && done !== "" ? done : ISLANDS[island].criterion;
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
