# Skein — plan for bringing the code to the IR semantics

> Russian mirror — `docs/plans/ir_semantics_migration_plan_ru.md`.

Related documents:

- `docs/ir_semantics.md` — **source of truth for the semantics** (the target).
- `docs/ir.md` — **as-built**: how the IR is structured in the current code (what
  we are reworking).
- `docs/logos_ir.md` — foundation: doxa and logos, goals, gap analysis.
- `docs/fix_ocaml_gc_ideal.md` — the reference trajectory (acceptance criterion).
- `docs/plans/implementation_plan.md`, `docs/plans/logos_roadmap_plan.md` — the
  overall plan and the earlier roadmap; this document refines them.

Status: **plan agreed; work not started.** We do not change the semantics — it is
already fixed; we bring the code to it. Working invariant: semantics first (already
there), then code, then a test for the preserved invariant.

---

## 1. Problem

The code implements the old model (`claim`/`decision`/`subgoal`, status fields,
`stale`, `mode`, ten doxa actions). The semantics (`ir_semantics_ru.md`) describes a
different one: a tree with nodes
`goal`/`plan`/`alternatives`/`action`/`observation`/`check`/`complete`/`constraint`/
`file`, three doxa operators (`create goal`/`apply`/`complete`), derived state, plan
traversal, and `achieved` / `achieved_under` honesty. We need to replace the core,
not add a compatibility layer.

Baseline at planning time: `npm run typecheck` clean, `npm test` — **103** tests
green.

## 2. Strategy

**Cohesive core replacement** (agreed). The vocabulary, operators, traversal,
honesty and projection change incompatibly, so the old model is not carried in
parallel: that would leave a double vocabulary and dead code.

- Inside — sub-steps (below); each ends with green `npm run typecheck` and
  `npm test`; where applicable, `npm run bench:gate`.
- Tests covering the old model are **rewritten together** with the step's code, not
  silently deleted.
- The scope of the first rework is the whole core: steps 1–6 (vocabulary,
  operators, traversal, honesty, projection, prompt). Integrations (step 7) and
  documentation (step 8) follow the core.

## 3. Gap (what exactly diverges)

| Area | Current code | Target semantics |
|---|---|---|
| `work` nodes | `goal, subgoal, claim, decision, action, observation, check, constraint` | `goal, action, plan, alternatives, observation, check, complete, constraint` |
| Concepts | `claim`/`subgoal`/`decision` are belief/choice nodes | none: justification is a goal's `why`, an assumption is an `under` edge, a subgoal is a `goal`, a decision is the logos/Arbiter |
| Edges | `decomposes, supports, justifies, chosen_over, locates, verifies, …` | `has_plan, item, has_alternatives, chosen, under, produces, verifies, closes, mutates` |
| Plan | no `plan` node; composition implicit | a `plan` node + ordered `item`s; order is the position among a container's children |
| Events | 8, including `set_status` | the same minus `set_status`; `record_check` carries `inconclusive` and `under` |
| Doxa operators | 10 actions (`decompose`, `decide`, `track`, `finish`, `abstain`, …) | 3: `create goal`, `apply`, `complete` |
| Traversal | `branch` stack tied to claim/subgoal; no cursor | a cursor over plan items; a stack of goals; the "applicable" moves at the current point |
| State | `statuses`/`edgeStatuses` as fields + `mode` | only derived predicates: `executed/achieved/achieved_under/refuted/abandoned/open` |
| Honesty | `claim verified/refuted`, `stale` | `achieved` (check `pass` without `under`) vs `achieved_under` (`under`/`complete`); `out_of_fragment` |
| Projection | `header.mode`, `frontier.claims/facts/decisions/subgoals` | `header` (root/current goal, constraints, fragment, budget); `frontier` — branch, plan and item state, obligations, last result |
| Root | stays `open`, closed by the harness | closed by the Arbiter against the criterion |
| Stop | `finish`/`abstain` are doxa operators; `knowledgeKey` | stop is the Arbiter's decision; repeat is by action signature with input versions |

---

## 4. Sub-steps

### Step 1. IR vocabulary and events

