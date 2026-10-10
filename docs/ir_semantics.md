# Skein — IR: formal semantics

> Russian mirror — `docs/ir_semantics_ru.md`.

> **Folded from the revision.** This document is now the source of truth for the IR shape,
> the doxa's operations and the context. It absorbed the working revision
> (`docs/ir_revision.md`, now removed) and supersedes the shape/operations/context parts of
> `docs/projection.md`, `docs/context_design.md` and `docs/plans/traversal_stack_spec.md`.
> The as-built state of the code is `docs/ir.md`; the operator registry is
> `docs/ir_operations.md`.

Related documents:

- `docs/logos_ir.md` — the foundation: doxa and logos, gaps.
- `docs/ir.md` — **as-built**: how the IR is built in the current code.
- `docs/projection.md` — the context projection (the message tape).
- `docs/walkthrough.md` — an end-to-end example (the tree and the context step by step).
- `docs/ir_operations.md` — the operator registry and the coverage map (`OP-*`, `TR-*`, `DER-*`, `REF-*`).
- `docs/plans/implementation_plan.md` — stages and status.

This is the **source of truth about the semantics of the IR**. Code follows it, not the
other way around. A behavior change goes: (1) the semantics here; (2) the code; (3) a test
that pins the invariant the change preserves. Without step 1, step 2 is not done.

**Status.** The doxa has **four operators** (`create_goal`, `apply`, `stop`, `decline`);
`recall`/`search` are read-only addresses, not moves. The request is interpreted **once** as a goal
(the `goal` relation) or declined (an `unactionable` node). A goal closes **only** through
`stop`. A plan holds **items**; an item holds **alternatives**. The context is a **message
tape** rebuilt from the tree. The doxa proposes; the logos executes and records.

---

## 0. The principle: semantics is an operation on the IR tree

Everything the system does is described **as an operation on the IR tree**:

- which **nodes** and **relations** are created;
- where the **current node** (the focus of work) moves;
- which **derived facts** change (they are not stored);
- what the **next projection** shows (the model on its next step);
- which **invariants** hold.

This applies to the doxa's moves and to the logos's reactions alike. New behavior is a new
operation described by this template, never an edit of state around the journal.

The tree is not a given but the trace of operations. It branches where the agent picks an
approach (alternative goals/commands) and deepens where a goal is worked by a plan.

---

## 1. Roles

| Role | Who | What it does | What it does not |
|---|---|---|---|
| **Doxa** | the LLM | proposes exactly one operator per turn | does not decide, does not derive |
| **Logos** | the deterministic engine, **including the environment and tools** | runs the commands; places the nodes and relations by the outcome; recomputes the derived view; builds the projection | does not infer truth; does not choose between equal options |
| **Arbiter** | external (a human; objectively, a toolchain) | the first request; the final acceptance of the run; the choice between equal hypotheses | does not produce content |

There is no separate protocol/environment role: execution and recording are part of the
logos. The logos's internal operators are `o_rev` (recount on change), `o_def`
(retract/refute), `o_ctx` (projection). There is no preference operator (`o_spec`).

Key consequences:

- **the doxa only proposes.** A proposal enters as a proposal (a goal is open, a command has
  no result yet), never as an established fact;
- **the choice is from the admissible.** The logos deterministically offers the admissible
  moves at the current point; the doxa chooses one and fills it in;
- **a run is output, not a verdict.** A command's exit code is ordinary output the model
  reads; nothing is gated on it — the doxa closes the goal with `stop`;
- **the request is not a goal.** It is raw, unstructured motivation, the root; the doxa
  interprets it once as a goal or declines it; acceptance stays external.

---

## 2. The IR tree

### 2.1 Nodes

Nodes fall into two spaces.

**The work space** — what the work is made of:

| kind | meaning |
|---|---|
| `request` | the arbiter's request: raw motivation (the root); interpreted once as a goal or declined |
| `goal` | a goal: what to achieve; carries `what` |
| `plan` | a goal's plan: an ordered list of items (≥1) |
| `item` | a plan item: an ordered list of alternatives (≥1) |
| `action` | a command; an alternative of an item |
| `observation` | a command's result (a read window, run output + exit code) |
| `stop` | the mark that a goal is closed |
| `unactionable` | the mark that the request has no actionable task |
| `constraint` | a restriction (payload `forbid`: regex paths) |

**The artifact space** — what exists besides the work:

| kind | meaning |
|---|---|
| `file` | a file |

### 2.2 Relations

A relation is a named connection from one node to another; the name is the role the child
plays for its owner. Each node kind has a fixed set of admissible relations:

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

The order of children is the order of addition; the current (chosen) child is the **last**
one. Two consequences:

- a goal's closure lives on the goal, in the relation `goal.stop`; it is no longer a plan
  item;
