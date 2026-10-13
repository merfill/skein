# Skein — state transitions plan (create_goal as the state-change move)

> English mirror of `docs/plans/state_transitions_plan_ru.md`.
> Status: **superseded by `docs/plans/state_protocol_plan.md`** (the live `fix-ocaml-gc` runs of
> 2026-10-13 showed the incremental fix does not make the doxa transition; the redesign makes the
> state a first-class move). Kept for the P1–P5 evidence and the prompt review.

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

A critical review of the injected per-state prompt followed; its outcome is folded into §2
(P4, P5) and §4 (C, D). The earlier vision documents (`docs/prompt_state_machine_concept.md`
§4.2–4.4, §5–6) are the reference for the state/transition/constraint vocabulary used here.

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

### P4 — the per-state prompt has no "what", and the transitions have no condition

The injected island instruction (`src/loop/prompt/blocks.ts:92-103`) carries only a **criterion**
and **constraints**; it never says what the state's work *is*. The `B4` graph
(`blocks.ts:15-19`) lists `done when <criterion>. → <next>` without the **precondition** that
makes an edge apply, and neither the candidate **initial** states nor the **terminal** state
are declared. A model cannot tell *when* it may cross a bridge, only *where* one leads.

### P5 — no state-level budget or pressure

Only Reference has a bound, and it is vague ("a small budget"). Reconnaissance reading,
Localization re-reading, and Verification re-runs are unbounded, and the engine never nudges a
goal that stalls. The observed drifts: 89% of the reasoning before the first edit, ~26 turns of
reinvention, 9×403 on `webfetch`, and `max_turns` without a `stop`.

## 3. Hypotheses

- **H1 (primary):** the model cannot transition (P1). Fix the engine and the model will be able
  to move between islands.
- **H2:** the prompt framing (P2) reinforces the defect — the model does not even *try* to
  transition (both runs: `refused 0`). Fix the wording so a state change reads as the normal
  next move, not a recovery.
- **H3 (to test, not assume):** with H1+H2 fixed, the doxa will create per-state goals and the
  bridges will actually steer (fewer wasted turns, an earlier patch). This must be *measured*,
  not assumed.
- **H4 (to test):** a per-state `What` + conditioned transitions + budgets + a stall nudge
  (P4/P5) reduce drift further — an earlier first edit, a clean `stop` instead of `max_turns`.
  Measured live, one run per branch.

## 4. Proposed changes

Order: semantics → code → prompt/data → test → docs.

### A. Semantics (`docs/ir_semantics{,_ru}.md` §2.7, §4.1; `docs/ir_operations{,_ru}.md` OP-CG)

