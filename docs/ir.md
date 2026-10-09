# Skein — IR: operations, state and control (as-built)

> Russian mirror — `docs/ir_ru.md`.

This is the **as-built**: how the IR is structured in the current code. The source
of truth for the semantics is `docs/ir_semantics.md` (change it with the code); the
plan for the request→goal model is `docs/plans/archive/request_goal_plan.md`. The conceptual
overview is `docs/concepts.md`; the traversal stack is
`docs/plans/traversal_stack_spec.md`; the end-to-end example is `docs/walkthrough.md`.

## 1. Four levels

```
                 append-only              pure            pure
  actions ─▶ journal (Event[]) ──fold──▶ State ──project──▶ Context ──▶ LLM
     ▲                                                            │
     └─────────── proposal: exactly one operator per turn ◀───────┘
```

1. **Journal** (`src/ir/events.ts`) — append-only, the only truth.
2. **State** (`src/ir/graph.ts`) — `fold(events)`: nodes, edges, container order,
   derived helpers, the traversal stack, file versions.
3. **Context** (`src/ir/project.ts`) — `project(state)`, a deterministic slice.
4. **Tape** — I/O only: the system prompt plus the current `Context`.

Before `project` the engine reconciles active `ref`s with the filesystem
(`src/loop/observe.ts`); a noticed drift becomes a `mutate` event.

## 2. Nodes and edges

**Nodes** (`src/ir/types.ts`). Space `work`: `request`, `goal`, `action`, `plan`,
`alternatives`, `observation`, `stop`, `unactionable`, `constraint`. Space
`artifact`: `file` (plus reserved `symbol`/`test`, not produced).

- `request.payload = { text }` — the raw motivation, the root. It is interpreted
  **once** as a goal (`has_goal`) or declined (`no_goal`); it has no plan, no
  criterion, no `stop`;
- `goal.payload = { what, why?, done_when, plan? }`, where `done_when` is a
  **string** — the goal's criterion, a literal command the engine runs and reads by
  its exit code. `plan` is the initial plan as a free-form **string sketch**;
- `plan`/`alternatives` are containers; child order is **not** stored in a field but
  is the **append order of the `item` edges**. The **last** child is the current
  item (there is no `chosen` edge);
- a read `observation.payload` carries `{ ref, version }`; a run
  `observation.payload` carries
  `{ command, target?, exitCode?, witness?, output?, outputRef?, error?, errorRef?, signal?, core?, corePattern?, backtrace? }`
  (`output` is stdout, `error` is stderr, kept separate; `target` marks a criterion
  run; `exitCode` is `0` = pass, non-zero = fail, absent on a timeout);
- `unactionable.payload = { why? }` — the doxa declined to formulate a goal.

**Edges** (`src/ir/types.ts`, with no status field): `has_goal` (request → goal, the
fixed interpretation), `has_plan`, `item`, `has_alternatives`, `produces`,
`has_stopped` (goal → stop), `no_goal` (request → unactionable), `mutates`.

## 3. Events (closed vocabulary)

`add_node`, `add_edge`, `descend`, `return`, `mutate`, `record_rejection`. There is
no `set_status` and no `record_check`: a state change is a new node-event
(`observation`, `mutate`, `stop`, …), not an edit. A run's result is a plain
`observation`; pass/fail is read from its `exitCode`, not stored as a verdict.

## 4. Derived state (`src/ir/graph.ts`, `src/ir/traversal.ts`)

Nodes never change; `fold` computes the facts and `src/ir/graph.ts` reads them:

- the displayed **`stateOf`** is `open | executed | stopped`: a **goal** is
  `stopped` once it has a `has_stopped` edge to a `stop` node; an action is
  `executed` once it produced a result (`produces`/`mutates`); otherwise `open`;
- **`goalOf(request)`** — the goal via `has_goal`; **`unactionableOf(request)`** — the
  node via `no_goal`;
- **`criterionResult/Exit/Pass/Failed`** — the latest `observation` whose `target` is
  a goal (0 = pass, non-zero = fail, absent = no verdict);
- **`lastChild(container)`** — the current item of a `plan`/`alternatives` (the last
  `item`); **`unselectedVariant`** — a node that is not the last of its container;
  **`actionSuperseded`** — an action whose container has a newer (last) option;
