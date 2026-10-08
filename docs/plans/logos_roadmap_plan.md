# Skein — implementation plan for the logos roadmap (management, stopping, honesty)

> Russian mirror — `docs/plans/logos_roadmap_plan_ru.md`.

Related: `docs/logos_ir.md` (§7–§9), `docs/plans/implementation_plan.md` (Tier 2),
`docs/plans/archive/staleness_scope_plan.md`, `docs/plans/archive/tier1_plan.md`. Overall plan —
`docs/plans/implementation_plan.md`.

Status: plan; work not started.

## 1. Problem

The failure in §2.1 of `logos_ir.md` is an unmanaged process, not a large context:
the model has no memory of the work in the IR, checks are attached to nothing, the
single edit is attached to nothing, stagnation is not noticed, and the only limit
is the turn budget. The code confirms it: the loop
`project → propose → classify → execute` (`src/loop/graph.ts`) is a rigid pipeline,
the model chooses the step, there is no `W`; `classify` already declares the `cited`
category but never returns it (`src/loop/classify.ts`); the check witness is the
whole workspace (`src/tools/index.ts`), so build artifacts invalidate checks.

The order in the first edition of §9.3 puts management (`W`, the stack) before
measurement and before honesty. The revision: measurement first, then management,
then honesty. What changed and why — §9.5 of `logos_ir.md`.

## 2. Decision

Adopt the revised order from §9.3 of `logos_ir.md`:

0. Baseline and a non-degradation gate.
1. `W` gate and linear modes.
2. `cited`.
3. Branch in the projection, then the stack and backtracking.
4. `no_progress` and loop detection.
5. `Revision` and coarse witness precision.
6. `out_of_fragment` (after the "declared fragment" design).
7. (deferred) full witness precision.

The dividing principle: measurement before management, management before honesty;
each step stands alone and is checked against the non-degradation gate.

## 3. Design

### Step 0 — Baseline and non-degradation gate

- Done: an offline gate — `bench/baseline.json` (a frozen reference for the simple
  set), `bench/compare.ts` (`compareRun`, the `tolerance` threshold),
  `bench/gate.ts` (CLI `npm run bench:gate -- <runDir|metrics.json>`); test
  `tests/bench_gate.test.ts`. No `src/` changes.
- Remaining: refresh the live baseline on the full simple set (12 cases) and record
  it in `docs/benches/bench_report.md`; wire the gate into the acceptance of steps 1–6.

### Step 1 — `W` gate and linear modes

- Done: the gate in `classify` (`src/loop/classify.ts`) — `edit` is rejected with
  `no_open_hypothesis` while there is no `claim` with status `open` on the path from
  the goal; the constraint check stays first. The step mode (`src/ir/project.ts`,
  `deriveMode`): `explore` (no open hypothesis), `act` (a hypothesis is open and no
  edit followed it), `check` (an edit followed the hypothesis). The mode is
  **derived from state** (a deterministic projection, no duplication in
  `LoopState`) and visible in `header.mode`; the model is guided by the prompt
  (`src/loop/propose.ts`).
- Step boundaries: only the gate is hard-enforced; `check`/`act` are informational.
  Full mode enforcement (with a branch and the stack) is step 3: one gate requires
  just one hypothesis, not a tree, so it must not worsen short tasks.
- Tests: `tests/loop.test.ts` (the gate, ordering with a constraint, an end-to-end
  scenario), `tests/ir.test.ts` (`deriveMode`).

### Step 2 — `cited`

- Done: `track` gained an optional `cite` field (`src/llm/schemas.ts`) — a path to a
  file that was read, or the id of a read observation. `classify`
  (`src/loop/classify.ts`) assigns a claim to `cited` only if the citation is
  grounded in a live read fact; otherwise it refuses with `invalid_cite` (no silent
  downgrade).
- The fact is stored in `payload.cite` (`src/tools/index.ts`), and the projection
  (`src/ir/project.ts`) shows grounded claims separately: `frontier.facts` versus
  `frontier.claims`. §8 of `logos_ir.md` (`proven` vs `proven_under(H)`) depends on
  this.
- Step boundaries: grounding lives in the payload, not on an edge; staleness of the
  citation (the read code changed) is not tracked yet — it belongs to
  `Revision`/witness precision (step 5).

### Step 3 — Branch in the projection, the stack and backtracking

