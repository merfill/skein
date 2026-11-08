# Skein — sessions and the session agent

> Russian mirror — `docs/ru/sessions.md`.
>
> The conceptual model is in `concepts.md`; the IR and the tape in `ir.md` and `projection.md`.
> This document describes the session container, its units and the session agent.

## 1. What a session is

A session is an ordered container of units. A **unit** is one IR with its own root and journal.
The session journal records the units in the order they appear and the session-level events:
opening, push/pop, suspend/resume/abandon, operations, refusals, no-decision turns and observer
triggers.

The main unit types are:

- `session` — the interpretation of a user utterance and the answer or operation it produces;
- `general` — a non-coding task that answers a question without changing the workspace;
- `task` — a coding task that changes the workspace;
- `plan` — plan development: a read-only agent returns an ordered list of items; it neither
  changes the workspace nor executes the items;
- `observer` — a service unit opened when a task is stuck; it is not shown in the session trace.

The **focus** is the top of the unit stack. At most one unit is active. A **pending** slot holds at
most one unprocessed user utterance; a new one replaces it.

## 2. Traces and memory

The session agent sees the **trace** of each unit: its id and type, the request or utterance, the
result, the status, and the answer or operation. A refusal keeps the proposed operation, its reason
and the model's reasoning; a no-decision turn keeps its reason.

The trace is an address, not a copy. Details are reached with the read-only memory tools:

| Tool | Level | What it returns |
|---|---|---|
| `unit` | L1 | the unit's states: id, state kind, `what`, open/closed, closure reason |
| `state` | L2 | a state's turns: action, status, result id and summary |
| `turns` | turns | actions with their results and the model's reasoning |
| `body` | L4 | a stored observation body, optionally a line window |
| `search` | L4 | pattern matches inside a stored body |

The result of a memory call becomes an observation of the calling session unit and is therefore
addressable in turn. L0 is shown to the session agent in full; the terminal view may bound it.

## 3. The session agent

The session agent is the only agent that sees the dialogue. It reads the current utterance and the
traces, and chooses one of four operations:

- `respond` — answer from the dialogue and earlier work;
- `general` — delegate an investigation to the general agent;
- `task` — open a coding task with a self-contained work order;
- `plan` — open a plan-development unit: a read-only agent reads the request and the workspace and
  returns an ordered list of items.

Before opening a task, the session agent **reformulates** the request from the dialogue and the
traces: what to do now, which constraints and findings from the past matter. Confirmation by the
user is an optional interaction policy, not an IR step.

The session agent has no workspace tools. Material questions go to the general unit; workspace
changes go to the task unit. `search` remains a memory tool over stored bodies, not a workspace
search.

## 4. Isolation and continuity

The task agent receives only the work order. It does not read the session L0, other units' journals
or the history tools; otherwise the task would turn into a monotone tape and lose focus. Continuity
is transferred through the **formulation**, not through shared history.

The general agent works read-only and returns an answer stored on its stop record. It does not
produce a post-task report.

After a task finishes, the driver asks the session agent for a **report** and records it in the
same session unit that proposed the task. The report is the user-facing Markdown answer: what was
done, where, how it was verified and what remains open. It closes nothing and does not open a new
unit.

## 5. Operations

| Operation | Admissible when | Effect |
|---|---|---|
| `respond` | always; non-empty text up to 4000 characters | answers the user in GitHub-flavored Markdown; task journals are unchanged |
| `general` | there is a text up to 4000 characters | pops the current focus and opens a general unit with that text |
| `task` | there is a coding-task text up to 4000 characters | pops the current focus and opens a coding task with that text |
| `plan` | there is a text up to 4000 characters | pops the current focus and opens a plan-development unit with that text |

The executor checks the precondition and applies the operation as a session event. An oversized
text is refused: the refusal is recorded in the session journal, shown in the trace, and changes no
unit journal.

## 6. Statuses and attention

Two statuses are independent:

| Status | Source | Meaning |
|---|---|---|
| open / closed | the unit journal | closed if and only if the unit's current state has a recorded closure |
| active / suspended / abandoned / completed | the session journal | the session's attention, not truth |

`abandoned` does not close a state and writes nothing to the unit journal. `completed` is derived:
the unit is closed and not abandoned. The focus changes by push/pop, not by rewriting units.

An interpretation can end without an operation: the model returns neither a tool call nor text
(`empty_reply`), or the loop reaches its cap (`max_turns`). The session journal records the reason,
the unit stays suspended, and L0 shows `no decision: …`.

## 7. Interruption

Interruption is a **pause** at a step boundary. It is not an IR operation: it writes no event,
closes no state and changes no focus.

- A model call in flight is aborted; its proposal never becomes a fact. On resume the model is
  asked again.
- A mutating tool that is already running finishes; its result, error or signal is recorded
  honestly, and a partial file change is a `mutate`.
- The unit stays open and keeps its focus; committed turns are the resume point. Resume re-enters
  the loop from the unit's journal, so no committed step is executed twice.
- After a pause the interface offers resume, leave to the session, or cancel. Leaving drops the
  focus (the unit stays as a trace), keeps the work, writes nothing to the unit journal and derives
  `suspended`; the next utterance is interpreted by the session agent.
- Cancel is destructive: it rolls the world back to the task-entry snapshot, records a `rollback`
  and marks the unit `abandoned`, so it cannot be resumed. It does not close a state either.
- The same rules hold for the session agent, the general agent, the task agent and the observer.
  Esc is an execution interrupt, not an IR operation.

## 8. Plan execution

A plan is a session-level artifact, not a task state. The `plan` unit (read-only; `shell` is
allowed, mutations are rolled back on exit and recorded as `rollback`) writes a `plan` node and its
ordered `plan_item` nodes (title, detail, kind `general|task`, done) into its journal. The plan's
Markdown is a render of those nodes, not a second source of truth.

After the plan is developed the interface asks the user whether to execute or rework it.
Confirmation is an interaction policy, not an IR step. Rework opens a new `plan` unit (a new
version); older items are never rewritten.

On execution the driver records `plan_started` and walks the items in order. For each item the
session agent is invoked again: it sees the plan with statuses, chooses `task` or `general`, and
reformulates a self-contained work order. The item runs as an ordinary unit linked to it
(`planItem`); only the current item's work order reaches the task/general agent — never the whole
list.

An item's status is derived from its unit's journal: `completed` means the item is done;
`abandoned` stops the plan and records `plan_finished` with status `aborted`; `active/suspended` is
a pause. After the last item, `plan_finished { status, n/N }` is recorded — the special
plan-completion element in the session trace. `plan_started`/`plan_finished` are session-journal
events; the mode and cursor are derived, never stored.

## 9. The observer

The observer is an advisory service unit. A deterministic trigger opens it when a task repeats a
state, spends too long in one state, or approaches its turn budget. The observer reads the **state
tape** — the request, the state's turns, the model's reasoning and the observations — and returns
one of:

- `hint` — a short, concrete next step for the current state;
- `memo` — a note for the rest of the unit;
- `halt` — a reason to stop advising.

The observer never edits the task. Its units are service units and are not shown in the session
trace. The observer is optional and disabled by default; `SKEIN_OBSERVER=true` enables it.

## 10. Errors

A persistent model error still produces a result. The executor closes the failed state with an
error-marked closure, enters the terminal state and writes the final report there; if the report
call also fails, the report falls back deterministically to the `Finish` lines. The task unit is
then `abandoned`, not `completed`.

## 11. Non-goals

- No similarity search or RAG: selection is by structure and declared rules.
- No summary as truth: a trace is an address and a short fact, not knowledge.
- No task access to other units or to the session L0: isolation is deliberate.
- No second implementation: a session unit is the same IR as a task.
