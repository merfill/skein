# Skein — staleness scope plan (witness dedup and transitivity)

> Russian mirror — `docs/plans/staleness_scope_plan_ru.md`.

Related: `docs/design_review.md` (R3b), `docs/plans/check_soundness_plan.md`,
`docs/plans/observation_plan.md`. Overall plan —
`docs/plans/implementation_plan.md`.

Status: implemented (see §8).

## 1. Problem

R3b asked whether a change to an imported module invalidates a check
("transitive staleness"). Reviewing the code shows it already does: `run`
snapshots the version of **every** tracked file (`workspace.list()`, `.skein`
excluded) and records them as the check's witness; `mutate` stales any `verifies`
edge whose witness contains the changed `ref` with a different version. So any
change anywhere invalidates the check — sound, but coarse. The transitivity
concern is covered by over-approximation, not by an import graph.

What actually remained:

- the docs still called R3b open;
- the witness was **duplicated** three times: in the observation payload, in
  `record_check`, and in the provenance of every `verifies` edge (per claim).
  The `record_check` copy was never read; the edge copies were the live ones.

## 2. Decision

- **Transitivity:** keep the workspace-wide snapshot; it gives sound
  transitivity. Precision (not staling on unrelated changes) needs a dependency
  graph and is deliberately deferred — without read tracing a narrowed witness
  risks unsoundness.
- **Dedup:** the witness lives **once**, in the source observation's payload.
  The `verifies` edge and `record_check` no longer carry it; `mutate` and
  reconciliation resolve it through `edge.from`.

## 3. Design

- `src/ir/types.ts` — remove `witness` from check provenance.
- `src/ir/events.ts` — remove `witness` from `record_check` and the check
  provenance schema.
- `src/tools/index.ts`, `run` — attach the witness to the observation payload
  only.
- `src/ir/graph.ts` — `witnessOf(state, edge)` resolves the witness from the
  source observation; `mutate` uses it for `verifies` edges.
- `src/loop/observe.ts` — reconciliation resolves active refs through
  `witnessOf` as well.
- Docs — `docs/plans/check_soundness_plan.md`, `docs/ir.md` / `ir_ru.md`,
  `docs/design_review.md` / `_ru`.

## 4. Verification

- `npm run typecheck`; `npm test`.
- The existing invalidation tests are rewritten to put the witness on the
  observation payload; invalidation on a witnessed change and re-verification
  still pass; reconciliation still observes drifted witnesses.

## 5. Invariants

- Soundness is unchanged: a change to any witnessed file stales the check.
- The journal stays append-only; the witness is written once, in the observation.
- `project` and `fold` stay pure and deterministic.

## 6. Boundaries

- **Precision** (do not stale on unrelated changes) is deferred: it needs a
  file-dependency graph, and a narrowed witness is unsound without knowing what
  the command read.
- The observation payload's witness is read by a typed cast, as other payloads
  already are.

## 7. Order of work

1. Remove the duplicate witness from types/events.
2. Resolve it via the observation in `mutate` and `reconcile`.
3. Update the `run` writer.
4. Tests and docs.

## 8. Status

Implemented. The witness is stored once, on the observation payload; `run` no
longer attaches it to `record_check` or `verifies`
(`src/tools/index.ts`); `witnessOf` resolves it for `mutate` and reconciliation
(`src/ir/graph.ts`, `src/loop/observe.ts`). `npm run typecheck` is clean and
`npm test` passes (44 tests). Docs updated: `check_soundness_plan`, `ir`,
`design_review`.
