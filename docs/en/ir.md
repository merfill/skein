# Skein — the IR: model and context

> Russian mirror — `docs/ru/ir.md`.
>
> This is the conceptual model of the IR. The formal operator registry, the detailed tool tables,
> the refusals and the coverage matrix are in `ir_operations.md`. The message tape is in
> `projection.md`; the work states in `states.md`; the agents and their memory in
> `sessions.md`.

## 0. What the IR is

The IR is a typed journal and the views derived from it:

```
actions ─▶ journal (Event[]) ──fold──▶ State ──project──▶ Context ──▶ model
   ▲                                                       │
   └──────────── proposal: tool calls for one turn ◀────────┘
```

- The **journal** is the record of what happened. It only grows; entries are never rewritten.
- The **state** is `fold(journal)`: records, relations, the current focus and file versions.
- The **context** is `project(state)`: the message tape the model reads on the next turn.

The journal is monotone; the context is not. The context is rebuilt from the journal on every
turn, so content can leave the tape when it is no longer relevant while remaining in the journal
by address.

## 1. How the system works

### 1.1 The session

A session is an ordered container of units. A **unit** is one IR with its own root and journal; the
session journal records the units in the order they appear. The main unit types are:

- a **reply** — a user utterance and the session agent's answer or operation;
- a **general task** — an investigation that answers a question without changing the workspace;
- a **coding task** — a request that changes the workspace;
- **plan development** — a read-only unit that returns an ordered list of items; the items are
  executed as ordinary units later;
- **a document** — one large text artifact written section by section; the executor owns the
  section plan and the file.

An **observer** unit is a service unit opened when a task is stuck; it is not shown in the session
trace.

The session agent sees the trace of each unit: its id and type, the request or utterance, the
result, the status, and the answer or operation. It does not see the details and has no tools to
open a unit or read its states and turns. The session journal also records push/pop,
suspend/resume/abandon, operations, refusals, no-decision turns and observer triggers.

The session agent chooses one of five operations: `respond` answers from the dialogue, `general`
delegates an investigation, `task` opens a coding task with a self-contained work order, `plan`
opens a plan-development unit, and `document` opens a document unit. The operation is recorded in
the session journal; the opened unit keeps its own journal.

### 1.2 A coding task

A coding task is one request and its states. The task agent receives only the work order; it does
not see the session tape.

- A request is the root of the task journal.
- A state (`move`) is a frame of work: the model names it, and the state kind supplies the goal,
  the completion condition, the instruction and the tool surface.
- The model works the state in ordinary ReAct turns: each tool call is an action, and its outcome
  is recorded as an observation or a file mutation.
- When the model closes the state with a plain text reply, the executor records a `stop`; the next
  state is then chosen from the admissible transitions.
- The terminal state (`end`) ends the run.

A state is never a turn, and a turn is never a state. A state's turns hang directly off its `move`;
the first `apply` creates the list and appends the first action. A state is closed only by the
model's text reply, recorded as `stop`.

### 1.3 The general task

The general agent handles a question that requires reading and analysis but no change to the
workspace. It works one request with read-only tools and returns an answer. The unit has no `move`:
its tape hangs off the request. It is closed by the model's text reply, recorded as the request's
`stop`; the session sees a trace with the answer.

### 1.4 A document

A document unit produces one text file section by section. In a gather phase it may inspect with
read-only tools and then submits an outline (the target path, the document title and an ordered list
of section briefs); the write phase offers no tools, so it replies with one section body at a time
as plain text. The executor writes the title as `# …`, appends each body under `## <section>`, and
decides when the unit is done: after the last section it asks for a short summary and records the
request's `stop`. The unit has no `move` and no tool argument carries the file.

### 1.5 The observer

The observer is opened by a deterministic trigger when a task repeats a state, spends too long in
one state, or approaches its turn budget. It reads the state tape — the request, the turns, the
reasoning and the observations — and returns a hint, a memo or a halt. It never edits the task.
Observer units are service units and are not shown in the session trace.

## 2. States and transitions

A state is not a step or a command. It is a frame of work with a known boundary and a declared
goal. Every state has five parts:

1. a **subject** — the object or situation the state works on, recorded by the model as an
   unverified note when it enters the state;
2. a **goal** — the kind of work the state performs;
3. a **completion condition** — the observable condition rendered to the model as `Done when`;
4. an **instruction** — how to act within the state, rendered as `Plan`;
5. a **tool surface** — the tools admissible in that state.

The model names the state with `move`. The state kind supplies the goal, the completion condition,
the instruction and the tool surface. The state is open until the model replies with text; the
executor records that reply as the state's `stop` and the state becomes finished. The executor does
not decide when a state is finished and does not evaluate the reply.

After a state is finished, the model chooses the next state from the admissible transitions. The
terminal state (`end`) has no turns and ends the run when it is closed. A request with no state may
be declined; the executor records `unactionable` and the run ends.

States are flat: every `move` is a child of the request, never of another state. The current state
is the last `move` child of the request. The events `descend` and `return` record entering a state
and leaving it behind; they are not a stored nesting structure.

If a model call fails persistently, the executor closes the failed state with an error-marked
`stop`, enters the terminal state and writes the final report there. The run then reports
`abandoned`, not `completed`.

