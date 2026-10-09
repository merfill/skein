# Skein — goal reduction plan (the minimal goal)

> English mirror of `docs/plans/goal_reduction_plan_ru.md`.
> Status: **planning — awaiting approval.** No code until the owner signs off.
> Supersedes the goal/plan/closure parts of `docs/plans/traversal_stack_spec.md` and the
> criterion gate of `docs/ir_semantics.md` §2.2/§4.3; touching `AGENTS.md`.

## 1. Purpose

A goal today carries too much: `done_when` (a criterion command), a separate `step`, a
`revises` id list, and an exposed `state`, and the engine gates `stop` on a criterion run's
`exitCode`. That makes the model commit a verification command **before it can explore** (a
fresh request offers only `create_goal`/`decline`), and a wrong command poisons the run — the
`fix-ocaml-gc` regression was 36 of 56 turns of churn from exactly this. The reduction keeps
only what a goal really is: what to do, why, a sketch, and a plan.

## 2. Target model

A **goal** = `what` (required) + `why?` + `sketch` (required string) + a **plan container**.

- **`sketch`** — a short free-form string; a note to the model so it does not lose the
  thread (the old `plan` string, renamed).
- The **plan container** is created with the goal and **immediately seeded with the first
  plan item**, which becomes the current item and grows as the model appends.
- **Every plan item is an `alternatives` container.** Its first element is the item itself —
  a command, or a goal. The engine executes the current element and returns its result with
  the whole context (the ordinary ReAct-in-place loop of `traversal_stack_spec.md` §3).
- After a result the model may:
  1. append the **next plan item**;
  2. `stop` — the next plan item becomes a `stop` node, and the goal-closing procedure runs;
  3. create an **alternative** to the current item — a goal or a command — appended to the
     item's alternatives container (append-only; the last is current).
- **Closure is dynamic.** `stop` appends the `stop` plan item and the `has_stopped` edge.
  There is no criterion run, no exit-code oracle, no `check_not_run` gate.

Closedness is read from **edges**, never stored: a goal is closed ⇔ it has a `has_stopped`
edge; a plan item is performed ⇔ its current option is an executed action or a closed goal.
The IR stays monotone (design principle: the context is a projection, facts are only added).

## 3. Attribute reductions

| attribute | now | after | why |
|---|---|---|---|
| `what` | required | **required** | keep |
| `why` | optional | **optional** | keep (hypothesis) |
| `plan` (string sketch) | required | **`sketch`, required** | keep, renamed; the model's not-lose-the-thread note |
| `step` | required, a separate field | **removed** — the seed is the plan's first item | redundant: a plan item is just the container's last element |
| `done_when` | required criterion command | **removed** | blind commitment; closure is `stop`, decided while working |
| `exitCode` as criterion | `run { target }` → pass/fail gate | **removed** | an exit code is ordinary output, not a closure oracle |
| `revises` (id list) | `create_goal` param | **removed** | the current item is implicit (the last); history lives in the events |
| `state` (`open`/`executed`/`stopped`) | derived, **exposed** on nodes/items | **removed from the model** | closedness = `has_stopped`; performed = `produces` — monotone, derived on demand |
| `checkReady` | projection field | **removed** | a consequence of the criterion |
| `nextAction` | projection field | **removed** | "the current item is the last" is already the rule |
| `background` / `job` (`run`) | run params + job machinery | **removed** | not part of the goal model (owner: never heard of it) |
| root-goal / `interpreted` special case | the request's goal is fixed-once and privileged | **removed** — an ordinary goal at the request | there is no "root goal"; a goal at the request is just a goal |
| `alternatives` | container | **kept** (now explicit per plan item) | branching/revision is how the model recovers — cannot be removed |
| `decline` / `unactionable` | operator + node | **kept** | still needed for a non-actionable request |

## 4. Operator surface after reduction

- `create_goal { what, why?, sketch, command }` — at the **request** it is the
  interpretation; at an **open goal** it is a **sub-goal alternative** to the current plan
  item. It seeds the plan container with the first item (`command` = the first plan item /
  command). `command` is not a special "step": it is simply the first plan item.
- `apply { … }` (`read` / `grep` / `list` / `edit` / `write` / `run` / `fetch` /
  `apply_patch`) — a plan step. `run` loses `target`, `background`, `job`: it is one plain
  command; applying a different command to the current item adds it as an **alternative**.
- `stop { why? }` — appends a `stop` plan item and closes the goal (no criterion gate).
- `decline { why? }` — a non-actionable request (kept).
- `query { id }` — addressing a stored body (kept).

> **Decided:** the first plan item is carried by `command` — `create_goal { what, why?,
> sketch, command }`; the old `step`'s `label` is dropped.