**Files:** `src/ir/types.ts`, `src/ir/events.ts`, `src/ir/graph.ts`.

**What changes:**

- `WORK_KINDS = goal, action, plan, alternatives, observation, check, complete,
  constraint`; `ARTIFACT_KINDS = file` (`symbol`/`test` are reserved, out of scope,
  §10.1 of the semantics).
- `EDGE_KINDS = has_plan, item, has_alternatives, chosen, under, produces,
  verifies, closes, mutates`.
- A goal's `Node.payload`: `{ what, why, done_when }`, where
  `done_when = { kind: "objective", command } | { kind: "subjective", text }`.
- `plan`/`alternatives` are container nodes; child order is **not** stored in a
  field: it is derived from the order of `add_edge item` events (deterministic for
  the same journal).
- Remove the `set_status` event. `record_check`: `targets: string[]` (goal ids),
  `under?: string[]` (assumption goal ids), `verdict: pass | fail | inconclusive`.
- `fold` builds derived predicates instead of `statuses`:
  `executed`, `achieved`, `achieved_under`, `refuted`, `abandoned`, otherwise
  `open`; `abandoned` — a variant in `alternatives` whose sibling has `chosen`.
- The cursor `cursor(G)` — the index of the first unfulfilled plan item; the stack —
  a fold of `descend`/`return`; the current node — the top of the stack.

**Done when:** the vocabulary compiles; `fold` is deterministic; a test encodes
that state is derived (no status fields) and that item order holds.

### Step 2. Doxa operators and gates

**Files:** `src/llm/schemas.ts`, `src/tools/index.ts`, `src/loop/classify.ts`.

**What changes:**

- The schema — exactly three operators:
  - `create goal { what, why?, done_when, plan? }`, `plan` a non-empty list of
    `goal|action` items (nesting — a decision, see §7);
  - `apply { tool: read|grep|edit|run, … }` (world actions are a special case of
    `apply`);
  - `complete { goal, note? }`.
- `apply`:
  - `read`/`grep` → `action` + `observation` (a `produces` edge);
  - `edit` → `action` + `mutate` + a `mutates` edge `action → file`; an edit on an
    outdated base (`current(ref)`) is refused;
  - `run` as a check → a `check` node + `verifies` to the current goal + `under` to
    the named assumptions; `inconclusive` (timeout/failure/flaky) does **not**
    refute the goal.
- `create goal`: a `goal` node + (if needed) the current goal's `plan` + `item`;
  its own `plan` when a list is given.
- `complete`: only a subjective `done_when`; the root is not completed by this
  operator (`closes` + `under` when needed).
- Remove `decompose`/`decide`/`track`. We keep `query` as read-only addressing (not
  an operator; a decision — §7).
- Gates in `classify`: constraint check, executability, presence of the current
  goal; admissibility of an `apply` check; `complete` only for a subjective goal.

**Done when:** the three operators produce the nodes/edges of §2.3; nothing produces
`claim`/`decision`/`subgoal`; the gates refuse the inapplicable with a reason.

### Step 3. Traversal (logos)

**Files:** a new `src/ir/traversal.ts`, `src/loop/graph.ts`, `src/loop/state.ts`.

**What changes:**

- A deterministic computation per §2.6: advance, `descend(G → H)`, `return`; the
  "applicable at the point" = the frontier visible to doxa.
- The loop: `project` (with the "applicable") → `propose` → `classify` (refuses the
  inapplicable) → `execute`; the derived `descend`/`return` are set by the logos.
- Loop detection (§2.7): a repeated action — the same command with the same input
  versions (`tool` + goal + `ref`/`version`) → `record_rejection`; a repeat
  **after** an edit is legitimate.
- Remove `knowledgeKey`/`deriveMode` as a primitive; progress is a cursor shift, a
  new observation/check, or a closure.

**Done when:** traversal is computed from the journal; the inapplicable is refused;
a repeat with the same versions is recorded as a refusal.

### Step 4. Honesty, alternatives, closure

**Files:** `src/ir/graph.ts`, `src/ir/project.ts`, `src/tools/index.ts`,
`src/loop/graph.ts`.

