# Skein — IR revision implementation plan

> Russian mirror — `docs/plans/ir_revision_implementation_plan_ru.md`.
> Status: **done (core).** P1 (shape), P2 (operations), P3 (context tape) and P4 (docs fold)
> are done; the offline suite is green (`npm run typecheck`; `SKEIN_LIVE=false npx vitest run`
> — 209 tests). P5 (live gate) is deferred to the following stage, the composite system
> prompt. Follow-ups noted in P4: full passes over `walkthrough` and `tools`.
> Spec: `docs/ir_revision.md` (EN) / `docs/ir_revision_ru.md` (RU). This plan is the order
> of work and the decisions. When it is done, the revision is folded into the standing
> documents (P4) and the spec is removed.

## 1. Purpose

Implement `docs/ir_revision` in code: the **shape** (nodes and relations), the
**operations** and command placement, and the **context** as a message tape; bring the
tests and the rest of the documentation in line. Not in scope (unchanged): the doxa/logos
split, "a goal is closed only through `stop`", the append-only journal, determinism.

## 2. Fixed decisions

| # | decision |
|---|---|
| D1 | Relations are renamed to the spec's names: `goal`, `unactionable`, `plan`, `stop`, `items`, `alts`, `result`, `mutates`. The former `item` (plan→action) and `has_alternatives` are gone. |
| D2 | Non-execution of a command (repeat, stale base, forbidden path, empty command) is an `action` + `observation` with a reason. `record_rejection` remains **only** for the structural moves (`create_goal` / `stop` / `decline`). |
| D3 | `Context` is a tape of messages only (`system` / `user` / `assistant` / `tool`), rebuilt from the tree each turn. The blocks `path` / `lastResult` / `shown` / `calls` / `applicable` / `budget` are gone. |
| D4 | `create_goal` runs its first `command` at once (the logos), so the goal is born with its first item already executed. The move is three messages: `assistant` (the goal), `assistant` (the command call), `tool` (the observation). |
| D5 | The doxa proposes; the logos executes and records. The engine never asks the model to run the plan. |

## 3. Defaults for the open questions (spec §8)

- **§8.1 base / node prompt.** Base = role, contract (one move; the logos decides), answer
  form, stream discipline, tool index — stable, the cache prefix. Node = the admissible
  moves, the rules of the current situation (fresh request / open goal / return), what the
  arm shows. Rule of thumb: true on any move → base; called for by a state → node.
- **§8.2 "first unfulfilled item".** Let `I = firstUnfulfilledItem(goal)` = the first plan
  item whose **current (last) alternative** is not fulfilled. An alternative is fulfilled
  when it is an executed `action` or a `stop`ped `goal`. None → the plan is exhausted.
- **§8.3 alternative marking.** Keep the one-line marker in the tape; revisit if it proves
  too coarse.

## 4. Placement of a command (spec §4)

The outcome of the current item is read from its **current (last) alternative**: a command
whose observation carries a result is a **success**; one that carries a reason is a
**failure**; a timeout (no `exitCode`) is **no verdict**; a `stop`ped goal is a **success**.

Placement of the incoming command (the doxa chooses the command; the logos places it):

- the current item `I = firstUnfulfilledItem(goal)`:
  - `I` is undefined (the plan is exhausted) → the command becomes a **new plan item**;
  - `I` exists → the command becomes a **new alternative of `I`**.
- a **sub-goal** (`create_goal` on an open goal) always becomes a new alternative of `I`
  and the focus descends into it; with no `I` it is refused (§3.2).

Bootstrap: `create_goal` seeds `I0 = [A]` and runs `A`; the outcome of `A` decides where
the first `apply` after it goes (a success → a new item; a failure → another alternative of
`I0`). Every attempt leaves new nodes; an existing node is neither reused nor edited.

## 5. Phases

Each phase ends with `npm run typecheck` and `SKEIN_LIVE=false npx vitest run` green before
the next starts.

### P1 — shape (`src/ir`, `tests/invariants.ts`)

