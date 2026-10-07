# Skein — plan: strictly step-by-step execution and the plan representation

> English mirror of `docs/plans/plan_stepwise_redesign_ru.md`.
> Basis — the bench analysis `docs/bench_report.md` §4.4 (run `2026-10-07__16-42-30`,
> Skein 0/9, `llm_error`) and the plan-representation discussion.
> Implemented **step by step**; every step leaves the tree green.

> **Step 0 decided: option (a)** — A1 (objective closure) is removed; a goal is always
> closed by its own check. `OP-AP-RUN-7` is rewritten for "closed by its own check".
> Step 2.5 is not added.
>
> **Progress.** Step 1 (remove A4) done. Step 2 (schema: `plan` string + `step`) done.
> Step 2.5 (§3(a), retire A1) done together with step 2: the schema change made the A1
> tests inexpressible, so `closeAncestors`/`ownerGoalOfPlan`/`itemSettled` were removed
> from `src/ir/graph.ts` and DER-CLOSE-1…5 plus OP-CG-5 were retired. Additionally
> (beyond plan, for consistency): `GoalPayload.plan` is projected as `PathNode.planHint`;
> the spec and `ir{,_ru}.md` are synced. Step 3 (sub-goal as an alternative to the
> current step) done; `OP-CG-2` rewritten. Step 4 (prompt B3/B4/B7/B11 +
> `system_prompt{,_ru}.md`) done. Step 5 (docs: `ir_semantics{,_ru}`, `ir{,_ru}`,
> `projection{,_ru}`, `context_design{,_ru}`, `concepts{,_ru}`,
> `traversal_stack_spec{,_ru}`) done. **Plan complete** (steps 0–5). Offline: 235 passed /
> 30 skipped.
>
> **Follow-up (after the bench).** From the `defeasible-rules` analysis: (a) a command rule
> in B6 (a request that names a command ⇒ `objective`, not `arbiter`) and rewritten refusal
> messages `unknown_revision` / `no current step to decompose`; (b) an optional external
> arbiter hook `AgentDeps.arbiter`, with the synthetic runner playing a program arbiter
> (`check.sh` → `record_check actor:"user"`). The whole synthetic suite is **10/10
> reward=1** (`docs/bench_report.md` §4.6). Offline: 236 passed / 30 skipped.

## 1. Context (what happened)

On the long terminal-bench tasks (high) Skein failed systematically: **all 9 trials —
`llm_error: "model returned no tool call"`** (`src/llm/structured.ts:309`). In the
`fix-ocaml-gc` trace the model built **6 nested `arbiter` goals**:

```
w:goal:2  arbiter; plan=[action ls ✓, action sed ✓, w:goal:18]
  w:goal:18 arbiter; plan=[…, w:goal:35]
    … → w:goal:65 arbiter; plan=[…, w:goal:82]
               w:goal:82 arbiter; plan=[3 actions ✓] cursor=3 (plan done, goal open)
```

The dead-end mechanics: for an `arbiter` goal with an **exhausted** plan, `applicable`
(`src/ir/traversal.ts`) offers neither `apply` (no `nextAction`, not `checkReady`) nor
`return` (not closed) — only `create_goal`. The model is forced to create another goal →
a funnel.

Roots:
1. **A4** ("auto-run leading items", `src/tools/index.ts` `AUTO_RUN_ACTIONS`) executes the
   plan in the same turn → "plan exhausted" happens instantly.
2. **Plan is optional** (`src/llm/schemas.ts:114` `plan … optional()`,
   `src/loop/classify.ts` `planOk`).
3. **A plan item can be a goal** (`planItemSchema`, `kind:"goal"`) — the model builds
   abstract sub-goals.

The fix direction: the goal node holds the plan as a **string hint**; traversal is
**step-by-step ReAct**; a sub-goal enters **only as an alternative** to a step.

## 2. Rules (IR invariants)

- **I1.** A goal is always created with a non-empty plan (`has_plan → plan`, ≥1 item).
  No plan → refusal.
- **I2.** At creation a plan item is **only `action`** (a concrete command, executable
  now). A `goal` item at creation is forbidden.
- **I3.** The goal node stores the **initial plan as a string** (`goal.payload.plan`) —
  an immutable hint.
- **I4.** Traversal is **strictly step-by-step** (ReAct): execute the current item → on a
  separate turn the model decides "next / enough". No auto-run.
