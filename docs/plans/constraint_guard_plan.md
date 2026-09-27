# Skein — constraint guard plan (run workaround)

> Russian mirror — `docs/plans/constraint_guard_plan_ru.md`.

Overall plan — `docs/plans/implementation_plan.md` (§3 "Immediate next steps", §6 "Open
questions"). Tier 0 spec — `docs/plans/tier0_plan.md` (§13 "Loose end").

## 1. Problem

A `must` constraint is expressed as `payload.forbid` — a list of regexes over
paths. Today `classify` applies them only to the `edit` action
(`action.path`). The `run` action executes a shell command unchanged, so it can
bypass the constraint, e.g. `printf ... > test/sum.test.mjs` or
`sed -i ... test/sum.test.mjs`. The witness (test plus unchanged test files)
catches this after the run, but the engine ("logos") does not.

## 2. Decision

Enforce the constraint by **effect**, not by parsing the shell string. A
constraint forbids *changes* to matching paths, not *mentions* of them. Static
matching against a command would be a heuristic with real false positives
(`cat test/x.test.mjs`, `node --test test/x.test.mjs`) and false negatives
(`$(...)`, variables, `base64`).

Rejected alternative: extend `classify` to match the regexes against
`action.command`. Minimal diff, but heuristic.

## 3. Design

- Before a `run`: for every forbid pattern, find matching workspace files and
  snapshot their contents.
- Run the command.
- After: if any forbidden file changed, restore it, record an observation
  `constraint violation (<pattern>): <path>` and **do not** record
  `record_check`/`verifies` edges (no claim is verified). Return a turn noting
  the revert.
- If nothing changed, behave as before.
- `classify` keeps its cheap `edit` pre-check unchanged.

## 4. Changes

1. **`src/ir/constraints.ts` (new, pure).**
   - `forbiddenPatterns(state): string[]` — moved out of `classify.ts`.
   - `matchesPath(pattern, path): boolean` — `RegExp` with try/catch (as now).
   - Both `classify` and `tools` need it; `ir/` avoids a `loop ↔ tools` cycle.
2. **`src/tools/index.ts`, `run` case.**
   - Snapshot matching files via `forbiddenPatterns` + `workspace.list()`.
   - On change: `workspace.write` restores the old content, emit the violation
     observation, skip `record_check`/`verifies`.
3. **`src/loop/classify.ts`** — import the shared helper; `edit` logic unchanged.
4. **`src/loop/propose.ts:27`** — extend: do not change forbidden paths via
   `edit` **or** `run`.
5. **`tests/loop.test.ts`**
   - scripted integration: constraint `\.test\.mjs$`, a `run` that writes to
     `test/sum.test.mjs` → file unchanged, no `mutate`, a violation observation;
   - existing e2e (`node --test` passes, test file untouched) stays as a
     regression.
6. **Docs** — mark the loose end resolved in `tier0_plan.md` (~300) /
   `tier0_plan_ru.md` (§13, 298-300), and drop/annotate the open question in
   `implementation_plan.md` §3.1 + §6 and the `_ru` mirror (46-47, 68).

## 5. Verification

- `npm run typecheck`;
- `npm test` — offline. Live gate only when `SKEIN_LIVE=true`.

## 6. Boundaries

- A `run` that mutates non-forbidden files still writes no `mutate` event
  (pre-existing behaviour; out of scope).
- No shell sandbox; the guard is post-hoc for `run`, with revert to preserve the
  invariant.

## 7. Status

Implemented. `src/ir/constraints.ts`; the `run` guard in `src/tools/index.ts`; the
shared helper in `src/loop/classify.ts`; the regression test in `tests/loop.test.ts`.
`npm run typecheck` is clean and `npm test` passes (21 tests). The Tier 0 loose
end is marked resolved in `docs/plans/tier0_plan.md` §13, and the open question is
closed in `docs/plans/implementation_plan.md` §3/§6.