## 3. Records and relations

The journal stores records:

| Kind | Role |
|---|---|
| `request` | the initial text and the root of a unit |
| `move` | a state opened by the model, with an optional note (`what`) |
| `turns` | the ordered list of a state's turns |
| `action` | one tool call |
| `observation` | what the command returned |
| `stop` | the model's closure of a state, recorded by the executor |
| `unactionable` | a request declined as not actionable |
| `constraint` | a path restriction seeded at the start |
| `fact` | an executor-owned session fact, such as the environment probe |
| `hint` / `memo` | advice from the observer; not knowledge about the task |
| `plan` | the plan header of a plan-development unit |
| `plan_item` | an ordered plan item (`title`, `detail`, `done`) |
| `file` | a referenced file, produced by `mutates` |

The relations are:

| Owner | Relation | Target |
|---|---|---|
| `request` | `move` | `move` |
| `request` | `unactionable` | `unactionable` |
| `move` | `turns` | `turns` |
| `move` | `stop` | `stop` |
| `turns` | `turn` | `action` |
| `action` | `result` | `observation` |
| `action` | `mutates` | `file` |
| a plan unit's `move` | `plan` | `plan` |
| `plan` | `plan_item` | `plan_item` |

```
request --move--> move --turns--> turns --turn--> action --result--> observation
                                                     \--mutates--> file
```

Children are ordered by addition; the current child is the last one. A state's closure is stored on
its `move`, in the relation `move.stop`. A `file` is the only record that several actions may point
to.

`plan` and `plan_item` are session-level artifacts, not states: `fold` keeps them out of the
ordered `move`/`turn` children, and a plan is never rewritten — a rework opens a new `plan` unit.

The full payloads and per-tool behaviour are in `ir_operations.md`.

## 4. Context and traces

The request leads the tape on every turn. It explains why the task exists, but the open state's goal
is the only active goal for the turn.

- While a state is open, the tape shows `Start state`, its brief, its turns and a working prompt
  with `Goal`, the model's earlier guess, `Done when`, `Plan` and the request marked as reference.
- When the state closes, its brief and turns leave the tape. Only `Start state` and
  `Finish state — <result>` remain, with an `Artifacts:` line when the state wrote files.
- When a unit finishes, its trace remains on the session tape: what was asked, how it ended, the
  status, and the answer or operation.

Nothing is lost through this elision. Every action, observation and file version remains in the
journal, addressed by id, and can be retrieved with `recall` or `search`.

The same principle operates at two levels: closed states collapse to a trace inside a task, and
completed units collapse to a trace in the session. The projection keeps the skeleton of what
happened and removes the detail until it is requested. This is the mechanism that keeps the context
compact without making the history incomplete.

File knowledge is versioned. A read records the version it observed; a mutation makes facts about
earlier versions stale without rewriting them. Staleness is a derived relation, not a stored flag.

## 5. Journal and determinism

The event vocabulary is closed: `add_node`, `add_edge`, `descend`, `return`, `mutate`, `revert`,
`rollback` and `record_rejection`. A change of state is a new event — a `move` record, an
observation, a mutation or a closure — never an edit.

The same events and parameters yield one state and one context. The only external source is a
change of files, and such a change enters through `mutate`. Before each projection the executor
reconciles active file references with the filesystem, and any drift becomes a `mutate`.

## 6. Invariants

1. The journal only grows, and records are never rewritten; only the view changes.
2. The projection is deterministic: the same events produce the same context.
3. A state is closed only by the model's text reply, recorded as `stop`; closure does not depend
   on a separate check or an exit code.
4. The model chooses the state, the tool calls and the moment of closure; the executor executes and
   records them and checks structural preconditions, not the content of the choice.
5. The exit code of a command is an ordinary observation.
6. Every `move` is a child of the request and may carry its own note (`what`). Turns hang off the
   `move`, and every action is exactly one turn of that state. A state is never a turn.
7. `stop` is a relation on the `move`, never a turn.
8. The turns of a closed state leave the tape; only `Start state`, `Finish state` and the optional
   `Artifacts:` line remain.
9. The `state` of a `move` is a label authored by the model. It does not close a state. It delimits
   the action surface of the open state; a tool outside that surface is refused with
   `not_in_state`, but the model can always leave the mode by a `move`.
10. The request ends when the terminal state is closed or when the request is declined. There is no
    `stop` on the request.
11. A command that did not run leaves an action and an observation with a reason. A structural move
    that is not admissible is refused without creating a record.
12. The structural relations form a directed acyclic graph, and a forest on the structural part.
13. Secrets reside only in `.env`; small results may be inlined, but secrets never are.

## 7. Non-goals

The IR has no abstract syntax tree, no symbol table, no embeddings, no constraint solver, no
arithmetic, no user interface and no criterion gate. There are no `check`, `claim`, `decision` or
`subgoal` kinds.

## 8. Where to read more

- `ir_operations.md` — the model surface, operators, tool tables, refusals and coverage registry.
- `projection.md` — the message tape in detail.
- `states.md` — the goal and completion condition of each state.
- `sessions.md` — sessions, units and the agents of those units.
- `walkthrough.md` — a worked example across states.
