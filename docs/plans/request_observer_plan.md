# Tier 4a — RequestObserver: triggers, observer unit, hint/memo/halt

> Russian original — `docs/plans/request_observer_plan_ru.md`.
>
> Status: **4a implemented** and verified on synthetic live scenarios (`entry`, `long`);
> real tasks — passed (see "Calibration" below). The `state_long` threshold 13 → 9 and the
> state tape replacing the survey tools were fixed on 2026-11-04. Scope — 4a only. Out of
> scope: session operations and attention statuses (4b), user interruption.

## 1. Goal

Build the minimal control loop: deterministic trigger → observer unit → `hint`, `memo` or `halt`,
on top of a minimal session. Task-tree semantics do not change: a state is closed only by the
doxa's `stop`, the journal only grows, the projection is deterministic. At the same time,
`nudge` and terminal `no_progress` are removed.

## 2. Fixed inputs

- `docs/controllability.md` §8: layers separated; a minimal session in 4a; a unit stack; the
  survey seed is a journal event; thresholds are rewritten; `nudge` is removed; the reactions
  are `hint`, `memo`, `halt`.
- `docs/session_concepts.md` §2/§10: `Session = (J_s, U, stack, pending)`, `focus` is the top
  of the stack; 4a needs only the shell, without operations or attention statuses.
- Invariants: the journal is append-only; `project` is deterministic; closure is only through
  `stop`; no stored verdicts or truth statuses; `hint`/`memo` are not `user` turns and are not
  counted as task knowledge.

## 3. Scope

**In:**

- the session container: session journal, units, stack, `pending`; no session operations;
- a deterministic trigger detector: `budget`, `state_cycle`, `state_long`;
- the observer unit: its own journal, its own prompt, an engine-seeded state tape, and the
  decisions `hint`/`memo`/`halt`;
- the reactions `hint`, `memo`, `halt`; logos checks and applies them;
- `hint`/`memo` in the task journal, rendered as `system`;
- removal of `nudge` and terminal `no_progress`; `max_turns` remains the absolute safeguard;
- offline tests and the as-built docs update after implementation.

**Out:**

- session operations `respond`/`resume`/`revise`/`redirect`/`cancel`/`query` and attention
  statuses — 4b;
- user interruption — a separate task;
- revoking `memo` and `pin`/`warn`/`constrain`;
- similarity/RAG;
- live/bench runs without an explicit go-ahead.

## 4. Target architecture

### 4.1. Session

- `src/session/types.ts`: `Unit { id, type: "task"|"observer"|"session", journal: Event[], turn }`,
  `UnitRef { unitId, turn }`, `SessionState { journal: SessionEvent[], units: Map, stack:
  UnitRef[], pending?: PendingUtterance }`.
- `SessionEvent` is a separate closed union: `open_unit`, `push`, `pop`, `trigger`,
  `reaction`. It is not a task `Event`; the journals are not mixed.
- `src/session/session.ts`: append-only; `focus = stack top`; `push`/`pop`; no context copies —
  only ids and return points.
- `AgentInput.session?` for resuming, `AgentResult.session` in the result. Without a session
  `runAgent` works as before (the observer path is off).

### 4.2. Nodes and provenance

- The observer journal uses **ordinary** `action`/`observation` nodes: payload `{ origin: "engine"
  | "doxa", tool, args, callId, result }`. There are no separate `observer_call`/`observer_result`.
- `WORK_KINDS` gains only `hint` and `memo`. `trigger` remains a session-journal event, not an
  IR node.
- Node provenance — `payload.origin` (`Node` has no provenance field).
- `fold` accepts the new members; `project` renders `hint`/`memo` as `system`. The observer
  journal never enters the task `project`.

### 4.3. Trigger detector

- `src/session/triggers.ts`: `detectTriggers(state, session, unit) → Trigger[]`; a pure
  function, with no finishes or advice.
- `Trigger { id, kind, anchor, evidence: string[], epoch }`.
- Counters are derived `State` fields, not node rewrites: `stateEntries` is counted in `fold`
  from `move`; `stateTurns` = the current turn minus `move.turn`.
