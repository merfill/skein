# Tier 4c — interruption: pause, resume, cancel and telemetry

> Russian original — `docs/plans/session_interrupt_plan_ru.md`.
>
> Status: **implemented** (slices 2–6: cancellation, resumable loops, task snapshot/rollback,
> driver/REPL, telemetry contract). Offline tests only; no live/bench run. The terminal menu is
> text commands (`r`/`c`/`q`) plus `Esc`/`Ctrl-C`; the panel/UI is still out of scope, as are
> persistence, force-kill, `revise`, and resuming an abandoned unit.
>
> Related: `docs/session_concepts.md` §3 (interruption), §4 (the session agent),
> `docs/plans/session_agent_plan.md`, `docs/plans/session_driver_plan.md`,
> `docs/plans/request_observer_plan.md`.

## 1. Goal

Make interruption a first-class control action, identical for the session agent, the task
agent and the observer. **Pause** is not an IR operation: it writes no journal event, closes no
state, changes no focus and does not fill `pending`. It stops work at a committed step boundary;
the user can resume from the journal, or cancel. **Cancel** is a separate control action: an open
task is restored to its entry snapshot (a full tree rollback), a rollback event is appended to
its journal, and control returns to the session level.

The same slice fixes the data contract for **observability**, so a future terminal status panel
(context, tokens, cache, reasoning, timing, units, states, session duration) can be built
without retrofitting the loops.

## 2. Fixed decisions

- **Step** = one tool call. A model call is a proposal, not a step.
- **Turn** = one pass of the loop "projection → proposal → execution → progress"; its number is
  used in the journals and in telemetry.
- **Unit** = a session record holding the journal of one kind of work: `task`, `session`,
  `observer` or `reading`.
- **Pause** = stop at a committed step boundary. No `stop`, no journal event, no `pending`,
  no focus change, no post-task report.
- **Resume** = re-enter the loop from the committed journal (`seed` + `startTurn`), not a live
  coroutine. The projection is rebuilt deterministically; committed turns are not re-executed.
- **Cancel** = roll back to the session level (pop the paused units). For an open task, restore
  its entry snapshot and write a rollback event to the task journal. Units stay in the session as
  traces; no `stop`, no `abandon`, no status event.
- **Task snapshot** = a full copy of the working tree taken when the task starts, used for
  rollback. It excludes `.skein` and secret files.
- **Uniform across agents.** The pause, resume and cancel rules are the same at all three levels;
  the world rollback on cancel applies only to tasks, since the session agent and the observer do
  not change files. The user sees "working" / "paused", not "task" vs "observer".
- **L0 is never truncated.** The session agent shows L0 in full; growth is accepted.
- **L0 is append-only.** Its lines are not rewritten. A session unit records the user request,
  the reformulation (operation) and the return (report/answer) — three messages; a task unit
  records its request and outcome; new units are appended.
- **Telemetry is a side channel**, not IR and not the projection: it must not affect
  determinism or grow the tree.

## 3. Semantics

### 3.1. Where a pause can happen

- before or after a tool call (the step boundary);
- during a model call: **abort** it — the proposal is not a fact; on resume the model is asked
  again;
- never inside a **mutating** tool: the tool finishes, its result/error and any `mutate` are
  recorded, and the pause is honoured after the step is committed. If the tool already changed
  the world, stopping silently would make the tree lie.

Read-only tools need no special handling: aborting the model call or checking the flag between
tools leaves no side effect.

### 3.2. Per level

| Level | Paused unit | At pause | Resume | Cancel |
|---|---|---|---|---|
| session | the `session` unit of the interpretation | commit the partial journal; keep the unit open and focused | continue `runSessionUnit` from its journal + start turn | pop the session unit; the interpretation ends without an operation; return to the prompt |
| task | the focused `task` unit | sync the event tail into the unit journal; keep the unit open and focused | `runAgent({ seed: unit.journal, startTurn: unit.turn, session, open: false })` | pop the task unit; restore the full tree from the entry snapshot; append a rollback event to the task journal; return to the session prompt. Without a snapshot: no rollback, a warning |
| observer | the `observer` unit on top of the task | commit the partial observer journal; keep it on the stack | finish the observer first, apply its reaction, pop it, then continue the task | pop the observer and then the task; roll back the task from its snapshot; return to the session prompt |

