# Skein — a coding agent with a non-monotone context

> Conceptual overview. The as-built IR semantics are in `ir.md`; the context tape in
> `projection.md`; the work states in `states.md`; the agents and their memory in
> `sessions.md`. The Russian mirror is `../ru/concepts.md`.

## 1. The central idea

Most coding agents treat the model's context as a conversation log. The log grows monotonically:
every action and result is appended, and the model is expected to recover the current goal, the
relevant evidence and the phase of work from that accumulation.

Skein inverts this arrangement. The primary record is a typed, append-only IR. The context is a
**projection** of that record, rebuilt on every turn by a deterministic function. The journal only
grows; the projection does not. Content can leave the visible tape when it ceases to be relevant,
while remaining available in the IR by address.

Two consequences follow. First, the context is bounded by the current focus rather than by the
length of the history. Second, the model is not asked to maintain continuity by memory: the
executor selects what the current decision requires, and everything else remains one `recall` or
`search` away.

## 2. Agents and units

Skein separates work by the kind of result and by the scope of attention. Seven model-driven agents
cooperate, and each reads a projection of the same kind of IR.

A **unit** is one IR with its own root and journal. A session is a container of units; each agent
works in a unit of its own type — a session interpretation, a coding task, a general task, a
revision, a plan development, a document write, or an observer run.

| Agent | Scope | Responsibility | Context |
|---|---|---|---|
| Session | the dialogue | interprets an utterance, remembers completed work, routes, formulates a task | the dialogue, the traces of past units, memory tools |
| Task (coding) | one request | walks the request as a state machine and changes the workspace | only its own request and states |
| General | one non-coding request | investigates and answers without changing the workspace | its brief, project facts, read-only tools |
| Revision | one described mutable operation | edits existing files and runs the operation's commands, including side-effecting ones; not coding | its brief, project facts, workspace tools |
| Planner | one request | inspects the workspace read-only and returns an ordered plan; does not execute it | the request, project facts, read-only tools |
| Document | one large text artifact | writes one file section by section; the executor owns the plan and the file | the request, project facts, read-only tools, section briefs |
| Observer | one stuck state | diagnoses the impasse and advises the task agent | the state tape: request, turns, reasoning, observations |

The session agent is the only agent that sees the whole dialogue. It chooses among six operations:
answer from the dialogue (`respond`), delegate an investigation to the general agent (`general`),
perform a described mutable operation that is not coding (`revision`), start a coding task (`task`),
develop a plan (`plan`), or write a document (`document`). For a coding task it formulates a
self-contained work order; the task agent receives only that text and never reads the session tape
or other tasks. Continuity is therefore transferred through the formulation, not through shared
history.

The general agent handles questions that require reading and analysis but no modification. It
uses inspection tools and a read-only shell; the executor restores any accidental change, so the
workspace is unchanged by contract. Its result is an answer, not a coding task.

The revision agent performs any mutable operation the request already describes, except coding: it
edits existing files and runs the commands the operation needs — adding a dependency, updating the
lock, installing a package, and other side-effecting commands. It is for a change that is given, not
for a defect whose cause must be found (that is a task). It uses the workspace tools including the
side-effecting shell and is mutable by contract.

The planner agent develops a plan: a read-only unit that inspects the workspace and returns an
ordered list of work orders. It neither changes the workspace nor executes the items; the plan is a
session-level artifact, and execution opens ordinary units per item.

The document agent writes one large text artifact (a document, report or spec) section by section.
It first submits an outline with the target path and the section briefs, then replies with one
section body at a time as plain text; the executor appends each section and decides when the unit
is done. No tool argument carries the file, so a large section cannot be cut into invalid JSON.

The observer is an advisory agent. When a task repeats a state, spends too long in one state, or
approaches its turn budget, a deterministic trigger runs the observer on the tape of that state.
The observer returns a short hint, a unit-scoped memo, or a halt; it never edits the task. The
observer is optional and enabled by configuration.

## 3. The non-monotone tape

The IR is monotone: events are appended and nodes are never rewritten. The tape is not.

- While a state is open, the tape shows the `Start state` marker, the brief for that state, its
  turns — the model's tool calls and the executor's observations — and, after the turns, a working
  prompt with the state's `Goal`, the model's earlier guess about the subject, its `Done when`
  criterion, its plan and the request marked as reference.
- When the state closes, its brief and turns leave the tape. Only `Start state` and
  `Finish state — <result>` remain, the latter carrying a short record of what the state
  achieved.
- When a task, general or document unit finishes, a trace remains on the session tape: what was
  asked, how it ended, its status, and the answer or the operation that produced it.

Nothing is lost through this elision. Every action, observation and file version remains in the
journal, addressed by node id, and can be retrieved with `recall` or `search`. The request always
leads the tape and is explicitly marked as reference: it explains why the task exists, but the
open state's goal is the only active goal for the turn.

The same principle operates at two levels: inside a task, closed states collapse to a trace; at
the session level, completed units collapse to a trace. In both cases the projection preserves the
skeleton of what happened and removes the detail until it is requested. This is the mechanism that
keeps the context compact without making the history incomplete.