- `state_cycle`: the third entry into the same island through `move`; once per current `move`.
  Threshold — `SKEIN_STATE_CYCLE_ENTRIES` (default 3).
- `state_long`: `stateTurns > 9`; once per current `move`.
  Threshold — `SKEIN_STATE_LONG_TURNS` (default 9).
- `budget`: fewer than K turns remain (`SKEIN_BUDGET_TURNS`, default 3). The trigger is
  suppressed when the focus is in a terminal island or the request is already near closure —
  then the engine lets it finish.
- Stagnation by a knowledge key is **not detected**. `repeat`, `reasoning_bloat` are stage 2.

### 4.4. Observer unit

- `src/session/observer.ts`: `runRequestObserver(deps, trigger, taskState) → { journal, decision }`.
- The seed is recorded in the observer unit journal as an ordinary `action`/`observation` pair with
  `payload.origin: "engine"` and a matching `callId`:
  - `system`: the observer prompt and the trigger facts (`kind`, `anchor`, evidence ids);
  - `assistant`: one `state` call → `tool` result whose body is the **state tape** (`stateTape`):
    the request, the move list, and every turn of the firing state in order — the agent's
    reasoning, the action, the observation it produced, each addressed by node id.
- The observer unit model: tools `hint`, `memo`, `halt` only. It reads the tape it is handed; there
  are no survey tools, because everything they could disclose is already in the state tape.
- `buildObserverMessages` reuses `TapeMessage`/`toMessage`; it has its own `OBSERVER_BASE_PROMPT` and
  no task situation tails.
- Loop: exactly one model call per run, one reaction per run. A reply that is not a decision is
  repaired once by `modelRequestObserver`; a reply that still decides nothing ends the run with
  `noDecision: "empty_reply"`, recorded on the observer unit.
- Nesting limit: `observerDepth < 1`; the depth counter itself is unchanged.
  infrastructure exists; nested runs are future work.

### 4.5. `hint` and `memo`

- `src/session/apply.ts`: preconditions — evidence ids exist in the task tree; the text is
  non-empty and bounded; `kind` comes from a closed list.
- `hint` — advice for the **current state**: `add_node` with `kind: "hint"`, `payload: { text,
  evidence, origin: "observer", sourceUnit, scope: "state", state: currentMoveId }`. Rendered as
  `system` after the open state's plan; after the state's `stop` it leaves the tape but stays in
  the journal.
- `memo` — permanent advice for the **unit**: `add_node` with `kind: "memo"`, `payload: { text,
  evidence, origin: "observer", sourceUnit, scope: "unit" }`. Rendered as `system` in every open
  state until the request ends. There is no revoke in 4a.
- Both write a `reaction` to the session journal; a rejected reaction's refusal is written to
  the observer unit journal, not the task journal.

### 4.6. `halt`

- `Decision.halt` → `progress` sets `done: true`, `stopReason: "observer_halt"`, `stopText:
  reason`.
- No `stop` node is written, the state is not closed, the partial journal is kept.
- User interruption later yields `user_interrupt` through the same result surface.

### 4.7. Loop integration

- `progress` is already called after `execute` and inspects the journal
  (`src/loop/graph.ts:206-234`). Make it **async** and embed the observer path there — a separate
  `supervise` node is not needed.
- Order inside `progress`:
  1. if `state.done` — return;
  2. check request closure (`request_addressed`);
  3. `detectTriggers`; if there is a trigger and the observer unit budget is not exhausted — push
     the observer unit, `runRequestObserver`, pop; apply `hint`/`memo`/`halt`;
  4. check `max_turns`; if the current island is `end|research|patch|construction`, allow
     another `G` turns once (`SKEIN_GRACE_TURNS`); otherwise finish; on `halt` —
     `done`/`observer_halt`.
- `LoopState` gains `session`; `AgentResult` returns the session.
- In live/bench the observer is on by default; `SKEIN_OBSERVER=false` disables it.
- `progress` remains the only after-turn point; `stall`/`no_progress` are removed from it.
- If responsibility separation is needed later, the observer path can move to a separate async node
  between `execute` and `progress`; the semantics are the same.