- Done (branch and stack): the state holds a `branch` stack (`descend` and `return`
  events; `src/ir/events.ts`, `src/ir/graph.ts`). `track` / `decompose` descend the
  branch to the parent and push the new node (`descendTo`, `src/tools/index.ts`); a
  passing check steps back (`return`), while a refutation leaves the hypothesis on
  top. `project` takes the focus from the top of the stack, otherwise from the
  newest open obligation; the branch is the chain of the focus's ancestors up to the
  goal. `frontier` shows the open obligations of that branch only, and the rest of
  the reachable open work appears in `frontier.backtrack`. Settled items
  (`verified` / `invalidated` / `rejected` / `achieved`), artifacts and the index
  stay global.
- Done (modes): `deriveMode` (`src/ir/project.ts`) knows `explore` / `act` /
  `check` / `revise`; `revise` means the branch's last hypothesis was refuted.
  `classify` rejects `edit` in `explore` and `revise`. The full mode selection from
  step 1 moved here: the focus comes from the stack, not a heuristic.

### Step 4 — `no_progress` and loop detection

Progress is relative to the mode, so looping is caught by layers
(`docs/logos_ir.md` §7.6), not by a single counter:

- Done (cooldown): a `progress` step in the loop (`src/loop/graph.ts`) compares a
  semantic knowledge key (`knowledgeKey`, `src/ir/progress.ts`) with the previous
  turn; N turns without a change stop the loop with `stopReason` `no_progress`. The
  key covers claim/subgoal/decision/check (with status) and files; observations and
  actions do not count, so repeated reads or runs cannot hide the stagnation. The
  threshold is `AgentDeps.noProgress` (10 by default).
- Done (terminus and traversal): modes provide a terminus (step 3), and the stack
  provides `return` on backtracking. An automatic `pop` on "K steps without closure
  at the top" is not implemented yet.
- **Deferred (action signature):** the content of `read`/`grep` is not addressable
  yet, so rejecting repeats would break legitimate re-reads; addressable content
  access is needed first. Repeats of already-refused actions are already collapsed
  in `frontier.refusals` (`×count`).
- **Deferred (witness churn):** depends on witness precision (step 5).
- The `out_of_fragment` stop reason (§8.3) is step 6.

### Step 5 — `Revision` and coarse witness precision

- Done (`Revision` is a projection, not state): a change of answer is derived from
  the append-only journal — `mutate` stales `verifies`, `invalidatedClaimIds`
  identifies the claims that lost force, and the projection adds
  `frontier.revisions` with the reason (which check no longer holds)
  (`src/ir/project.ts`). No new event or node is introduced — the derivation
  suffices.
- Done (coarse precision): generated and build directories (`_build`, `target`,
  `build`, `out`, `obj`, `__pycache__`, caches, virtualenvs) are excluded from the
  workspace walk (`src/tools/workspace.ts`, `SKIP_DIRS`). The witness and `mutate`
  therefore never see them, and a check command does not invalidate its own checks.
  The relaxation is deliberate and narrow; full precision is step 7.

### Step 6 — `out_of_fragment`

- Done (declared fragment): `src/ir/fragment.ts` declares the available capabilities
  (`inspect`, `modify`, `execute`, `verify`, `abduce`); they are visible to doxa in
  `header.fragment`. Anything not in the inventory is outside the fragment.
- Done (honest refusal): a new doxa proposal `abstain { missing, reason }`. The
  logos refuses the abstention if the named capability is in the fragment
  (`capability_available`) or the name is empty (`empty_missing`); an accepted
  abstention is recorded as an `out_of_fragment` node and stops the loop with
  `stopReason: "out_of_fragment"` (`src/llm/schemas.ts`, `src/loop/classify.ts`,
  `src/tools/index.ts`).
- The gap distinction (§8.3) is set by the prompt: an explanatory gap (evidence
  exists, the cause is unknown) leads to a hypothesis, not to an abstention; an
  abstention is only for a missing capability outside `header.fragment`.

### Step 7 (deferred) — full witness precision

- Narrow the witness to a dependency closure via each ecosystem's tooling; without
  read tracing a narrow witness is unsound (`docs/plans/archive/staleness_scope_plan.md`
  §6).

## 4. Verification

- `npm run typecheck`; `npm test` (offline; live only when `SKEIN_LIVE=true`).
- Non-degradation gate: `npm run bench:gate -- <runDir>` — `reward` not below the
  reference, steps/tokens/cost/peak not above the reference × 1.2 (see
  `docs/benches/bench_report.md` §4.3).
- `fix-ocaml-gc`: Skein either converges or stops honestly; comparison with the
  saved baseline run.
- The invariants of §3 of `logos_ir.md` hold by tests: no `verified` without a
  `check`; a stale fact is never shown as active; `project` is deterministic; the
  model does not set statuses.
- The context reaches a plateau, the cache share does not fall, fewer repeats of
  `read`/`grep`/`run` over the same files.
