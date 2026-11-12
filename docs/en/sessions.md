# Skein — sessions and agents

> Russian mirror — `docs/ru/sessions.md`.
>
> The conceptual model is in `concepts.md`; the IR and the tape in `ir.md` and `projection.md`.
> This document describes the session container, its units and the agents of those units.

## 1. What a session is

A session is an ordered container of units. A **unit** is one IR with its own root and journal.
The session journal records the units in the order they appear and the session-level events:
opening, push/pop, suspend/resume/abandon, operations, refusals, no-decision turns and observer
triggers.

The main unit types are:

- `session` — the interpretation of a user utterance and the answer or operation it produces;
- `general` — a non-coding task that answers a question without changing the workspace;
- `revision` — performing any mutable operation the request describes on the existing workspace,
  except coding: edits and commands, including side-effecting ones;
- `task` — a coding task that changes the workspace;
- `plan` — plan development: a read-only agent returns an ordered list of items; it neither
  changes the workspace nor executes the items;
- `document` — writing one large text artifact section by section: the executor owns the section
  plan and the file, the model supplies the section bodies;
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

`general`, `revision`, `plan` and `document` have one state anchored on the request: its id is the
unit id, and `state`/`turns` work with it as with any other state.

The result of a memory call becomes an observation of the calling session unit and is therefore
addressable in turn. L0 is shown to the session agent in full; the terminal view may bound it.

## 3. The session agent

The session agent is the only agent that sees the dialogue. It reads the current utterance and the
traces, and chooses one of six operations:

- `respond` — answer from the dialogue and earlier work;
- `general` — delegate an investigation to the general agent;
- `revision` — perform a mutable operation the request already describes (edits plus commands);
- `task` — open a coding task with a self-contained work order;
- `plan` — open a plan-development unit: a read-only agent reads the request and the workspace and
  returns an ordered list of items;
- `document` — open a document unit that writes one large text file section by section.

Before opening a task, the session agent **reformulates** the request from the dialogue and the
traces: what to do now, which constraints and findings from the past matter. Confirmation by the
user is an optional interaction policy, not an IR step.

The session agent has no workspace tools. Material questions go to the general unit; a described
mutable operation goes to the revision unit; work whose cause or approach must be found goes to the
task unit. `search` remains a memory tool over stored bodies, not a workspace search.

## 4. Isolation and continuity

The task agent receives only the work order. It does not read the session L0, other units' journals
or the history tools; otherwise the task would turn into a monotone tape and lose focus. Continuity
is transferred through the **formulation**, not through shared history. The order is written in the
user's language and keeps its scope, so the unit's answer comes back in that language.

After a task finishes, its End state writes the **report** — the task's own closing reply, which is
the user-facing Markdown answer: what was done, where, how it was verified and what remains open.
The session records that result in the session trace; it does not ask for a second report and does
not open a new unit. Keep the report as short as the result allows and add detail only when the user
asked for it.

## 5. Operations

| Operation | Admissible when | Effect |
|---|---|---|
| `respond` | always; non-empty text up to 4000 characters | answers the user in GitHub-flavored Markdown; task journals are unchanged |
| `general` | there is a text up to 4000 characters | pops the current focus and opens a general unit with that text |
| `revision` | there is a text up to 4000 characters | pops the current focus and opens a revision unit with that text |
| `task` | there is a coding-task text up to 4000 characters | pops the current focus and opens a coding task with that text |
| `plan` | there is a text up to 4000 characters | pops the current focus and opens a plan-development unit with that text |
| `document` | there is a text up to 4000 characters | pops the current focus and opens a document unit with that text |

The executor checks the precondition and applies the operation as a session event. An oversized
text is refused: the refusal is recorded in the session journal, shown in the trace, and changes no
unit journal.

## 6. Statuses and attention

Two statuses are independent:

| Status | Source | Meaning |
|---|---|---|
| open / closed | the unit journal | closed if and only if the unit records a closure (`stop`) on its current state or on its request |
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
- The same rules hold for the session agent, the general, task, plan and document agents and the
  observer. Esc is an execution interrupt, not an IR operation.

## 8. Plan execution

A plan is a session-level artifact, not a task state. The `plan` unit is strictly read-only: it
inspects with `read`/`grep`/`list`/`recall`/`search`, has no shell and no write tools, and any
off-surface tool call is refused, never executed. It writes a `plan` node and its
ordered `plan_item` nodes (title, detail, done) into its journal. An item is a work order, not a
classification: the planner does not choose the operation. The plan's Markdown is a render of those
nodes, not a second source of truth.