### 4.8. Removing `nudge` and `no_progress`

- Remove `Context.nudge`, `ProjectOptions.stall` and the text (`src/ir/project.ts:73-84,
  481-483`), the `stall` pass (`src/loop/graph.ts:105`), the `noProgress`/`stall` logic
  (`src/loop/graph.ts:84, 206-234`), `LoopState.stall`.
- `max_turns` stays as the absolute safeguard; the budget trigger fires before it.
- After implementation, update the as-built descriptions in `ir_semantics`/`projection`.

## 5. Work order

1. **Session shell.** `src/session/types.ts`, `session.ts`; journal/stack; tests. Task behavior
   does not change.
2. **Remove nudge/no_progress.** An isolated behavior change; adjust `tests/prompt.test.ts`,
   `tests/loop.test.ts`, `tests/state_transitions*`; keep `max_turns`.
3. **Budget, cycle and long-state detector.** `triggers.ts`, tests for threshold/reset/
   determinism, terminal suppression and `stateEntries`/`stateTurns` counters.
4. **Observer journal and seed.** `action`/`observation` in the observer journal, `projectObserver`,
   engine-origin, replay tests.
5. **Observer model and tools.** `observerTools()` = `hint`/`memo`/`halt`, decision schemas without
   a `state` field (the engine stamps the trigger's anchor), single call, repair/retry.
6. **Hint and memo.** Application, rendering, tests for evidence, state closure and memo
   permanence.
7. **Halt and async `progress`.** `AgentResult.session`, integration tests.
8. **Stage 2.** `repeat`/`reasoning_bloat`; nested observer triggers on top of the existing
   `maxDepth` infrastructure — after the first slice is reviewed.
9. **Docs.** `ir_semantics`, `projection`, README; final offline run.

## 6. Test invariants

- **Session:** the journal only grows; `focus` is the stack top; push/pop do not rewrite units;
  `pending` is not a stack.
- **Detector:** `state_cycle` on the third entry; `state_long` beyond 9 turns; `budget`
  within K turns, not at the hard limit and not at a terminal state; identical events →
  identical triggers.
- **Grace:** in `patch|research|construction|end` at `max_turns`, `G` more turns
  (`SKEIN_GRACE_TURNS`, default 5) once; in other states the run ends immediately.
- **Observer unit:** the seeded call and result have matching ids and `origin: "engine"`; a replay
  reads them from the journal; the observer never writes to the task journal; one reaction per run;
  a logos refusal does not break the task.
- **Hint/memo:** both are recorded in the task journal; on the tape they are `system`, not
  `user`; `hint` disappears when its state closes, `memo` remains until the request ends;
  invalid evidence is rejected.
- **Loop:** `nudge` is absent from `Context`; `no_progress` is not terminal; `max_turns` works;
  `halt` gives `observer_halt` without a `stop` node; request closure is unchanged.
- **Projection:** deterministic; hint/memo ordering is stable; they never become a `user` turn.
- Commands: `npm run typecheck`;
  `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'`.

## 7. Acceptance criteria

- Typecheck and the offline suite are green; the new tests cover the §6 invariants.
- The observer unit writes nothing to the task journal except `hint`/`memo`; it creates no
  `move`/`stop`/`plan`.
- The task sees `hint`/`memo` on the next turn as `system`; `halt` ends the run without `stop`.
- `nudge`/`no_progress` are absent; `max_turns` and normal closure are preserved.
- The budget trigger fires before `max_turns` and is suppressed near the terminal state;
  without a observer unit reaction, `max_turns` still ends the run, except for one grace window
  (`SKEIN_GRACE_TURNS`, default 5) in `patch|research|construction|end`.
- The same journal/session gives the same trigger and the same observer context (the LLM reply is
  replayed from the recorded journal).
- No live/bench run was made.

## 8. Risks and open questions

- **Seed shape.** `action`/`observation` in the observer journal — replay and wire pairing need
  verification; no separate kinds are introduced.
- **Async `progress`.** The graph already has an async node, `proposeNode`; if async in
  `progress` is inconvenient, the observer path moves to a separate node.
- **`memo` lifetime.** There is no revoke in 4a; if needed, it is a 4b operation.
- **Stagnation.** Not detected in 4a; `repeat`/`state_chain`/`reasoning_bloat` are stage 2.
- **Cost.** Every trigger is a observer-model run; thresholds and the observer budget must bound it. A
  live evaluation comes later and with a go-ahead.
- **Backward compatibility.** The new `hint`/`memo` kinds break the old journal parser; runs are
  short-lived, but the replay harness must account for it.

## 9. Rollback

- The session and the observer path land in separate commits; without a session `runAgent` works as
  before (except for the removed nudge/no_progress — a separate commit).
- Removing nudge/no_progress is rolled back by reverting its commit.
- New kinds need no migration of existing journals: old events still read, new ones appear only
  in new runs.

## 10. Calibration (2026-11-04)

**`state_long` threshold: 13 → 9.** Measured on recorded runs with the modern IR (a `turns`
container, 19 runs): at 13 it fires 11/19, at 9 it fires 16/19, and in 15 of 16 cases **before**
the answer is written. The observer tape is half as long: median 11.5k tokens vs 17.8k. Median
headroom — 7 turns. On `cobol-modernization` (the only task whose states really are long)
threshold 9 leaves 11–16 turns of headroom against 7–12 at 13. The `budget` trigger is
**unchanged** — the owner's decision: its three modern fires all landed in deep states, and the
single young one gave a genuinely useful early warning.

**The observer tape.** `defaultObserverTools`/`ObserverTools` are removed. The observer receives
one deterministic state tape (`stateTape`): reasoning → action → observation over every turn of
the state the trigger fired in, addressed by node id. There are no survey calls — a second model
turn could only restate the tape.

**Result-render fix.** `write`/`edit` attach `mutates` to `file:<path>` and never create a
`result` node, so 135/143 `write` and 146/158 `edit` were drawn as `-> no result`.
`actionResultText` (`src/ir/project.ts`) was introduced and `stateTape`/`observationBody` reuse
it. Verified: 0 false `no result` out of 272 successful edits.

**What the calibration did not show.** `password-recovery` (9/9, median 17 turns) does not
measure the observer: the shortest runs had no trigger, the agent derived the answer before the
hint, and every action inside a state is a distinct command. `state_long` measures productivity
there, not a lost thread. Testing "the observer earns its keep when the agent goes off course"
needs a task where the agent actually thrashes; the current registry has none.

**Re-measurement 2026-11-04 (K=1 per task, `--turns 80`, `net off`).** Two runs, both
`reward=1`, both revealing the same weakness from opposite sides. Neither hint carried new
information.

- `custom-memory-heap-crash` — 65 turns, 5.954₽. Two `state_long` triggers (t12, t24). The
  second hint told the agent to set a gdb breakpoint on `_Facet_Register_impl`, which it had
  already done. Eleven later turns open with "the hint is stale — I already did that",
  costing **0.886₽** of 5.95₽, and the agent rewrote `user.cpp` twice from the outdated
  advice (one `stale_base` refusal). The hint is built from the tape as it stood at the
  trigger and then persists in context as a `memo`, so it keeps reading as a live instruction
  after the work moves on.
- `fix-ocaml-gc` — 29 turns, 2.470₽. One `state_long` trigger at t12 whose hint names
  `pool_sweep` and the exact `p += Whsize_hd(hd)` line. The agent had derived the same fix
  one turn earlier (t11) from the `verify_pool` invariant, so the hint coincided with the
  conclusion instead of producing it.

So the failure is not the threshold: at 9 it fires in time in both runs. The defect is that a
`state_long` hint has **no notion of being current** — the engine never re-checks it against
turns that arrive after the trigger, and never retires it. This is the same class as the
invented-offsets defect below: logos checks that the evidence ids exist, not that what the
hint says is still true of the tape.

**Open defect.** The observer invents numeric offsets that are not in the tape (e.g. `1048671`
and `3145726` against an actual `3145727`). Logos validates that evidence ids exist, not that
the quoted content appears. Not fixed. Same root cause as the staleness above: the check is on
form, not on correspondence with the tape.
