# Skein — plan: one closure (`stop`), checks as observations, no arbiter

> Russian mirror — `docs/plans/archive/stop_closure_plan_ru.md`.
> Basis — the design discussion (2026-10-09): the `arbiter` / `check` / `under`
> machinery was imported from the Ankyra papers and does not fit a coding agent; a frame
> must close **only** by `stop`, and every result must be a journaled fact.
> Implemented step by step; every step leaves the tree green.

Related: `docs/ir_semantics.md` (source of truth — change it with the code),
`docs/ir_operations.md`, `docs/projection.md`, `docs/plans/traversal_stack_spec.md`,
`docs/system_prompt.md`, `docs/tools.md`. History: `docs/plans/archive/ir_operations_revision_plan.md`
§2.4 (the original "stop only at an addressed request"), commit `ad28337` (the arbiter-goal
stop that introduced the premature stop).

## 1. Context (what is wrong)

The tree currently closes a frame two different ways:

- an **objective** goal → a passing `check` auto-closes it (`predicateOf = achieved`,
  traversal pops it, `src/ir/traversal.ts:40`);
- an **arbiter** goal → the doxa's `stop` (`has_stopped`), plus `record_check actor:"user"`
  as "external acceptance" (`src/ir/approval.ts`).

Three things were imported from `ankyra/docs/doxa_and_logos_ru.tex` (§«Арбитр») and the
Ankyra paper, where the Arbiter only *chooses operators and when to stop* — it is **not**
per-goal acceptance:

1. **Acceptance as an event.** `done_when.kind = "arbiter"` + `record_check actor:"user"`.
   In an autonomous run there is no user, so such a goal can never close; commit `ad28337`
   patched the deadlock with `has_stopped` / `request_stopped`.
2. **Conditional interpretation** (`under` / `achieved_under`, `checkHasUnder`,
   `src/ir/graph.ts:83`) — central in Ankyra, no referent in a coding agent.
3. **A dual criterion** `objective` / `arbiter`.

**Observed defect.** `fix-ocaml-gc` (`bench/runs/sandbox-tasks/2026-10-08T19-10-07-157Z-…`)
ended `request_stopped` in 14 turns with **zero mutations**: the model created an arbiter
sub-goal and stopped it immediately; the engine accepted and the run ended (reward 0). The
problem is the artifact, not the stop: `stop` is *control*, not a criterion.

## 2. Target semantics

- **One closure: `stop`.** A frame (goal or request) is closed **iff** it has a
  `has_stopped` edge. The doxa proposes `stop`; the engine gates it. (Later: the user may
  force a stop/suspend; not now.)
- **A check is a run of the goal's criterion.** No `check` node, no `verdict`, no
  `verifies` edge, no `inconclusive`. A `run` produces an ordinary `observation` carrying
  `command`, `target?`, `exitCode`; **`pass ⇔ exitCode === 0`**, `fail ⇔ exitCode !== 0`.
  A non-decisive run (timeout / crash) is just an observation **without** `exitCode`.
- **No statuses on goals.** Derived: action `executed`; goal `open | stopped`; request
  `addressed` (the chosen interpretation is `stopped`). Success/give-up is read from the
  criterion observation, not stored as `achieved` / `refuted`.
- **Continuation reads the facts.** The admissible move at an open goal depends on its
  latest criterion observation:
  - no targeted observation → run the criterion (`run {target}`);
  - `exitCode 0` (pass) → may `stop`;
  - `exitCode != 0` (fail) → add an alternative (`create_goal {revises}`); or, **if the
    plan is exhausted**, `stop` (an honest give-up).
- **Hard gate for `stop`** (agreed):
  - on a **goal**: accepted **iff** the criterion passed, **or** (not passed **and** no
    unfulfilled plan item — the doxa actually ran its plan);
  - on the **request**: accepted **iff** the chosen interpretation is `stopped`.
- **Remove:** `done_when.kind` / `arbiter`, `src/ir/approval.ts`, `under` / `achieved_under`,
  the `check` node + `record_check` event + `verifies` edge + `verdict` + `inconclusive`,
  the derived predicates `achieved` / `refuted` / `abandoned`, and the auto-pop on
  `achieved`.

## 3. Invariants (rewritten)

- A goal is never closed without a `stop` (`has_stopped`); a request ends only at its own
  `stop`.
- A goal is never *stopped as satisfied* without a passing criterion observation
  (`exitCode 0`): check provenance stays. A `stop` without a pass is a give-up and is
  visible in the facts (the latest criterion result is not a pass).
- `project` is deterministic: same events → same `Context`.
- doxa proposes; logos (the engine) gates and derives.

