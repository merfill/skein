# Skein — watcher plan (observation by file signature)

> Russian mirror — `docs/plans/archive/watcher_plan_ru.md`.

Related: `docs/plans/observation_plan.md` (§8), `docs/concepts.md` (first
principle), `docs/ir.md` §5. Overall plan — `docs/plans/implementation_plan.md`.

Status: implemented (see §7).

## 1. Problem

`reconcile` (`src/loop/observe.ts`) re-hashes every active `ref` on every turn.
Detection is correct, but it re-reads unchanged files. A filesystem watcher was
proposed to make detection prompt.

## 2. Decision

Observe by file **signature** first, hash only when the signature changed.

- `Workspace.signature(path)` is a cheap content proxy: `mtime + ctime + size`.
- `reconcile(state, workspace, cache?)` keeps a cache
  `path → { signature, version }`. When the current signature equals the cached
  one, it reuses the cached version and skips hashing; otherwise it hashes,
  records and compares.
- The cache lives for one agent run (created in `compileGraph`). Without a cache,
  reconcile hashes every active `ref` — the previous behavior.

A filesystem watcher (`fs.watch`) is deliberately **not** implemented. The loop
is synchronous and has no idle point between turns where async events could be
consumed, so a watcher would be drained at the same turn boundary `reconcile`
already covers; it belongs to a future streaming/idle mode.

## 3. Design

- `src/tools/workspace.ts` — `signature(path)`: `statSync` → `mtime/ctime/size`.
- `src/loop/observe.ts` — an optional `VersionCache`; reuse the cached version on
  a matching signature, else hash.
- `src/loop/graph.ts` — one cache per run, passed to `reconcile`.

## 4. Verification

- `npm run typecheck`; `npm test`.
- Tests (counting workspace): one hash on the first reconcile, none on an
  unchanged second reconcile, a re-hash and a `mutate` after a change; the
  no-cache path still works.

## 5. Invariants

- Drift is still detected; the signature only skips the hash when unchanged.
- `project` stays pure; observation stays a loop step.
- The journal stays append-only.

## 6. Boundaries

- The signature is a proxy: a content change that preserves `mtime`, `ctime` and
  size is not seen — accepted, as in git; a forced re-hash can be added if needed.
- `fs.watch` — future streaming/idle mode.
- A per-turn `stat` of each active `ref` remains.

## 7. Status

Implemented. `Workspace.signature` (`src/tools/workspace.ts`); the cache and the
skip in `reconcile` (`src/loop/observe.ts`); one cache per run
(`src/loop/graph.ts`). `npm run typecheck` is clean and `npm test` passes. Docs
updated: `docs/ir.md` §5.
