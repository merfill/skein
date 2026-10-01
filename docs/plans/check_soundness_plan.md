# Skein — check soundness plan (a change invalidates verification)

> Russian mirror — `docs/plans/check_soundness_plan_ru.md`.

Related: `docs/design_review.md` (R3), `docs/concepts.md` (first principle),
`docs/ir.md` §3. Overall plan — `docs/plans/implementation_plan.md`.

Status: implemented (see §8).

## 1. Problem

A claim becomes `verified` through `record_check` (`src/ir/graph.ts:112`), but the
check records no file versions. `mutate` marks `stale` only read-provenance edges
(`src/ir/graph.ts:89`), so a `verifies` / `check` fact is never invalidated.
Consequence: after the code is edited, a claim verified against an older version
is still presented as verified by `frontier.verified` (`src/ir/project.ts:80`).
This breaks the invariant "a stale fact is never shown as active content" and the
first principle — a verdict must trace to the version it was obtained on.

## 2. Decision

Give a check the same version memory a read already has.

- A check records a **witness**: the `ref → version` pairs it was obtained
  against.
- `mutate` extends its rule to `verifies` edges: an edge whose witness contains
  the changed `ref` with a different `version` becomes `stale`.
- The projection shows a claim as verified only if it has a live (non-`stale`)
  `verifies` edge; otherwise the claim appears in a new `frontier.invalidated`
  bucket (one line), never in `verified`.

Invalidation stays a **derived** transition: it changes the derived edge status
in `State`, never the journal. The claim's status is still written only by the
arbiter (`record_check`); `mutate` never rewrites a claim status. The journal
remains append-only; the source facts (`add_edge`, `record_check`) are untouched.

Rejected: demoting the claim node on `mutate` (it would put logos on the node's
status and need `set_status`). It is monotone if done via events, but it
conflates "the claim is false" with "the evidence expired" — we reliably know
only the latter.

## 3. Design

- `src/tools/index.ts`, `run` — before recording, snapshot every tracked file's
  version (`workspace.list()` + `workspace.version`, `.skein` excluded) into the
  observation payload. (Originally the witness was also copied onto
  `record_check` and each `verifies` edge; those copies were removed — see
  `docs/plans/staleness_scope_plan.md`.)
- `src/ir/graph.ts`, `mutate` — mark `verifies` edges `stale` when the source
  observation's witness has the changed `ref` with a different `version` (via
  `witnessOf`).
- `src/ir/project.ts` — `frontier.verified` requires a live `verifies` edge; add
  `frontier.invalidated` (id + reason) for verified claims whose edges are all
  stale.
- `src/tools/index.ts`, `query` — the status filter and `verdictOf` should
  reflect edge liveness, so `status: "verified"` does not surface an invalidated
  claim.
- Docs — `docs/ir.md` / `ir_ru.md` (tool→events, status transitions, projection),
  `docs/design_review.md` / `_ru` (mark R3a resolved).

## 4. Verification

- `npm run typecheck`; `npm test`.
- New tests: a `run` on `v2`, then a `mutate` to `v3` → the claim is not in
  `frontier.verified` but in `frontier.invalidated`; a second passing `run`
  re-verifies it; `verifiedWithoutCheck` still holds.

## 5. Invariants

- The journal is append-only; only the derived status changes.
- A claim is `verified` only with `check` provenance.
- No stale evidence is shown as active.

## 6. Boundaries

- Transitive module dependency is covered by over-approximation: the witness is
  a snapshot of the whole workspace, so any change (including an imported module)
  stales the check. Precision via an import graph is deferred
  (`docs/plans/staleness_scope_plan.md`).
- External changes are handled in `docs/plans/observation_plan.md`.

## 7. Order of work

1. Types / events: the witness.
2. `run`: attach the witness.
3. `mutate`: stale `verifies` edges.
4. `project` / `query`: liveness filter + `invalidated`.
5. Tests + docs.

## 8. Status

Implemented. `run` snapshots the workspace into the observation payload and
`mutate` stales `verifies` edges whose source observation witnessed the change
(`src/tools/index.ts`, `src/ir/graph.ts`); `project` lists invalidated claims and
`query` reflects liveness (`src/ir/project.ts`, `src/tools/index.ts`). The witness
lives once, on the observation payload (`docs/plans/staleness_scope_plan.md`).
`npm run typecheck` is clean and `npm test` passes. Docs updated: `docs/ir.md`
§2–4 and `docs/design_review.md` (R3a).
