# Skein — sessions: memory and the session agent

> Russian original — `docs/session_concepts_ru.md`.
>
> Status: **partially implemented**. The session container and the first 4b slice are in place:
> attention statuses, the L0/L1 outline, the session unit with `respond`/`start`, the memory
> tools `read`/`grep`/`list`/`probe`/`unit`/`state`/`turns`/`body`/`search`, reading units, the
> `runSessionTurn` driver, the REPL and the CLI. The synthetic live scenario passed; session
> persistence, Ctrl-C, resume strategies, `revise`, pins and `attempt` are the next steps.
>
> Builds on: `concepts.md` (doxa/logos, projection), `ir_semantics.md` (the IR, operators,
> invariants), `projection.md` (the tape).

## 1. The task and the idea

### 1.1. How it works now

One Skein run is one **request**. The request is the root of the tree; the engine walks it as a
sequence of states and ends when the terminal state is closed or when the request is declined.
The next user message starts a new run from scratch: the previous tree is not read.

Memory inside one request works like this:

- the request text is shown to the model on every turn and leads the tape;
- the actions and results of an open state are visible while it is open;
- when a state is closed through `stop`, its turns leave the tape; only `Start state` and
  `Finish state` remain;
- the facts themselves do not disappear: they live in the tree and are addressable by id via
  `recall`/`search`.

### 1.2. What breaks in a dialogue

- **"Read this file, we will need it."** Reading is an ordinary action, but after `stop` the file
  body leaves the tape. The next state or the next request does not see it: the fact is in the
  tree, but nothing points to it.
- **Reading as a standalone request.** The startable state is `orientation`; the further path
  depends on the result (an artifact or a situation). A request "read README" is either declined
  or forced into a foreign goal.
- **"I changed my mind" / "the defect is not there".** Logos does not understand language: it
  cannot classify a free-form utterance and does not know what to do with it.
- **"Cancel everything."** There is no session-level operation: cancel execution and leave the
  tree as it is.
- **"Continue from where we left off."** There is no way to pass to a new task what has already
  been established without retelling the whole history.

### 1.3. Idea: the request as an addressable unit

In a monotone tape the processing of a request is indistinguishable from the session: the tape
grows, and user utterances are merely interspersed in it. The idea is to make the request a
first-class unit with its own journal and its own root. The session is then not text but a
container over units, and the past can be addressed rather than retold.

### 1.4. Idea: session memory is the IR itself

There is no separate "memory store". Session memory is the session's IR: the unit journals and
the session journal. The past is not deleted, compressed into a summary or rewritten. It remains
addressable: knowledge of it is built as a deterministic structural outline of the IR edges, not
as a similarity search.

### 1.5. Idea: the session tape shows unit traces; details on request

The tape is a projection, not the IR. For the session agent, past units are represented by
**traces**: the request or user utterance, the result, the status, the answer or the operation.
The traces form the stable skeleton of the dialogue.

Details of a trace are not put on the tape. They are reached with tools: unit → states → turns →
observation bodies, with content search. The result of such a request becomes an observation of
the calling unit and is therefore addressable. When a state or turn closes, its details leave the
projection but remain in the journal.

In other words, the journal is monotone, the projection is not. For the session agent traces are
stable; details are transient. This is the same principle as in a task, only at the session
level.

### 1.6. Idea: the task is isolated; context is transferred by formulation

The task agent sees only its own unit and its own task. It does not read the session L0, other
units' journals or history tools. Otherwise the task becomes a monotone tape, attention is
diluted, and controllability is lost.

Continuity is provided by the session agent. When starting a new task it **reformulates** the
request using the previous utterances and what was found: what exactly has to be done now, which
constraints and findings from the past are relevant. The task receives the formulated text and
then works only within it. If needed, the session agent first tells the user how it understood
the task and waits for confirmation, and only then starts it.

Thus context is transferred **through the task formulation**, not through the task's access to
other journals.

### 1.7. Idea: two independent statuses