A sub-goal at an open goal may **also start a new plan item** when the plan is exhausted (the
sibling of `placeAction`'s exhausted branch), not only replace the current item. The
`no_current_item` refusal for `create_goal` is removed. Focus descends as before.

### B. Engine code

- `src/loop/classify.ts` — drop the `no_current_item` refusal for `create_goal` (admissible at
  any open goal).
- `src/tools/index.ts` — generalise `placeAction` into `placeMove(goalId, nodeId)` (current
  item → newest `alts`; no item → new `plan` `item`), use it for `apply`, and call it from
  `case "create_goal"` (branch + focus descend as before).

### C. Prompt

#### C1. `B1` — remove engine internals, keep batching

Drop "records every result on the tape — your whole context. Nothing off the tape is known to
you" (the tape is the engine's concern; `docs/ir_semantics.md` §3). Keep the batching rule
(behaviour, not engine fact):
`... Each turn you reply with tool calls; the engine executes them and returns the results.
Batch calls whose arguments do not depend on a sibling's result.`

#### C2. `B2` + `FRAGMENT` — remove

`B2` ("What you can do: …") duplicates the `tools` field. Remove it and the now-unused
`src/ir/fragment.ts` (`FRAGMENT`); drop the import in `blocks.ts`.

#### C3. `B4` — mechanism preamble, `Start`, `Transitions`

Add the transition **mechanism** once (not per state), a `Start` list, and a `Transitions`
section as **conditioned edges grouped by source** (handles branches and cycles):

```
You are always in exactly one state — the state of the goal you are focused on; its work, its
closing criterion and its constraints are shown to you each turn. When the current state's work
is done (its criterion holds), move on by calling `create_goal` with the next `state`. Moving
is cheap: once a criterion is met, do not re-check it — move now.

Start — a goal starts in the state whose criterion already holds:
- Reconnaissance — the default: the entry point, the build/test commands and the touched files
  are not known yet.
- Localization — the request already names the file and the exact change (a one-line fix).
- Reproduction — the request hands a command that must first be seen to fail.
- Design — the task is a feature or a multi-step change, not a defect.
The state is named at `create_goal`; there is no fixed first step.

Transitions — move as soon as the condition holds; the order is not fixed:
Reconnaissance leads to:
  1. Reproduction — there is a command that fails observably.
  2. Localization — the cause is findable by reading.
  3. Design — a feature or many edits.
Reproduction leads to:
  4. Localization — the failure is the goal's, not the environment's.
Localization leads to:
  5. Patch — the file, the line and the exact change are named.
  6. Reference — external truth is needed (an upstream change, docs).
  7. Design — the change spans many edits.
Reference leads to:
  8. Localization — the reference refined your derivation.
  9. Patch — the reference confirms the change.
Design leads to:
 10. Patch — the first item is executable now.
Patch leads to:
 11. Verification — the change is in the workspace.
Verification leads to:
 12. Hand-off — the acceptance command passes.
 13. Localization — it fails: go back with the new evidence (corrective cycle).
Any state leads to Environment triage when a command fails for environmental reasons; it returns
to the state you came from.
Hand-off is terminal: call `stop`.
```

#### C4. Per-state instruction — `What / Done when / Constraints`

Replace the current `State: <label> — done when … / Constraints: … / When done, create the
goal for the next state: …` with:

```
State: <label> — <what this work is>
Done when: <criterion>
Constraints: <constraints>
```

The `When done …` line is dropped (routes are in `B4`). The per-state texts (authored in
`islands.ts`, rendered by `blocks.ts`):

| State | What | Done when | Constraints |
|---|---|---|---|
| Reconnaissance | build the project map: the entry point, how it builds and runs, where the relevant code and data are | the entry point, the build/test commands and the files the change touches are known | batch independent reads/greps; wide first, then narrow; at most two rounds of inspection, then move |
| Reproduction | obtain an observable failure tied to the goal | a command fails observably and the failure is the goal's, not the environment's | tell "not found" from "not built"; if the failure is environmental, move to Environment triage |
| Localization | find the exact cause: the file, the line and the expression, or the missing symbol/contract | you can name the file, the line and the exact change to make | if the target lines are already on the tape, name the exact replacement and edit now — do not re-read or re-derive; read only what you still need; move to Patch in the same move |
| Reference | obtain external truth — an upstream change, a diff, documentation | the reference is on disk, or one attempt failed and you derive it yourself | at most one fetch; an unavailable reference is a fact, not a reason to retry |
| Design | choose the approach and the sequence; for a design, the interface/structure | the set of changes, or the sequence, is concrete and its first item is executable now | the first item is a literal action, not a description; plan no more than the task needs — a single edit needs no design |
| Patch | make the change | the exact change is in the workspace | edit for a targeted change; oldString must be unique; after the edit, verify — do not re-read the file you just changed |
| Verification | confirm the change with the acceptance command/tests | the acceptance command that failed now passes | run builds/tests in the foreground; never repeat a failed command — on failure change the approach and return to Localization with the new evidence; do not re-verify what passed |
| Environment triage | tell an environmental failure (missing config/deps) from a failure of the goal | the failure is named as environmental or the goal's, and the environment is prepared if it is environmental | building the project is setup, not the defect; this is a detour — return to the state you came from |
| Hand-off | close the work | the goal is closed with `stop` | call `stop` now — the work is verified; do not re-verify and do not start new work |

#### C5. State budgets (`islands.ts`)

Budgets are **stop signals**, not work quotas; keep them small and in one place. Starting
values (calibrate live):

| State | Budget | Why |
|---|---|---|
| Reference | 1 fetch | the 9×403 live drift |
| Reconnaissance | 2 rounds of batched inspection | 89% reasoning before the first edit |
| Localization | 0 extra reads once the target lines are on the tape | 26 turns of reinvention |
| Verification | 0 repeats of the same command; 1 re-run after a change | repeated failing runs |
| Environment triage | 1 round, then return | wandering in a floating state |

#### C6. `create_goal` description and `B7`

- `src/llm/tools.ts` — lead with the transition: *move the work to the next state (or interpret
  the request)*; demote branching/decomposition; drop the now-false "A sub-goal replaces the
  current plan item". Keep the `WORKSPACE ROOT`/`cd <dir> &&` rule.
- `B7` — one explicit sentence: *to change state, call `create_goal` whose `state` names it; a
  failure is not needed*; drop the "after a failure" framing.

#### C7. Projection-level stall nudge

The engine already computes `stall` (`src/loop/graph.ts:315-318`, `src/ir/progress.ts`). Add a
**soft attractor** before the hard `no_progress` kill, rendered as a `SystemMessage` after the
island instruction — **not** a fake assistant turn (the tape is a projection of the IR):

- `projectNode` passes `state.stall` into `project(...)`; `Context` gains `nudge`; `buildMessages`
  pushes it (deterministic, derived from the loop state).
- Phrasing is a **decision prompt**, not a command (avoid the §7/B12 imitation trap):
  `You have made no progress for {n} turn(s) in {State}. Decide now: name the exact change and
  edit; move to another state with `create_goal`; or `stop`.`
- Escalation: gentle at `n=1`, firmer at `n=2`; the existing `no_progress` remains the hard
  stop.

### D. Data (`src/ir/islands.ts`)

- add `what: string` to `Island`;
- `next: readonly IslandId[]` → `next: readonly { to: IslandId; when: string }[]` (bridges as
  preconditions — closes the matching open question);
- `Start` stays a static block in `blocks.ts` (no data-model field), unless review prefers a
  field.

### E. Tests

- `tests/ops/create_goal.test.ts` — new case **`[OP-CG-5]`**: `create_goal` after a
  **successful** action is accepted, creates a new plan `item`, the goal is its newest
  alternative, focus descends.
- `tests/loop.test.ts` — replace "refuses to decompose an open goal with no current plan item"
  with "starts a new plan item when the plan is exhausted".
- `tests/ops/applicable.test.ts` — assert `classify` accepts `create_goal` on an exhausted plan
  (frontier/gate agree).
- `tests/islands.test.ts` — adapt `next` checks to `next[].to`; require `what` non-empty.
- `tests/prompt.test.ts` — the state render (`What/Done when/Constraints`), the `Start`/`Transitions`
  sections, and (if C7 lands) the nudge.

### F. Docs

- `docs/ir_operations{,_ru}.md` — OP-CG-2 `Pre`/`Effects`/`Refuses`, add `OP-CG-5`, notes, and
  the coverage matrix (`OP-CG-1..5`).
- `docs/ir_semantics{,_ru}.md` §2.7, §4.1.
- `docs/ir{,_ru}.md` — the `create_goal` bullet and the refusal list (`no_current_item` gone).
- `docs/system_prompt{,_ru}.md` — the B1/B2/B4/B7 rows and the block inventory.
- `docs/prompt_state_machine_concept{,_ru}.md` §5 — the assembly note (states render as
  `What/Done/Constraints`; transitions as conditioned edges).
- `docs/README.md` already links this plan.

### G. Synthetic live gate (before the expensive bench)

Cheap, one-LLM-call checks that the model actually **transitions** and **reacts to the nudge**.
They run before any expensive task and are a **gate**: if they fail, the bench is not worth
spending. The vehicle is the online step layer (`tests/live/ir_operations_step.test.ts`
pattern): build a projection **offline** (exactly what the engine would show) and assert the
**shape** of the model's next move, retried `SKEIN_STEP_REPEATS` (default 3). These check the
model's *willingness*; the engine's acceptance is covered offline by `OP-CG-5`.

New `tests/live/state_transitions_step.test.ts`:

- `localized-edit-now` — a focused Localization goal whose bug lines are already on the tape:
  expect `apply { edit }` (or `create_goal { state: "patch" }`); a further read/recall/grep is
  exactly the drift this change targets.
- `recon-transition` — a focused Reconnaissance goal with the project map on the tape: expect
  `create_goal` with a different `state`, or a concrete action — not another listing.
- `verified-stop` — a focused Verification goal with a passing acceptance observation: expect
  `stop` (or `create_goal { state: "handoff" }`).
- `handoff-stop` — a focused Hand-off goal: expect `stop`.
- `nudge-stalled` (with C7) — a focused Localization goal after several reads and no edit,
  **with** the stall nudge: expect a decisive move (`edit` / `create_goal` / `stop`); print the
  no-nudge control so the shift is visible.

Plus one **end-to-end** synthetic smoke on a tiny fixture (via the scenario harness,
`tests/live/scenarios.test.ts`): hard — the run is solved and closes with
`stopReason=request_addressed`; soft report — the distinct goal `states` visited. A new
`statesOf(events)` helper reads the goals' authored `state` from the journal.

Cost ≈ 5 steps × 3 repeats + one tiny loop ≈ a fraction of one run. Only if this gate is green
do we spend the two `fix-ocaml-gc` runs below.

### H. Verification (live bench)

- Re-run `fix-ocaml-gc`, net `on` and `off` (one run per branch = direction, not statistics,
  per `docs/prompt_state_machine_concept.md` §7).
- Success signal (beyond reward): the doxa creates **more than one goal** with **distinct
  `states`**, and the run reaches `reward 1` — ideally with a clean `stop` rather than
  `max_turns`.

## 5. Decisions from the prompt review

- `B1`: remove the tape/context sentences; **keep** the batch-calls rule.
- `B2` and `FRAGMENT`: remove.
- States render as `What / Done when / Constraints`; the per-state `When done …` line is
  dropped — the mechanism lives once in `B4`.
- Transitions are **conditioned edges grouped by source** (branches and cycles are explicit);
  `Start` names the candidate initial states; `Hand-off` is named terminal.
- Budgets: Reference 1 / Reconnaissance 2 / Localization 0 if on tape / Verification no repeat /
  Env_triage 1 then return.
- The stall nudge is a projection-level `SystemMessage` derived from `stall`, phrased as a
  decision, not an action order.

## 6. Open questions

- **`env_triage` `next`.** Keep the adjacency list in the data (the graph renders it) but speak
  "return to the state you came from" in the text, or introduce an explicit return semantics?
- **`Start`** as static text in `B4` vs a field on `Island`.
- **Missing `Interpretation` island** (the request→goal step) and the bridge from it.
- **`max_turns` vs `stop`.** Attempt 2 solved but never stopped. Is Hand-off (imperative
  "call `stop` now") + the nudge enough, or is an explicit verified→stop push needed?
- **Nudge phrasing/escalation** and the thresholds (interaction with `noProgress`).

## 7. Risks and cost

- Prompt and engine changes are cheap and offline-testable; the live confirmation is not
  (~9₽/run; 8 of the 10 allowed runs remain).
- Touching the `create_goal` gate is a semantics change: the doc comes first, and the
  `no_current_item` removal must not resurrect a criterion gate (closure stays `stop`).
- The prompt redesign is a behavioural change measured only live; budgets and the nudge are
  starting values to calibrate, not facts.
- Removing `B2`/`FRAGMENT` and reworking the graph touch stable, cached prompt text — one
  change per A/B, both nets.
- The synthetic live gate (§4 G) bounds the spend: transitions and the nudge are validated on
  cheap one-call checks before the two `fix-ocaml-gc` runs.
