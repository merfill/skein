# Skein

A coding agent with a deterministic IR context. The context is a **projection of
the IR**, not a message tape. The conceptual frame is doxa/logos: the LLM (doxa)
only proposes, the engine and the witness (logos) decide, the journal and the
projection are the protocol.

## The context is a projection (non-monotone)

The journal (IR/graph) is monotone: events are appended, nodes are never rewritten. The
prompt is **not** a transcript: `project(state)` rebuilds `Context` every turn, and
`buildMessages` assembles the messages from scratch. The projection is **non-monotone** —
content can disappear from the view as the focus moves.

- message 0 is always `BASE_PROMPT`; the request is always the leading `user` turn;
- an **open** state renders `Start state` + brief + instruction + its goal (`user`) + plan;
  a **closed** state renders only `Start state` + `Finish state` — no brief, instruction, goal,
  or plan turns;
- the situation tail (`request`/`plan`/`working`/`transition`/`terminal`) is appended per turn,
  never stored; `transition` is a `system` turn;
- "closed" does not delete nodes: they stay in the journal and are addressable via
  `recall`/`search`; only the projection stops selecting them;
- `project` is deterministic: same events → same `Context`.

When changing the prompt/tape, change the render predicates in `project`/`buildMessages`, not a
stored history. Do not reason about the context as an append-only chat transcript.

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

## Bench / replay tools (do not reinvent)

- `bench/rollout.ts <run> [--turns N] [--dry]` — build a FRESH tape with the current projection
  (`runAgent` → `project`/`buildMessages`) and roll N live turns forward; each tool result is
  taken positionally from `<run>`'s recorded observations (`bash` from the recording; the file
  tools run against the task's mini spec tree). Prints per-turn tokens + reasoning.
- `bench/turn.ts <run> --rebuild --turns A-B` — replay recorded turns over the RECORDED history
  (the tape is the old one; only the base prompt is current — not a from-scratch tape).
- `bench/replay.ts <run>` — replay recorded contexts through the live model as-is.
- `tests/sandbox/live-trace.ts` — full live rollout on the virtual `fix-ocaml-gc` spec workspace.
- `--dry` (where offered) reconstructs the context and prints it with no model call — free.

## Invariants (do not break)

- a state is closed only by the doxa's `stop` (a `has_stopped` edge on the `move`); there is
  no criterion gate — cycle / premature-stop detection is deferred
  (`docs/plans/archive/goal_reduction_plan.md`);
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
