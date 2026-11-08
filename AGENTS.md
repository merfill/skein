# Skein

A coding agent with a non-monotone IR context. The context is a **projection of
the IR**, not a message tape. The model proposes; the executor records and derives;
the journal and the projection are the protocol.

## The context is a projection (non-monotone)

The journal (IR/graph) is monotone: events are appended, nodes are never rewritten. The
prompt is **not** a transcript: `project(state)` rebuilds `Context` every turn, and
`buildMessages` assembles the messages from scratch. The projection is **non-monotone** —
content can disappear from the view as the focus moves.

- message 0 is always `BASE_PROMPT` (role + general instructions, B1/B2); the request is always
  the leading `user` turn;
- an **open** state renders `Start state` + brief + its **turns** (a monotone
  action/observation list); a **closed** state renders only `Start state` + `Finish state` —
  no brief or turns;
- an open state gets a per-turn **working prompt**: one `user` turn after the turns, with
  `Goal: <island.what>`, the model's unverified note (`Your earlier guess (may be wrong):`),
  `Done when: <criterion>`, `Plan:` (the state's instruction), and "The original user request
  is context for this state, not its goal." It is recomputed from the projection, never stored.
  The request/transition prompts are appended the same way; `transition` is a `system` turn;
- the **state map and transitions are not in the base prompt**: the request prompt names the
  startable states, and the transition prompt names the reachable states and the rules,
  scoped to the move at hand. An open state never sees another state's goal;
- the **request is reference, not the goal**: it explains why the task exists and what
  check it declares, but the state's goal and criterion are the only active goal for the
  turn. This is a real anchor the model otherwise treats as a broader task (see below);
- "closed" does not delete nodes: they stay in the journal and are addressable via
  `recall`/`search`; only the projection stops selecting them;
- `project` is deterministic: same events → same `Context`.

When changing the prompt/tape, change the render predicates in `project`/`buildMessages`, not a
stored history. Do not reason about the context as an append-only chat transcript.

## Prompt anchors (observed)

- **The request is the strongest anchor.** A model will treat the request's check as a second goal
  inside a state unless the state's goal/criterion is restated at the decision point and the
  request is explicitly *reference*. On `fix-ocaml-gc`, Patch kept building/testing because
  "Ensure … the testsuite runs cleanly" was still the broader task. It stopped only when
  (a) the request was marked reference, (b) the working prompt restated `Goal`/`Done when`/`Plan`
  at the decision point, and (c) the base prompt stopped carrying the state map/transitions, so
  "next state (Verification)" could not become another goal.
- **A state records its own work, not the request's check.** The request starts directly
  in a productive state (Patch/Research/Construction); there is no orientation pass, because the
  engine already renders the root, the repository status and the environment. A `Check: …`
  line in a state's result becomes a second goal on the tape for every later state. The
  check stays in the request, and the state that owns it reads it there.
- **Prohibitions are probes, not fixes.** "Stop after the edit; do not build" suppresses the
  symptom but leaves the model resolving the conflict between the request and the state. Fix
  the hierarchy and the salience; use a prohibition only to confirm the anchor exists. The
  positive form is the state's `Done when`, which already names the result; do not add a
  separate prohibition list.
- `bench/turn.ts --rebuild` is the cheap probe: it re-renders the current prompt over a
  recorded turn without a container. For `working`/`terminal` it must pass `allowText` like
  `propose` does, otherwise a text stop is repaired as a missing tool call and the probe lies.

## Documents

Start at `docs/README.md` — it links the English (`docs/en/`) and Russian (`docs/ru/`) trees.
The two trees mirror each other by base name; the handoff log is RU-only at
`docs/ru/handoff.md`.

## Commands

- `npm run typecheck` — `tsc --noEmit`
- `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — offline tests (`.env` sets
  `SKEIN_LIVE=true`)
- `npm run cli -- auth login|list|logout`, `... models`, `... doctor` — provider setup and
  probes; `docs/en/providers.md`. Provider tests use a mock fetch; no live calls without go-ahead.
- **NEVER run bare `npx vitest run`.** It collects `tests/sandbox/**`, which self-enable on any
  machine with Docker + the task images + the benchmark task cache and launch real containers and
  verifiers (300 s timeouts, 120 s cleanup) — minutes of runtime and apparent hangs, not the
  seconds an offline run should take. Always exclude `tests/sandbox/**`.
- **Heavy/live tests need the owner's explicit go-ahead — ask first, every time.** This covers
  `tests/sandbox/**` (which self-enables on any machine with Docker + the task images + the
  benchmark task cache and launches real containers/verifiers, regardless of `SKEIN_LIVE`), any
  `SKEIN_LIVE=true` run (gate, live scenarios, live step tests) and `npm run bench*`.
  They cost minutes and money — never start one on your own initiative.
- **Sandbox batch protocol (owner).** Our runner is the containerized `tests/sandbox/**`. For a
  K-run batch: run the cells **in parallel** (matrix.ts
  or parallel `sandbox-run.ts` processes — never a sequential shell loop), cap by **turns**
  (the task's `maxTurns`, 60 for `fix-ocaml-gc`), and impose **no wall-clock timeout** (do not
  pass/enforce `--timeout`, `VERIFIER_TIMEOUT_MS`, `DEFAULT_RUN_TIMEOUT_MS`).
- see `docs/en/testing.md` for the live gate and benches

## Bench / replay tools (do not reinvent)

- `bench/rollout.ts <run> [--turns N] [--dry]` — build a FRESH tape with the current projection
  (`runAgent` → `project`/`buildMessages`) and roll N live turns forward; each tool result is
  taken positionally from `<run>`'s recorded observations (`bash` from the recording; the file
  tools run against the task's mini spec tree). Prints per-turn tokens + reasoning.
- `bench/turn.ts <run> --rebuild --turns A-B` — replay recorded turns over the RECORDED history
  with the current projection (base prompt, `Start state` + brief + turns, working prompt); the
  tool results come from the recording, not a from-scratch tape. For `working`/`terminal` it must
  pass `allowText` like `propose`, or a text stop is repaired as a missing tool call.
- `bench/replay.ts <run>` — replay recorded contexts through the live model as-is.
- `tests/sandbox/live-trace.ts` — full live rollout on the virtual `fix-ocaml-gc` spec workspace.
- `--dry` (where offered) reconstructs the context and prints it with no model call — free.

## Invariants (do not break)

- a state is closed only by the model's text reply, recorded as `stop` (a `has_stopped` edge on
  the `move`); there is no criterion gate — cycle / premature-stop detection is deferred;
- the request ends when its goal is stopped (there is no `stop` on the request);
- a `stale` fact is never shown as active content;
- `project` is deterministic: same events → same `Context`;
- the model proposes; the executor records; refusals and tool failures are the only facts the
  engine adds;
- secrets live only in `.env` (the file is in `.gitignore`);
- minimal diff, no incidental refactoring or scope creep.

## Way of working

Plan first, then code (see the global `~/.config/opencode/AGENTS.md`). The
current stage, order of work, and open questions are in
`docs/ru/handoff.md`.
