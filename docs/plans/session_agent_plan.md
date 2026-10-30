# Tier 4b — SessionAgent: attention statuses, L0/L1 outline, session operations

> Russian original — `docs/plans/session_agent_plan_ru.md`.
>
> Status: **first slice implemented** (statuses, L0/L1, session unit + `SessionAgent`,
> `respond`/`start`, tools `read`/`unit`/`state`/`turns`/`body`/`search`; `attempt` deferred). Out of
> scope: the multi-utterance driver, the reading island, pins, `revise`, user interruption, live
> runs.
>
> **The operation vocabulary was revised:** only `respond` and `start` are exposed;
> `resume`/`cancel`/`redirect` were removed from the model (`resume` is a future strategy,
> `cancel` is not an operation). The sections below keep historical fragments with the old
> vocabulary.

## 1. Goal

Add the session as a first-class unit of work: the engine can carry several task units in one
session, deterministically outline them, and interpret a free-form utterance as a **session
operation** proposed by a `SessionAgent` and checked/applied by logos.

The task-tree semantics do not change: a unit journal only grows, a state is closed only by the
doxa's `stop`, the projection is deterministic. Session statuses are attention, not truth; the
session unit never writes `move`/`stop`/`plan` into a task tree.

## 2. Fixed inputs

- `docs/session_concepts.md` §2 (units, session, stack, pending, two statuses), §4 (the
  SessionAgent and its operations), §5 (the L0–L4 outline), §7 (invariants), §10 (minimal next
  step: L0/L1 + `respond`/`start`; the other operations are deferred).
- `docs/controllability.md` §1.4/§2: the agent unit is the same mechanism as the RequestObserver
  — its own journal, a different root and vocabulary, read-only outline tools, proposals checked by
  logos.
- The as-built 4a carrier: `src/session/types.ts`, `session.ts`, `observer.ts`; the seeded outline
  is an engine-origin journal event, not a transient render.
- Invariants: journals are append-only; `project` is deterministic; closure is only through
  `stop`; no verdicts or stored truth statuses; `abandoned` does not close a state.

## 3. Scope

**In:**

- attention statuses in the session journal: `suspend`, `resume`, `abandon`; `completed` is derived;
- a deterministic hierarchical outline **L0 (session)** and **L1 (unit)** with explicit
  truncation (`k more` + cursor);
- the session unit and the `SessionAgent`: a bounded loop with its own prompt, the utterance as the
  root, read-only outline tools, and one operation per run;
- the operations `respond` and `start`: logos checks the preconditions and applies them as
  session events; task journals are untouched;
- offline tests and the as-built docs update after implementation.

**Out:**

- the multi-utterance driver (utterance → operation → launch/resume a task unit);
- `revise`, `query`, pins and the reading island;
- user interruption, live/bench runs without an explicit go-ahead;
- similarity/RAG and any second engine: the session unit is the same mechanism as 4a.

## 4. Target architecture

### 4.1. Attention statuses

`src/session/types.ts` adds to the session journal:

```ts
| { type: "suspend"; unitId: string; turn: number }
| { type: "resume"; unitId: string; turn: number }
| { type: "abandon"; unitId: string; turn: number }
| { type: "operation"; unitId: string; turn: number; operation: SessionOperation }
```

`SessionOperation` is a closed union:

```ts
| { kind: "respond"; text: string }
| { kind: "start"; text: string }
```

`src/session/session.ts` gains `suspendUnit`, `resumeUnit`, `abandonUnit`, `recordOperation`, and
`attentionOf(session, unitId)`. The status is **derived from the journal**, never stored as a
field:

- `abandoned` — the last attention event for the unit is `abandon`;
- `completed` — the unit is terminal by its own journal (a task whose request ended: the terminal
  state is stopped or the request is `unactionable`; a session unit whose operation was recorded)
  and it is not `abandoned`;
- `active` — the unit is the focus (the top of the stack);
- otherwise `suspended`.

`abandon` and `suspend` write only the session journal; no task event, no `stop`, no state change.
The unit-open/closed fact stays a fact of the unit journal.

### 4.2. L0/L1 outline

`src/session/session_outline.ts`:

- `sessionOutline(session, options)` — **L0**: one line per unit (id, type, request label, session
  status, how it ended). The focus is always shown; the rest is the last `k` units. Truncation is
  explicit: a `k more (before <unitId>)` line plus a cursor, never a silent cut.
- `unitOutline(session, unitId)` — **L1**: the unit's states (`move`), each with island, authored
  `what`, closed?, and `stop.why`; source — `fold(unit.journal)` and the existing traversal helpers.
- "Result" is a terminal marker, not a verdict: `stop.why`, `unactionable.why`, `open at <state>`,
  `suspended at <state>`, `abandoned at <state>`.

The outline is a pure function of the session journal + unit journals; the same events give the
same text. Unit journals of `observer` units never appear at L0/L1.

### 4.3. Session unit and SessionAgent

`src/session/session_agent.ts` mirrors `src/session/observer.ts`:

- `SESSION_BASE_PROMPT`: who the agent is, when to answer instead of starting work, how to
  reformulate a task, and when to clarify or ask for confirmation.