## 4. The model (shapes)

- **goal payload:** `{ what, why?, done_when: string /* the criterion command */, plan: string /* sketch */ }`.
- **observation payload (run):** `{ command, target?, exitCode?, output?/outputRef?,
  error?/errorRef?, witness?, signal?, … }`.
- **edges:** `has_plan`, `item`, `chosen`, `has_alternatives`, `produces`, `mutates`,
  `has_stopped` (drop `verifies`, `under`).
- **helpers:** `criterionResult(state, goalId)` = the latest observation with
  `target === goalId`; `criterionPass` = its `exitCode === 0`; `planExhausted(state, goalId)`
  = no unfulfilled plan item.

## 5. Steps (each step green)

After each: `npm run typecheck` and `SKEIN_LIVE=false npx vitest run`.

### Step 1 — stop gate (the fix, engine only)
- `src/ir/graph.ts` (or a helper): `criterionPass(state, goalId)` and `planExhausted(...)`
  (criterion read from the current `check`/observation).
- `src/loop/classify.ts` `stop`: accept a goal **iff** `criterionPass` **or**
  `planExhausted`; keep the refusal messages (`check_not_run` for an objective goal that
  can still work, `not_addressed` for the request). Add a `focusHint`.
- `src/ir/traversal.ts` `applicable`: `stop` is offered under the same condition, so the
  frontier and the gate agree.
- Tests: extend `tests/ops/stop.test.ts` — a goal with zero work is refused
  (`check_not_run`); a goal whose criterion failed **and** whose plan is exhausted is
  accepted; a passing goal is accepted.

**Check:** typecheck + offline green. A goal whose plan is not exhausted can no longer be
stopped (the zero-work stop is gone). The observed `fix-ocaml-gc` give-up had an **exhausted**
plan, so this gate alone does not change that trace — the full fix is this gate **plus** step 2
(no `arbiter` shortcut) and the prompt (step 5).

### Step 2 — remove `arbiter` (and `under`)
- `src/llm/schemas.ts` / `src/llm/tools.ts` / `create_goal`: `done_when` becomes a
  **command string**; drop the `arbiter` branch and `under`.
- `src/ir/types.ts`: `GoalPayload.done_when: string`; remove `under` from node/check payloads.
- `src/ir/graph.ts`: drop `checkHasUnder`, `achieved_under`.
- remove `src/ir/approval.ts`; drop the `actor`-`user` acceptance path.
- `src/loop/classify.ts` / `src/tools/index.ts`: remove the `arbiter_goal_needs_acceptance`
  branch, the arbiter-goal `stop` acceptance, and `request_stopped` as "handed to arbiter".
- Prompt B6 (a request that names a command ⇒ objective) loses its `arbiter` counterpart.
- Tests: `tests/ops/create_goal.test.ts`, `tests/ops/stop.test.ts`, `tests/loop.test.ts`.

**Check:** typecheck + offline green.

### Step 3 — collapse `check` into `observation`
- `src/tools/index.ts` `run`: always write an `observation` with `{ command, target?,
  exitCode, output/error }`; no `record_check`, no `chk:` id, no `verdict` / `inconclusive`;
  move the run's `witness` onto the observation.
- `src/ir/events.ts` / `src/ir/types.ts`: remove the `record_check` event, the `check` node
  kind, `verdict`, `under`, and the check fields on the `produces` edge.
- `src/ir/graph.ts`: remove `latestClosingCheck`, `goalPredicate`, `requestPredicate`;
  `criterionResult` now reads observations with a `target`.
- `src/loop/observe.ts`: read `witness` from observations.
- `src/loop/classify.ts` / `src/ir/traversal.ts` / `src/ir/project.ts`: re-key on
  `criterionResult` / `has_stopped`; the projection shows the latest criterion observation
  (command + exit code) instead of a check row.
- Tests: `tests/ops/apply.test.ts`, `tests/ops/derivation.test.ts`, `tests/ops/query.test.ts`,
  `tests/loop.test.ts`, `tests/observe.test.ts`, `tests/crash.test.ts`.

**Check:** typecheck + offline green.

### Step 4 — traversal: sole closure `has_stopped`
- `src/ir/traversal.ts`: `isFinished` = `hasStopped` (a goal) — drop the
  closed-predicate branch and `isSettledSuccess`; `itemFulfilled` = action `executed` /
  goal `has_stopped`; drop `itemSucceeded`; re-key `cursorOf` / `applicable` / `focusEvents`.
- Consequence: after a `pass` the doxa must explicitly `stop` the goal — one extra turn,
  uniform closure.