- **`requestSettled(request)`** — the request's goal (through its current variant)
  passed its criterion.

The rest is derived too: `currentVersion(ref)` = the last `mutate` version,
otherwise the first observed version; `cursor(G)` = the first unfulfilled plan item;
the stack is the fold of `descend`/`return`.

There are **no truth predicates on nodes** (no `achieved`/`refuted`/`abandoned`).
A criterion run settles nothing by itself: the goal is closed only by the doxa's
`stop`, and the run's exit code is the fact the gates read.

## 5. Doxa operators

`src/llm/schemas.ts`, `src/tools/index.ts`, gates in `src/loop/classify.ts`:

- **`create_goal`** `{ what, why?, done_when, plan, step, revises? }` — at the
  request (once): the interpretation (`has_goal`; refused `interpreted` if the
  request already has a goal). At an open goal: a sub-goal that decomposes the
  current step (its newest `alternatives` option). At a goal whose criterion failed:
  a variant (a `revises` revision). `plan` is a string sketch; only the first
  concrete `step` is materialized as a plan item (an action).
- **`apply`** `{ action }` — `read`/`grep`/`list` → `action`+`observation`; `edit`/
  `write` → `action`+`mutate`+`mutates`, refused on a stale base; `run` with a
  `target` (a goal criterion) → an `observation` carrying `target`+`exitCode`, the
  command taken from `target.done_when`; `run` without `target` → an ordinary
  `observation`.
- **`decline`** `{ why? }` — the request's intent is not actionable: records an
  `unactionable` node (`no_goal` edge) and ends the run. Only at a fresh request.
- **`stop`** `{ why? }` — finishes the focused **goal**: appends a `stop` node as the
  goal's **last plan item** and a `has_stopped` edge `goal → stop`. Accepted (for
  now) only once the goal's criterion has passed (`check_not_run` otherwise); there
  is no `stop` on the request.
- **`query`** — read-only addressing (nodes/edges, a stored result's body).

Gates in `classify`: constraints; `stale_base`; `repeated_action` (waived for a
re-check after a timeout); strict `revises`; `repeat_hypothesis`; `run {target}` only
for the focus (`invalid_target`, `not_current_goal`); `interpreted`; `addressed`;
`not_addressed` (a `stop`/`decline` at the request); `check_not_run`.

## 6. Traversal (logos)

`src/ir/traversal.ts`: `focusEvents` descends from the request into its goal
(`has_goal`) and, inside a goal, into the last option of a step's `alternatives`;
it returns when a goal is **finished** (`has_stopped`, or an executed action). A
criterion pass closes nothing by itself, so after a pass the doxa must still `stop`.
`applicable` gives the doxa the frontier (`createGoal`/`apply`/`stop`/`decline`,
`checkReady`), from the same facts the gates use. The loop (`src/loop/graph.ts`):
`project → propose → classify → execute → progress`; the run ends when the request's
goal is stopped (`request_addressed`), or on `no_progress` / the budget (`maxTurns`).

## 7. Projection

`Context` (`src/ir/project.ts`) is the **traversal branch**, not a dump: `path` (the
`request → … → focus` stack; a goal carries its own `plan`/`alternatives`, and a plan
item carries its own `alternatives`), `constraints`, `lastResult` (the **full**
result of the latest call), `shown` (the working set), `calls` (a deduplicated
summary), `applicable`, `checkReady`/`nextAction`, `budget`. A request node has only
`text` (its goal is the next node on the path). A node's `state` is
`open | executed | stopped`; a result view carries `exitCode` instead of a `verdict`.
Everything else is reached via `query`. The full specification is
`docs/projection.md`, the tool contract is `docs/tools.md`.

## 8. Honesty and boundaries

- A goal is closed **only by `stop`**, and (for now) only once its criterion has
  passed; a `stop` records the closure and its reason in the goal's plan. The engine
  never marks a goal "achieved".
- The request is not closed in the IR: acceptance is external and implicit
  (silence/the harness); inside, `requestSettled` is computed from the goal's
  criterion. There is no LLM verdict.
- Deferred: re-interpretation of a request (the interpretation is fixed for now),
  negative/give-up stops, `out_of_fragment`, witness precision (the whole workspace,
  `SKIP_DIRS`), `symbol`/`test`.