Whether a unit is open and where the session's attention lies are different things. The first is
a fact of the unit journal (closed if and only if its `move` has a `stop`). The second is a fact
of the session journal (`active`/`suspended`/`abandoned`/`completed`) and expresses attention,
not truth. The separation allows one to "leave" work without closing it, and does not contradict
the invariant "nothing is deleted".

### 1.8. Idea: the semantics of an utterance belongs to the doxa

Free text is unstructured, and the mapping "utterance → what to do with the session" is a
semantic judgment. The doxa therefore performs it, not logos: the session agent reads the
utterance and the traces and proposes an operation. Logos, as everywhere, checks the
preconditions and applies it.

### 1.9. Requirements

- **R1. Continuity.** Work is not deleted; previous trees remain available.
- **R2. Interpretation of utterances.** Free text becomes a structured decision; this is a
  semantic act, hence doxa, not logos.
- **R3. Knowledge of the past.** The session agent learns what was done from traces and the
  outline, without retelling the whole history and without similarity search.
- **R4. Bounded context.** The bulk is not on the tape; the tape carries traces and addresses,
  details on request.
- **R5. Task isolation.** The task agent sees nothing beyond its own unit; context is
  transferred only through the reformulated request.
- **R6. Invariants.** Journals only grow; the projection is deterministic; a state is closed only
  through `stop`; no verdicts or stored truth statuses.

## 2. Concepts

**Unit.** One IR with its own root and its own journal. A unit has a type: `task` — an ordinary
task (`request → move → plan → …`); `session` — a unit that interprets a user utterance;
`observer` — a RequestObserver unit. Types form a closed registry that can be extended.

**Session.** A container over units:
`Session = (J_s, U, stack, pending)`, where `J_s` is the session journal, `U` is the set of
units, `stack` is the unit stack, and `pending` is at most one unprocessed user utterance.
`focus` is the top of the stack: the unit the session is attending to.

**Unit stack.** The stack stores unit ids and return points, not copies of contexts: the current
unit is deferred, an interpretation unit is pushed on top, and work proceeds with its IR; when
the interpretation finishes the unit is popped and the outer unit resumes from its own journal.
`focus` is the top of the stack; `pending` is not a stack.

**Session journal.** An append-only journal of session-level events: open a unit, suspend,
resume, leave, apply a session-agent operation. It does not change unit journals.

**Trace.** The projection of a past unit onto the session agent's tape: id, type, request or
utterance, result/ending, status, answer or operation. A trace is neither a journal copy nor a
summary-truth; it is an address and a short fact. For a task unit the trace shows its `request`
— the reformulated task text. For a session unit it shows the original utterance and the
operation, with a reference to the opened unit; the reformulation text is not duplicated, its
source is the task request. If an operation is refused, the trace keeps the proposed operation,
the reason and the model's reasoning; the interpretation is still complete.

**Two independent statuses.** This matters:

| Status | Source | Meaning |
|---|---|---|
| unit open / closed | the unit journal | closed ⇔ its `move` has a `stop` |
| unit in the session: active / suspended / abandoned / completed | the session journal | the session's attention, not truth |

`abandoned` does **not** close a state and writes nothing to the unit journal. It is a session
fact. `completed` is derived: the unit is closed through `stop` and is not `abandoned`. So
"nothing is deleted" and "closure only through `stop`" do not contradict each other.

**Focus.** At most one unit is active at a time. Focus is the top of the stack: it changes by
push/pop operations, not by rewriting units. Losing focus is `suspended` or `abandoned`, not
`stop`.

**Pending.** A slot for one utterance. A new utterance replaces the old one if it has not been
processed yet: this is not a stack, so interpretation cannot recursively nest into itself.

**Committed and proposed.** The journal contains only **committed** facts — what the doxa
proposed and logos checked and applied. A model reply that has not passed the check is
**proposed**; it is not in the IR. This is needed in §3.