- **I5.** Closure is **only by criterion**: objective → the command check; arbiter → ask a
  human and wait. The engine never closes (no auto-close).
- **I6.** A sub-goal enters **only as an alternative** to an existing item (append-only),
  never at creation and never as a plan item.

## 3. Consequence for A1 (decide before step 2)

`closeAncestors` (`src/ir/graph.ts`) walks **plan** containers and looks for goal
ancestors with a matching `done_when.command`. If plans hold actions only,
`closeAncestors` effectively never fires → **A1 ("one check closes the chain") becomes
dead**; nested objective goals close only by their own check.

Options:
- **(a) accept A1's removal** (closure is always a goal's own check; recover the "one
  step" saving differently);
- **(b) move closure to alternatives**: `closeAncestors` also walks `alternatives`
  containers (a sub-goal alternative with the same `command` closes its owner).

The decision affects `OP-AP-RUN-7` (`tests/ops/apply.test.ts`) — the only A1 coverage.

**Decision: (a)** — accept A1's removal. Under step-by-step ReAct, nested objective chains
with the same criterion do not arise, and supporting (b) adds coupling with no step saving.
The `closeAncestors`/`itemSettled`/`ownerGoalOfPlan` code in `src/ir/graph.ts` is removed
with A1 (dead branches). `OP-AP-RUN-7` — the only coverage — is rewritten for "closed by
its own check".

## 4. Step-by-step plan (each step green)

Order: **0 → 1 → 2 → 3 → 4 → 5**. After each: `npm run typecheck` and
`SKEIN_LIVE=false npx vitest run` (normal: 240 passed / 30 skipped).

### Step 0 — design decision on A1 (done)
Option **(a)** of §3 adopted: A1 is removed, closure is by a goal's own check; step 2.5 is
not needed.

### Step 1 — remove A4 (isolated)
- `src/tools/index.ts`: delete `AUTO_RUN_ACTIONS` and the auto-run loop in
  `case "create_goal"` (the "A4: …" comment); return the simple
  `{ events, turn: proposalTurn(...), done:false, stopReason:null }`.
- Drop the now-unused `fold` import if it becomes unused.
- Rewrite tests that assumed the auto-run (`tests/loop.test.ts` where the plan ran in the
  same turn) to step-by-step execution.
- `docs/plans/step_reduction_plan{,_ru}.md`: mark A4 **reverted** (next to A5), with the
  reason (it violates step-by-step; it created the funnel).

**Check:** typecheck + offline green.

### Step 2 — `create_goal` schema: plan string + first step
- `src/llm/schemas.ts`: remove `GoalItem`/`ActionItem`/`PlanItem`/`planItemSchema`; add
  `ActionStep { command; label? }` and `stepSchema`. In `create_goal`: `plan: z.string()`
  + `step: stepSchema` (+ `revises`).
- `src/loop/classify.ts`: remove `planOk`; refusals `empty_plan` (empty plan string),
  `empty_step` (empty command).
- `src/ir/types.ts`: `GoalPayload.plan?: string` (the sketch).
- `src/llm/tools.ts`: `createGoalParams` → plan string + step; update the description.
- `src/tools/index.ts`: `buildGoal` creates the plan with exactly **one** item — the first
  action from `step`; stores `plan` in the payload.
- Tests: `tests/ops/create_goal.test.ts` (OP-CG-4 "single step item"; REF-CG-EMPTY on
  `empty_plan`/`empty_step`; drop OP-CG-5 "nested plan"),
  `tests/ops/helpers.ts` (`interpretation(what, command?, step?)`), `loop.test.ts`,
  `workingset.test.ts`, `tests/live/ir_operations_step.test.ts` (drop `PlanItem`, pass the
  first step).

**Check:** typecheck + offline green.

### Step 3 — sub-goal as an alternative
- `src/tools/index.ts` `case "create_goal"`: the "else" branch (focus is an open goal)
  instead of "add a plan item" makes an **alternative to the current step**:
  `firstUnfulfilledItem(current)`; if it is an `action` — `ensureAlternatives(step)` +
  `item`+`chosen`; if there is no current step —
  `fail("no current step to decompose")`.
- Test: `create_goal` on an open goal attaches the new goal as an alternative to the
  current step, the focus descends into it (replace OP-CG-2).