The observer is a sub-step of the task's `progress`. A paused observer therefore keeps its unit
on top of the stack; the resume path resolves the top pause first.

A task rollback is full: the whole working tree is restored, so changes made by anyone else
during the task are reverted too. This is a deliberate decision: responsibility for such changes
lies with the user and the environment, not the engine.

### 3.3. What is never done on pause/resume/cancel

On **pause and resume** none of the following is written:

- no `stop` node, no `move`, no `plan` item;
- no session event (`suspend`/`resume`/`abandon`/`operation`/`no_decision`/`report`);
- no `pending` write;
- no post-task report and no `no_decision` on an interrupted interpretation.

The focus does not change during pause or resume.

On **cancel** the event prohibitions remain: no `stop`, `move`, `plan`, session event, `pending`,
`report` or `no_decision`. The focus change is expected — the unit is popped. The only permitted
event is `rollback` in the task journal when a snapshot is available. It is a fact of the changed
world; without it the task trace would be inaccurate. If there is no snapshot, no rollback
happens, no event is written, and the terminal shows a warning.

An interrupted interpretation or task is `suspended` by derivation (`attentionOf`): it is not
closed and not focused after a cancel. No status event is needed for that.

## 4. Mechanism

### 4.1. Pausing a model request

Requirement: the current request to the model must be cancelable by the user's command, and the
cancellation must not be classified as a provider error. Tools are not canceled: a running
mutating tool finishes (see §3.1).

The concrete mechanism is `AbortSignal` (see §4.1.1); it is chosen for the current model layer.

### 4.1.1. Implementation: cancellation in JavaScript/Node

JavaScript runs on a single thread and performs long operations (an HTTP request to the model, a
child process) asynchronously. An asynchronous operation cannot be "killed" from outside: it must
cooperate by accepting a cancellation signal. The standard JavaScript mechanism is
`AbortController` and `AbortSignal`:

- an `AbortController` is an object with a `signal` (an `AbortSignal`) and an `abort()` method;
- the `signal` is a cancellation token passed to an operation that supports cancellation;
- `controller.abort()` sets `signal.aborted = true` and notifies listeners; an operation that
  received the signal stops and rejects with an error whose name is `"AbortError"`;
- a signal can be aborted once and cannot be reset; a new resume cycle therefore needs a new
  controller.

In the current model layer the AI SDK functions `generateText` and `streamText` accept an
`abortSignal`; on abort the HTTP request to the provider is canceled and the promise rejects with
`AbortError`. The loops also read `signal.aborted` between tool calls, so a pause is observed at a
step boundary. Tools do not receive the signal and run to completion.

The model-call error handler must recognize `AbortError` and classify it as a pause, not
`llm_error`; otherwise a user pause would be recorded as a provider failure (`graph.ts` currently
maps any proposer error to `llm_error`).

`AbortSignal` is chosen as the standard mechanism. A cooperative flag checked between calls, or an
SDK-specific cancellation API, remain fallbacks; the plan fixes the requirement and the chosen
mechanism.

### 4.2. Resumable loops

- `runAgent` already accepts `seed` + `startTurn`; keep it as the task-side resume path.
- `runSessionUnit` and `runRequestObserver` gain the same optional inputs: a journal seed and
  a start turn. Their counters (`surveys`, loop `turn`, `maxTurns`) must be derived from or
  passed with the seed, so a resumed run does not reset the safety cap or the survey budget.
- Every loop checks the pause flag:
  - before a model call (skip if paused);
  - after each tool call (return `paused` with the journal committed so far);
  - in the observer, between its tool calls and before its next model call.
- A loop returns `{ journal, paused: true, turn }`; the caller commits the returned tail and
  keeps the unit open.
- On resume `startTurn` equals `unit.turn`: the turn counter continues and `maxTurns` stays
  absolute. The transient `grace` flag is not persisted; a pause inside the grace window resumes
  without it — accepted.

### 4.2.1. Stable seed and prompt cache

On resume the already committed unit journal is passed as `seed` **unchanged**. Re-running
`probe`, re-adding constraints, re-labeling the request, renumbering events, reordering,
compacting or pruning the journal is forbidden. Resume only appends new events to the end.