**Pin.** A reference to a fact that holds for the session: the observation id, the path, the
version, a short gist. A pin **does not copy the body**: the body is fetched with `recall` by id.
A pin answers "keep it in mind" without inflating the tape. Not implemented in the current
slice.

**Session operation.** A structured action of the session agent on the session. The vocabulary
is currently minimal: `respond` (answer) and `start` (begin a task). Resume, cancel, revise and
query (`resume`/`cancel`/`revise`/`query`) are deferred. Logos checks admissibility and applies
the operation.

**Report.** The session agent's Markdown answer after a task it started has finished. It is a
report on the outcome, not a second interpretation of the utterance, so it is appended to the
same session unit as the `start`. A report closes nothing and starts nothing.

**No decision.** An interpretation can end without an operation: the model returns neither a
tool call nor text (`empty_reply`), or the loop reaches its safety cap (`max_turns`). The session
journal records the reason; the unit stays suspended and L0 shows `no decision: …`. It is not a
silent drop.

**Request reformulation.** A semantic action of the session agent: based on the utterance and the
traces, compose the text of the new task so that it carries the needed context. The result is an
ordinary task-unit request, not a separate kind of knowledge.

**Confirmation.** An optional dialogue step: the session agent tells the user how it understood
the task and waits for agreement before starting it. Confirmation is an interaction policy, not
an IR gate.

**Outline.** A deterministic hierarchical representation of a unit or the session: at the top
the request and how it ended, deeper the states, deeper still the course of work. Details in §5.

**Session agent.** The doxa of the session unit: it reads the utterance and the traces, descends
through the outline levels when needed, proposes an operation and formulates the request of a new
task. It does not edit task trees.

**Task agent.** The doxa of the task unit. It sees only its own unit and works only with it; the
request formulation comes from outside.

**Reading unit.** A one-step unit: `path → observation`. It is not a task: it has no states or
plan. The observation carries `path`, `version`, the full size (`bytes`), the line count
(`lines`), a bounded `preview` and the address of the full body. L0 shows
`reading r2 "NOTES.md" completed; read 40 B, 1 line(s); obs:…`.

Diagram:

```
session
├── task r1   (journal J1)   — "fix pool_sweep"
├── task r2   (journal J2)   — "read AGENTS.md"
└── session m1   (journal J3)   — "the defect is not there"   ← focus
```

## 3. Interruption

The user can interrupt execution. Formally this is not an IR operation.

- If a model reply has not passed the check yet (proposed), an interrupt simply **discards** it.
  Nothing appears in the journal: no node, no `stop`, no change of the task's status.
- If a tool is interrupted, what actually happened is recorded honestly: the result, the error,
  or `killed by <SIG>`; a partial file change is a `mutate`, a fact of the world.
- Suspension is a **session** status (`suspended`), not an event of the task tree.
- The user's utterance goes into `pending` and waits to be interpreted.

So `stop` remains the only way to close a state: an interrupt closes nothing.

## 4. The session agent

### 4.1. Why a separate agent

Logos is a deterministic function over structured events, while free text is unstructured. The
mapping "utterance → what to do with the session" is a semantic judgment, so the doxa makes it.
The session unit is the same IR as a task, but:

- its root is the user's utterance;
- it has its own vocabulary of states (e.g. `survey` — look at the traces, `interpret` —
  understand the utterance, `decide` — choose an operation, `respond` — answer, `finish`);
- its structural operations are session operations, not `move`/`apply`/`stop`.

### 4.2. The session agent's tape

The session agent's tape contains:

1. the base prompt: who it is and which operations are admissible;
2. the current user utterance as the root;
3. L0 — the unit traces in full, including the answer/operation, refusal and decision reasoning;
4. the results of the tools it requested (workspace `read`/`grep`/`list`/`probe`, memory
   L1–L4). Each such result becomes an observation of the session unit and is therefore
   addressable.

The traces include the session agent's own past turns: its answers and operations. The dialogue
is thus reconstructed structurally, without retelling.

