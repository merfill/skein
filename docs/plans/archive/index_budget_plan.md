# Skein — index budget plan (address space and turn budget)

> Russian mirror — `docs/plans/archive/index_budget_plan_ru.md`.

Related: `docs/design_review.md` (R1, P4), `docs/concepts.md` (resolved Q4),
`docs/ir.md` §4. Overall plan — `docs/plans/implementation_plan.md`.

Status: implemented (see §8).

## 1. Problem

Two context-budget gaps:

- **R1. Unbounded `index`.** `project` emits every node as `{ id, kind, label }`;
  it is the only section without a bound and it grows linearly with the run (a
  50-turn run yields a 50-entry list). It duplicates the header/frontier/artifacts
  and gives no status and no edges. Its role for the LLM was never specified.
- **P4. No turn budget.** `maxTurns` lives in the loop, so the model cannot see
  how many turns remain.

## 2. Decision

**R1 — `index` is an address space (contract A).** The projection guarantees:

```
∀ node n ∈ State :  id(n) is either shown in the Context, or retrievable by a
                    deterministic query over State (`query { id | kind | status }`).
```

Because `query` already reaches every node, enumeration is not required for the
guarantee — it is one mechanism among two. So `index` becomes a bounded summary:
counts by kind (the shape of the space) plus a window of the newest `K` nodes
(convenience). Full listings go through `query`.

**P4 — the turn budget is part of the `header`.** The loop passes
`{ turn, maxTurns }` as a projection option; the header exposes
`{ turn, maxTurns, remaining }`. Turns are deterministic; token accounting is not
and stays out.

## 3. Design

- `src/ir/project.ts`
  - `Context.index` becomes `{ counts: Partial<Record<NodeKind, number>>; recent:
    IndexEntry[] }`, where `IndexEntry = { id, kind, label }`.
  - `counts` is built in `NODE_KINDS` order (stable, independent of insertion
    order); `recent` is the newest `K = tail` nodes by `seq` descending.
  - `ProjectOptions` gains `budget?: { turn: number; maxTurns: number }`; the
    header carries `{ turn, maxTurns, remaining }` when provided.
- `src/loop/graph.ts` — pass `budget: { turn: state.turn, maxTurns: deps.maxTurns }`
  to both `project` calls.
- `src/loop/propose.ts` — describe `header.budget` and the `index` contract
  (summary plus a `query` escape hatch).
- Docs — `docs/concepts.md` / `_ru` (Q4), `docs/ir.md` / `ir_ru.md` §4, §6,
  `docs/design_review.md` / `_ru` (R1, P4), `docs/plans/implementation_plan.md` /
  `_ru`, `README.md`.

## 4. Verification

- `npm run typecheck`; `npm test`.
- Tests: `index.counts` sums to the node total and is ordered by `NODE_KINDS`;
  `index.recent` is bounded by `tail` and newest-first; a node outside the window
  is still returned by `query { id }` (addressability); `header.budget` carries
  the correct `remaining`.
- The example in `docs/ir.md` §6 is refreshed to the new shape.

## 5. Invariants

- Addressability: no node becomes unnameable by bounding `index`.
- `project` stays pure and deterministic for the same state and options.
- The journal stays append-only; nothing about the IR changes.
- Visibility budget: `index.recent`, `recent`, `verified`, `refusals` share the
  same `tail` knob — "how much is shown"; the guarantee stays "what is
  retrievable".

## 6. Boundaries

- No token accounting (non-deterministic).
- `query` is unchanged; the summary is enough to reveal the shape of the space.
- True provenance relevance (a working set) is out of scope; that is C2.

## 7. Order of work

1. `index` shape and `budget` in the projection.
2. Pass the budget from the loop.
3. Prompt.
4. Tests and docs.

## 8. Status

Implemented. `Context.index` is `{ counts, recent }` and `header.budget` is
optional, computed in `project` (`src/ir/project.ts`); the loop passes the budget
(`src/loop/graph.ts`); the prompt describes both (`src/loop/propose.ts`).
`npm run typecheck` is clean and `npm test` passes (42 tests). Docs updated:
`concepts`, `ir`, `design_review`, `implementation_plan`, `README`.