The projection prefix — the system prompt and the already rendered events — therefore stays
byte-identical. The provider caches exactly that stable prefix, so resume does not invalidate the
prompt cache. A step result appended after the pause point goes to the end and does not change the
prefix that was already sent.

For the session agent this means L0 at the pause point must not change: no session events are
written while paused. On resume L0 is built with the same exclusion of the current session unit
as on the first entry, or the stored outline snapshot is reused; otherwise the already-open unit
would appear in L0 and the prefix would change. Telemetry must not affect the journal or the
projection either.

This rule concerns a pause of a running unit. Resuming an already traversed unit is a separate
case: its journal is not continued and its IR is not copied; a new task is formulated instead
(see §6).

### 4.2.2. Session cache across a task transition

The session agent's tape order already favours the cache: system prompt → `Earlier tasks` (L0) →
the current utterance → tool turns. The utterance comes after L0, so changing it does not touch
the L0 prefix.

For the L0 prefix to survive a "session → task → session" transition:

- L0 is **never truncated** in the session agent: it is shown in full and its growth is accepted;
- L0 lines are not rewritten. A unit records the user request, the reformulation (operation) and
  the return (report/answer) — three messages; new units are appended;
- L0 has no volatile fields (timestamps, the current status of an open unit) that could change
  earlier lines;
- the post-task report is a separate call with a separate prompt; it does not share the
  interpretation prefix. If it evicts the session cache at the provider, that is acceptable;
- the provider cache may be evicted during the task; the engine does not control that.
  `cachedInputTokens` per agent and per transition shows whether the prefix really survives.

### 4.3. Commit at pause

- **task:** `runAgent` returns the events committed so far; the driver appends the missing tail
  to `unit.journal` and sets `unit.turn` (the existing `syncUnit`).
- **session/observer:** the loop's journal is local until it returns; on pause the caller
  appends the tail to the unit journal and keeps the unit on the stack.
- Node/observation ids stay based on `journal.length`, so a resumed run continues the sequence
  without collisions; the seed is never appended twice.

### 4.4. Driver and REPL

- `SessionTurnResult` gains `paused?: { agent: "session" | "task" | "observer"; unitId: string;
  turn: number }`.
- New control functions (not session operations): `resumeTurn(deps, session, paused)` and
  `cancelTurn(session, paused)`. They change no IR event.
- `runRepl` gains a pause mode. It accepts **string commands** (`resume`, `cancel`, `quit`) so
  it stays testable without a terminal; `src/cli.ts` maps keys to these commands.
- Keys (explicit):
  - working: `Esc` = pause; `Ctrl-C` opens the same menu with `c` selected;
  - menu: `Enter` or `c` = cancel, `r` = resume, `q` = quit;
  - `c` in task/observer = pop to the session; `c` in session = discard the interpretation and
    return to the prompt;
  - a second `Ctrl-C` on the pause screen = exit the agent (as in GigaCode); it is shown in the
    menu, so there is no hidden press-count.
- At the session prompt after a cancel: "enter a message (or exit)". Do not promise a "new
  session" command before persistence exists.
- The status line shows "working" or "paused"; the internal agent kind (task/observer) is not
  shown.
- The post-task report is a separate call, not a unit and not a pause step. Interrupting it simply
  cancels the report; the task's terminal result remains the fact.

### 4.5. Nesting and unwinding

- The observer is opened/pushed/pop-ed inside the task's `progress`; wrap it in `try/finally`
  so an abort cannot leave a dangling stack entry.
- On resume, if the top of the stack is a paused observer, finish it before re-entering the
  task. The task journal is already synced up to the interrupted turn, so the task continues
  with the next turn and does not repeat the completed `execute`.
- A trigger is recorded once. Resuming an observer must not record the same trigger again
  (dedupe by unit/turn/trigger id, or resume the already-recorded trigger).

### 4.6. Task snapshot and rollback on cancel

- A checkpoint store already exists in `tests/sandbox/checkpoint.ts` (`CheckpointBackend`,
  `HostBackend`, `createCheckpoint`, `createCheckpointWithBackend`). It should be moved into a
  production module (e.g. `src/tools/checkpoint.ts`) and wired into `fsWorkspace`, not rewritten;
  `DockerBackend` stays a test adapter of the same interface.