## 4. A state defines a goal

A state is not a step or a command. It is a frame of work with a known boundary and a declared
goal. Every state has five parts:

1. a **subject** — the object or situation the state works on, recorded by the model as an
   unverified note when it enters the state;
2. a **goal** — the kind of work the state performs;
3. a **completion criterion** — the observable condition under which the state's work is done;
4. an **instruction** — how to act within the state;
5. a **tool surface** — the tools admissible in that state.

The executor renders these as `Goal`, `Done when`, `Plan` and the offered tool set. The state's goal
is the only active goal for the turn. When the criterion holds, the model replies with text and
the executor records that reply as the state's `Finish` line. Closure does not depend on the
criterion: the criterion guides the model, while closure remains the model's decision.

The live states are:

| State | Goal |
|---|---|
| Research | derive the required result from the material or the specification, and write it if the task requires it |
| Patch | find the defect in an existing artifact and make the change it needs |
| Construction | build a new artifact from the specification or from the material's behaviour |
| Verification | check the changed artifact against the check the request declares |
| End | complete the request and report the result |

This is the capability a flat ReAct agent lacks. In ReAct there is one goal — the original
request — and every phase, subgoal and completion condition exists only as prose in the growing
transcript. The model must continuously reconstruct which part of the work it is in. In Skein the
executor names the state, renders its goal and criterion at the decision point, and offers only the
tools that belong to it.

## 5. A hybrid: ReAct inside, a graph between

The system combines two control regimes.

**Within a state it is ReAct.** The model calls a tool, the executor executes it and returns the
observation, and the next decision is made from that observation. The state's turns form a
monotone list of actions and results; nothing is hidden from the model while the state is open.

**Between states it is a deterministic graph.** `move` declares the next state; a state is closed
by `stop`, after which the next state is chosen from the transitions the executor declares. The
request prompt and the transition prompt list the admissible states and the condition for each,
scoped to the choice at hand. The executor does not choose content; it constrains the admissible
moves, and the model chooses among them.

The hybrid has a practical consequence for prompt design. A state's prompt is a small, local
artifact: one goal, one criterion, one instruction, one tool surface, and the facts the state
needs. It can be written and tested against that state alone. In a single-prompt ReAct agent the
same text must serve localization, editing, verification and reporting at once; the model infers
the phase, and state-specific behaviour becomes a matter of prose emphasis rather than an explicit
contract. Here the phase is a first-class object, so its prompt has a defined scope and a
defined failure mode.

## 6. The IR in one page

A request is the root. The model moves into a state (`move`), and the state's turns hang directly
off that move. Each turn is an action and its observation; a file mutation is recorded as an
artifact relation rather than as an observation body.

```
request ──move──▶ state (turns) ──turn──▶ action ──result──▶ observation
                                             └──mutates──▶ file
```

The model has four operators: `move` declares a state, `apply` executes a tool, `stop` closes the
current state (or, at End, the request), and `decline` records that the request is not actionable.
`recall` and `search` are read-only addressing operations; they leave ordinary turns and are
therefore themselves addressable.

File knowledge is versioned. A read records the version it observed; a mutation makes facts about
earlier versions stale without rewriting them. Staleness is a derived relation, not a stored flag.
The journal remains monotone even though the knowledge it supports is not.

## 7. What this design provides

- **A compact context.** The tape carries the current state's goal, its turns and a trace of the
  work already completed. It does not grow with the whole history.
- **Explicit goals.** Each state declares what it is for and when it is done. The model does not
  infer the phase from transcript position.
- **Deterministic, testable prompts.** A state's prompt is a local artifact with a defined goal,
  criterion, instruction and tool surface.
- **Complete, addressable history.** Elided content is not deleted; it is retrieved by identifier.
- **Explicit closure.** An exit code is an ordinary observation. A state is closed only by the
  model's `stop`.

## 8. How it differs

- **ReAct.** A flat, growing transcript with one global goal, where the model decides when the
  task is over. Skein keeps the ReAct loop inside each state but adds declared goals, explicit
  transitions and a non-monotone projection.
- **Graph orchestration frameworks.** A graph usually coordinates control flow while the context
  remains a message tape. In Skein the graph is the source of the context: states, their goals and
  their results are the structure from which the tape is built.
- **Textual memory systems.** Systems in the MemGPT/Letta tradition let the model manage textual
  memory blocks; summarisation-based systems compress the tape but keep it. Skein derives typed
  state deterministically and never treats a summary as truth.
- **Retrieval by similarity.** RAG selects content by embedding similarity. Skein selects by
  structure, state and provenance, and retrieves the rest by explicit address.

## 9. Further reading

- `ir.md` — the IR model, operators, derived facts and invariants.
- `projection.md` — the message tape in detail.
- `states.md` — the goal, criterion and routes of each work state.
- `system_prompt.md` — the prompt blocks and the state prompts.
- `sessions.md` — sessions, units and the agents of those units.
- `walkthrough.md` — an end-to-end example of a task across states.