- a `file` is the only node several actions may point at (`action.mutates`): a file has many
  owners, every other node has one.

### 2.3 The general shape

```
goal --plan--> plan --items--> item --alts--> action | goal
```

Rules that follow:

- a plan item is **always** a list of alternatives with at least one element; with no
  branching the element is exactly one and it is a command (`action`);
- a goal appears in only two ways: as the request's interpretation (`request.goal`) or as an
  alternative of an item (`item.alts`). Nowhere else;
- **`what`.** A goal carries `what` (what to achieve). The plan is a separate
  `plan` node, seeded by `create_goal` with one item whose sole alternative is the first
  command.

### 2.4 The current node

At any moment there is a **current node** — the focus of work; every doxa operator is
relative to it. The focus is the top of the **traversal stack** (§2.6).

### 2.5 State is derived

Nodes have **no stored status**; nodes are not edited, and there is no `stateOf`. The facts a
decision needs are read from nodes/relations:

- an action is **executed** ⇔ it has a produced child (`result`/`mutates`); otherwise the
  item is only planned;
- an action **succeeded** ⇔ it mutated a file, or its result observation is not a failure
  (a `failed` reason, or a non-zero `exitCode`; a missing `exitCode` is a timeout — no
  verdict);
- a goal is **closed** ⇔ it has a `stop` relation to a `stop` node; otherwise open. A
  request is **finished** ⇔ its goal is closed or it has an `unactionable` node; the request
  is never closed by `stop`;
- **`goalOf(request)`** — the goal via `goal`; **`unactionableOf(request)`** — the node via
  `unactionable`; **`stopOf(goal)`** — the stop node via `stop`;
- **`lastChild(container)`** — the current item/alternative (the last child);
- an item is **fulfilled** ⇔ its current (last) alternative is an executed, succeeded action
  or a stopped goal; the **cursor** is the first unfulfilled item.

There are **no truth predicates** (`achieved`/`refuted`/`abandoned`) and **no criterion**.
A run by itself settles nothing: a goal is closed only by the doxa's `stop`. These are
`project`/read rules, not fields. Only the journal is monotone (§3).

### 2.6 The stack and traversal

Traversal is the deterministic part of the logos. It does **not** choose what to do; it
computes the *admissible* moves at the current point; the doxa chooses among them.

**The stack** `S = [R, G₀ … G_k]` is the path from the root request to the current goal.
**The cursor** of `G` is the index of the first unfulfilled item of `G`'s plan. Neither is
stored: the stack is a fold of the focus events (`descend`/`return`, journal append-only);
the cursor is computed from the plan.

Deterministic movement:

- **advance** — executing an action item changes nothing about the stack; the cursor moves
  on its own;
- **descend** `G → H` — push `H`, focus → `H`; the doxa descends into the request's goal
  (`goal`) or into a sub-goal just created as the newest alternative of an item (`alts`);
- **return** — pop, focus → the parent. It happens when the current goal is **finished**
  (`stop`) or by a `W` decision. A closed goal does not hold the focus on its descendants:
  the branch is trimmed under a closed ancestor, not only when the top closes.

The engine hands the doxa **the whole arm** (the ordered neighbouring alternatives of the
focus) and the cursor marks the current node. One computation of the admissible moves feeds
both the projection and `classify`.

**The admissible moves at `G`:**

- `G` is the request with no goal yet → `create_goal` (interpret) or `decline`;
- `G` is a closed goal → `return` (engine-internal);
- otherwise (an open goal) → `apply` (a command), `create_goal` (a sub-goal decomposing the
  current item), and `stop` (close the goal).

### 2.7 How a command enters the tree

`apply` is a tool call. The logos runs the command and **always** records its outcome as an
observation; the doxa reads the observation and chooses the next move; the logos only places
the incoming move.

The **outcome of the current item** is read from its current alternative:

- the alternative is a **command**: its observation carries a result (**success**), or a
  reason (**failure**: the tool could not run, the admissibility check failed it, or the run
  returned a non-zero code, or a timeout — **no verdict**);
- the alternative is a **goal**: no observation; the outcome is its `stop`; a closed goal is
  a **success**.

**Where the next move goes** (the logos places it by that outcome; the doxa chooses the
command or goal):

- after **success** — as a **new plan item**;
- **otherwise** — as a **new alternative of the current item**; if the move is a goal, the
  focus descends into it.

A **sub-goal** (`create_goal` on an open goal) always becomes a new alternative of the
current item and the focus descends; with no current item it is refused.

Bootstrap: `create_goal` seeds the goal's plan with one item and runs its first command at
once (the logos); the goal is born with its first item executed. Every attempt leaves new
nodes; an existing node is neither reused nor edited — the journal stays monotone.