- The move must not change the algorithm: the hardlink clone of the previous tree, the delta and
  the signature cache stay. A full tree copy or re-hashing every file per snapshot is not
  acceptable; the current implementation is already optimal in time and space.
- Performance was measured on `fix-ocaml-gc` (over 4k files): the first snapshot reads and hashes
  the tree once; later snapshots use the signature cache, the hardlink clone and the delta and
  take milliseconds. That is enough for a task-entry snapshot; the algorithm stays.
- The snapshot is taken at task entry, before the first step (in the driver, before the first
  `runAgent` call), via `workspace.checkpoint("task-start")` when the workspace supports
  checkpoints. The snapshot id lives in the unit metadata and in the pause state; it is not part
  of the projection and is not an IR event.
- The snapshot lives until the end of the session: it is not deleted when an individual task
  finishes. Physical cleanup happens at session boundaries — on a new session start and on
  session end — not after each task. Snapshots live under `.skein` (gitignored), and the hardlink
  clone and delta make accumulation cheap.
- Cancelling an open task restores the whole tree from the snapshot. The existing
  `Checkpoint.restore(token, paths)` already restores named paths, removes files created after
  the snapshot and returns the versions; a full rollback needs the union of the current paths and
  the snapshot paths, or a `restoreTree`/`restoreAll` added to the store. `Workspace` then exposes
  the corresponding full-restore operation.
- After the restore, a `rollback` event is appended to the task journal as
  `{ type: "rollback"; checkpoint: string; reason: "cancelled" }`. It is added to `eventSchema`
  and `fold`; no file list is needed, the full rollback is defined by the snapshot.
- If there is no snapshot (the workspace does not support `checkpoint`), no rollback happens, no
  `rollback` event is written, and the terminal shows a warning. Cancel still pops the unit; the
  world keeps its changes.
- A full rollback also reverts changes made by anyone else during the task. This is a deliberate
  decision: such changes belong to the responsibility of the user and the environment.
- The snapshot excludes `.skein` and secret files; everything else, including `.git` and large
  directories, is captured. This is accepted: a full rollback matters more than the saving, and
  performance is acceptable (see above).
- Snapshots are cleaned at session boundaries: a clean store is created on session start and old
  trees are removed on session end. During a session, task snapshots accumulate and are not
  deleted one by one.

## 5. Telemetry

The goal is the contract, not the panel. The step boundary defined above is also the metric
boundary, so nothing has to be retrofitted later.

### 5.1. Principle

Telemetry is an append-only **side channel**, keyed by `sessionId/unitId/turn/callId`. It is
not an `Event`, not part of `project`, and not rendered on the tape. The sink is passed through
the dependencies (instrumentation); no field is added to `SessionState`. Derived views are pure
functions; the future menu/UI only reads them.

### 5.2. Event shape

```ts
type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
};

type ContextSnapshot = {
  messages: number;
  chars: number;
  approxTokens: number;
  sections?: Record<string, number>; // base/system, request, plan/state, tail, L0, L1
};

type MetricEvent =
  | { type: "session"; sessionId: string; title?: string; startedAt: number; endedAt?: number }
  | { type: "unit"; sessionId: string; unitId: string; unitType: UnitType;
      openedAt: number; closedAt?: number }
  | { type: "turn"; sessionId: string; unitId: string; turn: number; state?: string;
      startedAt: number; endedAt: number }
  | { type: "model_call"; sessionId: string; agent: "session" | "task" | "observer";
      unitId: string; turn: number; callId?: string; model: string;
      startedAt: number; endedAt: number; status: "ok" | "aborted" | "error";
      usage?: Usage; context?: ContextSnapshot }
  | { type: "tool_call"; sessionId: string; agent: "session" | "task" | "observer";
      unitId: string; turn: number; callId?: string; tool: string;
      startedAt: number; endedAt: number; status: "ok" | "error"; mutated?: string[] }
  | { type: "pause"; sessionId: string; unitId: string; at: number }
  | { type: "resume"; sessionId: string; unitId: string; at: number }
  | { type: "cancel"; sessionId: string; unitId: string; at: number;
      rollback: "ok" | "unavailable" | "error" };

interface TelemetrySink {
  record(event: MetricEvent): void; // default: no-op; the CLI wires an in-memory sink
}
```