### 4.3. Session operations

| Operation | Admissible when | Effect |
|---|---|---|
| `respond` | always; non-empty text up to 4000 chars | answers the user in GitHub-flavored Markdown; task trees unchanged |
| `start` | there is a task text up to 4000 chars | pops the current focus (the unit stays as a trace) and opens a new request with that text |

Exceeding the limit is a logos refusal. The refusal is written to the session journal, shown in
the L0 trace (`(refused: …)`), and changes no task tree; the interpretation is still complete.

The session agent only **proposes**. Logos checks the preconditions and applies the operation as
a session event.

After a `start` task finishes, the driver asks the session agent for a **report** and records it
on the same session unit. The report is the user-facing Markdown answer: what was done, where,
how it was verified, and any caveats. It uses the task's deterministic trace (states, changed
files, outcome) and does not open a new session unit. A failed report never hides the task
result; the terminal stop remains the fact.

An interpretation that produces neither an operation nor a tool call, or that exhausts the
safety cap, ends with a `no_decision` event (`empty_reply`/`max_turns`). The unit stays
suspended; L0 and the terminal view show the reason.

`read` is not a session operation but a read-only session-agent tool. It reads a file, creates a
reading unit and returns a preview plus an address. `start` is not used to read a file.

`grep`, `list` and `probe` are read-only tools too, but they create no unit: their result is an
ordinary observation of the session unit, bounded and paged with a cursor. `grep`/`list` see the
live workspace (locate code, see what exists); `probe` returns one recorded toolchain fact by
`kind` (`environment`, `packages`, `interpreters`, `build`, `tests`, `vcs`, `tools`, `material`,
`all`) and is computed once per session. `search` remains the memory tool: it searches the stored
bodies of a past unit, not the workspace.

`resume`, `cancel`, `revise` and `query` are not in the current vocabulary:

- resuming work is a separate strategy to be discussed later; for now "continue" means `start`
  with a new formulation;
- there is no separate cancel: a user utterance is interpreted, and Esc is a task interruption,
  not an IR operation, and changes nothing;
- revising a task's input (`revise`) is deferred;
- `query` is unnecessary: `respond` already answers from the history with the outline tools.

### 4.4. Reformulation and confirmation

Before starting a new task the session agent:

1. reads the current utterance and L0;
2. descends into past units (L1–L4) and searches when needed;
3. formulates the task request: what to do, which constraints and findings from the past are
   relevant;
4. if the policy requires confirmation, answers the user with the formulation and waits for
   "yes";
5. after confirmation proposes `start` with that text; logos opens the task unit, and the text
   becomes its `request` (the single source of the reformulation).

The formulation is authored by the doxa. The engine does not check its meaning; it records the
request and creates the unit. Confirmation is optional and is enabled by the interface or the
session policy.

### 4.5. Examples

**"Hi, Vasya!"** → `respond`. The task stays `suspended`, the trees do not change.

**"Now add a test"** → `start` with a reformulated request. The old task is not closed: it loses
focus and remains a trace; its tree is intact.

**"Continue from where we left off"** → the agent raises the trace of the past task, reads its
L1–L4 if needed and formulates a new request with the findings; for now this is `start`. Strategies
for resuming the same unit come later.

**"The defect is not there, it is here"** → for now `start` with a new formulation that includes
the correction. `revise` (editing the input of the current task) is a separate future slice.

**"Cancel all this, we will do something else"** → `respond`, then `start` with the new task if it
is named. There is no separate cancel operation; the old task's tree does not change. Esc is an
execution interrupt, not an IR operation.

## 5. Session memory: the hierarchical outline

The hierarchy is not a new model on top of the IR but the **edges of the IR themselves**:
`request → move → plan → item → action → observation`. So an outline is a deterministic
projection, not separate "knowledge".

