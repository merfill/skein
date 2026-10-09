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
- `SKEIN_LIVE=false npx vitest run` — offline tests (`.env` sets `SKEIN_LIVE=true`)
- see `docs/testing.md` for the live gate and benches

## Invariants (do not break)

- a goal is closed only by the doxa's `stop`; a `stop` is accepted only once the goal's
  criterion run passed (a give-up / negative stop is deferred);
- the request ends when its goal is stopped (there is no `stop` on the request);
- a `stale` fact is never shown as active content;
- `project` is deterministic: same events → same `Context`;
- doxa (the LLM) only proposes; logos decides (a criterion run's `exitCode` is the only
  pass/fail fact);
- secrets live only in `.env` (the file is in `.gitignore`);
- minimal diff, no incidental refactoring or scope creep.

## Way of working

Plan first, then code (see the global `~/.config/opencode/AGENTS.md`). The
current stage, order of work, and open questions are in
`docs/plans/implementation_plan.md`.
