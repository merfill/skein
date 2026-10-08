# Skein — IR operations revision: the frontier and the doxa's three node-kinds

> Russian mirror — `docs/plans/ir_operations_revision_plan_ru.md`.
>
> Basis — the arm principle (`docs/concepts.md`, "The arm is ReAct in place") and the
> audit of `docs/ir_operations.md`, `docs/ir_semantics.md`, `docs/projection.md`,
> `docs/plans/traversal_stack_spec.md` against `src/ir/*`, `src/tools/index.ts`,
> `src/loop/classify.ts`, `src/ir/project.ts`.

Related: `docs/ir_semantics.md` (source of truth — this plan changes it first),
`docs/ir_operations.md` (operator registry and coverage), `docs/projection.md`,
`docs/plans/traversal_stack_spec.md`, `docs/system_prompt.md`, `docs/tools.md`.

## 1. Context: what the audit found

The principle (`docs/concepts.md`): within one arm Skein is ReAct in place — a goal is
created with a plan of exactly one item-command, the item executes, the result is
recorded and fed to the doxa, and the doxa adds the next node; an alternative turns the
arm into a tree. Every step is an IR event.

The code matches the *shape* (one-item plan: `buildGoal` `src/tools/index.ts:591`;
sub-goal as a step alternative `src/tools/index.ts:718`; check closes only its own goal
`src/tools/index.ts:1375`; deterministic focus `src/ir/traversal.ts:110`), but the audit
found gaps:

- **F1 — the frontier and the gate disagree.** `applicable` marks `create_goal` for
  every open goal (`src/ir/traversal.ts:222`), while `classify` refuses it when the
  objective goal's plan is done (`all_plan_fulfilled`, `src/loop/classify.ts:261`) or
  when no step can be decomposed (`src/tools/index.ts:688`).
- **F2 — the arbiter funnel.** For an open arbiter goal whose one step has executed,
  `applicable` is `["create_goal"]` (`nextAction` undefined, `checkReady` false,
  `plan !== undefined`), and that `create_goal` is guaranteed to fail — while the legal
  `apply` (a new command) is hidden (`docs/plans/plan_stepwise_redesign.md` §1).
- **F3 — two copies of the frontier.** `traversal.applicable` and `classify.focusHint`
  (`src/loop/classify.ts:183`) recompute the same rules independently and differently.
- **F4 — the stop is hidden.** Stopping is purely derived (`request_addressed` /
  `no_progress` / budget); the doxa has no node for it, and `applicableNames`
  (`src/ir/project.ts:359`) never exposes `return`.
- **F5 — `chooseVariant` is dead.** Set by `applicable`
  (`src/ir/traversal.ts:200`), never projected, with no operator.
- **F6 — the registry is incomplete.** `ir_operations.md` never specifies how `apply`
  attaches to a plan (reuse / chosen alternative of the current item / append an item,
  `src/tools/index.ts:629`), nor that a check creates an action and a `produces` edge.
- **F7 — the arm history is not rendered.** `traversal_stack_spec.md` §7 requires an
  item's `alternatives` inline; `ProjectionItem` has none (`src/ir/project.ts:33`).
- **F8 — `calls` collapses distinct edits.** Spec wants the short diff in `action`
  (`docs/tools.md` §4.4); the code dedups on `edit <path>` and keeps the diff only in
  `note` (`src/ir/project.ts:536`).
- **F9 — `tools.md` §2.1 is stale** (`plan` as a list, no `step`).

## 2. Target semantics

### 2.1 The arm and the cursor

At a focus the doxa is handed the **whole arm** — the ordered siblings (`plan` items or
`alternatives` options) with their states — and the **cursor marks the current node
only**. The engine does not dictate a single next move; it states what is admissible at
this point (the frontier). This is what makes the arm ReAct: the doxa chooses, the logos
gates.

### 2.2 The doxa's three node-kinds