**Structural moves.** `create_goal`, `stop` and `decline` are not a command execution but a
change of the tree. If such a move is inadmissible, it is **refused**: no node is created, and
the reason reaches the doxa as a message on the tape next turn (`rejected <move>: <reason>`).
So is a **bare** addressed `recall` refused as redundant. A command has no such refusal: its
non-execution (a repeat, a stale base, a forbidden path, an empty command) arrives as an
**observation with a reason**.

### 2.8 Loop detection

Looping is not a separate sensor but an **absence of progress**. Progress at a point is a
cursor shift, **new knowledge** (a new observation or a new outcome, or a fragment retrieved
by `recall`/`search`), or a closure. The
layers are deterministic: a **repeat action** (the same command with the same inputs and an
unchanged world) is refused and its observation names the existing result; **stagnation**
(the cursor does not shift and there is no new knowledge for `K` turns) returns to the
parent; **exhaustion** without progress at the root stops the run (`no_progress`).

---

## 3. Journal and folding

- **The journal** (`Event[]`) is the single truth; it is only appended to.
- **State** — `fold(journal)`, derived.
- **Projection** — `project(state)`, derived; exactly what the model sees.

The event vocabulary is closed: `add_node`, `add_edge`, `descend`, `return`, `mutate`,
`record_rejection`. A state change is a **new event** (an `observation`, `mutate`, `stop`),
never an edit; there is no `set_status` and no `record_check`. A command's failure is never
forgotten: it materializes as an observation flagged `failed` (and, for a non-execution,
`refused`).

Determinism: the same events and parameters give one state and one projection. The only
external source is file changes; they enter through `mutate`.

---

## 4. Doxa operators

The doxa has **four operators** (`create_goal`, `apply`, `stop`, `decline`); `recall` and
`search` are read-only addresses, not moves. Each is described by one template: purpose → applies to →
input → action → focus → refusal.

### 4.1 `create_goal`

Interprets the request, or decomposes the current item into a sub-goal.

**Input.** `{ what, command }`: `what` — what to achieve; `command` — the first plan item
(a concrete command).

**At the request (interpretation).** Create goal `G` and its plan `Q` with one item `I`
whose sole alternative is the action `A` (the `command`); link `R.goal = G`, `G.plan = Q`,
`Q.items = [I]`, `I.alts = [A]`. The logos **runs `A` at once** and records its outcome;
the goal is born with its first item executed. The move renders as three messages
(assistant goal, assistant call, tool observation). Focus descends into `G`. The
interpretation is created once: a second `create_goal` at the request is refused
(`interpreted`).

**At an open goal (decomposition).** The sub-goal becomes the newest alternative of the
current item (`I.alts += G`), with its own plan seeded by its `command` (also run at once);
focus descends. With no current item the move is refused.

### 4.2 `apply`

Runs one command in the current goal.

**Input.** `{ tool, … }`, where `tool` is one of `read`/`grep`/`list`/`edit`/`write`/`run`/
`fetch`/`apply_patch`, plus the tool's parameters.

**Action.** The command runs; the outcome is recorded as `A.result = observation` (read,
grep, list, run) or `A.mutates += file` (an edit) — or, when it did not run, an observation
with a reason. Placement is by the outcome of the current item (§2.7). Focus does not move.

### 4.3 `stop`

Closes the goal — the only way to finish it.

**Input.** `{ why? }` — the reason.

**Action.** Create a `stop` node `S`; link `C.stop = S`. Focus is on the goal; the next
projection returns to the parent. If the root request's goal is closed, the run ends. There
is **no criterion gate**: the doxa closes the goal while working. `stop` on the request is
refused (`not_addressed`).

### 4.4 `decline`

Finishes a request whose intent is not actionable, inventing no goal.

**Input.** `{ why? }` — the reason. **Applies to.** A fresh request.

**Action.** Create an `unactionable` node `U`; link `R.unactionable = U`. No goal or plan is
created. Focus ends the run (`request_unactionable`). On a goal — `not_request`; on an
already interpreted request — `interpreted`; on an already declined one — `repeated_action`.

### 4.5 `recall` and `search`

Two read-only tools address a stored result by `id`; neither creates a node or changes the
tree. `recall { id, start?, end? }` reads the body (optionally a window of lines);
`search { id, pattern, before?, after? }` finds a regex inside the body (stdout **and**
stderr). They are separate so reading a result is never confused with searching one, or with
`read`/`grep` (which target the workspace). A **windowed** `recall`, or any `search`, is a
different fragment — new content; only a **bare** recall of an id whose body is already in
view is redundant.

---

## 5. Time, versions, witness

### 5.1 Version

A file's version is an identifier of its content (a hash). The content of old versions is
not in the IR; blobs live in the workspace. The IR stores only version names.

### 5.2 History and the current version