| Level | Address | Shows | Source |
|---|---|---|---|
| L0 — session | — (on the tape) | unit traces: id, type, request/utterance, result, status, answer/operation/refusal, report, no decision, decision reasoning | session journal + fold |
| L1 — unit | `unit` | states: id, island, authored `what`, closed?, `stop.why` | `request.move`, `move.stop` |
| L2 — state | `state` | plan items: the chosen action, result id, outcome, number of earlier alternatives | `plan.items`, `item.alts` |
| turns | `turns` | action, result, the task agent's reasoning (bounded) | `action`, `action.result` |
| L3 — item | `attempt` (deferred) | all alternatives (the full history of attempts) | `item.alts`, `action.result` |
| L4 — body | `body`, `search` | content/window; search over the unit's observation bodies | observations |

Rules:

- **L0 is the skeleton of the dialogue.** It is always available to the session agent; L1–L4 only
  on request.
- **The reformulation appears in the task unit's trace** as its `request`; the session unit's
  trace keeps the original utterance and the operation with a reference to the created unit, not
  a second copy of the text.
- **A task does not see L0 or other units' L1–L4.** That is the right and duty of the session
  agent.
- **"Result" is not a verdict.** One cannot write `success`/`failure`. One can write `stop.why`
  of the last state, `unactionable.why`, `open at <state>`, `suspended at <state>`,
  `abandoned at <state>`. This is a fact, not an evaluation.
- **L2 is not linear.** An item may have several alternatives (attempts). `state` shows the
  current one and the number of earlier ones; `attempt` (L3) discloses them all — deferred.
- **The history shows the authored `what`.** The current projection hides it because the goal
  comes from the island; in a historical outline, without it one loses what was actually done.
- **Truncation is explicit.** Every level has a limit; instead of a silent cut — `k more` and a
  cursor (the id of the last shown node).
- **L0 is shown in full.** Traces are short, so the projection does not select "the last k". If
  the context overflows, the engine warns explicitly; there is no silent truncation.

L0 example:

```
1. task r1  "fix pool_sweep"       completed; Verification: "make check passed"
2. task r2  "read AGENTS.md"       completed; Reading: "AGENTS.md read"
3. session m1  "continue from where we left off"  completed; start → r3
4. task r3  "fix pool_sweep: add a test for …"  open at Patch
```

L1 example for `r2`:

```
- Reading  what: "read AGENTS.md and remember the rules"  closed  why: "the rules are recorded"
- End      —                                             closed
```

### 5.1. Reading a file

Reading is one action, not a task. The `read(path)` tool:

- reads the file through the workspace;
- creates a reading unit with a request (the path) and an observation;
- returns a **preview** and an **address**:
  - `bytes` is the full file size, `lines` the full line count;
  - a small file is shown in full;
  - a large one — the first ~120 lines/8 KB and `…[lines 1–120 of N; continue from 121]`;
- the full body is not copied onto the tape: it is read by `path`/`version` through the reading
  unit's `body`/`search`.

On "what does it say" the session agent reads the preview; if that is not enough it pages a
window; if it needs to find something it searches; then it answers with `respond`. A summary is
only the answer or a note, never the fact.

## 6. The projection

### 6.1. Session unit

The session unit sees:

1. the session agent's base prompt;
2. the current user utterance as the root;
3. L0 — the unit traces in full, including the answer/operation, refusal and decision reasoning;
4. the requested L1–L4 fragments; every request is a read-only action, and its result becomes an
   observation of the unit and is therefore addressable.

### 6.2. Task unit

The task unit sees only its own journal and its own task. Its projection contains no session L0,
no other units and no session history tools. The task request is the text formulated by the
session agent; from then on the task is self-contained.

Details inside the task follow the same principle: closed states leave the tape, the facts remain
in the journal and are addressable via `recall`/`search`.

### 6.3. Determinism

The projection is deterministic: the same unit journals and the same session journal give the
same tape. Traces do not store a separate "memory state"; they are derived from the journals.

## 7. Invariants

