# Skein — state transitions plan (create_goal as the state-change move)

> English mirror of `docs/plans/state_transitions_plan_ru.md`.
> Status: **planning — for tomorrow.** No code until the owner signs off.

## 1. Context

The state-machine prompt landed (`docs/prompt_state_machine_concept.md`): the doxa authors a
goal's `state` at `create_goal` (an island id from `src/ir/islands.ts`), the base prompt (`B0`
preamble + `B4` graph) describes the islands and their transitions, and `project` injects
`ISLAND_INSTRUCTIONS[state]` on an open goal. All offline gates are green
(`npm run typecheck`, 296 offline tests, sandbox engine tests).

The live check on `fix-ocaml-gc` (2026-10-12):

- attempt 1, `2026-10-12T05-48-08-483Z` — **reward 0**, `max_turns` (60). Cause: the prompt
  text (`B6`/`B7`) still said `create_goal { what, command }` while the schema had moved to
  `{ what, state, action }`; the mismatch derailed the model (it localized at t25 and never
  edited). Fixed the vocabulary in the prompt.
- attempt 2, `2026-10-12T06-12-37-722Z` — **reward 1**, `max_turns` (60). Solved, but the fix
  came late (one `edit` at t57) and the run never called `stop`.

In **both** runs the doxa created **exactly one goal** (`state: reconnaissance`) and never
created a sub-goal. The islands map was inert: nothing ever traversed a bridge.

## 2. Problems

### P1 — the transition is blocked in the engine (primary)

`create_goal` at an open goal requires an **unfulfilled plan item** to decompose:

- `src/loop/classify.ts` refuses with `no_current_item: the plan is already fulfilled; apply
  an action to add the next item`;
- `src/tools/index.ts` fails the same way (`create goal failed: no current plan item to
  decompose …`).

But a plan item is **fulfilled** once its current alternative is an executed, succeeded action
(`itemFulfilled`). So after any **successful** action the plan is exhausted and `create_goal`
is refused. Consequence: **a state change is only possible after a failure.** During healthy
progress the doxa physically cannot move to the next state — which is exactly when it should.

This is also a **frontier/gate mismatch**: `applicable` (`src/ir/traversal.ts`) marks
`createGoal: true` for every open goal, while `classify` refuses it for an exhausted plan. The
projection tells the doxa the move is admissible; the gate then rejects it.

### P2 — the prompt frames `create_goal` as branching, not transitioning

The tool description leads with "add a sub-goal that moves the work to a new state **or
branches the current plan item**", and `B7` puts the state sentence inside a list of
failure-handling options. The doxa reads `create_goal` as "recover from a failure", not as "the
way work changes state". There is no single, prominent sentence that says *to change state,
call `create_goal` with the new `state` — a failure is not needed*.

### P3 — the state is a single, frozen label

Because the doxa never creates a second goal, the focused goal's `state` stays whatever the
interpreter chose (`reconnaissance`). The per-island instruction then restates that one island
every turn. So even a good criterion/relief has no effect: the model is never "in"
Localization or Patch.

P3 is a consequence of P1 (+P2): with transitions impossible, there is nothing to freeze or
advance.

## 3. Hypotheses

- **H1 (primary):** the model cannot transition (P1). Fix the engine and the model will be able
  to move between islands.
- **H2:** the prompt framing (P2) reinforces the defect — the model does not even *try* to
  transition (both runs: `refused 0`). Fix the wording so a state change reads as the normal
  next move, not a recovery.
- **H3 (to test, not assume):** with H1+H2 fixed, the doxa will create per-state goals and the
  bridges will actually steer (fewer wasted turns, an earlier patch). This must be *measured*,
  not assumed.

## 4. Proposed changes

Order per the repo rule: semantics → code → test.

### A. Semantics (`docs/ir_semantics{,_ru}.md` §2.7, §4.1; `docs/ir_operations{,_ru}.md` OP-CG-2)

A sub-goal at an open goal may **also start a new plan item** when the plan is exhausted (the
sibling of `placeAction`'s exhausted branch), not only replace the current item. The
`no_current_item` refusal for `create_goal` is removed. Focus descends as before.

### B. Code

- `src/loop/classify.ts` — drop the `no_current_item` refusal for `create_goal` (admissible at
  any open goal).
- `src/tools/index.ts` (`case "create_goal"`) — when there is no current item, append a new plan
  `item` and hang the goal as its newest alternative, mirroring `placeAction`'s exhausted
  branch; `descend` as before.

### C. Prompt

- `create_goal` description — lead with **"call it to move the work to the next state"**; the
  branch/decompose case becomes secondary.
- `B7` — one explicit sentence: *to change state, create a goal whose `state` names it; a
  failure is not needed*.
- Keep `B4`.

### D. Tests and docs

- `tests/ops/create_goal.test.ts` / `tests/loop.test.ts` — `create_goal` after a **successful**
  action is accepted and creates a new plan item whose alternative is the goal.
- Update the OP-CG rows (OP-CG-2) and the coverage map in `docs/ir_operations{,_ru}.md`.

### E. Verification (live)

- Re-run `fix-ocaml-gc`, net `on` and `off` (one run per branch = direction, not statistics,
  per `docs/prompt_state_machine_concept.md` §7).
- Success signal (beyond reward): the doxa creates **more than one goal** with **distinct
  `states`**, and the run reaches `reward 1` — ideally with a clean `stop` rather than
  `max_turns`.

## 5. Open questions

- **Grain of `state`.** State-on-goal is inert unless the doxa creates a goal per state. Is
  "one goal per state" the intended discipline (and should the prompt force it), or should
  `state` also be re-declarable on `apply` (current state = the last declaration)? The latter
  was set aside earlier but is the alternative if goals stay rare.
- **Bridges as preconditions.** Today `next` is an adjacency list; the concept's bridge is a
  *precondition* ("move to B when X holds"). Do we add an explicit condition per edge, and
  model the missing `Interpretation` island (the request→goal step)?
- **`env_triage` return.** It is modeled as "many targets" rather than "back to where you
  came"; a return edge may be needed.
- **`max_turns` vs `stop`.** Attempt 2 solved but never called `stop` (60 turns). Is the
  Hand-off island / relief enough, or does the doxa need an explicit "verified → stop" push?

## 6. Risks and cost

- Prompt and engine change are cheap and offline-testable; the live confirmation is not
  (~9₽/run; 8 of the 10 allowed runs remain).
- Touching the `create_goal` gate is a semantics change: the doc comes first, and the
  `no_current_item` removal must not resurrect a criterion gate (closure stays `stop`).
