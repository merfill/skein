# Skein — goal-into-move plan (the state carries its own goal)

> English mirror of `docs/plans/archive/goal_into_move_plan_ru.md`.
> Status: **settled with the owner (2026-10-13); implementation in progress.** The goal node
> and the `create_goal` operator are removed; the state (`move`) carries its own goal text and
> owns the plan. Written to be self-contained: work can resume from it after a context reset.

## 0. How to read this plan

§1 is the evidence. §2 is the settled concept. §3 fixes the walk (operators, situations, tool
sets). §4–§6 are the IR / engine / projection changes. §7 is the phase order, §8 the tests,
§9 the docs, §10 the risks. Nothing is open: a future change goes through the normal
semantics-first path.

## 1. Why — the evidence

A live `fix-ocaml-gc` run on the previous design (goal node + `create_goal`), 2026-10-13:

| run | reward | stop | turns | what happened |
|---|---|---|---|---|
| net on | 0 | `no_progress` | 46 | after `stop` at t26 the doxa looped `create_goal`/`apply` for 19 turns |

The trace (`bench/runs/sandbox-tasks/2026-10-13T08-15-40-551Z-fix-ocaml-gc`):

- exactly **one** state change (t0, `move` → reconnaissance) and **one** goal closure (t26,
  `stop`) in the whole run; reconnaissance was over-worked (relief says "at most two rounds",
  criterion met by ~t6, `stop` only at t26);
- after the `stop`, the state was finished — but `create_goal` was still offered, so the doxa
  called it, got `state_finished`, and alternated `create_goal`/`apply` until the budget ran
  out. Replaying the post-`stop` context: **5/5 `create_goal`** with the full tool registry vs
  **5/5 `move`** when the surface was reduced to the frontier.

Root cause: the goal was a **separate node** with its own operator, so "the state is done" and
"start its work" were two different things, and the surface kept offering the second after the
first was settled. The fix is to make the state its own goal.

## 2. The concept (settled)

**A state is a goal.** A `move` declares both the phase (the island) and the concrete outcome
for that phase (`what`); the plan hangs directly off the `move`. There is no `goal` node and no
`create_goal` operator.

Two phases stay **separate calls with different contexts and tool sets** (settled with the
owner):

1. **Transition** (`request` / finished state): the doxa picks the next state — only `move`
   (and `decline` at the request) is offered.
2. **Concretization** (the state just entered): a **second** LLM call gives the first plan
   item. There is no dedicated operator — the first ordinary `apply` seeds the plan and its
   first item. `move` and my concretization never share a turn.

So the state's goal text arrives with `move`, and the plan's first action arrives right after,
as a normal tool call.

## 3. The walk (fixed)

Operators: `move { state, what, note? }`, `apply`, `stop`, `decline`, and the read-only
`recall` / `search`. `create_goal` is gone; `what` is required except for `handoff`.

| situation | focus | offered tools | prompt |
|---|---|---|---|
| `request` | the request | `move`, `decline` (+recall/search) | pick the first state, or decline |
| `plan` | a `move`, plan empty | apply-vocabulary, `stop` (+recall/search) | give the first plan item |
| `working` | a `move`, plan has items | apply-vocabulary, `stop` (+recall/search) | continue / stop |
| `transition` | a finished `move` | `move` (+recall/search) | choose the next state |
| `terminal` | the `handoff` move | `stop` (+recall/search) | stop to finish the request |

The surface IS the frontier (`applicable`), so a move the engine would refuse is never offered
— the post-`stop` loop is impossible by construction, not by prompt wording.

Chain:

```
request ─move{state,what}▶ state(plan) ─first apply▶ state(working) ─apply▶ …
state(working) ─stop▶ state(transition) ─move{state,what}▶ …   handoff ─stop▶ end
```

## 4. IR changes

