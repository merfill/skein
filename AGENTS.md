# Skein

A coding agent with a deterministic IR context. The context is a **projection of
the IR**, not a message tape. The conceptual frame is doxa/logos: the LLM (doxa)
only proposes, the engine and the witness (logos) decide, the journal and the
projection are the protocol.

## Documents

Start at `docs/README.md` — the documentation index (concepts, the IR, the model
surface, testing, plans, and benchmarks). Every document has a `_ru` mirror.

## Commands

- `npm run typecheck` — `tsc --noEmit`
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — offline tests (`.env` sets
  `SKEIN_LIVE=true`)
- **NEVER run bare `npx vitest run`.** It collects `tests/sandbox/**`, which self-enable on any
  machine with Docker + the task images + the Harbor cache and launch real containers and
  verifiers (300 s timeouts, 120 s cleanup) — minutes of runtime and apparent hangs, not the
  seconds an offline run should take. Always exclude `tests/sandbox/**`.
- **Heavy/live tests need the owner's explicit go-ahead — ask first, every time.** This covers
  `tests/sandbox/**` (which self-enables on any machine with Docker + the task images + the
  Harbor cache and launches real containers/verifiers, regardless of `SKEIN_LIVE`), any
  `SKEIN_LIVE=true` run (gate, live scenarios, live step tests), `npm run bench*`, and Harbor.
  They cost minutes and money — never start one on your own initiative.
- see `docs/testing.md` for the live gate and benches

## Invariants (do not break)

- a state is closed only by the doxa's `stop` (a `has_stopped` edge on the `move`); there is
  no criterion gate — cycle / premature-stop detection is deferred
  (`docs/plans/goal_reduction_plan.md`);
- the request ends when its goal is stopped (there is no `stop` on the request);
- a `stale` fact is never shown as active content;
- `project` is deterministic: same events → same `Context`;
- doxa (the LLM) only proposes; logos decides (refusals and tool failures are the only
  facts the engine adds);
- secrets live only in `.env` (the file is in `.gitignore`);
- minimal diff, no incidental refactoring or scope creep.

## Way of working

Plan first, then code (see the global `~/.config/opencode/AGENTS.md`). The
current stage, order of work, and open questions are in
`docs/plans/implementation_plan.md`.
