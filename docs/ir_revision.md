# Skein — IR revision: shape, operations and context

> English mirror of `docs/ir_revision_ru.md`.
> Status: working record of the revision. Only what is agreed lives here; disputed points go
> under "Open questions". While the discussion is ongoing, the code does not change.
> When the revision is complete, this text will replace the divergences in
> `docs/ir_semantics.md`, `docs/projection.md`, `docs/context_design.md` and
> `docs/plans/traversal_stack_spec.md`. It is itself temporary and must not remain yet another
> source.

## 1. Purpose of the document

There are more and more documents about how the IR is built, and they have already drifted
apart: `concepts`, `ir_semantics`, `ir`, `projection`, `context_design`, `traversal_stack_spec`
and `walkthrough` describe different slices of one system and in places contradict the code. For
example, `done_when`, `checkReady` and `state` were long ago removed from the code but still
live in the texts.

One short summary is needed, from which the model can be understood as a whole without being
assembled out of seven documents. This document is that summary.

It answers three questions:

- **shape** — which nodes and relations the tree is made of;
- **operations** — which moves grow the tree and where the focus of work looks after each move;
- **context** — what of the tree the model sees on the next step.

Not part of the revision and left as is: the doxa/logos split, the rule "a goal is closed only
through `stop`", the requirement "the journal is only appended to" and determinism — "the same
events give the same context".

## 2. The shape of the tree

### 2.1 Nodes

Nodes fall into two spaces.

**The work space** — what the work itself is made of:

- `request` — the user's request; the root of the tree;
- `goal` — a goal: what must be achieved;
- `plan` — a goal's plan: an ordered list of items;
- `item` — a plan item: a list of alternatives for this item (**a new node kind**);
- `action` — a command; serves as an alternative of an item;
- `goal` — a goal can also be a sub-goal, that is, likewise an alternative of an item;
- `observation` — the result of a command that ran;
- `stop` — the mark that a goal is closed;
- `unactionable` — the mark that the request contains no actionable task;
- `constraint` — a restriction: what is forbidden.

**The artifact space** — what exists besides the work:

- `file` — a file.

The former kind `alternatives` (a container of variants) is gone: its role now belongs entirely
to the plan item `item`.

### 2.2 Relations

A relation is a named connection from one node to another. Each node kind has a fixed set of
admissible relations:

| Owner | Relation | To | Card. |
|---|---|---|---|
| `request` | `goal` | `goal` | 0 or 1 |
| `request` | `unactionable` | `unactionable` | 0 or 1 |
| `goal` | `plan` | `plan` | exactly 1 |
| `goal` | `stop` | `stop` | 0 or 1 |
| `plan` | `items` | `item` | 1 or more, in order |
| `item` | `alts` | `action` or `goal` | 1 or more, in order |
| `action` | `result` | `observation` | 0 or 1 |
| `action` | `mutates` | `file` | 0 or more |

The name of the relation is the role the child plays for its owner. That is why no separate
"edge list" is needed: a relation is added by the next event, and the node itself is not
rewritten. This preserves the journal's main property — it is only appended to.

The order of children is the order of addition. The current (chosen) child is the **last** one.

Two places deserve a separate note:

- a goal's closure is stored right on the goal, in the relation `goal.stop`; there is no longer
  a separate plan item for `stop`;
- a file (`file`) is the only node several actions may point at (via `action.mutates`). This is
  the one real sharing: a file has many "owners", every other node has one.

### 2.3 The general shape

```
goal --plan--> plan --items--> item --alts--> action | goal
```

The rules that follow:

- a plan item is **always** a list of alternatives, with at least one element; when there is no
  branching the element is exactly one and it is a command (`action`);
- a goal can appear in only two ways: as the request's interpretation (`request.goal`) or as an
  alternative of an item (`item.alts`). Nowhere else.

## 3. How the tree grows: operations

Notation:

- `R` — the root request (`request`);
- `C` — the open goal the focus is on;
- `I` — the current plan item of goal `C` (the first unfulfilled one; see §4).

Every operation is described by one template: purpose → applies to → input → action → focus →
refusal.

### 3.1 `create_goal` on the request — interpretation

**Purpose.** Once interpret the request as a goal.

**Applies to.** A fresh `request` — one that has neither a goal nor an `unactionable` mark yet.

**Input.** `{ what, why?, sketch, command }`: `what` — what to achieve; `why?` — the
hypothesis/reason; `sketch` — a plan note; `command` — the first plan item.

**Action.** Nodes created: goal `G`, plan `Q`, item `I`, command `A`. Relations:
`R.goal = G`, `G.plan = Q`, `Q.items = [I]`, `I.alts = [A]`. The request gains a goal, the goal
gains a plan of one item, the item gains one command alternative.

**Focus.** Descends into `G`.

**Refusal.** On an already interpreted request — `interpreted` (the interpretation is created
once).