**Check:** typecheck + offline green.

### Step 2.5 (§3(a)) — retire A1
- `src/ir/graph.ts`: remove `closeAncestors` and `ownerGoalOfPlan`; in `fold` collapse the
  second pass (`derivePredicates; closeAncestors; derivePredicates` → a single
  `derivePredicates`). Keep `itemSettled` only if another consumer still needs it,
  otherwise remove it too (check references).
- `tests/ops/apply.test.ts` `OP-AP-RUN-7`: rewrite for "a goal is closed by its own check"
  (no implicit ancestor closure).
- `tests/ops/derivation.test.ts`: remove the cases that covered A1 closure.

### Step 4 — prompt (B3/B7)
- `src/loop/prompt/blocks.ts` B3: "plan is a list of STAGES (sub-goals)" → "plan is a
  **string sketch**; at creation only the **first concrete step** is materialized; the
  traversal is step-by-step".
- B7: rewrite the example to `{ plan: "<string>", step: { command } }`; state explicitly:
  steps are **actions one at a time**; a sub-goal is **only an alternative**; "do one
  step, then decide the next from its result".
- Check `tests/prompt.test.ts` (block assembly) and update `docs/system_prompt{,_ru}.md`
  if needed.

**Check:** typecheck + offline green.

### Step 5 — documentation
- `docs/ir_semantics{,_ru}.md`: I1–I6 in §2 (nodes/plan), §4 (operators), invariants.
- `docs/ir{,_ru}.md` §2/§5: `done_when`, plan, `create_goal`, "an item is only an action".
- `docs/plans/traversal_stack_spec{,_ru}.md`: I1–I6 explicit; step-by-step traversal.
- `docs/concepts{,_ru}.md`: "plan = string + first step" if needed.

## 5. File map

- Core: `src/llm/schemas.ts`, `src/llm/tools.ts`, `src/ir/types.ts`,
  `src/loop/classify.ts`, `src/tools/index.ts`, `src/ir/traversal.ts`,
  `src/ir/graph.ts` (if §3(b)).
- Tests: `tests/ops/create_goal.test.ts`, `tests/ops/helpers.ts`,
  `tests/ops/apply.test.ts`, `tests/ops/traversal.test.ts`, `tests/loop.test.ts`,
  `tests/workingset.test.ts`, `tests/live/ir_operations_step.test.ts`,
  `tests/prompt.test.ts`.
- Docs: `docs/ir_semantics{,_ru}.md`, `docs/ir{,_ru}.md`,
  `docs/plans/traversal_stack_spec{,_ru}.md`, `docs/plans/step_reduction_plan{,_ru}.md`,
  `docs/system_prompt{,_ru}.md`, `docs/concepts{,_ru}.md`.

## 6. Bench status (paused)

- The §4.4 baseline run did not line up: the saved job `2026-10-06__17-31-37` is
  **high** (both agents), while the templates had been set to **low** by commit `ee24be9`.
- Decision: run the long tasks at **high** for both.
- Done: `bench/harbor/skein.template.yaml` and `bench/harbor/compare.template.yaml` set to
  `high`; `compare-offline.yaml` (a local dataset with `[agent] network_mode="no-network"`,
  `/tmp/opencode/tb-offline`) created and added to `.gitignore`.
- Runs (draft, before the fix): online-high `2026-10-07__16-42-30` (Skein 0/9, `llm_error`);
  offline did not complete cleanly (SIGTERM on the egress-control check).
- After this plan is implemented — rerun online-high (Skein) and offline-high (both
  agents), update `docs/bench_report.md` §4.4.

## 7. Open questions

- **§3**: decided — **(a)**, A1 is removed (see step 2.5).
- **I2**: confirmed — the plan is **actions only**; the terminal is the goal's `done_when`.
- **A4**: confirmed — remove it (it violates step-by-step).
- **arbiter in an autonomous run**: fine for the tests for now; the "human as a program
  with std streams" question is deferred.

## 8. Repository state

- HEAD `7bab53e` — base. Working tree: steps 1, 2 and 2.5 done; typecheck clean, offline
  234 passed / 30 skipped (minus 6 A1/OP-CG-5 tests).
- Uncommitted: Harbor template edits (`high`) and `.gitignore` (bench) — from the previous
  session, unrelated to the redesign.