Every accepted doxa turn **adds exactly one node**; a rejected turn adds a
`record_rejection` and changes the projection. The kinds:

- **continue** — `apply` a command: execute the next step. The engine attaches it to the
  plan (reuse an unexecuted matching action item; else it becomes the `chosen`
  alternative of the current unfulfilled item; else a new `item`) — `ir_semantics` §4.2.
- **alternative** — "let's try another": `create_goal` (a new interpretation at the
  request, a variant of a refuted goal, or a sub-goal decomposing the current step) or
  `apply` a different command (recorded as the `chosen` alternative of the current item).
- **stop** — `stop`: claim the request is done. Accepted only if the derived predicate is
  already `addressed`; otherwise refused.

`query` stays read-only (it adds no node). This must be stated in the semantics and in
the prompt (B3/B7/B15), not left implicit.

### 2.3 The frontier (one computation, shared)

`frontier(state, focus)` replaces `applicable` and drives both the projection and
`classify` (fixes F1–F3):

```
frontier = {
  goalId,
  canCreateGoal,   // request (not addressed) | refuted goal | open goal with a current
                   // unfulfilled action step
  canApply,        // focus is an open goal: a command may be executed now
  canCheck,        // objective goal whose plan is complete (== checkReady)
  canStop,         // focus is the root request and the derived predicate is addressed
  current?         // the current arm node (the cursor), informational
}
```

- `canApply` is true whenever the focus is an open goal (the exploratory command is
  always legal) — not only when `nextAction`/`checkReady` happen to be set (fixes F2).
- `canCreateGoal` mirrors the gate exactly (no `all_plan_fulfilled` surprise).
- `return` is engine-internal (never a doxa operator) and is no longer part of the
  frontier the model sees.
- `chooseVariant` is removed (F5): choosing a variant is just "alternative".

`Context.applicable` lists the operator names truly admissible: `["stop"]`, `["apply"]`,
`["create_goal"]`, or combinations; `checkReady = canCheck`.

### 2.4 The `stop` operator

- **Input:** `{ why? }`.
- **Pre:** focus is the root request; the derived predicate of the request is
  `addressed` (the chosen interpretation is `achieved`/`achieved_under`).
- **Effects:** `add_node` of kind `stop` (payload `{ why? }`); the loop stops with
  `request_addressed`.
- **Refuses:** `not_addressed` (the focus is not the request, or the request is not
  addressed), with a `focusHint`.
- **Projection:** the `stop` node is the terminal node; the request's acceptance stays
  external — `addressed` remains derived, `stop` sets no status.
- **Loop:** on an addressed request the frontier is `["stop"]`, so the doxa cannot
  wander; the run stops when the `stop` node is recorded.

### 2.5 Invariants (changes)

- invariant 20 is refined: the doxa still never closes a goal; `stop` is a *proposal*
  validated against the derived `addressed`.
- new: every accepted doxa turn adds a node (continue/alternative/stop) or is refused.
- invariant 4 (determinism) keeps its caveat: `project` also needs the latest turn's
  transient result (`ProjectOptions.lastOutput`).

## 3. Spec changes (step 1 — before code)

