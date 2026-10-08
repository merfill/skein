# Skein — user approval plan (an arbiter: user acceptance)

> Russian mirror — `docs/plans/archive/user_approval_plan_ru.md`.

Related: `docs/design_review.md` (C1), `docs/concepts.md` (the arbiter),
`docs/ir.md` §2. Overall plan — `docs/plans/implementation_plan.md`.

Status: implemented (see §8).

## 1. Problem

`verified` is reachable only through `record_check`, which the `run` tool emits
for a passing command. Non-code work (a document, a design) has no test runner, so
it can never reach a settled state. The concepts already name an **arbiter** (the
user, through acceptance criteria) beside the objective toolchain,
but there was no mechanism for it.

An LLM critic issuing checks is rejected: it would put doxa in the role of logos.

## 2. Decision

Reuse `record_check` with an authority field: `actor: "arbiter" | "user"`
(default `arbiter`). The user's verdict enters **out of band** (like the goal
seed), never through an LLM action, so `verified` keeps exactly one path and the
invariant `verifiedWithoutCheck` is untouched.

## 3. Design

- `src/ir/events.ts` — `record_check` gains `actor?: "arbiter" | "user"`.
- `src/ir/graph.ts` — `CheckRecord` carries `actor`; `fold` defaults it to
  `"arbiter"`.
- `src/ir/approval.ts` — `userAcceptance(claimIds, verdict?, note?)` builds a
  `record_check` with `actor: "user"`.
- `src/tools/index.ts`, `run` — sets `actor: "arbiter"` explicitly.
- `src/tools/index.ts`, `query` — `verdictOf` returns checks including `actor`.
- `src/loop/propose.ts` — the prompt says a claim is settled by an objective
  check or by the user's acceptance.
- Docs — `docs/concepts.md` / `_ru`, `docs/ir.md` / `ir_ru.md`,
  `docs/design_review.md` / `_ru`.

## 4. Verification

- `npm run typecheck`; `npm test`.
- Tests: a user-actor check passes the event schema; `userAcceptance` verifies a
  claim and records `actor: "user"`; a plain check defaults to `"arbiter"`;
  `verdictOf` exposes the actor; `verifiedWithoutCheck` still holds.

## 5. Invariants

- `verified` still has exactly one path: `record_check` with `verdict = "pass"`.
- The LLM cannot emit a check at all.
- The journal stays append-only; `fold`/`project` stay pure and deterministic.

## 6. Boundaries

- No UI or interactive prompt is built; the harness calls `userAcceptance`.
- The projection does not distinguish the authority in `frontier.verified`; the
  actor is available through `query { verdictOf }`.

## 7. Order of work

1. The `actor` field (events, state).
2. `userAcceptance`.
3. `run` and `query`.
4. Prompt, tests, docs.

## 8. Status

Implemented. `record_check` carries `actor` (`src/ir/events.ts`); `CheckRecord`
and `fold` default it to `"arbiter"` (`src/ir/graph.ts`); `userAcceptance`
records an arbiter verdict (`src/ir/approval.ts`); `run` marks `"arbiter"` and
`query { verdictOf }` exposes the actor (`src/tools/index.ts`). `npm run
typecheck` is clean and `npm test` passes. Docs updated: `concepts`, `ir`,
`design_review`.
