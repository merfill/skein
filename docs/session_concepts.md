# Skein — sessions: concepts and mechanics

> Russian original — `docs/session_concepts_ru.md`.
>
> Status: **partially implemented**. The minimal session container from 4a exists; the
> `SessionAgent`, session operations and attention statuses are the 4b concept.
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

- **"Read this file, we will need it."** Reading is an ordinary action, but after `stop` the
  file body leaves the tape. The next state or the next request does not see it: the fact is in
  the tree, but nothing points to it.
- **Reading as a standalone request.** The startable state is `orientation`; the further path
  depends on the result (an artifact or a situation). A request "read README" is either declined
  or forced into a foreign goal.
- **"I changed my mind" / "the defect is not there".** Logos does not understand language: it
  cannot classify a free-form utterance and does not know what to do with it.
- **"Cancel everything."** There is no session-level operation: cancel execution and leave the
  tree as it is.
- **Several files.** The plan can handle it (several items), but retaining the result is the
  same problem.

### 1.3. Idea: the request as an addressable unit

In a monotone tape the processing of a request is indistinguishable from the session: the tape
grows, and user utterances are merely interspersed in it. The idea is to make the request a
full-fledged (first-class) unit with its own journal and its own root. The session is then not
text but a container over units, and the past can be addressed rather than retold.

### 1.4. Idea: continuity without retelling

The past is not deleted and is not compressed into a summary-truth. It remains addressable:
knowledge of it is built as a deterministic structural outline of the IR edges, not as a
similarity search. This lets the agent learn what was done without retelling the whole history
and without inflating the tape.

### 1.5. Idea: two independent statuses

Whether a unit is open and where the session's attention lies are different things. The first is
a fact of the unit journal (closed if and only if its `move` has a `stop`). The second is a fact
of the session journal (`active`/`suspended`/`abandoned`/`completed`) and expresses attention,
not truth. The separation allows one to "leave" work without closing it, and does not contradict
the invariant "nothing is deleted".

### 1.6. Idea: the semantics of an utterance belongs to the doxa

Free text is unstructured, and the mapping "utterance → what to do with the session" is a
semantic judgment. The doxa therefore performs it, not logos: the SessionAgent reads the utterance
and the outline and proposes an operation. Logos, as everywhere, checks the preconditions and
applies it.

### 1.7. Requirements

- **R1. Continuity.** Work is not deleted; previous trees remain available.
- **R2. Interpretation of utterances.** Free text becomes a structured decision; this is a
  semantic act, hence doxa, not logos.
- **R3. Knowledge of the past.** The agent learns what was done without retelling the whole
  history and without similarity search.
- **R4. Bounded context.** The bulk is not on the tape; the tape carries a brief outline and
  addresses.
- **R5. Invariants.** The journal only grows; the projection is deterministic; a state is closed
  only through `stop`; no verdicts or statuses.

## 2. Concepts

**Unit.** One IR with its own root and its own journal. A unit has a type: `task` — an ordinary
task (`request → move → plan → …`); `session` — a session task (reading the user's utterance and
deciding about the session); `observer` — a RequestObserver unit. Types form a closed registry
that can be extended.

**Session.** A container over units. Formally:
`Session = (J_s, U, stack, pending)`, where `J_s` is the session journal, `U` is the set of
units, `stack` is the unit stack, and `pending` is at most one unprocessed user utterance.
`focus` is the top of the stack: the unit the session is attending to.

**Unit stack.** Nested session units need a way back to the deferred context. The stack stores
unit ids and return points, not copies of contexts: a trigger fires — the current unit is
deferred, a session unit is pushed on top, and work proceeds with its IR; the session unit finishes —
it is popped and the outer unit resumes from its own journal. `focus` is the top of the stack;
`pending` is not a stack.

**Session journal.** An append-only journal of session-level events: open a unit, suspend,
resume, leave, pin a fact, apply a SessionAgent decision. It does not change unit journals.

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
processed yet: this is not a stack, so session interpretation cannot recursively nest into itself.

**Committed and proposed.** The journal contains only **committed** facts — what the doxa
proposed and logos checked and applied. A model reply that has not passed the check is
**proposed**; it is not in the IR. This is needed in §3.

**Pin.** A reference to a fact that holds for the scope of a request or a session: the
observation id, the path, the version, a short gist. A pin **does not copy the body**: the body
is fetched with `recall` by id. A pin answers "keep it in mind" without inflating the tape and
without losing actuality.

**Session operation.** A structured action of the SessionAgent on the session: respond, resume,
revise, redirect, cancel, query. Logos checks admissibility and applies it.

**Outline.** A deterministic hierarchical representation of a unit or the session: at the top
the request and how it ended, deeper the states, deeper still the course of work. Details in §5.

**SessionAgent.** The doxa of the session unit. It reads the utterance and the
session outline and proposes a session operation. It does not edit task trees.

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

## 4. The SessionAgent

### 4.1. Why a separate agent

Logos is a deterministic function over structured events, while free text is unstructured. The
mapping "utterance → what to do with the session" is a semantic judgment, so the doxa makes it.
The session unit is the same IR as a task, but:

- its root is the user's utterance;
- it has its own vocabulary of states (e.g. `survey` — look at the outline, `interpret` —
  understand the utterance, `decide` — choose an operation, `respond` — answer, `finish`);
- its structural operations are session operations, not `move`/`apply`/`stop`.

### 4.2. Session operations

| Operation | Admissible when | Effect |
|---|---|---|
| `respond` | always | answers the user; task trees unchanged |
| `resume` | focus = suspended | returns attention to the unit |
| `revise` | focus ≠ none | adds a user fact to the unit journal |
| `redirect` | focus ≠ none | leaves the current unit and opens a new request |
| `cancel` | focus ≠ none | leaves the current unit; focus = none |
| `query` | always | answers from the session outline, changing nothing |