After the plan is developed the interface asks the user whether to execute or rework it.
Confirmation is an interaction policy, not an IR step. Rework opens a new `plan` unit (a new
version); older items are never rewritten.

On execution the driver records `plan_started` and walks the items in order. For each item the
session agent is invoked: it sees the plan with statuses and the earlier items' results, chooses
the operation (`revision`, `task`, `general`, `document` or `plan`), and reformulates a
self-contained work order. The item runs as an ordinary unit linked to it (`planItem`); only the
current item's work order reaches the unit's agent — never the whole list.

An item's status is derived from its unit's journal: `completed` means the item is done;
`abandoned` stops the plan and records `plan_finished` with status `aborted`; `active/suspended` is
a pause. After the last item, `plan_finished { status, n/N }` is recorded — the special
plan-completion element in the session trace. `plan_started`/`plan_finished` are session-journal
events; the mode and cursor are derived, never stored. There is no separate acceptance pass: the
plan is done when the last item's unit closes. An item's `done` note is the work order's own check,
carried into the unit by the session agent rather than re-judged after the fact.

## 9. The general agent

The general agent answers a question that requires reading and analysis but no workspace change. It
works on one request with the read-only tools (`read`, `grep`, `list`, `recall`; `shell` only for
read-only commands) and the deterministic project facts. It has one state anchored on the request:
`move` is not used, the unit's tape hangs off the request, and there are no state transitions. The
model closes it with a text answer, recorded as the request's `stop`; the session sees the trace
with the answer. The general agent does not write a post-task report and does not open further
units.

## 10. The revision agent

The revision agent performs any mutable operation the request already describes, except coding: it
edits existing files and runs the commands the operation needs — adding a dependency, updating the
lock, installing a package, and other side-effecting commands. It is for work whose change is given,
not for a defect whose cause must be found (that is a task).

It has one state anchored on the request: `move` is not used, the tape hangs off the request, and
the model closes it with a text reply recorded as the request's `stop`. It works with the workspace
tools, including the side-effecting `bash`; unlike the general agent it is mutable, so it has no
read-only snapshot and no rollback. The same unit is opened directly by the `revision` operation and
by a plan item the session agent routes to it.

## 11. The document agent

The document agent produces one text file (Markdown by default) in the request's language, writing
it section by section. The unit has one state anchored on the request: `move` is not used, the tape
hangs off the request, and the executor decides when it is done.

1. **Gather.** The agent inspects the material with the read-only tools (including `webfetch`): it
   has 10 inspection steps, then a warning with 3 more, then the executor forces `start_document`.
   It calls `start_document` once with the target `path`, a short document `title`, and an ordered
   list of sections, each a title and a self-contained brief. That JSON fixes the number of
   sections. The plan stays around the request (only information directly related to it). The
   writer has no tools, so each brief must carry the facts its section needs; briefs stay within
   the file's subject.
2. **Write.** For each item the executor asks for one section and offers no tools; the agent
   replies with the Markdown body only, and the executor writes `# <title>` before the first
   `## <section>`. A tool-call reply is discarded and retried, never written. A body cut by the
   output cap is continued by a bounded follow-up request. The body is plain text, never a tool
   argument, so a large section is not a truncated JSON string.
3. **Summary.** After the last section the agent writes a short summary from the plan and the file;
   the executor records it and closes the unit with the request's `stop`.

The model never emits the whole file at once and never chooses when to stop: the executor walks the
outline. The same unit is opened by the `document` operation — both directly and from a plan item
the session agent routes to it.

## 12. The observer

The observer is an advisory service unit. A deterministic trigger opens it when a task repeats a
state, spends too long in one state, or approaches its turn budget. The observer reads the **state
tape** — the request, the state's turns, the model's reasoning and the observations — and returns
one of:

- `hint` — a short, concrete next step for the current state;
- `memo` — a note for the rest of the unit;
- `halt` — a reason to stop advising.

The observer never edits the task. Its units are service units and are not shown in the session
trace. The observer is optional and disabled by default; `SKEIN_OBSERVER=true` enables it.

## 13. Errors

A persistent model error still produces a result. The executor closes the failed state with an
error-marked closure, enters the terminal state and writes the final report there; if the report
call also fails, the report falls back deterministically to the `Finish` lines. The task unit is
then `abandoned`, not `completed`.

## 14. Non-goals

- No similarity search or RAG: selection is by structure and declared rules.
- No summary as truth: a trace is an address and a short fact, not knowledge.
- No task access to other units or to the session L0: isolation is deliberate.
- No second implementation: a session unit is the same IR as a task.
