# Skein — IR: formal semantics

> Russian mirror — `docs/ir_semantics_ru.md`.

> **Folded from the revision.** This document is now the source of truth for the IR shape,
> the doxa's operations and the context. It absorbed the working revision
> (`docs/ir_revision.md`, now removed) and supersedes the shape/operations/context parts of
> `docs/projection.md`, `docs/context_design.md` and `docs/plans/archive/traversal_stack_spec.md`.
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

**Status.** The doxa has **four operators** (`move`, `apply`, `stop`, `decline`);
`recall`/`search` are read-only addresses, not moves. A request is walked as a
**state machine over islands**: the doxa `move`s to a state (an island of work), declaring both
the island (`state`) and the state's goal text (`what`) — a state **is** its own goal — then
works it with `apply` (the first `apply` seeds the plan), and `stop`s it — which forces the next
transition decision. The states are the request's **flat children** (the `move` relation), each
carrying its own `what`; the plan hangs directly off the `move`. A state closes **only** through
`stop`. A plan holds **items**; an item holds **actions** (alternatives), never goals. The
context is a **message tape** rebuilt from the tree. The doxa proposes; the logos executes and
records. (docs/plans/archive/goal_into_move_plan.md.)

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
approach (alternative commands) and deepens where a state is worked by a plan.

---

## 1. Roles

| Role | Who | What it does | What it does not |
|---|---|---|---|
| **Doxa** | the LLM | proposes one or more operators per turn (a batch) | does not decide, does not derive |
| **Logos** | the deterministic engine, **including the environment and tools** | runs the commands; places the nodes and relations by the outcome; recomputes the derived view; builds the projection | does not infer truth; does not choose between equal options |
| **Arbiter** | external (a human; objectively, a toolchain) | the first request; the final acceptance of the run; the choice between equal hypotheses | does not produce content |

There is no separate protocol/environment role: execution and recording are part of the
logos. The logos's internal operators are `o_rev` (recount on change), `o_def`
(retract/refute), `o_ctx` (projection). There is no preference operator (`o_spec`).

Key consequences:

- **the doxa only proposes.** A proposal enters as a proposal (a state is open, a command has
  no result yet), never as an established fact;
- **the choice is from the admissible.** The logos deterministically offers the admissible
  moves at the current point; the doxa chooses one and fills it in;
- **a run is output, not a verdict.** A command's exit code is ordinary output the model
  reads; nothing is gated on it — the doxa closes the state with `stop`;
- **the request is not a goal.** It is raw, unstructured motivation, the root; the doxa walks
  it as a sequence of states (`move`) or declines it; acceptance stays external.

---

## 2. The IR tree

### 2.1 Nodes

Nodes fall into two spaces.

**The work space** — what the work is made of:

| kind | meaning |
|---|---|
| `request` | the arbiter's request: raw motivation (the root); walked as a sequence of states |
| `move` | the doxa's declaration of the state it will work in AND the state's goal text `what`; carries `state` (the island) and `what` (the state's goal); a child of the request; owns the plan |
| `plan` | a state's plan: an ordered list of items (≥1) |
| `item` | a plan item: an ordered list of alternatives (≥1) |
| `action` | a command; an alternative of an item (never a state) |
| `observation` | a command's result (a read window, run output + exit code) |
| `stop` | the mark that a state is closed |
| `unactionable` | the mark that the request has no actionable task |
| `constraint` | a restriction (payload `forbid`: regex paths) |
| `fact` | an engine-owned session fact (e.g. the environment probe; payload — the environment); no edges and no plan parent, projected on the tape |

**The artifact space** — what exists besides the work:

| kind | meaning |
|---|---|
| `file` | a file |

### 2.2 Relations

A relation is a named connection from one node to another; the name is the role the child
plays for its owner. Each node kind has a fixed set of admissible relations:

| Owner | Relation | To | Card. |
|---|---|---|---|
| `request` | `move` | `move` | 0 or more, in order (the LAST is the current state) |
| `request` | `unactionable` | `unactionable` | 0 or 1 |
| `move` | `plan` | `plan` | 0 or 1 (seeded by the first `apply`) |
| `move` | `stop` | `stop` | 0 or 1 (the state's closure) |
| `plan` | `items` | `item` | 1 or more, in order |
| `item` | `alts` | `action` | 1 or more, in order |
| `action` | `result` | `observation` | 0 or 1 |
| `action` | `mutates` | `file` | 0 or more |

The order of children is the order of addition; the current (chosen) child is the **last**
one. Two consequences:

- a state's closure lives on its `move`, in the relation `move.stop`;
- a `file` is the only node several actions may point at (`action.mutates`): a file has many
  owners, every other node has one.

### 2.3 The general shape

```
request --move--> move --plan--> plan --items--> item --alts--> action
```

Rules that follow:

- a plan item is **always** a list of alternatives with at least one element; with no
  branching the element is exactly one and it is a command (`action`);
- a state appears in only one way: the work hangs off the `move` (`move.plan`). A state is
  never an item's alternative, and the request has no goal of its own;
- **`what`.** A `move` carries `what` (the state's goal text). The **state** and its goal live
  together on the `move`. The plan is a separate `plan` node, seeded by the first `apply` with
  one item whose sole alternative is that first action.

### 2.4 The current node

At any moment there is a **current node** — the focus of work; every doxa operator is
relative to it. The focus is the top of the **traversal stack** (§2.6).

### 2.5 Status is derived

Nodes have **no stored status**; nodes are not edited, and there is no `stateOf`. The facts a
decision needs are read from nodes/relations:

- an action is **executed** ⇔ it has a produced child (`result`/`mutates`); otherwise the
  item is only planned;
- an action **succeeded** ⇔ it mutated a file, or its result observation is not a failure
  (a `failed` reason, or a non-zero `exitCode`; a missing `exitCode` is a timeout — no
  verdict);
- a state is **closed** ⇔ its `move` has a `stop` relation to a `stop` node; otherwise open;
- a `move` is **finished** ⇔ it has a `stop` relation to a `stop` node (the terminal state has
  no plan but is closed the same way); otherwise open;
- the request is **finished** ⇔ it has an `unactionable` node, or its current (last) `move` is
  the terminal state and is finished; the request is never closed by `stop`;
- **`movesOf(request)`** — the `move` children in order; **`currentMove(request)`** — the last;
  **`planOf(move)`** — the state's plan via `plan`; **`unactionableOf(request)`** — the node via
  `unactionable`; **`stopOf(move)`** — the stop node via `stop`;
- **`lastChild(container)`** — the current item/alternative (the last child);
- an item is **fulfilled** ⇔ its current (last) alternative is an executed, succeeded action;
  the **cursor** is the first unfulfilled item. (An item's alternatives are actions only; a
  nested state alternative no longer exists.)

There are **no truth predicates** (`achieved`/`refuted`/`abandoned`) and **no criterion**.
A run by itself settles nothing: a state is closed only by the doxa's `stop`. These are
`project`/read rules, not fields. Only the journal is monotone (§3).

A `move`'s `state` and `what` are different in kind: they are **authored** by
the doxa at `move` and never change. They record which island of work the state is entered in
and its goal text. They are not a derived status: the island never closes a state (closure stays
with `stop`, §8) and never gates a `move`. It does delimit the **action surface** of the open
state — the apply-tools the island admits (`Island.applies`, §2.6) — so a tool outside the
state's work is refused (`not_in_state`); the island is a self-declared mode, held by the engine,
not a criterion gate.

### 2.6 The stack and traversal

Traversal is the deterministic part of the logos. It does **not** choose what to do; it
computes the *admissible* moves at the current point; the doxa chooses among them.

**The stack** `S = [R, M]`: the root request and the current `move` (the state in focus, which
is its own goal). **The cursor** is the index of the first unfulfilled item of the `move`'s
plan. Neither is stored: the stack is a fold of the focus events (`descend`/`return`, journal
append-only); the cursor is computed from the plan.

Deterministic movement:

- **descend** `R → M` — on `move`, push the `move`; focus → `M`. The states are **flat**
  children of the request: a new `move` after a finished state is a new child (a sibling of the
  previous state), never nested under it;
- **advance** — executing an action item changes nothing about the stack; the cursor moves on
  its own;
- **return** `M → R` — when the next `move` is emitted, the finished state is left behind (a
  sibling is pushed in its place).

The engine hands the doxa **the admissible moves at the focus**. One computation feeds both the
projection and `classify`.

**The admissible moves:**

| Focus | Admissible | Meaning |
|---|---|---|
| request with no `move` yet | `move`, `decline` | choose the first state (or decline) |
| an open state (no plan yet: `plan`) | `apply`, `stop` | give the first plan item — the first `apply` seeds the plan |
| an open state (plan has items: `working`) | `apply`, `stop` | continue the work; `stop` closes the state |
| a finished state (`transition`) | `move` | the forced transition decision |
| the terminal state (`end`, `terminal`) | `stop` | the request is complete |

### 2.7 How a command enters the tree

`apply` is a tool call. The logos runs the command and **always** records its outcome as an
observation; the doxa reads the observation and chooses the next move; the logos only places
the incoming move.

The **outcome of the current item** is read from its current alternative, which is always a
**command**: its observation carries a result (**success**), or a reason (**failure**: the tool
could not run, the admissibility check failed it, or the run returned a non-zero code, or a
timeout — **no verdict**).

**Where the next move goes** (the logos places it by that outcome; the doxa chooses the
command):

- after **success** — as a **new plan item**;
- **otherwise** — as a **new alternative of the current item**.

Bootstrap: `move` declares the state and its goal; the first `apply` seeds the state's plan
with one item and runs its action at once (the logos); the state is born with its first item
executed. Every attempt leaves new nodes; an existing node is neither reused nor edited — the
journal stays monotone.

**Structural moves.** `move`, `stop` and `decline` are not a command execution
but a change of the tree. If such a move is inadmissible, it is **refused**: no node is created,
and the reason reaches the doxa as a message on the tape next turn (`rejected <move>:
<reason>`). So is a **bare** addressed `recall` refused as redundant. A command has no such
refusal: its non-execution (a repeat, a stale base, a forbidden path, an empty command) arrives
as an **observation with a reason**.

### 2.8 Loop detection

Looping is not a separate sensor but an **absence of progress**. Progress at a point is a
cursor shift, **new knowledge** (a new observation or a new outcome, or a fragment retrieved
by `recall`/`search`), a closure, or a **new `move`** (a change of state). The
layers are deterministic: a **repeat action** (the same command with the same inputs and an
unchanged world) is refused and its observation names the existing result; **stagnation**
(the cursor does not shift, the `move` does not change, and there is no new knowledge for
`K` turns) returns to the parent; **exhaustion** without progress
at the root stops the run (`no_progress`). A change of state is progress, so a run that keeps
entering new islands is not stalled. The projection can also carry a soft attractor keyed to
the **turns since the last `move`** (§7, docs/plans/archive/state_protocol_plan.md §4a).

---

## 3. Journal and folding

- **The journal** (`Event[]`) is the single truth; it is only appended to.
- **State** — `fold(journal)`, derived.
- **Projection** — `project(state)`, derived; exactly what the model sees.

The event vocabulary is closed: `add_node`, `add_edge`, `descend`, `return`, `mutate`,
`record_rejection`. A state change is a **new event** (a `move` node, an `observation`,
`mutate`, `stop`), never an edit; there is no `set_status` and no `record_check`. A command's
failure is never forgotten: it materializes as an observation flagged `failed` (and, for a
non-execution, `refused`).

Determinism: the same events and parameters give one state and one projection. The only
external source is file changes; they enter through `mutate`.

---

## 4. Doxa operators

The doxa has **four operators** (`move`, `apply`, `stop`, `decline`); `recall`
and `search` are read-only addresses, not moves. Each is described by one template: purpose →
applies to → input → action → focus → refusal.

### 4.1 `move`

Declares the state (the island of work) the doxa will work in — the automaton's transition.

**Input.** `{ state, what }`: `state` — one of the island names the base prompt lists (the
**first** move picks the opening state; later moves the next one); `what` — the concrete goal of
**this state** (required except for the terminal `end`, which has no plan).

**Action.** Create a `move` node `M` with payload `{ state, what }`; link it as the
request's newest `move` child (`R.move += M`); emit `descend` `R → M`. Focus moves to `M`. The
move declares the state AND its goal: the plan hangs directly off `M`. The move is legal at a
**fresh request** (no `move` yet) or at a **finished state** (a `move` with a `stop`). It is
refused while a state is still open (`state_open`) or with a bad state name (`empty_state`).

**Focus.** The focus becomes `M`; the next admissible moves are `apply` (the first call seeds
the plan) and `stop`; at the terminal state (`end`, no plan) only `stop`.

### 4.2 `apply`

Runs one command in the current state.

**Input.** `{ tool, … }`, where `tool` is one of `read`/`grep`/`list`/`edit`/`write`/`run`/
`fetch`/`apply_patch`, plus the tool's parameters.

**Action.** The command runs; the outcome is recorded as `A.result = observation` (read,
grep, list, run) or `A.mutates += file` (an edit) — or, when it did not run, an observation
with a reason. Placement is by the outcome of the current item (§2.7). The **first** `apply` in
an open state seeds the state's plan: it creates the `plan` and its first `item`, of which the
command is the sole alternative. Focus does not move. `apply` is admissible only inside an open
state; elsewhere it is refused (`no_state`).

### 4.3 `stop`

Closes a state — the only way to finish it.

**Input.** `{ why? }` — the reason.

**Action.** If the focus is an open **state** (a `move` not yet stopped), create a `stop` node
`S` and link `M.stop = S`: the state is finished; the next decision is the transition (§4.1).
If the focus is the **terminal state** (`end`, which has no plan), the same `stop` ends the
request (`request_addressed`). There is **no criterion gate**: the doxa closes the state while
working. `stop` at the request (or at an already-finished state) is refused (`not_addressed`).

### 4.4 `decline`

Finishes a request whose intent is not actionable, inventing no state.

**Input.** `{ why? }` — the reason. **Applies to.** A fresh request.

**Action.** Create an `unactionable` node `U`; link `R.unactionable = U`. No `move` or plan is
created. Focus ends the run (`request_unactionable`). On a `move` — `not_request`; on an
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
| an open state | `stop` (no gate) | closed; the `stop` relation leads move → stop; the state is finished, focus stays on its `move` |
| the terminal state (`end`) | `stop` (no gate) | closed; the `stop` relation leads move → stop; the request ends (`request_addressed`) |
| the request (root) | ends when the terminal state is stopped (`request_addressed`) or on `decline` (`request_unactionable`); the request has no `stop` | the run ends |

**The request is not closed in the IR.** There is no "accepted" node: the user's silence is
agreement, and an objective harness judges the run from outside. The request ends when its
terminal state is stopped or when the doxa declines it.

**Honesty.** The strength of a conclusion does not exceed the strength of its premises: a
run's `exitCode` is ordinary output; the request is never marked "achieved"; no hypothesis
is stored as an assumption.

---

## 7. Context: the message tape

The context is what the model sees on the next step. It looks like an ordinary tape of
messages but is **rebuilt from the tree every turn** — it is a projection, not an
accumulating transcript. The same events always give the same tape.

**Roles:** `system` (the stable base prompt, the constraints, each state's `instruction` — shown
once when the state is entered — and, appended last and temporary, the current situation's
instruction), `user` (the request — it **leads** the tape, on every turn — and each state's goal),
`assistant` (the state markers and the doxa's calls), `tool` (command results).
The **working steps** use the native tool-calling contract: an `apply` is an `assistant` with
`tool_calls` (the tool name and arguments), its result a `tool` with `tool_call_id`. A batch is
one `assistant` with N `tool_calls`, then the N `tool` results in order. A **state change**, by
contrast, is not a tool call (see below). The names and arguments are the model-facing **native**
ones (`read` `edit` `write` `grep` `list` `bash` `webfetch` `apply_patch` `move` `recall`
`search` `stop` `decline`) — `modelCall` renders the IR `apply` back into them and `toProposal`
maps the reverse, so the tape and the callable schema share one vocabulary (the IR keeps
`path`/`start`/`end`, `find`/`replace`, `fetch`).

**States and their messages:**

- `fact` — a session fact, not a call and not a separate message after the request. The
  projection emits the block as a `system` turn before the **current** state's goal (`user`). One
  `fact:session` carries `{ environment, material }`: available tools (with versions where they
  are cheap), VCS status, top-level entries/paths and the file count. Orientation gets
  `Workspace` (the map); Localization and Research get the same map as `Orientation result`
  (Research also gets `Probe`); Patch gets it as `Workspace`; other states get `Probe`
  (environment) under its own heading.
  Configs, build commands, extensions and build state are not shown in Orientation; a declared
  command is not presented as the acceptance. Closed states carry no block. The source is an
  `add_node kind:"fact"` event recorded once at request start (`src/loop/probe.ts`); replay
  reads the recorded fact instead of probing again;
- `move` — a state is a decision, not a tool call, so it has **no tool call**: it renders as a
  `Start state <label>` marker (an `assistant` turn), then the state's `instruction` (a `system`
  turn), then the state's goal as a `user` turn (`what: <the island's goal>`). The doxa's
  `move.what`/`move.notes` are **not** shown: the goal comes from the island definition. The
  request is the second message of the tape (right after the base prompt), on **every** turn —
  never dropped;
- **returning to Localization or Patch.** For the **current open** `localization` or `patch`
  state, right after `Start state` comes a `system` "Previous failed attempt" message: the actual change of the last
  `patch` (from `payload.call`) and the failed `verification`'s `stop.why` — the doxa's literal
  retelling of the failure (command, exit, actual error), not a code diagnosis and not the
  mechanical last failing command/tail. It is a projection of existing events
  (`mutates`/`observation`/`stop`), not a status
  or a gate; `stop` still closes only by the doxa. Only the last attempt is shown (earlier ones
  remain on the tape as `Finish state` lines);
- `apply` — `assistant` with `tool_calls` (the tool name and arguments) + `tool` (the
  observation); the **first** `apply` after a `move` seeds the state's plan (a `plan` + one
  `item`), so the first plan item is an ordinary tool call;
- `stop` — the state's closure renders as a `Finish state <label> — <why>` marker (an `assistant`
  turn), read from the `move.stop` relation; it adds no tool call. At the terminal state `stop`
  ends the request;
- `decline` — `assistant` with the reason (`why`): the request is declined;
- a refused structural move — a transient `assistant` (the call that was refused) + `tool`
  with the reason (`rejected <move>: <reason>`, next turn; no node). A `recall`/`search` is a
  regular step: an `action` + its `observation` on the state's tape (see above).

So a **state** is `Start state <label>` / `instruction` (`system`) / goal (`user`) / `Finish state
<label>` and, while it is open, its plan (the `apply` calls and their results). Alternative commands carry a
marker (`alternative to step "…" (previous attempt: "…" — reason)`), where `reason` is **one
line** referencing the observation (`see [obsId]`), never an inlined body. Each `apply` result
exposes the node id (`[id] …`) so it can be addressed by id with `recall`/`search`.

**The tape is not monotone.** A finished state — the current one awaiting the transition, or one
already left behind — collapses to `Start state <label>` / `instruction` / goal / `Finish state
<label> — <why>`; its plan turns (the `apply` calls and their results) leave the tape. Only the
view goes, not the data: the tree stays complete.

**The doxa's reasoning is not stored**: raw `thought` is not in the tree and does not enter
the tape; its meaning lives in the `why` fields.

**Working with data.** A result body is bounded by the tool itself, with a **per-tool** budget:
the `read` window is 8K (bounded by bytes, no line cap), while `grep`/`list`/`bash` are kept
small (8K) because they are pointers, not content; a larger fragment of a file comes back as a
`read` window or via `recall` (a 64K budget). `grep` and `search` return **plain text with line
numbers** (`path:line:match`, context `path-line-text`, like `grep -n`), not JSON: there is no
structural scaffolding for the model to parse instead of code. The `tool` message shows the tool's window
whole, never cutting its middle: an inspection result (`read`/`grep`/`list`) is consumed from
the beginning, so its head is kept; a command's output matters at its end, so `run` keeps its
tail. Only a body that still exceeds its tool's budget is bounded, with an omission note. The full body is stored as a file, and the node keeps an `outputRef`. Access is by
identifier, not by path: read a fragment with `recall { id, start, end }`, search the body with
`search { id, pattern }`. A command killed by a **signal** renders `killed by <SIG> (core: …)`
(or `no core: core_pattern …`) plus the backtrace, so a crash reaches the model, not just a
nonzero exit.

**The system part** is assembled per situation, not as a monolith: the base prompt holds only
what is true on any turn (the role, the principles, the contract, the state set and its
transitions); appended last each turn (temporary, never stored) is the current situation's
instruction per situation: `request` (choose the first state, or `decline`; `what`/`done` — from the
request), `plan` (the state's first step), `working` (`turnInstruction`: the criterion named
explicitly — "This state's done criterion: "<criterion>". When it holds, call `stop`;
do not over-work the state"), `transition` (`transitionInstruction(island)`: the source of
`what`/`done` is the `Finish state <label>` line of the just-finished state; the `next` neighbours
are listed; choose the next state), `terminal` (call `stop` when the request is complete). The tool names/parameters/descriptions
are **not** in the prompt — they ship in the request's `tools` field, and that field is **bound
from `Context.applicable`**: on a `request`/`transition` only `move` is offered (plus read-only
`recall`/`search`), while a state is open the apply tools and `stop` are offered, so a move the
engine would refuse cannot be called at all (the `propose` path passes `toolNamesFor(applicable)`
as `allowedTools`).

---

## 8. Invariants

1. The journal only grows; nodes are not rewritten — only what we show changes.
2. The projection is deterministic: the same events give one context.
3. A state is closed only through `stop` (the terminal state included).
4. The doxa only proposes; the logos decides.
5. A command's exit code is ordinary output, not a closure verdict.
6. Every `move` is a child of the request and carries its own goal (`what`); the plan hangs off
   the `move`; every action is an alternative of exactly one item. A state is never an item's
   alternative, and the request has no goal of its own.
7. `stop` is a relation on the `move`, never a plan item.
8. A closed state's plan turns leave the tape: only `Start state <label>` / `instruction` / goal /
   `Finish state <label> — <why>` remains (§7).
9. A `move`'s `state` is the doxa's authored label: it never gates a `move` and never closes a
   state (closure is `stop` alone). It delimits the open state's action surface — the tools the
   island's `applies` admits; a tool outside it is refused (`not_in_state`), but the doxa can
   always leave the mode with a `move`.
10. The request ends when the terminal state (`end`) is stopped, or when it is declined;
    there is no `stop` on the request.

---

## 9. Open questions and non-goals

### 9.1 Open

- The exact boundary of the base prompt and the node prompts (§7) — the next stage.
- Re-formulate "the first unfulfilled item" once the item shape is settled in detail.
- The alternative marker is simplified; revisit if it proves too little.

### 9.2 Non-goals

No AST/symbol table, no embeddings, no CSP/arithmetic, no UI, no multi-language, no multiple
LLM providers. No `check`/`claim`/`decision`/`subgoal` node kinds; no criterion gate.
