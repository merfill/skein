# Skein — plan: `has_goal`, `unactionable`, `stop` inside the plan, no `chosen`

> Russian mirror — `docs/plans/archive/request_goal_plan_ru.md`.
> Basis — the design discussion (2026-10-09), a continuation of the stop-closure refactor
> (`docs/plans/archive/stop_closure_plan.md`).
> **Status: implemented and verified (2026-10-09).** Steps 1–7 done: code, docs, a live
> virtual-sandbox run of `fix-ocaml-gc` (no premature stop; the frontier after a failed
> criterion now offers `apply` too). Archived.

Related: `docs/ir_semantics.md` (source of truth — change it with the code),
`docs/walkthrough.md`, `docs/ir_operations.md`, `docs/projection.md`,
`docs/system_prompt.md`.

## 1. Why

The request → interpretation relation is currently an `alternatives` container with a
`chosen` edge. That leaks the revision machinery into the common case: a request almost
always has a single interpretation ("the request *is* this goal"), yet it is modeled as one
option among several. Two problems fall out:

1. **Naming/semantics.** `has_alternatives` + `chosen` says "one of many" where the intent
   is "this is what the request is".
2. **No honest close for a non-actionable request.** A request like "привет, дядя Вася" has
   no goal; today the only way to end it is to invent a goal with a fake criterion
   (`done_when: "true"`) — a logical contradiction (creating a goal where there is none).

Separately, `chosen` and the "cursor = first unfulfilled item" duplicate what container order
already expresses: the current item is simply the **last** one (the plan is a sequence
emulated by the order of children in the container).

## 2. Target model (decisions)

- **One interpretation.** `request --has_goal--> goal` (exactly one). For now the
  interpretation is **fixed** (the model may not change it; re-interpretation is a later
  step, not this one).
- **`unactionable`.** A request whose intent is not actionable gets
  `request --no_goal--> unactionable { why }`; the request ends. New doxa move `decline`.
- **Containers own ordered children.** The order of a container's children (the append
  order) is the structure; `item` is a conceptual name, not a required edge. The graph is a
  **DAG**, not a tree (a `stop` node may be referenced by both the plan and a `has_stopped`
  edge) — accepted.
- **Plan and steps.** `goal --has_plan--> plan`: the plan is a container of **plan items**;
  each plan item is itself a container of **alternatives** (a command, or a sub-goal). The
  thing to execute now is the **last alternative of the last plan item**.
- **`stop` closes the goal.** On `stop`, the engine adds a `stop` node `{why}` as the last
  child of the plan AND a `has_stopped` edge `goal → stop` (fast lookup + the reason). A
  goal is closed ⟺ it has a `has_stopped` edge. For now `stop` is accepted only once the
  goal's criterion has passed (a **positive** stop; otherwise `check_not_run`); the
  negative/give-up cases are a later step.
- **No `chosen`.** The current option is the last child of its container.
- **Request closure is derived.** A request is done ⟺ its goal is closed (a `has_stopped`
  edge) or it has an `unactionable` node. There is no `stop` on the request.
- **Doxa moves:** `create_goal` (interpret the request), `apply` (a command), `stop`,
  `decline` (unactionable), plus read-only `query`. The model explicitly chooses between
  "a new plan item (step)" and "a new alternative of the current step". Proposed API (to
  avoid the engine guessing):
  - `create_goal { what, why?, done_when, plan, step }` — at the request: the
    interpretation (`has_goal`); at a goal: a sub-goal **alternative** of the current step.
  - `apply { command }` — a command as a **new plan item** (a new step).
  - `branch { command }` — a command as a **new alternative** of the current step (retry /
    replace).
  - `stop { why }`, `decline { why }`, `query`.

Shapes:

```
request R
  has_goal ─▶ goal G { what, why?, done_when, plan }
                has_plan ─▶ plan P  [ item1, item2, …, stop ]      (order = sequence)
                              item1 = alternatives [ c1, c1', G' ] (current = last)
                              item2 = alternatives [ c2 ]
                has_stopped ─▶ stop       (the same stop node that is the plan's last child)
  alternatively
  no_goal ─▶ unactionable U { why }
```

## 3. Consequences (what changes vs the current code)

- `chosen` disappears (`latestChosen`, `chosenInterpretation`, `unselectedVariant`,
  `actionSuperseded` re-keyed on "the last child / not the last").
- `has_alternatives` on the request disappears; the request has `has_goal` or `no_goal`.
- **focus / traversal** become last-child based:
  - `focusEvents` descends from the request into its single goal; inside a goal, the current
    item is the last plan child; if that item owns alternatives whose last child is a goal,
    descend into it.
  - `cursorOf` (first unfulfilled) is retired; `itemFulfilled` and `planExhausted` are
    re-derived over the last-child view.
- `requestSettled` is replaced by reading the goal's criterion (`criterionPass(goal)`).
- run end: the request is done when its goal is closed; the stop reasons are renamed
  accordingly.
- The projection shows the request's goal (or the unactionable note), not an alternatives
  list; the goal's plan shows its items with the `stop` last.

## 4. Open questions (decide with the code)

- **Edge name** for the unactionable relation: `no_goal` (node kind `unactionable`)? Doxa
  move: `decline { why }`?