**What changes:**

- `under` on `check`/`complete`; `achieved` vs `achieved_under`; `refuted` from
  `fail`; `inconclusive` leaves `open`.
- `alternatives` + `chosen`; the unselected are `abandoned` (derived); a change of
  approach is a doxa proposal, and the choice absent a criterion is the Arbiter's.
- Root closure — the Arbiter (externally). Stop reasons: criterion reached,
  `no_progress`, budget.
- `out_of_fragment` — an honest refusal after a "declared fragment" design (§10.1);
  if the design is not agreed, the mechanism is deferred (a decision — §7).

**Done when:** `achieved` is unreachable with `under`; `complete` yields
`achieved_under`; the root is closed only by the Arbiter; refuted/unselected
variants show as `refuted`/`abandoned`.

### Step 5. Projection

**Files:** `src/ir/project.ts`.

**What changes:**

- A new `Context`:
  - `header`: the root and current goal, constraints, `fragment`, budget;
  - `frontier`: the current branch (goal, its `plan` node, items and their state,
    open obligations), the last result;
  - `artifacts` (a file index + current version), `index` (an overview), `recent`.
- No `mode`/`claims`/`facts`/`decisions`/`verified(claims)`.
- Determinism (`project(state)` — a pure function), a stable prefix first; file
  contents and raw output are not stored in the IR.

**Done when:** the projection is built from the new state; a test for "same events
→ same `Context`"; an old node is not shown as active content.

### Step 6. Doxa prompt

**Files:** `src/loop/propose.ts`.

**What changes:** the system prompt describes the three operators and working from
the "applicable"; `claim`/`decision`/`decompose`/`track`/`finish` are gone; honesty
is `achieved`/`achieved_under`; an explanatory gap leads to a new goal, not a
refusal.

**Done when:** the prompt matches the new projection's `header`/`frontier`.

### Step 7. Integrations

**Files:** `bench/run.ts`, `langgraph/graph.ts`, `src/config/settings.ts` (if
needed).

**What changes:** `AgentInput` carries the Arbiter's first goal with `why`/
`done_when`; root closure against the criterion (an Arbiter rule) and a
`stopReason`; acceptance via the existing `check.sh`/harness without a semantic
change.

### Step 8. Tests and documentation

**Files:** `tests/invariants.ts`, `tests/ir.test.ts`, `tests/loop.test.ts`,
`tests/gate.test.ts`, `tests/observe.test.ts`; `docs/ir.md`,
`docs/plans/implementation_plan.md`, `docs/plans/logos_roadmap_plan.md` (+ ru
mirrors).

**What changes:**

- rewrite the tests for the invariants of §9 of the semantics (including: no
  `achieved` without `check`, honest `under`, deterministic `project`, journal
  monotonicity, structural-edge forest, the inapplicable is refused);
- `docs/ir.md` — the new as-built; the plans — status alignment and cancellation of
  the `cited` step (§9.6 of `logos_ir.md`).

---

## 5. Invariants we preserve

- `achieved` — only a `check` with `pass` and **without** `under`; doxa does not
  render a verdict.
- `achieved_under` — a non-empty `under` on the closing `check` or a `complete`;
  revocable.
- `stale`/outdated is never shown as active; version and actuality are computed.
- The journal is monotone; a state change is a new node-event, not an edit.
- `project` is deterministic; doxa only proposes; `W` and the verdict belong to the
  Arbiter/logos.
- A forest of structural edges (`has_plan`/`item`/`has_alternatives`/`chosen`)
  without cycles; a container always carries ≥1 item.
- Secrets only in `.env`; file contents are not stored in the IR.

## 6. Verification

- `npm run typecheck`; `npm test` (offline; live — `SKEIN_LIVE=true`).
- `npm run bench:gate -- <runDir>` — non-degradation on the simple set.
- `fix-ocaml-gc`: Skein either converges or stops honestly; comparison with the
  saved reference run.
- The tree shape from §5 of `fix_ocaml_gc_ideal_ru.md`: ≥1 approach goal; ≥1 `edit`
  under it; ≥1 `check` with `verifies` (± `under`); ≥1 `achieved`/`achieved_under`;
  root closed.

