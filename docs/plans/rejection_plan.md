# Skein — rejection plan (recording refused proposals)

> Russian mirror — `docs/plans/rejection_plan_ru.md`.

Related: `docs/design_review.md` (P3), `docs/concepts.md` (first principle),
`docs/ir.md` §2–4. Overall plan — `docs/plans/implementation_plan.md`.

Status: implemented (see §8).

## 1. Problem

A refusal by `classify` is a logos decision: the engine considered a proposal and
rejected it with a reason (`src/loop/classify.ts`). An accepted action becomes
knowledge in the IR; **a refusal does not**. It lands only in `recent`, which is:

- **not the journal**: it lives in `LoopState` (`src/loop/state.ts:18`), is not
  derived from events, and is not reproduced by replay;
- **bounded by the tail**: the projection takes the last `tail=6`
  (`src/ir/project.ts`), so the refusal is evicted.

Two gaps follow:

- **no source in the journal** — the engine's decision has no trace in the IR,
  against the first principle;
- **no memory for the model** — the context is rebuilt from state each turn, and
  the refusal is not part of state, so after eviction the model "forgets" it and
  can repeat a forbidden action.

Not to be confused with the `run` guard: there the engine runs the command,
reverts the forbidden change, and **records an observation** (`src/tools/index.ts`).
That path is already recorded.

## 2. Decision

Add a **`record_rejection` event**, symmetric to `record_check`. Both an
arbiter's verdict and a gate's refusal are *logos records*, not belief nodes. A
refusal is not materialized as a node: it has no world content to observe, only a
proposal signature and a reason. This keeps `index` untouched (R1), adds no
status, and does not widen the node vocabulary.

## 3. Design

- `src/ir/events.ts` — a new `record_rejection` event:
  `{ tool, target, reason, constraintId?, turn }`.
- `src/ir/graph.ts` — a `RejectionRecord` and `state.rejections`, filled by
  `fold` (parallel to `state.checks`). Append-only; replay yields the same state.
- `src/ir/constraints.ts` — `forbiddenConstraints(state)` returning
  `{ id, pattern }`, so the violated constraint can be named.
- `src/loop/classify.ts` — `Classification` carries the violated `constraintId`.
- `src/loop/graph.ts` — on a refused proposal, emit `record_rejection` from the
  action signature and `classification.reason`.
- `src/ir/project.ts` — a new `frontier.refusals` section (one line each),
  bounded by `tail`, collapsed by signature with a repeat count.
- `src/loop/propose.ts` — describe `frontier.refusals` in the system prompt.
- Docs — `docs/ir.md` / `ir_ru.md` (operations, projection),
  `docs/design_review.md` / `_ru` (P3).

Signature: `tool` plus `target` (path / command / `kind:label`), one line,
truncated. The full proposal is never stored; the thought stays in the tail.

## 4. Verification

- `npm run typecheck`; `npm test`.
- Tests: `record_rejection` passes the event schema; `fold` records it in
  `state.rejections`; a forbidden `edit` produces a `record_rejection` with the
  right `tool`/`target`/`reason`/`constraintId`; `project` shows it under
  `frontier.refusals`; repeated identical refusals collapse to one line with a
  count; the section is bounded by `tail`.

## 5. Invariants

- The journal stays append-only; only derived state is computed.
- `fold` and `project` stay pure and deterministic.
- Doxa only proposes; the engine records the refusal (logos).
- The proposal is not stored as a belief; only its signature is recorded.

## 6. Boundaries

- The `run` guard is untouched — it already records an observation.
- Tool failures (`read failed`, `edit failed`) are the world's answer, not a gate
  refusal; a separate question, out of scope here.
- The speculative split of `provenance.llm` into
  `llm_proposal`/`llm_hallucination` is not done (the kind is not produced in code
  and nodes carry no provenance).

## 7. Order of work

1. Event schema and state.
2. Gate: constraint id and event emission.
3. Projection `frontier.refusals`.
4. Prompt.
5. Tests and docs.

## 8. Status

Implemented. The `record_rejection` event (`src/ir/events.ts`); `RejectionRecord`
and `state.rejections` in `fold` (`src/ir/graph.ts`); `forbiddenConstraints` and
the `constraintId` in `classify` (`src/ir/constraints.ts`, `src/loop/classify.ts`);
the emission in the loop (`src/loop/graph.ts`); `frontier.refusals` with
signature collapse in the projection (`src/ir/project.ts`); the prompt note
(`src/loop/propose.ts`). `npm run typecheck` is clean and `npm test` passes (40
tests). Docs updated: `docs/ir.md` §2, §4, §6; `docs/design_review.md` (P3).