## 5. What is explicitly deferred (a different problem)

- **Cycle / loop detection**, premature-stop and no-progress guards. The owner defers this;
  the reduction deliberately does not replace the criterion gate with another guard yet.
- Working-set eviction policy (`traversal_stack_spec.md` §11).

## 6. Changes by file

1. **`src/llm/schemas.ts`** — `create_goal`: `{ what, why?, sketch, command }` (drop
   `done_when`, `step`, `revises`); `run`: `{ command? }` only (drop `target`, `background`,
   `job`); `actionSchema` rewritten accordingly.
2. **`src/llm/tools.ts`** — `createGoalParams`, `runParams`; `create_goal`/`run`/`stop`
   descriptions lose the criterion/check/job language.
3. **`src/ir/types.ts`** — `GoalPayload`: `{ what; why?; sketch? }` (drop `done_when`);
   remove `NodeState`.
4. **`src/ir/graph.ts`** — remove `criterionPass`/`criterionFailed`/`stateOf`; closedness via
   `hasStopped`, performed via `actionExecuted`.
5. **`src/ir/traversal.ts`** — `applicable`: drop `checkReady`, `nextAction`, the
   criterion-based `stop` gate (`stop: true` on an open goal) and the request/root special
   case; `firstUnfulfilledItem`/`cursorOf`/`isFinished` reworked without `NodeState`.
6. **`src/loop/classify.ts`** — remove the `stop` gate (`check_not_run`), the
   `repeat_hypothesis`/`unknown_revision` guards and the `interpreted`/`addressed`
   criterion-coupled checks.
7. **`src/ir/project.ts`** — `PathNode`: drop `state`, `done_when`, `planHint`; keep
   `what`/`why`/`sketch` + `plan`/`alternatives` (per item). `Context`: drop `checkReady`;
   drop `nextAction` or keep it purely informational.
8. **`src/tools/index.ts`** — `create_goal` seeds the plan's first item and descends;
   `run` is a plain command (no `target`, no job machinery — remove `startJob`/`pollJob`
   from the model path or the whole `emitJob` branch); `stop` appends the `stop` item.
9. **`src/loop/prompt/blocks.ts`** — B3/B4 (vocabulary: `what`/`why`/`sketch`, no
   `done_when`/`state`/`checkReady`), B6 (drop "the criterion is the request's command"),
   B7 (no `step`), B10 (failure→cause without a criterion link), B11 (revision without
   `revises`/ids), B15 (`stop` without `check_not_run`).
10. **Docs** — `docs/ir_semantics{,_ru}.md` (§2.2, §2.4–2.6, §4.1–4.3, §6),
    `docs/tools{,_ru}.md` (§2.1, §2.2, §4.3, §4.7, §5.1), `docs/system_prompt{,_ru}.md`,
    `docs/ir_operations{,_ru}.md` (operator registry), `docs/walkthrough{,_ru}.md`,
    `docs/plans/traversal_stack_spec{,_ru}.md` (mark the criterion parts superseded),
    `docs/benches/bench_report{,_ru}.md` (note the model change), **`AGENTS.md`** (rewrite the
    stop invariant: a goal closes by `stop`; no criterion gate).
11. **Tests** — `tests/ops/{create_goal,stop,applicable,traversal,derivation,decline}.test.ts`,
    `tests/{ir,loop,prompt,coverage}.test.ts`, `tests/tools.test.ts`, L1 prompt contract.

## 7. Staging and verification

Each stage is its own green commit.

1. **Schema + types + action parser** (`schemas.ts`, `tools.ts`, `types.ts`).
   `npm run typecheck`.
2. **Graph + traversal + classify** (closure and frontier without the criterion).
   `tests/ops/{applicable,traversal,derivation,stop}.test.ts`.
3. **`executeAction`** (`create_goal` seed, `run`, `stop`).
   `tests/ops/{create_goal,apply,stop}.test.ts`, `tests/tools.test.ts`.
4. **Projection + prompt**; `tests/ir.test.ts`, `tests/prompt.test.ts`.
5. **Docs + coverage registry + `AGENTS.md`**; `tests/coverage.test.ts`.
6. **Full offline gate**: `npm run typecheck` and
   `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'`.

Optional after the gate: one cheap live `create_goal` call to confirm the reduced shape
(no `done_when`/`step`; the plan seeded with the first item), then a live
`fix-ocaml-gc` to confirm the churn is gone (owner's call, cost).

## 8. Consequence to accept

Closure moves from a criterion run (`logos` reads an exit code) back to the doxa's `stop`.
That is the point of the reduction, and the reason cycle / premature-stop detection is
explicitly a **separate, later** problem (§5).