- The root is the user utterance: the session unit journal records it as a `request` node; the
  projection renders it as the leading `user` message.
- The engine seeds the unit journal with an `outline` call + `tool` result (`origin: "engine"`),
  exactly as 4a seeds the RequestObserver.
- The loop is bounded (default 4 turns), one operation per run. Read-only calls are executed and
  written to the session unit journal with `origin: "doxa"`/`"engine"`; a proposal that logos
  refuses is recorded in the session unit journal, not in a task journal.
- `projectSessionAgent` / `buildSessionMessages` rebuild the tape from the unit journal; a replay
  reads the seeded outline instead of re-running it.
- `runSessionAgent(deps, session, utterance, options) → { session, operation?, applied?, turns }`
  opens/pushes the session unit, runs the loop, pops it, and applies the operation through logos.

`src/llm/session_agent.ts` is the AI SDK adapter (zod schemas + `createSessionAgentDeps`), in the
same shape as `src/llm/observer.ts`. Tools:

| Tool | Kind | Arguments |
|---|---|---|
| `read` | read-only | `{ path }` — creates a reading unit and returns a preview + address |
| `unit` | read-only | `{ id }` (L1) |
| `state` | read-only | `{ unit, id }` (L2) |
| `turns` | read-only | `{ unit, id, from?, to? }` (turns + reasoning) |
| `body` | read-only | `{ unit, id, start?, end? }` (L4) |
| `search` | read-only | `{ unit, pattern, before?, after?, from?, count? }` (L4) |
| `respond` | operation | `{ text }` |
| `start` | operation | `{ text }` (the reformulated request) |

L0 is on the tape: there is no separate `outline` tool. `attempt` (L3) is deferred. The survey
budget is `surveyLimit` (default 4) with a "Decide now" message.

### 4.4. Operations and logos

`src/session/operations.ts` — `validateOperation(session, operation)` and
`applyOperation(session, operation, turn)`:

| Operation | Admissible when | Effect |
|---|---|---|
| `respond` | always; non-empty text up to 2000 chars | records the operation and reasoning; task trees unchanged |
| `start` | non-empty text up to 4000 chars | pops the current focus, puts the text into `pending`; a future driver opens the new request |

Every applied operation is recorded as an `operation` event on the session journal; the source
session unit's journal keeps only its own calls and observations. A refusal is recorded as a
`refusal` event (operation, reason, reasoning) in the session journal and shown in L0; the task
tree does not change.
`start` does not close the previous unit: it remains a trace; `suspended`/`completed` are derived
statuses.

## 5. Work order

1. **Plan doc.** This file + the RU mirror; index entry in `docs/README.md`.
2. **Statuses.** `types.ts`/`session.ts`; `attentionOf`; tests for append-only, derived
   `completed`, `abandon` not closing a state.
3. **Outline.** `session_outline.ts`; L0/L1, truncation/cursor; determinism and replay tests.
4. **Operations.** `operations.ts`; preconditions and refusals; task journals untouched.
5. **Session unit and agent.** `session_agent.ts`, `llm/session_agent.ts`; seeded outline, bounded
   loop, one operation per run; integration tests with a scripted agent.
6. **Docs.** Update the status in `docs/session_concepts.md`, `implementation_plan.md`; final
   offline run.

## 6. Test invariants

- **Session:** the journal only grows; `focus` is the stack top; statuses are derived; a unit
  closed by `stop` is `completed` unless `abandoned`; `abandon` writes no task event.
- **Outline:** L0/L1 are deterministic; the focus is always present; truncation is explicit with
  `k more` and a cursor; `observer` journals never leak.
- **Operations:** a refusal writes a session `refusal` event, not a task event; `respond` changes
  no unit; `start` pops the focus, leaves the old unit as a trace and puts the text into
  `pending`.
- **Session unit:** the seeded call/result have matching ids and `origin: "engine"`; a replay
  reads them from the journal; read-only tools write nothing to a task journal; one operation per
  run; a logos refusal does not break the session.
- **Projection:** deterministic; the utterance is the leading `user` turn; no task `stop`/`move` is
  created by the session unit.
- Commands: `npm run typecheck`;
  `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'`.

## 7. Acceptance criteria

- Typecheck and the offline suite are green; the tests cover §6.
- The session unit writes no `move`/`stop`/`plan` into any task tree.
- Statuses are derived from journals; nothing stores a verdict.
- L0/L1 are bounded and deterministic; the same session gives the same outline.
- An operation is applied only after the logos check; a refusal is visible and harmless.
- No live/bench run is made.

## 8. Open questions

- **Driver.** This slice stops at `runSessionAgent`; the utterance → operation → task-run loop is
  the next step.
- **`respond`.** The answer is recorded in the session journal and shown in the L0 trace.
- **L0.** Shown in full; when the context overflows there is an explicit warning.
- **`revise`.** Deferred: a user fact attached to a unit/state.
- **Session unit vocabulary.** The bounded loop is used instead of a full `survey/interpret/decide`
  state machine; this mirrors 4a and can be replaced by the same IR later.

## 9. Rollback

- Statuses, outline, operations and the session agent land in separate commits.
- Removing them leaves the 4a session container intact; `runAgent` is untouched.
- No journal migration is needed: new session events appear only in new sessions.