- Loop tests: a repeat of an action with the same input versions is rejected and
  recorded as a refusal; a series of steps without closing obligations yields
  `no_progress`; a repeat **after** an edit (a changed input version) is not
  treated as a loop; swings of `verified` ↔ `invalidated` without a witness change
  raise the churn signal.
- `W` gate: an `edit` without an open hypothesis is rejected with
  `no_open_hypothesis` and recorded as a refusal; after `track` the edit goes
  through.
- Grounding (`cited`): a claim without a read source is rejected with
  `invalid_cite`; a grounded claim appears in `frontier.facts`, not in
  `frontier.claims`.
- Branch: `frontier` shows the active branch only; open obligations outside it
  appear in `frontier.backtrack`, and settled items stay global.
- Stack and modes: `track`/`decompose` descend the branch (`descend`), a passing
  check returns (`return`); `edit` in `explore`/`revise` is rejected; after a
  refutation `deriveMode` yields `revise`, and a refined hypothesis returns to
  `act`.
- No progress: a run of turns without new knowledge (no new claim/subgoal/decision/
  check, no status change, no new file) stops the loop with `no_progress`; reading
  a new file counts as progress.
- Revision: an invalidated check is explained in `frontier.revisions` (the reason —
  which command no longer holds), as a projection over the journal.
- Witness: generated and build directories (`_build`, `target`, caches, etc.) never
  enter the witness or `mutate`, so a check does not invalidate itself via its own
  build.
- Fragment: the available capabilities are visible in `header.fragment`; an
  `abstain` for an available capability is refused, and for a missing one it stops
  the loop with `out_of_fragment`.

## 5. Invariants

- A verdict only through a `check`; `W` chooses logos, not doxa.
- The base is monotone; a status change is a new entry, not an edit of the old one.
- `project` is deterministic: the same events give the same context.
- The context is necessary and sufficient for the chosen operator.
- No progress — stop or change branch.
- Secrets only in `.env`.

## 6. Boundaries

- We do not let the model set verdicts; we do not make it the arbiter.
- We do not compress context by model summarization.
- We do not store file contents in the IR — pointers only.
- We do not silently "lower" the logic; step 6 is an honest refusal.
- We do not optimize at the cost of correctness.

## 7. Order of work

1. Step 0 — baseline and gate.
2. Step 1 — `W` gate and linear modes.
3. Step 2 — `cited`.
4. Step 3 — branch, then the stack and backtracking.
5. Step 4 — `no_progress` and loop detection.
6. Step 5 — `Revision` and coarse witness precision.
7. Step 6 — `out_of_fragment` (after the "declared fragment" design).
8. Step 7 — deferred.

## 8. Status

- **Step 0:** the offline baseline gate is implemented (`bench/baseline.json`,
  `bench/compare.ts`, `bench/gate.ts`, `tests/bench_gate.test.ts`; the command
  `npm run bench:gate`). Remaining: a live baseline on the full simple set.
- **Step 1:** the `W` gate and the derived mode are implemented
  (`src/loop/classify.ts`, `src/ir/project.ts`; the prompt
  `src/loop/propose.ts`).
- **Step 2:** `cited` is implemented: `cite` in the `track` schema, grounding in
  `classify`, storage in `payload` and the `frontier.facts` section
  (`src/llm/schemas.ts`, `src/loop/classify.ts`, `src/tools/index.ts`,
  `src/ir/project.ts`).
- **Step 3:** the active-branch filter, the `branch` stack (`descend`/`return`) and
  the `revise` mode are implemented (`src/ir/events.ts`, `src/ir/graph.ts`,
  `src/ir/project.ts`, `src/tools/index.ts`, `src/loop/classify.ts`). 92 tests pass,
  `tsc` is clean.
- **Step 4:** `no_progress` is implemented: the `progress` step and `knowledgeKey`
  (`src/loop/graph.ts`, `src/loop/state.ts`, `src/ir/progress.ts`). The signature
  and churn layers are deferred (see the step 4 boundaries). 97 tests pass, `tsc`
  is clean.
- **Step 5:** `Revision` as a projection (`frontier.revisions`) and coarse witness
  precision (`SKIP_DIRS` in `src/tools/workspace.ts`) are implemented. 99 tests
  pass, `tsc` is clean.
- **Step 6:** the declared fragment and the honest refusal are implemented
  (`src/ir/fragment.ts`, `header.fragment`, the `abstain` action,
  `stopReason: "out_of_fragment"`). 103 tests pass, `tsc` is clean.
- **Step 7:** deferred (full witness precision).