## 7. Risks and open decisions

1. **Root closure in an autonomous run.** Currently the harness; in the semantics —
   the Arbiter. Decision: `AgentInput` carries the criterion (the root's
   `done_when`), an Arbiter rule closes the root; for bench — the existing
   `check.sh`.
2. **The `done_when` format.** Proposed:
   `{kind:"objective", command} | {kind:"subjective", text}`. Confirm at step 1.
3. **Plan nesting.** Whether to allow a plan on a goal-item to arbitrary depth (a
   recursive schema) or limit to one level. Affects the `create goal` zod schema.
4. **`query`.** We keep it as read-only addressing (not a doxa operator), otherwise
   the addressability guarantee of §8 of the semantics is lost.
5. **`out_of_fragment`.** Needs a separate "fragment" design (§10.1). If not agreed
   — defer, keeping only `no_progress` and the budget.
6. **ru/en sync.** We keep both mirrors in one commit.
7. **The fate of `symbol`/`test`.** Keep them reserved (not produced).

## 8. Boundaries (out of scope)

- Full witness precision (dependency closure) — deferred.
- `analogy`/`intuition` (Tier 3), AST/symbol table, embeddings, CSP, UI,
  multi-provider support.
- File contents in the IR, `set_status`, a silent "lowering" of the logic.

## 9. Order of work

1. Step 1 — IR vocabulary and events.
2. Step 2 — doxa operators and gates.
3. Step 3 — traversal.
4. Step 4 — honesty, alternatives, closure.
5. Step 5 — projection.
6. Step 6 — prompt.
7. Step 7 — integrations.
8. Step 8 — tests and documentation.

Each step: `typecheck` + `test` (+ `bench:gate` where applicable); a review of the
whole `git diff`; no incidental refactoring.

## 10. Status

**Steps 1–8 are done** (except as noted below). `npm run typecheck` is clean; the
offline suite (`SKEIN_LIVE=false npx vitest run`) — 51 tests green; the live gate
(`SKEIN_LIVE=true`) was not run in this iteration.

What was done per step:

- **Step 1.** New vocabulary in `types.ts`/`events.ts`; `fold` derives predicates,
  item order comes from the `item` event order; `set_status` removed;
  `record_check` carries `targets`/`under`/`inconclusive`.
- **Step 2.** Three operators (`create_goal`/`apply`/`complete`) + read-only
  `query`; `apply` covers read/grep/edit/run; gates in `classify` (constraints,
  `stale_base`, `repeated_action`, `complete` admissibility).
- **Step 3.** `src/ir/traversal.ts`: stack/cursor/`focusEvents`/`applicable`; the
  loop applies the deterministic focus before projecting.
- **Step 4.** `under`/`achieved`/`achieved_under`/`refuted`/`abandoned`;
  `alternatives`+`chosen`; root closure is the Arbiter's (the criterion as a
  `check`); stopping via `no_progress`/`root_closed`/budget.
- **Step 5.** New `Context` (`header.root/current/plan`, `frontier.plan/
  obligations/applicable`, `artifacts` with version and `stale`, `index`,
  `recent`).
- **Step 6.** The prompt describes the three operators and working from the
  "applicable".
- **Step 7.** `bench`/`langgraph` moved to `actionName`/`graphCounts`;
  `AgentInput` carries `why`/`done_when`.
- **Step 8.** Tests rewritten for the invariants of §9 of the semantics; the plan
  updated.

**Deviations/deferred** (deliberate):

- `out_of_fragment` is not implemented as an operator: it needs a separate
  "declared fragment" design (§10.1 of the semantics); stop reasons are
  `no_progress`, `root_closed`, budget. `header.fragment` is kept for reference.
- `query` is kept as read-only addressing (not a doxa operator) for the
  addressability guarantee.
- Witness precision stays coarse (the whole workspace, `SKIP_DIRS`).
- `docs/ir.md`/`docs/ir_ru.md` are brought to the new as-built (a brief version);
  the detailed description is `docs/ir_semantics.md`.