- `types.ts`: `WORK_KINDS` loses `alternatives`, gains `item`; `EDGE_KINDS` becomes
  `goal`, `unactionable`, `plan`, `stop`, `items`, `alts`, `result`, `mutates`.
- `events.ts`: picks the new kinds up from `types.ts` (no structural change).
- `graph.ts`: `children` is populated by `items` (plan→item) and `alts` (item→action/goal);
  helpers `planOf` / `goalOf` / `unactionableOf` / `stopOf` / `itemOf`; drop `alternativesOf`
  and `hasStopped`.
- `traversal.ts`: `itemFulfilled` via the current alternative; `cursorOf` /
  `firstUnfulfilledItem` over items; `focusEvents` descends into a goal alternative;
  `isFinished` reads the `stop` relation.
- `tests/invariants.ts`: DAG edge set and goal binding under the new relations.
- Standalone shape tests in `tests/ir.test.ts`; `tests/ops/*` move to the new shape.

### P2 — operations and placement (`src/tools`, `src/loop`)

- `tools/index.ts`:
  - `create_goal` (request): `goal` edge + `G/Q/I/A` (`plan`, `items`, `alts`); run `A` at
    once (D4); descend.
  - `create_goal` (goal): `alts` edge `I → G`; run the sub-goal's first command; descend.
  - `apply`: run the command; place its `action` by the rule of §4 above (new item on
    success / new alternative otherwise); a repeat / stale / forbidden path / empty command
    is an `action` + `observation` with a reason (D2). No `ensureAction` reuse.
  - `stop`: only the `stop` relation `goal → stop`; a stop node is no longer a plan item.
  - `decline`: unchanged (`unactionable` node, `unactionable` relation).
- `loop/classify.ts`: drop the command-level refusals; keep the structural ones
  (`interpreted`, `not_addressed`, `not_request`, empty fields).
- `loop/graph.ts`: `progress` / `branchSubtree` / level results over `items` / `alts`;
  run completion reads the `stop` relation.
- `tests/ops/*` rewritten for the new placement and observation-based refusals.

### P3 — context tape and system part (`src/ir/project.ts`, `src/loop`, `src/llm`)

- `project` returns a tape of messages (§5): roles `system` / `user` / `assistant` / `tool`;
  built from the tree; a non-monotone cut at a goal's closure (its inner messages leave, the
  `stop` message stays on the parent's arm).
- Move → messages: `create_goal` → goal + call + observation; `apply` → call + observation;
  `stop` / `decline` → the reason. Alternative marking per §8.3; `thought` is not stored.
- Base / node system part (§6 and §8.1): the base is stable; the node instruction is
  rendered with its node, once.
- `recall`/`search` render as transient `assistant` + `tool` messages (not nodes); addressing by
  `id` and the working set stay, without the old blocks.
- `loop/graph.ts` `projectNode` simplified; `loop/propose.ts` / `loop/prompt/blocks.ts`
  follow the base/node split.
- Tests: `tests/prompt.test.ts`, `tests/ir.test.ts`, `tests/loop.test.ts`,
  `tests/workingset.test.ts`.

### P4 — documentation

- Fold the revision into `ir_semantics`, `projection`, `context_design`,
  `plans/traversal_stack_spec` (EN + `_ru`); remove `ir_revision` (EN + `_ru`).
- Update the as-built `ir`, the operator registry `ir_operations` (+ ids and the coverage
  gate), `walkthrough`, `tools`, `system_prompt`, `concepts`, `README`, `implementation_plan`,
  `step_reduction_plan`; all `_ru` mirrors.

### P5 — verification

- `npm run typecheck`; `SKEIN_LIVE=false npx vitest run`; then the live gate and a
  `fix-ocaml-gc` run (the context changes, so measure turns / tokens).

## 6. Open questions

- The exact base / node prompt boundary (§8.1) — a first cut in P3, refined on live runs.
- The alternative marker (§8.3) — simplified; revisit if it proves too little.