### 3.2 `create_goal` on a goal — decomposing an item

**Purpose.** Decompose the current item into a sub-goal, when a step needs a sub-task of its
own.

**Applies to.** An open `goal` that has a current item.

**Input.** The same `{ what, why?, sketch, command }`; `command` becomes the first command of
the new sub-goal's item.

**Action.** Nodes created: sub-goal `G`, plan `Q`, item `I'`, command `A`. Relations:
`I.alts += G` (the sub-goal becomes the last, that is the current, alternative of the item),
`G.plan = Q`, `Q.items = [I']`, `I'.alts = [A]`.

**Focus.** Descends into `G`.

**Refusal.** No current item (the plan is already fulfilled).

### 3.3 `apply` on a goal — a command

**Purpose.** Run one command in the current goal.

**Applies to.** An open `goal`.

**Input.** `{ tool, … }`, where `tool` is one of `read`/`grep`/`list`/`edit`/`write`/`run`/
`fetch`/`apply_patch`, plus the tool's parameters (`path`, `pattern`, `find`/`replace`,
`command`, …). There is no "continuation or branch" flag in the input — hence §4.

**Action.** The command runs; the result is recorded: either `A.result = observation` (read,
grep, run) or `A.mutates += file` (a file edit). Whether the command becomes a new item or an
alternative is decided by the outcome (§4).

**Focus.** Does not move: the action runs in place, in the current goal.

**Refusal.** A command has no separate refusal: non-execution (a repeat, a stale base, a
forbidden path, an empty command) arrives as an **observation with a reason** (§4), not as a
refusal without a node.

### 3.4 `stop` on a goal — closure

**Purpose.** Close the goal. This is the only way to finish it.

**Applies to.** An open `goal`.

**Input.** `{ why? }` — the reason for the closure.

**Action.** Node `S` is created; the relation `C.stop = S` is set.

**Focus.** The goal is closed; the next projection moves the focus to the parent. If the root
request's goal is closed, the run ends.

**Refusal.** On a `request` — `not_addressed` (a request has no `stop`; the request ends when
its goal is closed).

### 3.5 `decline` on the request — refusal

**Purpose.** Record that the request contains no task that can be taken up; no goal is
invented. It arises when the request has no task at all (a greeting, thanks, feedback), when it
is not about working with code or the workspace, or when its intent does not reduce to an
actionable task. The refusal ends the run, but does not "close" the request: the request's
acceptance stays external, and the user may clarify and send a new one. If there is a task and
it is clear — that is `create_goal`; if there is a task but a tool or procedure is missing —
that is a separate, still deferred case (a capability gap).

**Applies to.** A fresh `request`.

**Input.** `{ why? }` — the reason for the refusal.

**Action.** Node `U` is created; the relation `R.unactionable = U` is set. No goal, plan or
commands are created.

**Focus.** The run ends (`request_unactionable`).

**Refusal.** On a goal — `not_request`; on an already interpreted request — `interpreted`; on
an already declined one — `repeated_action`.

Separately: `query` is not a doxa move but a read. Its input is `{ id?, kind?, edgesOf?,
start?, end? }`; it creates no nodes and does not change the tree.

## 4. How a command enters the tree

`apply` is a tool call. The engine runs the command and **always** records its outcome as an
`observation`; the doxa reads the observation and itself decides the next move, and the engine
only places the incoming move. Which move to give is chosen by the model (it may take the
previous command slightly changed, based on the reason in the observation) — the engine does not
constrain that choice.

The **outcome of an item** is taken from its current alternative:

- the alternative is a **command**: its `observation` carries either a result (**success**), or
  a reason (**failure**), or nothing when aborted by a timeout (**no verdict**). The reason for
  a failure: the tool could not run (no file, empty pattern), the admissibility check did not
  pass it (a repeat, a stale base, a forbidden path), or the run returned a non-zero code;
- the alternative is a **goal**: there is no observation, the outcome is its `stop`; the reason
  for the closure is taken from the `why` of the `stop` node. A closed goal counts as
  **success**.

**Where the next move goes** (the engine places it by the outcome; the doxa chooses the command
or goal):

- after **success** — as a **new plan item**;
- **otherwise** (failure or no verdict) — as an **alternative of the current item**; if the new
  move is a goal, the focus descends into it.

Every attempt at a command leaves nodes: one that ran — `action` and `observation` with the
result, one that did not — `action` and `observation` with the reason. Even a repeat of the
same command is recorded as new nodes; an existing node is neither reused nor edited — the
journal stays monotone.

**Structural moves.** `create_goal`, `stop`, `decline` are not the execution of a command but a
change of the tree. If such a move is inadmissible in the current context, it is **refused**:
the doxa is given the reason, and no node is created.

**A consequence for reproduction.** A failing run is a failure, so the command after it is
placed as an alternative of the same item, not as a new item.