- Tests: `tests/ops/traversal.test.ts`, `tests/ops/applicable.test.ts`,
  `tests/ops/ir_properties.test.ts`, `tests/loop.test.ts`, `tests/workingset.test.ts`.

**Check:** typecheck + offline green.

### Step 5 — prompt
- `src/loop/prompt/blocks.ts` + `docs/system_prompt{,_ru}.md`: drop the arbiter text; state
  that every goal has a command criterion; that a `pass` is followed by `stop`; that `stop`
  without a pass is allowed **only when the plan is exhausted** (an honest give-up); that
  the request is stopped once its interpretation is closed.

**Check:** `tests/prompt.test.ts` + offline green.

### Step 6 — documentation (mandatory; do not skip)
Update, in the same commit as the code, so the achieved state is not lost:

- `docs/ir_semantics{,_ru}.md` — §2 node kinds (no `check`), §4.2 command/check, §4.3 `stop`
  (the sole closure + the gate), §6 completion (facts, no acceptance), invariants.
- `docs/ir{,_ru}.md` — as-built: `done_when` as a command, `run {target}`, observation facts.
- `docs/ir_operations{,_ru}.md` — `OP-ST` (the gate), `OP-AP-RUN` (criterion run), drop the
  `record_check` / `arbiter_goal_needs_acceptance` ids.
- `docs/projection{,_ru}.md` — the criterion observation replaces the check row.
- `docs/concepts{,_ru}.md`, `docs/logos_ir{,_ru}.md` — the arbiter is no longer a per-goal
  acceptance; the doxa proposes, the engine gates, the `stop` closes.
- `docs/tools{,_ru}.md` — `run {target}` (the criterion of the focus goal) and the exit code
  as the pass/fail fact.
- `docs/plans/traversal_stack_spec{,_ru}.md` §9 — verification is a targeted run's exit code.
- `docs/plans/implementation_plan{,_ru}.md` — mark this work done; refresh §3.
- `docs/benches/bench_report{,_ru}.md` — note the premature-stop fix and re-run
  `fix-ocaml-gc` in the sandbox.
- `AGENTS.md` (repo root) — rewrite the invariant "an arbiter goal only by external
  acceptance" to "a goal is closed only by `stop`; a `stop` without a passing criterion
  observation is a give-up".
- Move this plan to `docs/plans/archive/` when complete.

### Step 7 — sandbox smoke and report
- Re-run `fix-ocaml-gc` and one more task in the sandbox (one deliberate run) to confirm no
  premature stop and that the criterion run appears as an observation.
- Update `docs/benches/bench_report{,_ru}.md` §4.8/§4.9 with the result.

## 6. Tests

- `tests/ops/stop.test.ts` — the gate (pass, fail+exhausted, no-work refused).
- `tests/ops/derivation.test.ts` — only `executed` / `stopped` / `addressed`; no
  `achieved`/`refuted`/`achieved_under`.
- `tests/ops/apply.test.ts` — a `run {target}` yields an observation with `exitCode`;
  pass/fail derived.
- `tests/ops/traversal.test.ts`, `tests/ops/applicable.test.ts` — the frontier offers `stop`
  exactly when the gate accepts.
- `tests/ops/ir_properties.test.ts` — the frontier never offers an operator the gate refuses.
- `tests/loop.test.ts` — a goal is popped only by `stop`; the request ends only at its stop.
- `tests/coverage.test.ts` — the registry ids stay consistent with `docs/ir_operations.md`.

## 7. File map

- Core: `src/ir/{types,events,graph,traversal,project}.ts`, `src/loop/{classify,observe}.ts`,
  `src/tools/index.ts`, `src/llm/{schemas,tools}.ts`, `src/loop/prompt/blocks.ts`,
  remove `src/ir/approval.ts`.
- Tests: `tests/ops/{stop,derivation,apply,traversal,applicable,ir_properties,create_goal}.test.ts`,
  `tests/{loop,observe,crash,workingset,prompt}.test.ts`, `tests/live/ir_operations_step.test.ts`.
- Docs (§6): the files listed there, plus `docs/README.md` (index) and this plan's archive move.

## 8. Open questions

- **`revises`.** Today it is required when the focus goal is `refuted`. Re-key on "the
  criterion observation failed" — or simplify `revises` away (keep only the alternative
  mechanism)? Decide at Step 2.
- **`request_stopped`.** Keep it as the terminal reason for a give-up (chosen interpretation
  stopped without a pass) for the run report, or report only `request_addressed`? Leaning:
  keep both, derived.
- **`run {target}`.** Kept (agreed): it disambiguates nested goals with the same command and
  tags the observation, replacing `verifies` with a plain field.