- `WORK_KINDS`: drop `goal`. `EDGE_KINDS`: drop `goal`.
- `MovePayload`: add `what: string` (the state's goal text); keep `state`, `note`. Drop
  `GoalPayload`.
- `plan`/`items`/`alts`/`stop` edges hang off the `move`.
- Traversal: drop `goalOf`; `isMoveFinished(state, move) = hasStopped(state, move)`;
  `stopOf(state, move)`; `desiredPath = [request, move?]`; `applicable` per §3.
- `Applicable`: drop `createGoal`; keep `move`, `apply`, `stop`, `decline` (+ `return`).
- `Context.situation`: `request | plan | working | transition | terminal` (was
  `request | move | goal | transition | terminal`).
- `Context.applicable`: the frontier, used to bind the offered tools (already added for the
  tool-surface work; `createGoal` removed).

## 5. Engine / classify

- `tools/index.ts`: drop `buildGoal` and the `create_goal` case; `buildMove` writes `what`;
  the `move` case adds only the move node + `move` edge (no plan/seed). `ensurePlan(moveId)`,
  `buildItem(moveId)`, `placeMove(moveId, …)`. A `stop` on an open non-terminal `move` closes
  it (transition follows); on the terminal `move` it ends the request.
- `classify.ts`: drop the `create_goal` branch and its reasons (`no_state` / `state_worked` /
  `state_finished` / `terminal`). `move` validates non-empty `what` (`empty_what`) except for
  `handoff`, is accepted at the request or at a finished `move`, else `state_open`. `apply`
  and `stop` require an open (non-terminal) `move`; `stop` also accepts the terminal `move`.

## 6. Projection / prompt

- `project.ts`: `situationOf` per §3; `renderState` renders the `move` call (with `what`) +
  confirmation, then the plan (`plan`/`working`), or the closure line when the current state is
  finished; a left-behind finished state stays a single compaction line. `observationInstruction`
  reads the goal from `move.what` (the observation reminder keeps `State`/`Goal`/`Done when`/
  `Constraints`, restated at the highest recency).
- `prompt/blocks.ts`: `NODE_INSTRUCTIONS` keys are the five situations; the walk text
  (`B4`) loses `create_goal`; the `plan` block is "give the first plan item"; the `working`
  block is "continue / stop"; `transition` and `terminal` unchanged in spirit.
- `llm/schemas.ts` + `llm/tools.ts`: drop the `create_goal` operator/tool and the nested
  `goalActionParams`; `move` gains `what`; `toolNamesFor` drops `createGoal`.

## 7. Phase order

0. This plan (EN + RU).
1. IR types/graph/traversal.
2. Engine (`tools/index.ts`).
3. Classify.
4. Projection + prompt + schemas/tools.
5. Tests (ops, traversal, classify, tape, prompt, islands, coverage, live harness).
6. Docs (semantics, operations, ir, projection, system_prompt, concepts, tools, plans,
   `AGENTS.md` invariant) + `_ru`.
7. `npm run typecheck` + offline suite green.
8. Live synthetic step tests for the cases (owner's go-ahead).

Each phase must leave `tsc` and the offline suite green.

## 8. Tests

- `tests/ops/create_goal.test.ts` dissolves into `tests/ops/move.test.ts` (move carries `what`,
  no plan until the first `apply`) and `tests/ops/apply.test.ts` (the first `apply` seeds the
  plan + first item).
- `applicable` / `traversal` / `ir` / `islands` / `ir_properties` / `coverage`: drop `goal`
  and `create_goal`; add the five situations and the frontier.
- `tape` / `tape_render` / `tape_contract` / `messages` / `prompt`: the move call carries
  `what`; no `create_goal` pair.
- Loop / stop / decline / workingset: focus is the `move`.
- Live step tests (`state_transitions_step`, `ir_operations_step`, `fix_ocaml_step`) + the
  sandbox step runner: update the operator vocabulary.

## 9. Docs / invariants

`docs/ir_semantics{,_ru}.md`, `ir_operations{,_ru}.md`, `ir{,_ru}.md`,
`projection{,_ru}.md`, `system_prompt{,_ru}.md`, `concepts{,_ru}.md`,
`prompt_state_machine_concept{,_ru}.md`, `tools{,_ru}.md`, `testing{,_ru}.md`,
`walkthrough{,_ru}.md`, `docs/README.md`, and `AGENTS.md` — the invariant "a goal is closed
only by the doxa's `stop` (a `has_stopped` edge)" becomes "a state is closed only by the doxa's
`stop` (a `has_stopped` edge on the `move`); there is no criterion gate".

## 10. Risks

- The `what` and the first `apply` are two turns; a vague `what` is corrected by the first
  action. Accepted.
- A full-engine refactor: mechanical but wide (types → engine → traverse/classify →
  projection/prompt → tests → docs). Mitigated by the phase order and green-at-each-phase.
- Old `contexts.ndjson` traces no longer replay under the new IR (no `goal` node); verification
  uses fresh runs.
