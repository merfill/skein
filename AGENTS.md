# Skein

A coding agent with a deterministic IR context. The context is a **projection of
the IR**, not a message tape. The conceptual frame is doxa/logos: the LLM (doxa)
only proposes, the engine and the witness (logos) decide, the journal and the
projection are the protocol.

## Documents

- `docs/concepts.md` — conceptual overview.
- `docs/ir.md` — the IR: operations, state, and control.
- `docs/plans/implementation_plan.md` — overall plan, decisions, roadmap, status.
- `docs/plans/tier0_plan.md` — detailed Tier 0 spec.

## Commands

- `npm run typecheck` — `tsc --noEmit`
- `npm test` — vitest (live gate only when `SKEIN_LIVE=true`)

## Invariants (do not break)

- a claim never becomes `verified` without `check` provenance;
- a `stale` fact is never shown as active content;
- `project` is deterministic: same events → same `Context`;
- doxa (the LLM) only proposes (`status=open`); logos decides;
- secrets live only in `.env` (the file is in `.gitignore`);
- minimal diff, no incidental refactoring or scope creep.

## Way of working

Plan first, then code (see the global `~/.config/opencode/AGENTS.md`). The
current stage, order of work, and open questions are in
`docs/plans/implementation_plan.md`.
