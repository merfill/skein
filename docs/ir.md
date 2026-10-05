# Skein — IR: operations, state and control (as-built)

> Russian mirror — `docs/ir_ru.md`.

This is the **as-built**: how the IR is structured in the current code. The source
of truth for the semantics is `docs/ir_semantics.md`; the code follows it. The
conceptual overview is `docs/concepts.md`; the foundation is `docs/logos_ir.md`;
the migration to the semantics is `docs/plans/ir_semantics_migration_plan.md`.

## 1. Four levels

```
                 append-only              pure            pure
  actions ─▶ journal (Event[]) ──fold──▶ State ──project──▶ Context ──▶ LLM
     ▲                                                            │
     └─────────── proposal: exactly one operator per turn ◀───────┘
```

1. **Journal** (`src/ir/events.ts`) — append-only, the only truth.
2. **State** (`src/ir/graph.ts`) — `fold(events)`: nodes, edges, plan item order,
   derived predicates, the traversal stack, file versions.
3. **Context** (`src/ir/project.ts`) — `project(state)`, a deterministic slice.
4. **Tape** — I/O only: the system prompt plus the current `Context`.

Before `project` the engine reconciles active `ref`s with the filesystem
(`src/loop/observe.ts`); a noticed drift becomes a `mutate` event.

## 2. Nodes and edges

**Nodes** (`src/ir/types.ts`). Space `work`: `request`, `goal`, `action`, `plan`,
`alternatives`, `observation`, `check`, `complete`, `constraint`. Space
`artifact`: `file` (plus reserved `symbol`/`test`, not produced).

- `request.payload = { text }` — the Arbiter's raw motivation, the root of the
  forest; it is not closed in the IR (acceptance is external);
- `goal.payload = { what, why?, done_when }`, where `done_when` is
  `{kind:"objective", command}` or `{kind:"subjective", text}`;
- `plan`/`alternatives` are containers; child order is **not** stored in a field
  but derived from the `add_edge item` event order (`State.children`);
- a read `observation.payload` carries `{ ref, version }`; `check.payload` —
  `{ command, verdict, output, error?, actor, witness?, outputRef?, errorRef? }`
  (`output` is stdout, `error` is stderr, kept separate).

**Edges** (`Edge.provenance`, with no status field): `has_plan`, `item`,
`has_alternatives`, `chosen`, `under`, `produces`, `verifies`, `closes`,
`mutates`.

## 3. Events (closed vocabulary)

`add_node`, `add_edge`, `descend`, `return`, `mutate`, `record_rejection`,
`record_check`. There is no `set_status`: a state change is a new node-event, not
an edit. `record_check` carries `targets` (goal ids), `under` (assumption ids) and
`verdict` (`pass`/`fail`/`inconclusive`); `fold` materializes the `check` node and
the `verifies`/`under` edges.

## 4. Derived state (§2.5 of the semantics)

Nodes never change; `fold` computes the predicates (`src/ir/graph.ts`):

- an action is `executed` iff it has a produced child (`produces`/`mutates`);
- a goal is `achieved` iff the latest closure is a `check` `pass` **without**
  `under`;
- a goal is `achieved_under` iff a `check` `pass` has `under` or a `complete`
  node closes it;
- a goal is `refuted` iff the closing `check` is `fail`; `inconclusive` leaves it
  `open`;
- a goal is `abandoned` iff it is a variant in `alternatives` not equal to the current
  `chosen` one (the container's latest `chosen` edge);
- a request is `addressed` iff its current chosen interpretation is
  `achieved`/`achieved_under`;
- otherwise `open`.

The rest is derived too: `currentVersion(ref)` = the last `mutate` version,
otherwise the first read version; `cursor(G)` = the first unfulfilled plan item;
the stack is the fold of `descend`/`return`.

## 5. Doxa operators

`src/llm/schemas.ts`, `src/tools/index.ts`, gates in `src/loop/classify.ts`:

- **`create_goal`** `{ what, why?, done_when, plan?, revises? }` — if the current
  node is the request, the goal enters as an interpretation in its `alternatives`
  (`item`+`chosen`); if the current goal is `refuted`, as a variant in its
  `alternatives`; otherwise as an `item` of the current goal's plan. On failure
  `revises` **must** list all `refuted`/`abandoned` options of the container, else a
  refusal `missing_revision`; a `what` repeating a refuted one — `repeat_hypothesis`.
- **`apply`** `{ action }` — `read`/`grep` → `action`+`observation`; `edit` →
  `action`+`mutate`+`mutates`, refused on a stale base; `run` with a `target`
  (objective goal) → `check`+`verifies` (+`under`), and the **command comes from
  `target.done_when`**, not from the doxa's proposal; `run` without `target` →
  `observation`.
- **`complete`** `{ goal?, note?, under? }` — only a subjective, non-root goal.
- **`query`** — read-only addressing (not a doxa operator): reaches nodes/edges.

Gates in `classify`: constraints on `edit`; `stale_base`; `repeated_action`; strict
`revises`; `repeat_hypothesis`; `apply run { target }` only for an objective goal
(`subjective_goal_needs_complete`); `complete` only for a subjective non-root goal.

## 6. Traversal (logos)

`src/ir/traversal.ts`: `focusEvents` descends from the request into the chosen
interpretation, then into the first unfulfilled sub-goal, and returns when the
current goal closes; `applicable` gives doxa the frontier
(`createGoal`/`apply`/`complete`/`checkReady`/`chooseVariant`). The loop
(`src/loop/graph.ts`): `project → propose → classify → execute → progress`;
stopping via `request_addressed` (the request is `addressed`), `no_progress` (the
semantic key unchanged for N turns), or the budget (`maxTurns`).

## 7. Projection

`Context` (`src/ir/project.ts`) is the **traversal branch**, not a dump: `path` (the
`request → … → focus` stack; a node carries its own `plan`/`alternatives`),
`constraints`, `lastResult` (the **full** result of the latest call), `shown` (the
results kept via `need` — the hypothesis's working set), `calls` (a deduplicated
summary of previous calls: `id`, `action`, `status ok/fail/refused`, `note`,
`count`), `applicable`, `budget` (turns). No `artifacts`, versions, `index`, `recent`
or raw payloads — everything else is reached via `query`. There is no total char
budget; `SKEIN_CTX_ITEMS` bounds list shapes. The full specification is
`docs/projection.md`, the tool contract is `docs/tools.md`. File contents and raw
output are not stored in the IR; `lastResult` shows the full result of the latest call,
and action failures are materialized as an observation with `verdict=fail` and land in
`calls`.

## 8. Honesty and boundaries

- `achieved` — only a `check` `pass` without `under`; doxa does not render a
  verdict; `achieved_under` — `under` or `complete`.
- The request is not closed in the IR: acceptance is external and implicit
  (silence/the harness); inside, only `addressed` is computed. There is no LLM
  verdict; `userAcceptance` (`src/ir/approval.ts`) gives a subjective goal check.
- Deferred: `out_of_fragment` (needs a "declared fragment" design, §10.1 of the
  semantics), witness precision (currently the whole workspace, `SKIP_DIRS`),
  `symbol`/`test`, full staleness precision.
