# Skein — IR: operations, state and control (as-built)

> Russian mirror — `docs/ir_ru.md`.

This is **as-built**: how the IR is built in the current code. Source of truth for the
semantics — `docs/ir_semantics.md` (changed together with the code); the operator registry —
`docs/ir_operations.md`. The conceptual overview — `docs/concepts.md`; the traversal model —
`docs/ir_semantics.md` §2; the end-to-end example — `docs/walkthrough.md`.

## 1. Four levels

```
                 append-only              pure            pure
  actions ─▶ journal (Event[]) ──fold──▶ State ──project──▶ Context ──▶ LLM
     ▲                                                             │
     └─────────── proposal: exactly one operator per turn ◀────────┘
```

1. **Journal** (`src/ir/events.ts`) — append-only, the single truth.
2. **State** (`src/ir/graph.ts`) — `fold(events)`: nodes, relations, container order, derived
   helpers, the traversal stack, file versions.
3. **Context** (`src/ir/project.ts`) — `project(state)`, a deterministic **message tape**.
4. **Tape** — the only I/O surface: the system part (base + node instruction + constraints)
   plus the history.

Before `project`, the engine reconciles active `ref`s with the filesystem
(`src/loop/observe.ts`); a drift becomes a `mutate` event.

## 2. Nodes and relations

**Nodes** (`src/ir/types.ts`). Work space: `request`, `goal`, `plan`, `item`, `action`,
`observation`, `stop`, `unactionable`, `constraint`. Artifact space: `file` (also reserved
`symbol`/`test`, not produced).

- `request.payload = { text }` — raw motivation, the root. Interpreted **once** as a goal
  (`goal`) or declined (`unactionable`); no plan, no `stop`;
- `goal.payload = { what }` — the interpretation. The plan is a separate node;
- `plan`/`item` — containers; the order of children is the order of relation addition, and
  the **last** child is the current item/alternative;
- `action.payload` carries the command (and, for an edit, `find`/`replace`; for a run, a
  `signature`), so a repeat can be recognized;
- `observation.payload` for a read carries `{ ref, version, start, end, total, output? }`; for
  a run `{ command, exitCode?, output?, outputRef?, error?, errorRef?, signal?, core?, … }`
  (`output` is stdout, `error` is stderr, kept apart; `exitCode` `0` = pass, absent on a
  timeout); a failure carries `failed: true`, a non-execution `refused: true`;
- `stop.payload = { why? }`, `unactionable.payload = { why? }`, `constraint.payload = { forbid }`.

**Relations** (`src/ir/types.ts`, no status field): `goal` (request → goal), `unactionable`
(request → unactionable), `plan` (goal → plan), `stop` (goal → stop), `items` (plan → item),
`alts` (item → action/goal), `result` (action → observation), `mutates` (action → file).

## 3. Events (closed vocabulary)

`add_node`, `add_edge`, `descend`, `return`, `mutate`, `record_rejection`. No `set_status`, no
`record_check`: a state change is a new node-event (`observation`, `mutate`, `stop`), not an
edit. A run result is an ordinary `observation`; success/failure is read from its outcome,
not stored as a verdict. `record_rejection` is used only for a refused **structural** move
(`create_goal`/`stop`/`decline`); a refused command is an observation with a reason.

## 4. Derived state (`src/ir/graph.ts`, `src/ir/traversal.ts`)

Nodes do not change; `fold` computes the facts and `graph.ts` reads them:

- **`actionExecuted`** — an action produced a child (`result`/`mutates`);
- **`actionSucceeded`** — it mutated a file, or its result observation is not a failure
  (`failed`, or a non-zero `exitCode`; a missing `exitCode` is a timeout);
- **`hasStopped`/`stopOf`** — a goal's `stop` relation; **`goalOf`/`unactionableOf`**;
- **`lastChild`** — the current item/alternative; **`itemFulfilled`** — its current
  alternative is an executed, succeeded action or a stopped goal; **`cursorOf`** — the first
  unfulfilled item; the stack is a fold of `descend`/`return`.

There are **no truth predicates** on nodes. A run's exit code is a fact the model reads; the
goal closes only through the doxa's `stop`.

## 5. Doxa operators

`src/llm/schemas.ts`, `src/tools/index.ts`, the gate `src/loop/classify.ts`:

- **`create_goal`** `{ what, command }` — at the request (once): the
  interpretation (`goal`; the plan is seeded with one item and the `command` is run at once;
  refusals `interpreted`, empty fields). At an open goal: a sub-goal appended as the current
  item's newest alternative; with no current item, refused.
- **`apply`** `{ action }` — the command runs; placement by the outcome of the current item
  (`OP-AP-PLACE`): a success → a new plan item, otherwise → a new alternative; non-execution
  (repeat/stale/forbidden/empty) is an observation with a reason.
- **`stop`** `{ why? }` — a `stop` node hung off the focus goal via the `stop` relation; the
  request has no `stop`.
- **`decline`** `{ why? }` — an `unactionable` node under the request; only on a fresh request.
- **`recall` / `search`** — read-only addressing of a stored result's body (window / pattern).

The gate in `classify` handles only the structural moves (`not_addressed`, `not_request`,
`interpreted`, empty fields, `no_current_item`); the command guards (`repeated_action`,
`stale_base`, `constraint_violation`, empty command) live in the engine and produce
observations (`src/tools/index.ts`).

## 6. Traversal (logos)

`src/ir/traversal.ts`: `focusEvents` descends from the request into its goal and into the
current item's sub-goal alternative; it returns when a goal is **finished** (`stop`) or under
a closed ancestor. `applicable` gives the doxa the admissible moves (`createGoal`/`apply`/
`stop`/`decline`) from the same facts as the gate. The loop (`src/loop/graph.ts`):
`project → propose → classify → execute → progress`; the run ends when the request's goal is
stopped (`request_addressed`), or on `no_progress` / the budget (`maxTurns`).

## 7. Projection

`Context` (`src/ir/project.ts`) is `{ history, situation, constraints }`: the tape of
`user`/`assistant`/`tool` turns (rebuilt from the tree), the current situation
(`request`/`goal`), and the constraints. `src/loop/propose.ts` assembles the model messages:
the base prompt, the node instruction for the situation, the constraints, then the history.
The `tool` messages carry the bounded inline body (an inspection result's head, a command's
tail, when large); the full body is addressed by id via `recall`/`search`. A structural move refused by `classify` creates no node, so its
reason is appended as a transient `tool` message for the next turn. The full specification is
`docs/projection.md`.

## 8. Honesty and boundaries

- a goal closes **only** through `stop`; the engine never marks a goal "achieved";
- the request is not closed in the IR: acceptance is external; the run ends when its goal is
  stopped or on `decline`;
- deferred: re-interpretation of the request, negative/give-up `stop`, `out_of_fragment`,
  witness precision (the whole workspace, `SKIP_DIRS`), `symbol`/`test`, and the composite
  system prompt (base/node boundary — the next stage).