1. `docs/ir_semantics.md`
   - §2.1/§2.5: add the `stop` work node; keep `addressed` derived.
   - §2.6: rewrite "applicable at the point" around the arm + cursor + frontier; add the
     three node-kinds.
   - §4: add `stop` (§4.3) with the §0 template; update the operator count (two → three).
   - §4.2: make the `apply` tree-attachment cases explicit (they exist in the text but
     not as the operator's defined effect).
   - §9: refine invariant 20; add "every accepted turn adds a node".
2. `docs/ir_operations.md`
   - §1.1: add `stop`.
   - §2: new `OP-ST` family; extend `OP-AP-*` with the plan-attachment effects
     (`OP-AP-*-CONT` continue, `OP-AP-*-ALT` alternative); note check → action →
     `produces`.
   - §3: refusal `not_addressed` (stop); align with the shared frontier.
   - §5: coverage matrix entries.
3. `docs/projection.md`: operator names include `stop`; `PathNode.plan.items[]` carries
   `alternatives` (item-level revision history); `Item` shape updated.
4. `docs/system_prompt.md` (+ `src/loop/prompt/blocks.ts`): B3/B7/B15 state the three
   node-kinds and "always add a node"; the stop condition is the doxa's `stop`.
5. `docs/tools.md`: fix §2.1 (`plan` string + `step`); note the `stop` tool.

## 4. Code changes (step 2)

- `src/ir/traversal.ts`: replace `applicable` with `frontier`; drop `chooseVariant`;
  keep `focusEvents` as the engine's normalization.
- `src/loop/classify.ts`: gate from the shared `frontier`; add the `stop` gate
  (`not_addressed`).
- `src/tools/index.ts`: handle the `stop` proposal (add the node); document the
  `ensureAction` attachment as the continue/alternative path.
- `src/llm/schemas.ts` / `src/llm/tools.ts`: add the `stop` tool.
- `src/ir/types.ts` / `src/ir/events.ts`: add the `stop` work kind (via `add_node`).
- `src/ir/project.ts`: render `stop`; item-level `alternatives`; `applicable` from
  `frontier`; fix the edit dedup key (F8).
- `src/loop/graph.ts`: stop on the recorded `stop`; keep the derived `addressed`.

## 5. Tests (step 3–4)

**Offline (`tests/ops/`)**

- new `tests/ops/applicable.test.ts` (`TR-8`): for each focus shape (request
  open/addressed; goal open with a fresh step; objective plan done; arbiter plan done;
  refuted with/without variants) assert the frontier and that `applicable` equals the
  gate's admissible set.
- `tests/ops/create_goal.test.ts`: `apply` continue/alternative attachment with new IDs
  (`OP-AP-*-CONT`/`-ALT`); `all_plan_fulfilled` covered.
- new `tests/ops/stop.test.ts` (`OP-ST-1..`, `REF-ST-STATE`): accepted iff addressed;
  refused otherwise; the loop stops.
- `tests/ops/traversal.test.ts`: item-level `alternatives` in the projection
  (`TR-9`/`PRJ-ITEM-ALT`).
- `tests/ops/ir_properties.test.ts`: property over 400 seeds — the frontier's
  `canCreateGoal`/`canApply`/`canStop` never leads to a `classify` refusal of that
  operator (`TR-8`).
- `tests/coverage.test.ts`: the registry gains `OP-ST`; every new ID has a test.

**Online (`tests/live/ir_operations_step.test.ts`)**

- an objective goal with an exhausted plan → the model proposes a **check**, not a
  `create_goal`;
- an arbiter goal after its step → the model proposes **continue/alternative**, not the
  funnel;
- an addressed request → the model proposes **stop**.

## 6. Order of work (each step green)

0. (Optional) capture a baseline (`docs/testing.md`).
1. Spec: `ir_semantics` → `ir_operations` → `projection` → `system_prompt`/blocks →
   `tools`. New IDs registered; a test citing each ID must exist by step 3.
2. Code: unify the frontier (F1–F3, F5) → add `stop` (F4) → projection item
   alternatives and the edit key (F7–F8). Check: `npm run typecheck` +
   `SKEIN_LIVE=false npx vitest run`.
3. Offline tests.
4. Online step tests (`SKEIN_LIVE=true npx vitest run tests/live/ir_operations_step.test.ts`).
5. Coverage matrix and `docs/ir.md` sync.

## 7. Open questions

- **Decided:** at an **addressed** request the frontier is strictly `["stop"]`; a new
  interpretation (`create_goal`) is refused there. Revision after addressing is future
  work.
- Does `stop` need a payload (`why`) rendered in the projection, or is the derived
  `addressed` enough?
- F8 (`calls` edit key) may be deferred: it is a projection detail, not a frontier bug.
