# Skein

A coding agent with a deterministic IR context. The context is a **projection of
the IR**, not a message tape. The conceptual frame is doxa/logos: the LLM (doxa)
only proposes, the engine and the witness (logos) decide, the journal and the
projection are the protocol.

## Documents

- `docs/concepts.md` — conceptual overview.
- `docs/ir.md` — the IR: operations, state, and control.
- `docs/plans/traversal_stack_spec.md` — the traversal stack (spine and arms).
- `docs/testing.md` — how to run tests and benches, and where output lands.
- `docs/plans/implementation_plan.md` — overall plan, decisions, roadmap, status.
- `docs/plans/tier0_plan.md` — detailed Tier 0 spec.

## Commands

- `npm run typecheck` — `tsc --noEmit`
- `SKEIN_LIVE=false npx vitest run` — offline tests (`.env` sets `SKEIN_LIVE=true`)
- see `docs/testing.md` for the live gate and benches

## Invariants (do not break)

- a goal never becomes `achieved` without `check` provenance;
- a `stale` fact is never shown as active content;
- `project` is deterministic: same events → same `Context`;
- doxa (the LLM) only proposes; logos decides (an objective goal is settled only by
  its own check, an arbiter goal only by external acceptance);
- secrets live only in `.env` (the file is in `.gitignore`);
- minimal diff, no incidental refactoring or scope creep.

## Way of working

Plan first, then code (see the global `~/.config/opencode/AGENTS.md`). The
current stage, order of work, and open questions are in
`docs/plans/implementation_plan.md`.