The SessionAgent only **proposes**. Logos checks the preconditions (as `classify` checks
`move`/`stop`/`decline`) and applies the operation as a session event.

### 4.3. Examples

**"Hi, Vasya!"** → `respond`. The task stays `suspended`, the trees do not change, we wait.

**"You localized it in the wrong place; the defect is here"** → `revise` (a user fact attached
to the current state) and then `resume` — or `redirect`, if the SessionAgent decides to reopen the
work.

**"Cancel all this, we will do something else"** → `cancel` (or `redirect`, if a new task is
named right away). The old unit becomes `abandoned`; its tree is intact, the state is not
closed.

## 5. Knowledge of the past: the hierarchical outline

The hierarchy is not a new model on top of the IR but the **edges of the IR themselves**:
`request → move → plan → item → action → observation`. So an outline is a deterministic
projection, not separate "knowledge".

| Level | Address | Shows | Source |
|---|---|---|---|
| L0 — session | — | units: id, type, request, session status, how it ended | session journal + fold |
| L1 — unit | unit id | states: id, island, authored `what`, closed?, `stop.why` | `request.move`, `move.stop` |
| L2 — state | move id | plan items: the chosen action, result id, outcome, number of earlier alternatives | `plan.items`, `item.alts` |
| L3 — item | item id | all alternatives (the full history of attempts) | `item.alts`, `action.result` |
| L4 — body | observation id | content/window | `recall`/`search` |

Rules:

- **L0 is always on the tape** of the session unit; L1–L4 only on request. This gives knowledge of
  the past without search and without an unbounded tape.
- **"Result" is not a verdict.** One cannot write `success`/`failure`. One can write `stop.why`
  of the last state, `unactionable.why`, `open at <state>`, `suspended at <state>`,
  `abandoned at <state>`. This is a fact, not an evaluation.
- **L2 is not linear.** An item may have several alternatives (attempts). The outline shows the
  current one and the number of earlier ones; L3 discloses them all.
- **The history shows the authored `what`.** The current projection hides it because the goal
  comes from the island; in a historical outline, without it one loses what was actually done.
- **Truncation is explicit.** Every level has a limit; instead of a silent cut — `k more` and a
  cursor (the id of the last shown node).

L0 example:

```
1. task r1  "fix pool_sweep"          completed; Verification: "make check passed"
2. task r2  "read AGENTS.md"          completed; Reading: "AGENTS.md read"; pin: AGENTS.md@v3
3. session m1  "the defect is not there" completed; revise → resume
```

L1 example for `r2`:

```
- Reading  what: "read AGENTS.md and remember the rules"  closed  why: "the rules are recorded"
- End      —                                             closed
```

## 6. The session unit's projection

The session unit sees:

1. the base prompt of the SessionAgent (who it is and which operations are admissible);
2. the user's utterance as the root (it leads the tape, as the request does in a task);
3. the session L0 in the header (briefly, within budget);
4. the L1–L4 fragments it requested; every request is a read-only action, and its result becomes
   an observation of the session unit and is therefore addressable.

The projection is deterministic: the same journals give the same tape.

## 7. Invariants

1. Journals (of units and of the session) only grow; nodes are not rewritten.
2. The projection is deterministic: the same events → the same context.
3. A task state is closed only through `stop`; an interrupt and `abandoned` do not close it.
4. The doxa proposes; logos checks and applies.
5. An exit code is ordinary output, not a verdict.
6. The outline introduces no statuses or verdicts; a "result" is a terminal marker.
7. A pin is a reference, not a copy; the body is not duplicated in the snapshot.
8. L0 is bounded by budget; truncation is explicit.

## 8. Open questions

1. `respond`: is the answer a session-journal event (a transcript) or only output, not in the
   IR?
2. `revise`: is the user fact a new addressable node (`hint`) or a unit-level user message
   rendered at the focus (like the request)?
3. The selection rule for L0 (focus + last k + pins?) and its budget.
4. Order: is the session operation applied before the `stop` of the session state or after; who
   closes the session unit.
5. `redirect`: leave the old unit `suspended` (one can return) or `abandoned`?
6. The registry of unit types: who extends it and how.
7. The reading report: a derived view or an artifact file? (Not a new truth.)
8. Is memory needed between sessions, or is a session the boundary? If yes — how to refer to
   past sessions.
9. Who sets a pin: only the user (provenance `user`) or also the doxa (checked by logos)?
10. Structural search over the session (by path/version/pin) — when it is needed and in what
    form.
11. The reading island: name (`reading`/`survey`), goal, criterion, transitions, whether it is
    startable.

## 9. Non-goals

- Do not delete or "compress" the history into a summary-as-truth.
- Do not introduce similarity/embeddings/RAG. Selection is by structure and declared rules.
- Do not make an LLM archivist the source of truth: it may propose an address, but the facts are
  returned by a deterministic query.
- Do not introduce verdicts, criteria or stored statuses.
- Do not build a second engine: the session unit is the same IR.

## 10. Minimal next step

Tier 4a needs only the shell: the session container (the session journal, units, the stack,
`pending`), without session operations or attention statuses. It provides the carrier for
triggers and session units. The rest is the 4b slice:

1. The reading island and pins of references.
2. The session container: session journal, units, the stack (its top is `focus`), `pending`.
3. `outline` L0/L1 (deterministic, with truncation).
4. A session unit with the operations `respond`, `resume`, `cancel`, `redirect`; `revise` as the
   next step.
5. An implementation plan in `docs/plans/` with test invariants.