1. Journals (of units and of the session) only grow; nodes are not rewritten.
2. The projection is deterministic: the same journals → the same context.
3. A task state is closed only through `stop`; an interrupt and `abandoned` do not close it.
4. The doxa proposes; logos checks and applies.
5. An exit code is ordinary output, not a verdict.
6. The outline introduces no statuses or verdicts; a "result" is a terminal marker.
7. The task is isolated: its journal and projection contain no events of other units; context is
   transferred only through the reformulated request text. Revising the input (`revise`) is a
   future operation that also writes to its own unit's journal.
8. A pin is a reference, not a copy; the body is not duplicated in the snapshot.
9. L0 is shown in full; when the context overflows, there is an explicit warning, not a silent
   truncation.
10. A reading unit is not a task: one `read` action, a preview + full size + address; the full
    body is not copied onto the tape.
11. A report is appended to the session unit that started the task; it closes nothing and starts
    nothing. A failed report does not hide the task's terminal stop.
12. A no-decision turn closes nothing: the unit stays suspended and the journal keeps the reason
    (`empty_reply` or `max_turns`).

## 8. Open questions

1. How to represent confirmation: a `respond` with the formulation and a following `start`, or a
   separate operation?
2. L0 is shown in full; when the context overflows there must be an explicit warning. What should
   the threshold and the warning format be?
3. How literal the request reformulation should be; which details of the past go into it.
4. Strategies for resuming work on a previous unit (for now "continue" means `start`).
5. `revise`: is the user fact a new addressable node (`hint`) or a unit-level user message
   rendered at the focus?
6. The registry of unit types: who extends it and how.
7. Is memory needed between sessions, or is a session the boundary? If yes — how to refer to
   past sessions.
8. Who sets a pin: only the user (provenance `user`) or also the doxa (checked by logos)?
9. Structural search over the session (by path/version/pin) — when it is needed and in what
   form.

## 9. Non-goals

- Do not delete or "compress" the history into a summary-as-truth.
- Do not introduce similarity/embeddings/RAG. Selection is by structure and declared rules.
- Do not make an LLM archivist the source of truth: it may propose an address, but the facts are
  returned by a deterministic query.
- Do not give the task agent access to other units or to the session L0: that breaks isolation
  and controllability.
- Do not introduce verdicts, criteria or stored statuses.
- Do not build a second engine: the session unit is the same IR.

## 10. Minimal next step

Implemented: the session container, attention statuses, the L0/L1 outline, and the session unit
with `respond`/`start`. The session unit's L0 trace includes the answer or the `start` text (the
reformulation); the task unit's trace shows the reformulation as its `request`.

Session agent tools: `read` (a file, as a reading unit), `grep`/`list` (the live workspace),
`probe` (toolchain/environment facts), `unit` (L1), `state` (L2), `turns` (turns with reasoning),
`body` (L4), `search` (L4, over stored bodies). `attempt` (L3) is deferred; `outline` is
unnecessary because L0 is on the tape. The workspace tools create no unit: their results are
observations of the session unit.

The `runSessionTurn` driver, the `runRepl` loop and the `src/cli.ts` entry point are implemented;
the scenario is verified offline with scripted agents. Reformulation and confirmation are set by
the prompt.

After a task the driver asks the session agent for a `report` (GitHub-flavored Markdown) and
records it on the same session unit. The terminal view (`src/session/view.ts`) shows the session
tool calls/results, the task moves/actions/stops, and the Markdown answer or report. Tool results
are previews with an explicit truncation marker; `--verbose` expands them and shows the provider's
reasoning in a `Thought:` block (the `reasoning` field, not the ephemeral `thought` text).

Next steps:

1. The live `read` scenario passed: reading is one turn, `body` by `obs:reading:1`, then `start`
   with the reformulation; the task created `Makefile`/a test and `make test` passed.
2. Session persistence across restarts and Ctrl-C handling.
3. Resume strategies, `revise`, pins, `attempt` and the reading island — separate slices.
