# Skein — the system prompt: behavior and blocks

> Russian mirror — `docs/ru/system_prompt.md`.
>
> This is the source of truth for prompt behavior. A behavior change goes: edit here, edit the
> block in `src/loop/prompt/blocks.ts`, add a test. Related: `ir.md` (states and the tape),
> `ir_operations.md` (the tool registry), `projection.md` (what the model sees),
> `states.md` (the state goals).

## 1. Purpose

The prompt describes a **space of work states**, not a list of actions. A state has a goal, a
completion condition, an instruction and a tool surface; the transition is caused by the state's
result. This shape keeps the trajectory convergent: without it the model flounders and does not
know what to do next.

The prompt is checked at three levels:

- **L1 — static contract** (`tests/prompt.test.ts`, offline, CI): assembly, block ids, tool names,
  required phrasings;
- **L2 — live scenarios** (`tests/live/scenarios.test.ts`): trajectory shape on a fixture;
- **L3 — bench and real tasks**: behavior on actual work.

L2 and L3 depend on model non-determinism and are therefore weaker; L1 is mandatory.

## 2. Terminology

| Concept | Term | Where |
|---|---|---|
| a state of work | **state** | `move { state, what? }`, `Start state <label>` |
| a transition into a state | **move** | the `move` tool |
| a state's completion condition | **Done when** | the state kind's condition, rendered in the working prompt |
| a state's closure | **text reply** | the model replies without a tool call; the executor records a `stop` |
| a state's closure line | **`Finish state <label> — <why>`** | the tape marker |
| the terminal state | **End** (`end`) | `move { state: "end" }` |

`what` is an optional note about the concrete subject. The legacy `done` field is not offered to
the model and is not rendered. There is no `stop` tool: a state is closed only by the model's text
reply, recorded as a `stop` record. The request is reference, not the goal.

## 3. Assembly

- The prompt has a stable **base** (`BASE_PROMPT`, true on any turn) and per-situation prompts
  (`request`, `working`, `transition`, `terminal`), assembled in `src/loop/prompt/blocks.ts`.
- The base blocks are `B1` (role) and `B2` (principles). Situation prompts are named, never `B…`.
- `src/loop/propose.ts` builds the message list as: `BASE_PROMPT`, the constraints, the tape (the
  history), then the situation prompt **appended last** — temporary, re-derived from the situation
  each turn, never stored. `working` appends one `user` turn; `request`, `transition` and
  `terminal` append a `system` turn.
- The tool contract (names, parameters, descriptions) is **not** copied into the prompt text: it is
  sent as the request's `tools` field, generated from the single registry `PROPOSAL_TOOLS`
  (`src/llm/tools.ts`).

**Assembly invariants:**

1. one block = one behavior; no duplication between blocks;
2. every behavior has an id (base block) or a name (situation prompt);
3. the assembled prompt equals the concatenation of blocks;
4. the prompt does **not** repeat the tool descriptions — they ship in the request's `tools`.

## 4. Blocks

The prompt is deliberately plain: it states what the executor requires, not how to think.
Strategy lives in the tool descriptions and the tape.

| ID | Block | Behavior |
|---|---|---|
| B1 | `role` | A coding agent; exactly one state at a time; the state is its goal with its own completion condition; work until it holds, then reply with text only; after the closure choose the next state with `move`; each turn is tool calls, run in order, independent calls batched |
| B2 | `principles` | Follow the project; work only the state's goal; prefer the dedicated tools; inspect narrowly; the result comes from the material or the specification; do not reconstruct an external version from memory; keep the material intact; do not re-probe executor facts; no secrets; concise output |

### Situation prompts

| Name | Situation | Role | Content |
|---|---|---|---|
| `request` | fresh request | `system` | choose exactly one of Patch, Construction or Research; `decline` is also available; the request is context, not the goal |
| `working` | open state, after its turns | `user` | `Goal`, the model's earlier guess, `Done when`, `Plan`, and the request marked as reference |
| `transition` | after a `Finish state` line | `system` | the `Finish` line is the source of the result; the next states are listed by their `next` condition; call `move` alone with `what` and leave `done` out |
| `terminal` | End | `system` | `This is End.` plus the End instruction; reply with the final report as text, no tool calls |

### The state tape

A state is rendered on the tape in order:

| Name | Message | Role |
|---|---|---|
| `start` | `Start state <Label>` | `system` |
| `brief` | the executor facts for the state | `system` |
| `turns` | the state's tool calls and their results | `assistant` / `tool` |
| `working` | one turn after the turns: `Goal`, guess, `Done when`, `Plan`, request reference | `user` |
| `finish` | `Finish state <Label> — <why>` | `system` |

The request leads the tape after the base prompt and any constraints, on every turn.
`start` and `brief` are shown while the state is open; `working` is recomputed each turn and never
stored. When the state closes, only `start` and `finish` remain, with an `Artifacts:` line when the
state used `write` or `edit`.

## 5. Test map

| Level | Where | What it checks |
|---|---|---|
| L1 | `tests/prompt.test.ts` | assembly from blocks; unique ids; the prompt does not repeat tool descriptions; stream separation and `pipefail` in the `bash` description; stale-read safeguard in `edit`/`write`; workspace root |
| L2 | `tests/live/scenarios.test.ts` | trajectory shape on a fixture |
| L3 | `bench/` | behavior on real tasks |

## 6. Open questions

- The target character budget for the prompt and what to move into tool descriptions.
- How strict `B1`/`B2` should be: how much order to dictate versus how much flexibility to leave.
- A diff or localization heuristic, if wanted, belongs in an optional tool hint, not in a base
  block.