### 5.3. What to record and where

- **Model calls:** usage from the AI SDK (`inputTokens`, `outputTokens`, `reasoningTokens`,
  cached tokens) and wall time. Instrument the task model adapter, the session-agent adapter
  and the observer adapter. The loops attach `unitId/turn/callId`; the adapter attaches
  `model/usage`.
- **Tool calls:** tool name, status, duration; for the task, the `ref`s changed by the step.
- **Turns/units/session:** open/close timestamps, state/island per turn, unit type.
- **Context snapshots:** at each projection/message build, record message count, chars, an
  approximate token count and a section breakdown. For the session agent this includes L0/L1;
  for the task it includes base/system, request, plan/state and the situation tail.
- **Provider input tokens** (`usage.inputTokens`) are the truth for "what the model saw"; the
  snapshot explains the composition. Both are kept.
- **Model context window** (the limit) goes into the model settings, so the panel can show
  "X of Y". It is configuration, not telemetry.
- **Session title:** generated from the first utterance (deterministic truncation first; an
  optional LLM title later). It is session metadata, not an IR node or event.
- **Pause/resume:** record the timestamps, so duration can distinguish active time, paused time
  and idle-at-prompt time.
- **Cancel:** record the rollback outcome (`ok`, `unavailable`, `error`), so the panel can show
  whether the world was restored.

### 5.4. Aborted work

An aborted model call is recorded with `status: "aborted"` and whatever usage the provider
returned; a resumed call gets a new `callId`. This shows the cost of a pause and prevents
double counting. A tool that finished before the pause is recorded normally (`status: "ok"`).

### 5.5. Derived views (future UI)

Pure functions over the journals + telemetry:

- `sessionSummary` — id/title, started/ended, active/paused/idle duration, utterance count,
  units by type, totals and cache ratio;
- `unitStats(unitId)` — type, turns, states (L1), per-state duration/tokens, tools, changed
  files, outcome;
- `contextTimeline` — context snapshots and provider input tokens per turn/agent;
- `usageTotals` — input/output/reasoning/cached, cost, cache hit ratio.

The menu/palette and the panel layout are a **separate** plan.

## 6. Non-goals / deferred

- the status panel, menu rendering, key-binding polish;
- force-kill of a mutating tool (a second interrupt that kills the child and records
  `killed by SIGINT` + partial `mutate`);
- persistence and multi-session storage (keys are designed for it, storage is not);
- simplifying the `read` unit into a plain observation (separate decision);
- `revise`, resuming an already traversed (completed or unfocused) unit, pins, `attempt`.
  Resuming a traversed unit is done neither by copying nor by continuing its IR: it is a new task
  that the session agent formulates afresh from the user's request and the later dialogue. It may
  ask for clarification or report that the work is already done; the old unit stays only as a
  trace. The session operation and the new formulation are part of a separate slice;
- live/bench runs without the owner's explicit go-ahead.

## 7. Work order

1. **Docs.** This plan, its RU mirror, the index entry, and the §3 rewrite in
   `session_concepts.md`/`_ru.md`.
2. **Cancellation mechanism.** Implement cancellation of a model request (a possible option is
   `AbortSignal`, §4.1.1); thread cancellation through the three model adapters; classify it as
   paused, never `llm_error`. Tools are untouched.
3. **Resumable loops.** Pause checks and `paused` results in `runAgent`, `runSessionUnit` and
   `runRequestObserver`; commit the journal tail at pause; observer `try/finally` and trigger
   dedupe.
4. **Task snapshot and rollback.** Move the existing store from `tests/sandbox/checkpoint.ts`
   into a production module without rewriting it (keep the hardlink clone, the delta and the
   signature cache) and wire `checkpoint`/`restoreCheckpoint` into `fsWorkspace`; take the snapshot
   at task entry; keep its id; restore the full tree on cancel; write the `rollback` event; show a
   warning when no snapshot exists; clean the store at session boundaries. Add a full-tree
   restore (`restoreTree`) to the store if needed.
