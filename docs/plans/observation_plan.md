# Skein — observation plan (changes outside the engine)

> Russian mirror — `docs/plans/observation_plan_ru.md`.

Related: `docs/concepts.md` (first principle), `docs/design_review.md` (R3),
`docs/plans/archive/check_soundness_plan.md`. Overall plan —
`docs/plans/implementation_plan.md`.

Status: (a),(b) implemented; (c) open (see §8).

## 1. Problem

The engine learns about a file change only from events it produced itself (an
`edit` → `mutate`). Two gaps remain:

- `run` may write a non-forbidden file, and no `mutate` is recorded
  (`constraint_guard_plan.md` §6);
- a file changed by an external writer (a user, another program) is not observed
  at all until it is re-read.

In both cases an observation fact is missing. Under the first principle this is a
gap in experience, not invented knowledge; the remedy is to observe, not to
guess.

## 2. Decision

Add observation at three levels, so any change relevant to current activity has
a source.

- (a) **Engine writes.** After `run`, compare tracked-file versions before and
  after; emit `mutate` for every changed file, not only forbidden ones.
- (b) **Reconciliation.** At the start of a turn, an engine step re-checks the
  versions of the `ref`s that current activity depends on (witnesses of live
  checks and live read facts) and emits `mutate` on drift. This is the guarantee.
  A `mtime`/`ctime`/size signature cache avoids re-hashing unchanged files
  (`docs/plans/archive/watcher_plan.md`).
- (c) **Watcher.** A filesystem watcher turns external changes into `mutate`
  events promptly. This is an optimization (a fast path); it does not replace
  (b).

Observation happens in the loop, never inside `project`, so `project` stays a
pure function of state.

## 3. Design

- (a) `src/tools/index.ts`, `run`: extend the existing before/after snapshot to
  all tracked files; on each version change, emit `mutate`.
- (b) a new pure step (e.g. `src/loop/observe.ts`): given `State` and the
  `Workspace`, compute the active `ref` set, compare recorded and current
  versions, return `mutate` events. Wire it before `project` in
  `src/loop/graph.ts`. Scope: `ref`s in the witness of non-stale `verifies`
  edges and `ref`s with live read facts.
- (c) watcher: `fs.watch` / chokidar over the workspace (`.skein` excluded),
  debounced, emitting `mutate` with the new version. It runs as an input to the
  loop; an optional phase.

## 4. Verification

- `npm run typecheck`; `npm test`.
- Tests: a `run` that writes a non-forbidden file emits `mutate`; a reconciled
  external edit (write the file behind the engine, then run the observe step)
  emits `mutate` and invalidates a check; `project` is unchanged for the same
  events.

## 5. Invariants

- Every recorded change traces to an observation (engine write, reconcile, or
  watcher) — a source.
- `project` remains pure; observation is a loop step.
- The journal stays append-only.

## 6. Boundaries

- Watcher events are environment-dependent; replay determinism rests on the
  journal, not on reproducing the environment.
- Network filesystems and missed notifications are why reconciliation (b) is the
  guarantee, not the watcher.

## 7. Order of work

1. (a) the `run` gap.
2. (b) scoped reconciliation.
3. (c) watcher (optional).

## 8. Status

Implemented (a) and (b); (c) remains open.

- (a) `run` snapshots tracked-file versions before and after the command and
  emits a `mutate` per changed file (`src/tools/index.ts`).
- (b) the loop reconciles active `ref`s before `project` (`src/loop/observe.ts`,
  wired in `src/loop/graph.ts`); an observed drift becomes a `mutate`. A
  signature cache avoids re-hashing unchanged files
  (`docs/plans/archive/watcher_plan.md`).
- (c) the filesystem watcher is not implemented: reconciliation is the
  guarantee, the watcher only adds promptness, and it can be added later without
  touching the correctness path.

`npm run typecheck` is clean and `npm test` passes (35 tests). Docs updated:
`docs/ir.md` §1, §2, §5.