## 5. The context: a tape of messages

The context is what the model sees on the next step. It looks like an ordinary tape of messages
(as in a ReAct agent), but is **rebuilt from the tree every time** — it is a projection, not an
accumulating transcript. That is why the same set of events always gives the same tape.

**Roles:**

- `system` — the system prompt;
- `user` — the request;
- `assistant` — the doxa's moves;
- `tool` — command results.

**Moves and their messages:**

- `create_goal` — an `assistant` with the goal (`what`/`why`/`sketch`), then the first command:
  `assistant` (the call) + `tool` (the observation);
- `apply` — an `assistant` (the command call), then `tool` (the observation);
- `stop` — an `assistant` with the reason (`why`): the goal is closed;
- `decline` — an `assistant` with the reason (`why`): the request is declined.

That is, **every plan item is a pair** `assistant` + `tool`, while creating and closing a goal
are separate `assistant` messages.

**Marking alternatives.** If a command is an alternative to an already started step, this is
visible from its `assistant` message: `alternative to step "<label>" (previous attempt:
"<command>" — <reason>)`. So the model sees what has already failed.

**The tape is not monotone.** As soon as a goal is closed, all of its internal messages are
removed from the tape; on its parent's arm only the closure message (`stop` with `why`) remains.
Going up further — the same. Only the view goes, not the data: the tree stays complete and
unchanged.

**The doxa's reasoning is not stored.** Raw `thought` does not enter the tape: it is not in the
tree, and including it would break determinism. The meaning of the reasoning is preserved where
it matters — in the `why` fields.

### 5.1 The context format

The context is **only a tape of messages**, that is, history. There are no separate blocks
(`brief`, `path`, `calls`, `shown`, `applicable`, `budget` and the like).

- What is not in the tape, the model does not know: the tape is all its memory.
- **The context is not limited.** We show the whole history; the only reduction is the
  non-monotone cut when a goal closes, when its internal messages leave (see above).
- Everything that used to be a state field is now either a message or an instruction of the
  system part:
  - a goal's plan and alternatives are messages (pairs `assistant` + `tool`);
  - constraints are `system` messages (§6);
  - the admissible moves are the node's instruction (§6).

### 5.2 Working with data

**Principle.** Large data is not stored in the IR: the body of a result that does not fit the
tape is saved as a file (owned by the engine), and only the reference `outputRef` remains in the
tree. It is not part of the IR but ordinary data.

- A tool result arrives as a `tool` message in a volume honestly bounded by the tool itself
  (`read` — up to 400 lines from the start, `run`/`grep` — up to 8000 characters, etc.).
- A small body lives right in the node; a large one — in a file, with `outputRef` left in the
  node.
- **Access is by identifier, not by path.** We do not expose `.skein/...` paths to the model:
  - read a fragment — `query { id, start, end }` (a window of lines);
  - search the body — `query { id, pattern }`.

## 6. Assembling the system part

The system part of the tape is assembled **not as a monolith**, but from the intent of the
current node. On a fresh request only the "interpret or decline" instruction is needed; once a
goal appears — the instruction about working the goal; and so on. Constraints are added there
too.

**Added once.** An instruction is attached to the node that triggers it and is rendered
together with it: one node — one appearance in the tape. There is no need to add it again, and
no separate counter is needed for that. A counter would only be needed for a later technique —
"hide an instruction after N turns and bring it back" — which we do not do now.

### 6.1 Principles of the split

- **The base prompt — only what is true on any move:** the role (who the doxa is), the contract
  (it proposes exactly one move; the logos decides), the general answer form. It does not depend
  on the node and is stable — it is also a good prefix for caching.
- **The node prompt — only what the current node calls for:** which moves are admissible now and
  how to shape them; the rules of the current situation (a fresh request / an open goal / a
  return); what the arm shows.
- **Rule of thumb:** needed on any move → the base; called for by a concrete state → the node
  prompt, attached to it.
- **Consequence:** the set of admissible operators and their fields is contextual (it matches
  the frontier) and is not listed in the base in full.

### 6.2 Open

The exact boundary — what exactly goes into the base prompt and what into the nodes (for
example, where the answer form and the general branching rules live) — is to be investigated
(§8).

## 7. What does not change

- the journal is only appended to; nodes are not rewritten, only what we show changes;
- the projection is deterministic: the same events give one context;
- a goal is closed only through `stop`;
- the doxa only proposes, the logos decides;
- a command's exit code is ordinary output, not a verdict; nothing is closed on it.

## 8. Open questions

1. The exact boundary of the base prompt and the node prompts (§6.2).
2. Re-formulate "the first unfulfilled item" for the new item shape (`item`) (§3).
3. The marking of alternatives in the tape (§5) is simplified — revisit if it turns out to be
   too little.
4. Bring the documentation into order once the shape is agreed.