5. **Driver/REPL.** `paused` in `SessionTurnResult`; `resumeTurn`/`cancelTurn`; the pause menu; the
   no-rollback warning; the CLI key mapping.
6. **Telemetry.** Types and sink; instrument model usage/timing, tool timing and context
   snapshots; add the pure derived views. No UI.
7. **Tests and docs.** The offline suite, the status update in the as-built docs.

Slices 2–5 are interruption; slice 6 is observability. They can land as separate commits, but
step 6 must not require re-touching the loop boundaries established in 3–5.

As a separate small change (before verifying the session cache in §4.2.2), remove L0 truncation
and make it append-only. Without it the requirement "the session cache is not dropped on a task
transition" does not hold.

## 8. Test invariants

- **No IR change on pause.** Pause and resume write no `Event` to a task unit and no session
  event; a state never closes; `pending` is untouched.
- **Cancel and the journal.** Cancel writes no session event and closes nothing. With a snapshot
  it appends exactly one `rollback` event to the task journal; without a snapshot it writes none.
- **Step boundary.** A task paused after a tool call resumes at the next turn without
  re-executing the committed tool; a model call aborted by the pause is re-proposed on resume.
- **Stable prefix.** Resume passes the committed journal verbatim; the rendered prefix before the
  new events is identical; `probe` and constraints are not re-added.
- **Mutating tool.** A pause requested while a mutating tool runs lets it finish; its result and
  `mutate` are recorded before the pause.
- **Session.** A paused interpretation resumes from its committed journal; a cancel leaves the
  unit without an operation and `suspended` by derivation.
- **Observer.** A paused observer resumes without duplicating the trigger; its reaction is
  applied once; cancel pops the observer and the task and rolls back the task.
- **Cancel.** Focus returns to the session level; the popped units remain addressable and are
  not closed. With a snapshot the world is fully restored, and changes made by anyone else during
  the task are reverted too (accepted). Without a snapshot the world is unchanged, a warning is
  shown, and no `rollback` event is written.
- **Snapshot.** Taken at task entry; lives until session end; used only when an open task is
  cancelled; physically cleaned at session boundaries, not after each task.
- **Past unit.** Resuming an already traversed unit neither copies nor continues its IR; a new
  task with a newly formulated request is created, and the old unit stays a trace.
- **Abort classification.** A provider abort during a pause yields `paused`, not `llm_error`.
- **Telemetry.** Usage/timing are recorded per call with stable keys; an aborted call is
  `aborted`; context snapshots are deterministic; no telemetry appears in `project`/the tape.
- **Menu.** `Esc` pauses; `Ctrl-C` opens the menu with `c` selected; `Enter` or `c` cancels,
  `r` resumes, `q` or a second `Ctrl-C` exits; a cancel at the session prompt returns to the
  message prompt.

## 9. Acceptance criteria

- Interruption pauses a session interpretation, a task and an observer with the same rules.
- Resume continues from the committed journal; no committed step is re-executed.
- Cancel returns to the session prompt; nothing is closed. With a snapshot the world is fully
  restored and a `rollback` event is written to the task journal; without a snapshot the world is
  unchanged and a warning is shown.
- Typecheck and the offline suite are green; no live/bench run is made.
- The telemetry contract is exercised by offline tests; the panel is not built.

## 10. Open questions

- **Session title.** Deterministic truncation vs an LLM title; when it is generated.
- **Context-window overflow with a full L0.** L0 is not truncated; if the full L0 exceeds the
  model's context window, that is a separate problem (an explicit warning or error), not a reason
  to introduce truncation.
- **Undo of a completed task.** This slice cancels and rolls back only an open task; undoing a
  finished task needs a separate undo/revert operation.

## 11. Rollback

- The cancellation mechanism, the resumable loops, the task snapshot and rollback, the driver/REPL
  pause and the telemetry hooks land in separate commits.
- Removing them restores the current behaviour: `runAgent`/`runSessionUnit` without pause,
  the REPL without a pause mode, and no telemetry sink.
- No journal migration is needed: pause/resume write no IR events, and cancel appends only a
  `rollback` event to the task journal.