- **Positive stops only.** A `stop` is accepted only once the goal's criterion has passed
  (`check_not_run` otherwise). Negative/give-up stops are a **later** step, not this one.
- **`alternatives` on goals.** Keep only for plan items, or also for goals? (Leaning: plan
  items only; a goal's approach branches through its plan items.)
- **`has_stopped` vs "the plan's last item is `stop`".** Keep both (the edge for a fast
  lookup, the item for the sequence) — accepted; the code must keep them consistent.

## 5. Steps (each step green)

After each: `npm run typecheck` and `SKEIN_LIVE=false npx vitest run`.

### Step 1 — `unactionable` + `decline`
- `src/ir/types.ts`: node kind `unactionable`, edge kind `no_goal`; `WORK_KINDS`.
- `src/tools/index.ts`: the `decline { why }` move creates the `unactionable` node and the
  `no_goal` edge from the request; the request ends (`done`).
- `src/loop/classify.ts`: the gate — `decline` is accepted only when the request has no
  goal / no `unactionable` yet.
- `src/llm/schemas.ts` / `src/llm/tools.ts`: the new move.
- Tests: `tests/ops/*` (unactionable, decline).

### Step 2 — `has_goal` (request → goal), drop the request's alternatives
- `create_goal` at a request: add `has_goal R → G` instead of `has_alternatives` + `item` +
  `chosen` (and `create_goal` is refused once the request has a goal).
- `graph.ts`: `goalOf(request)`; drop the request's `alternativesOf` usage.
- `traversal.ts`: `focusEvents` descends into the single goal; `requestSettled` → the
  goal's `criterionPass`.
- Tests: `tests/ops/applicable.test.ts`, `create_goal.test.ts`, `tests/loop.test.ts`.

### Step 3 — `stop` inside the plan + `has_stopped` from the goal
- `stop` on a goal: append the `stop` node as the last child of the plan and add the
  `has_stopped` edge `goal → stop`. Accepted only once the criterion has passed.
- Resolve the give-up gate (open question §4).
- Tests: `tests/ops/stop.test.ts`.

### Step 4 — drop `chosen`; current = last
- `graph.ts`: remove `latestChosen`/`chosenInterpretation`; re-key `unselectedVariant`,
  `actionSuperseded` on the last child.
- `traversal.ts`: current item = last plan child; `itemFulfilled`/`planExhausted` over the
  last-child view.
- `project.ts`: alternatives show the last option as current.
- Tests: `tests/ops/traversal.test.ts`, `ir_properties.test.ts`, `derivation.test.ts`.

### Step 5 — projection + prompt
- `project.ts`: the request's path node shows its goal (or the unactionable note).
- `src/loop/prompt/blocks.ts` + `docs/system_prompt{,_ru}.md`: the new vocabulary
  (`has_goal`, `unactionable`/`decline`, stop-last-in-plan, no `chosen`).

### Step 6 — documentation (mandatory)
- `docs/ir_semantics{,_ru}.md` — roles, §2 nodes/edges, §2.5 state, §2.6 traversal (last
  child), §4 operators (`decline`; `stop` in the plan), invariants.
- `docs/ir{,_ru}.md`, `docs/ir_operations{,_ru}.md` (new IDs), `docs/projection{,_ru}.md`,
  `docs/concepts{,_ru}.md`, `docs/tools{,_ru}.md`, `docs/walkthrough{,_ru}.md` (redraw the
  tree), `AGENTS.md` (if the invariant phrasing changes).
- Move this plan to `docs/plans/archive/` when complete.

### Step 7 — sandbox smoke
- One deliberate run to confirm the request→goal→stop-in-plan shape end to end.

## 6. Tests

- `tests/ops/create_goal.test.ts` — `has_goal` at the request; refused when already
  interpreted.
- `tests/ops/stop.test.ts` — `stop` appends the last plan item and the `has_stopped` edge.
- `tests/ops/traversal.test.ts`, `applicable.test.ts` — the last-child current node.
- `tests/ops/derivation.test.ts` — no `chosen`; the last option is current.
- `tests/loop.test.ts` — the run ends when the goal is closed; `decline` ends the request.
- `tests/coverage.test.ts` — the registry ids stay consistent with `docs/ir_operations.md`.

## 7. File map

- Core: `src/ir/{types,events,graph,traversal,project}.ts`, `src/loop/{classify}.ts`,
  `src/tools/index.ts`, `src/llm/{schemas,tools}.ts`, `src/loop/prompt/blocks.ts`.
- Tests: `tests/ops/{create_goal,stop,traversal,applicable,derivation,ir_properties}.test.ts`,
  `tests/{loop,ir,workingset,prompt}.test.ts`.
- Docs (§6).

## 8. Relationship to `stop_closure_plan.md`

The stop-closure refactor stands: `stop` remains the only closure and a criterion run is an
ordinary `observation`. This plan changes **where** the stop is recorded (inside the plan,
plus the `has_stopped` edge) and **how the request relates to its goal** (`has_goal`), and
removes `chosen`. It supersedes the request-`alternatives`/`chosen` and
"cursor = first unfulfilled" parts of the current model.