`history(ref)` is the versions of `ref` in `mutate` order; `current(ref)` is the last.
Both are derived from the journal.

### 5.3 Actualness is computed

An observation obtained by reading a file carries its **version**. There is no "stale" flag:
actualness is a **relation of a fact to the current context**, not a property of the fact:
`actual(fact) ⇔ fact.version = current(fact.ref)`.

### 5.4 Monotonicity

The journal only grows. A change of knowledge (a new version, a new observation, a new
hypothesis) is new records; only the derived view is recomputed.

---

## 6. Completion and honesty

| Condition | Closed by | Derived state |
|---|---|---|
| an open goal | `stop` (no gate) | closed; the `stop` relation leads goal → stop |
| the request (root) | ends when its goal is closed (`request_addressed`) or on `decline` (`request_unactionable`); the request has no `stop` | the run ends |

**The request is not closed in the IR.** There is no "accepted" node: the user's silence is
agreement, and an objective harness judges the run from outside. The request ends when its
goal is stopped or when the doxa declines it.

**Honesty.** The strength of a conclusion does not exceed the strength of its premises: a
run's `exitCode` is ordinary output; the request is never marked "achieved"; no hypothesis
is stored as an assumption.

---

## 7. Context: the message tape

The context is what the model sees on the next step. It looks like an ordinary tape of
messages but is **rebuilt from the tree every turn** — it is a projection, not an
accumulating transcript. The same events always give the same tape.

**Roles:** `system` (the base prompt plus the current node's instruction and the
constraints), `user` (the request), `assistant` (the doxa's moves), `tool` (command results).

**Moves and their messages:**

- `create_goal` — an `assistant` with the goal (`what`), then the first
  command: `assistant` (the call) + `tool` (the observation);
- `apply` — `assistant` (the call) + `tool` (the observation);
- `stop` — `assistant` with the reason (`why`): the goal is closed;
- `decline` — `assistant` with the reason (`why`): the request is declined;
- a refused structural move — a `tool` with the reason (`rejected <move>: <reason>`),
  transient for the next turn (no node); a `recall`/`search` result is likewise a transient
  `assistant` (its arguments) + `tool` pair.

So every plan item is a pair `assistant` + `tool`, while creating and closing a goal are
separate `assistant` messages. Alternative commands carry a marker
(`alternative to step "…" (previous attempt: "…" — reason)`). Each message exposes the node
id (`[id] …`) so a result can be addressed by id with `recall`/`search`.

**The tape is not monotone.** As soon as a goal closes, its internal messages leave the tape;
on its parent's arm only the closure message (`stop` with `why`) remains. Going up further —
the same. Only the view goes, not the data: the tree stays complete.

**The doxa's reasoning is not stored**: raw `thought` is not in the tree and does not enter
the tape; its meaning lives in the `why` fields.

**Working with data.** A result body is bounded by the tool itself, with a **per-tool** budget:
`read` is the big one (64K; bounded by bytes, no line cap), while `grep`/`list`/`run` are kept
small (8K) because they are pointers, not content. The `tool` message shows the tool's window
whole, never cutting its middle: an inspection result (`read`/`grep`/`list`) is consumed from
the beginning, so its head is kept; a command's output matters at its end, so `run` keeps its
tail. Only a body that still exceeds its tool's budget is bounded, with an omission note. The full body is stored as a file, and the node keeps an `outputRef`. Access is by
identifier, not by path: read a fragment with `recall { id, start, end }`, search the body with
`search { id, pattern }`.

**The system part** is assembled from the current node's intent, not as a monolith: the base
prompt holds only what is true on any move (role, contract, answer form, tool index, stream
discipline); the node instruction holds the admissible moves and the rules of the current
situation (a fresh request / an open goal); constraints are added there. This split is the
subject of a following stage (the composite system prompt).

---

## 8. Invariants

1. The journal only grows; nodes are not rewritten — only what we show changes.
2. The projection is deterministic: the same events give one context.
3. A goal is closed only through `stop`.
4. The doxa only proposes; the logos decides.
5. A command's exit code is ordinary output, not a closure verdict.
6. Every action is an alternative of exactly one item; a goal is a request's interpretation
   or an item's alternative.
7. `stop` is a relation on the goal, never a plan item.
8. A closed goal's internals leave the tape (only its closure message remains).

---

## 9. Open questions and non-goals

### 9.1 Open

- The exact boundary of the base prompt and the node prompts (§7) — the next stage.
- Re-formulate "the first unfulfilled item" once the item shape is settled in detail.
- The alternative marker is simplified; revisit if it proves too little.

### 9.2 Non-goals

No AST/symbol table, no embeddings, no CSP/arithmetic, no UI, no multi-language, no multiple
LLM providers. No `check`/`claim`/`decision`/`subgoal` node kinds; no criterion gate.
