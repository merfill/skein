# Skein — the IR: model, semantics and operator registry

> Russian mirror — `docs/ru/ir.md`.

This document is the source of truth for the intermediate representation (IR). It defines the
shape of the IR, the operators available to the doxa, the derived state, the projection, the
invariants, and the stable operator registry used by the coverage gate. For orientation, see
`docs/en/concepts.md`; for the message tape in detail, `docs/en/projection.md`; for a worked
example, `docs/en/walkthrough.md`; for the tool surface, `docs/en/tools.md`.

A change of behaviour proceeds in three steps: (1) amend the semantics here; (2) change the
code; (3) add a test that pins the invariant the change preserves. A code change without the
first step is incomplete.

## Status

The doxa has four operators: `move`, `apply`, `stop` and `decline`. `recall` and `search` are
read-only addresses, not moves. A request is executed as a state machine over islands. The doxa
`move`s into a state — an island of work — declaring the island (`state`); a state is its own
goal. It may also record an unverified note about the concrete subject (`what`). The doxa then
works the state with `apply` and closes it with a text reply, recorded as `stop`, which forces
the next transition decision. States are flat children of the request (`move`); each carries its
own `what`. A state's turns hang directly off its `move`. A state closes only through the doxa's
`stop`. The turns of a state form a monotone list of actions, each with its observation or
mutation; there are no plan items or alternatives. The model sees a message tape rebuilt from the
tree on every turn. The doxa proposes; the logos executes and records.

## 0. Principle: semantics as operations on the IR tree

Every behaviour of the system is described as an operation on the IR tree. Such a description
specifies five things:

1. which nodes and relations are created;
2. where the current node — the focus of work — moves;
3. which derived facts change;
4. what the next projection shows;
5. which invariants continue to hold.

The rule applies equally to moves proposed by the doxa and to reactions of the logos. New
behaviour is a new operation described in this form; it is never an edit of state around the
journal. The tree is not given in advance: it is the trace of operations. It grows where work is
done, and every tool call appends one turn — an action together with its outcome — to the
monotone list of the current state.

## 1. Roles

| Role | Agent | Responsibility | Limit |
|---|---|---|---|
| **Doxa** | the language model | proposes one or more operators per turn (a batch) | does not decide and does not derive |
| **Logos** | the deterministic engine, including the environment and tools | executes commands, places nodes and relations, recomputes the derived view, builds the projection | does not establish truth and does not choose among equal alternatives |
| **Arbiter** | external (a human, or objectively a toolchain) | issues the first request, accepts the final result, chooses among equal hypotheses | does not produce content |

Execution and recording belong to the logos; there is no separate protocol or environment role.
Four consequences follow.

- The doxa only proposes. A proposal enters as a proposal — a state is open, a command has no
  result yet — and never as an established fact.
- Choice is made among admissible alternatives. The logos determines the admissible moves at the
  current point; the doxa selects one and supplies its content.
- A run is output, not a verdict. The exit code of a command is ordinary output read by the
  model; no decision is gated on it, because the doxa closes the state with `stop`.
- The request is not a goal. It is raw, unstructured motivation and the root of the tree. The
  doxa either walks it as a sequence of states (`move`) or declines it. Acceptance remains
  external.

## 2. The IR tree

### 2.1 Nodes

Nodes belong to two spaces.

**Work space.** Nodes that constitute the work:

| Kind | Payload | Role |
|---|---|---|
| `request` | `{ text }` | raw motivation; the root; walked as a sequence of states; ends when the terminal state is stopped |
| `move` | `{ state, what, done? }` | the state declared by the doxa, together with its note; a flat child of the request; owns the turns |
| `turns` | — | the turns of a state: an ordered list of actions (at least one) |
| `action` | `{ tool, … }` | a command; one turn of the open state, never a state |
| `observation` | `{ ref?, version?, command?, exitCode?, output/error/…, failed?, refused? }` | the result of a command; `exitCode` is ordinary output, not a closure oracle |
| `stop` | `{ why?, error? }` | marks that a state is closed |
| `unactionable` | `{ why? }` | marks that the request has no actionable task |
| `constraint` | `{ forbid: string[] }` | a restriction on paths, seeded at the start of a run |
| `fact` | `{ environment, material }` | an engine-owned session fact, such as the environment probe; it has no edges and is projected onto the tape |
| `hint` / `memo` | advisory | a state-scoped `hint` or a unit-scoped `memo`; neither is knowledge about the task |

**Artifact space.** Nodes that exist beside the work:

| Kind | Role |
|---|---|
| `file` | a referenced file, produced by `mutates`; `symbol` and `test` are reserved and never produced |

### 2.2 Relations

A relation is a named connection from one node to another; its name states the role the child
plays for its owner. Each node kind admits a fixed set of relations.

| Owner | Relation | Target | Cardinality |
|---|---|---|---|
| `request` | `move` | `move` | zero or more, in order; the last is the current state |
| `request` | `unactionable` | `unactionable` | zero or one |
| `move` | `turns` | `turns` | zero or one, seeded by the first `apply` |
| `move` | `stop` | `stop` | zero or one, the closure of the state |
| `turns` | `turn` | `action` | one or more, in order |
| `action` | `result` | `observation` | zero or one |
| `action` | `mutates` | `file` | zero or more |

Children are ordered by addition; the current child is the last one. A state's closure is stored
on its `move`, in the relation `move.stop`. A `file` is the only node that several actions may
point to.

### 2.3 General shape

```
request --move--> move --turns--> turns --turn--> action --result--> observation
                                                     \--mutates--> file
```

Three rules follow.

- The turns container is always a monotone list with at least one action. Each action is one
  turn, carrying either a `result` observation or `mutates` files.
- A state appears in exactly one way: its work hangs off the `move` through `move.turns`. A
  state is never a turn, and the request has no goal of its own.
- The `what` field of a `move` is the doxa's note about the concrete subject — a guess that may
  be wrong. The goal of the state is the definition of its island. The first `apply` seeds the
  turns container with its first action; every later `apply` appends the next turn.

### 2.4 The current node

At every moment there is a current node, the focus of work, relative to which every doxa
operator is interpreted. The focus is the top of the traversal stack (§2.6): the root request
and the current `move`.

### 2.5 Derived status

Nodes carry no stored status; they are never edited, and there is no `stateOf`. Every fact needed
for a decision is read from nodes and relations.

- An action is **executed** if and only if it has a produced child (`result` or `mutates`);
  otherwise it has only been proposed.
- An action **succeeded** if and only if it mutated a file, or its result observation is not a
  failure. A failure is marked `failed` or has a non-zero `exitCode`; a missing `exitCode`
  denotes a timeout and carries no verdict.
- A state is **closed**, and therefore **finished**, if and only if its `move` has a `stop`
  relation to a `stop` node. The terminal state has no turns but is closed in the same way.
- The request is **finished** if and only if it has an `unactionable` node, or its current
  (last) `move` is the terminal state and that state is finished. The request is never closed by
  `stop`.
- `movesOf(request)` returns the `move` children in order; `currentMove(request)` returns the
  last of them; `turnsOf(move)` returns the turns container through `turns`;
  `unactionableOf(request)` returns the node reached through `unactionable`; `stopOf(move)`
  returns the stop node reached through `stop`.
- `lastChild(container)` returns the last appended child, that is, the current state or the
  latest turn.
- The turns of a state are read in the order of addition. There is no cursor and no predicate
  that marks a turn as fulfilled.

There are no truth predicates (`achieved`, `refuted`, `abandoned`) and no criterion. A run by
itself establishes nothing: a state is closed only by the doxa's `stop`. These are rules of
reading, not stored fields. Only the journal is monotone (§3).

The fields `state` and `what` of a `move` are authored by the doxa and never change. They are not
derived status. The island never closes a state and never gates a `move`. It does delimit the
action surface of the open state, that is, the apply-tools the island admits (`Island.applies`).
A tool outside that surface is refused with `not_in_state`. The island is therefore a
self-declared mode held by the engine, not a criterion gate.

### 2.6 The stack and traversal

Traversal is the deterministic part of the logos. It does not choose what to do; it computes the
admissible moves at the current point, and the doxa chooses among them.

The stack is `S = [R, M]`, where `R` is the root request and `M` the current `move`. The stack is
not stored; it is the fold of the focus events `descend` and `return` over the append-only
journal. The turns of a state are the ordered children of its `turns` node.

- **Descend** `R → M`: a `move` pushes the new `move` and moves the focus to `M`. States are flat
  children of the request; a `move` after a finished state becomes a sibling of the previous
  state, never a child of it.
- **Append**: executing an action does not change the stack; it appends the next turn.
- **Return** `M → R`: when the next `move` is emitted, the finished state is left behind.

The admissible moves at each focus are the following.

| Focus | Admissible | Meaning |
|---|---|---|
| request with no `move` | `move`, `decline` | choose the first state, or decline |
| open state (`working`) | `apply` | append the next turn; the first `apply` seeds the turns |
| finished state (`transition`) | `move` | the forced transition decision |
| terminal state (`end`, `terminal`) | none | a text reply completes the request |

### 2.7 How a command enters the tree

An `apply` is a tool call. The logos executes the command and always records its outcome as an
observation. The doxa then reads the observation and chooses the next move.

Every `apply` is a turn. The logos executes the command, records its outcome — a result, a
reason or a timeout, never a verdict — and appends the action to the state's turns in order.
There is no cursor and no grouping of retries. A failed turn is followed by whatever the doxa
proposes next, and both turns remain on the tape.

The state is created as follows. A `move` declares the state. The first `apply` creates the turns
container and appends its first action immediately. Every call leaves new nodes; an existing node
is never reused or edited, so the journal remains monotone.

**Structural moves.** `move`, `stop` and `decline` are not executions of commands but changes of
the tree. If such a move is inadmissible, it is refused: no node is created, and the reason
reaches the doxa on the tape of the next turn as `rejected <move>: <reason>`. A command has no
such refusal. Its non-execution — a repeat, a stale base, a forbidden path or an empty command —
is recorded as an observation with a reason.

### 2.8 Loop detection

A repeated action — the same command with the same inputs against an unchanged world — is refused,
and its observation names the existing result. There is no deterministic `no_progress`, and the
projection contains no soft attractor. Loops are detected by `RequestObserver` triggers:
`state_cycle` on the third entry into the same island, `state_long` after nine turns in one
state, and `budget` near `max_turns`. In `patch`, `research`, `construction` and `end`, when
`max_turns` is reached, the engine grants `G` additional turns once (`SKEIN_GRACE_TURNS`,
default 5); otherwise `max_turns` ends the run.

## 3. Journal and folding

Three layers are distinguished.

- The **journal** (`Event[]`) is the single source of truth and is append-only.
- The **state** is `fold(journal)` and is derived.
- The **projection** is `project(state)` and is derived; it is exactly what the model sees.

The event vocabulary is closed: `add_node`, `add_edge`, `descend`, `return`, `mutate`, `revert`,
`rollback` and `record_rejection`. A change of state is a new event — a `move` node, an
`observation`, a `mutate` or a `stop` — never an edit. There is no `set_status` and no
`record_check`. A command failure is never discarded: it materialises as an observation marked
`failed`, and a non-execution as one marked `refused`.

The system is deterministic: the same events and parameters yield one state and one projection.
The only external source is a change of files, and such a change enters through `mutate`.

## 4. Operators of the doxa

The doxa has four operators: `move`, `apply`, `stop` and `decline`. `recall` and `search` are
read-only addresses, not moves. Each operator is specified by its precondition, its effects on
the journal and the tree, the derived facts it changes, the reasons for which `classify` may
refuse it, and its projection. Each specification carries a stable identifier, which a test
cites as the `ID` token in its title.

The identifier families are: `OP-MV` for `move`; `OP-CG` for the first turn of a state, created
by its first `apply`; `OP-AP-READ`, `OP-AP-GREP`, `OP-AP-LIST`, `OP-AP-EDIT`, `OP-AP-WRITE`,
`OP-AP-RUN`, `OP-AP-FETCH` and `OP-AP-PATCH` for the apply sub-tools; `OP-AP-PLACE` for the
placement of an `apply` in the tree; `OP-ST` for `stop`; `OP-DC` for `decline`; `OP-RC` and
`OP-SR` for `recall` and `search`; `TR` for traversal and containers; `DER` for derived facts;
`REF` for refusals; and `PRJ` for projection points.

### 4.1 `move`

A `move` declares the state — the island of work — in which the doxa will work. It is the
transition of the automaton.

**Input.** `{ state, what }`. The field `state` is one of the island names listed in the base
prompt: the first move selects the opening state, later moves select the next one. The field
`what` is an optional note about the concrete subject — a guess that may be wrong, not the goal
of the state.

**Action.** The engine creates a `move` node `M` with payload `{ state, what }`, links it as the
newest `move` child of the request, and emits `descend` from `R` to `M`. The focus moves to `M`.
A `move` is legal at a fresh request, that is, when there is no `move` yet, and at a finished
state, that is, a `move` that carries a `stop`. It is refused while a state is still open
(`state_open`) or when the state name is invalid (`empty_state`).

| Case | Precondition | Effects | Derived facts | Refusals | ID |
|---|---|---|---|---|---|
| open a state | the focus is the request and no `move` exists | add `move` (`state`, `what`); add the relation `move` from request to move; emit `descend` | the state is declared; the focus is the `move`; its turns are empty until the first `apply` | `empty_state` | `OP-MV-1` |
| transition to the next state | the current state is finished, that is, stopped | add a `move` as a new child of the request, a sibling of the previous state; emit `return` out of the finished state, then `descend` | the finished state is left behind; the focus is the new `move` | `empty_state`, `state_open` | `OP-MV-2` |
| enter the terminal state | the state is `end` | as above, without `what`; the terminal state accepts `stop` directly (`OP-ST`) | entering the terminal state marks the end of the run | `empty_state` | `OP-MV-3` |

- **Projection** (`PRJ-MV`): an open state renders a `Start state <label>` marker (an
  `assistant` turn), the `instruction` of the state (a `system` turn) and its goal (a `user`
  working prompt). Once the state is stopped, only `Start state <label>` and `Finish state
  <label> — <why>` remain, the latter read from the relation `move.stop`; the brief,
  instruction, goal and turn messages are elided (§7).
- A `move` is refused while a state is still open (`state_open`). The engine does not gate a
  `move` on a criterion: the doxa decides when a state is finished, by stopping it, and where to
  go next. The field `what` is required except for the terminal state `end`.

### 4.2 `apply`

An `apply` executes one command in the current state. It also gives birth to the state's turns:
the first `apply` after a `move` creates the `turns` container and its first `turn`
(`OP-CG-1`). That first turn is an ordinary tool call, not a separate operator.

**Input.** `{ tool, … }`, where `tool` is one of `read`, `grep`, `list`, `edit`, `write`, `run`,
`fetch` or `apply_patch`, together with the parameters of that tool.

**Action.** The command runs. Its outcome is recorded either as `A.result = observation`, for
`read`, `grep`, `list` and `run`, or as `A.mutates += file`, for `edit`; if the command did not
run, the outcome is an observation with a reason. The action is appended to the state's turns
(§2.7). The first `apply` in an open state creates the `turns` container and its first `turn`.
The focus does not move. An `apply` is admissible only inside an open state; elsewhere it is
refused with `no_state`.

**Placement.** Every `apply` appends exactly one turn to the `turns` of the open state, in order
(`OP-AP-PLACE-1`). After a carried-out turn, the next `apply` appends the next turn
(`OP-AP-PLACE-2`). There is no layer of items or alternatives and no cursor. The engine never
enters the action.

**Batches.** The engine accepts one or more calls per move and applies them in order within the
same turn, sharing `payload.turn`. A terminal move (`move`, `stop` or `decline`) ends the batch,
so anything the model emits after it is discarded (`src/loop/graph.ts`, `executeNode`). The
projection renders a batch as one `assistant` message with N `tool_calls` followed by N `tool`
results (§7).

| Case | Precondition | Effects | Derived facts | Refusals | ID |
|---|---|---|---|---|---|
| first turn | the focus is a non-terminal `move` with no turns | the `apply` creates the `turns` node and its first `turn` for any tool; the engine executes it immediately | the state acquires its turns; the first turn is executed | none; an empty `bash` is a failed observation, `REF-RUN-EMPTY` | `OP-CG-1` |
| next turn | the focus is an open state that has turns | the `apply` appends the next `turn` (`OP-AP-PLACE-1`); after a carried-out turn, the next `apply` appends the next turn (`OP-AP-PLACE-2`) | the turns grow in the order of addition | `no_state` | `OP-AP-PLACE-1`, `OP-AP-PLACE-2` |

#### 4.2.1 `read` (`OP-AP-READ`)

| Case | Precondition | Effects | ID |
|---|---|---|---|
| new window | the path exists and the world is unchanged since an identical earlier read | add an `action`; add an `observation` as its `result`; record the observed version | `OP-AP-READ-1` |
| continued window | a different `start` or `end` | a new action and observation | `OP-AP-READ-2` |
| missing file | — | an action and a failed observation | `OP-AP-READ-3` |
| repeat | an identical window against an unchanged world | an action and an observation whose reason is `repeated_action`, naming the stored identifier | `OP-AP-READ-4` |
| path outside the workspace | — | an action and a failed observation, without a crash | `OP-AP-READ-5` |
| repeated windows of one file | several different windows of the same file | each different window is a new action and observation, with no per-file limit; an identical window is `OP-AP-READ-4` | `OP-AP-READ-6` |
| large window | the requested window exceeds the byte limit | the observation shows the whole window and never drops its middle; only a single over-long line is clipped, while the full window remains behind `outputRef` and is recalled by `recall` | `OP-AP-READ-7` |
| window beyond the budget | the file is longer than the byte budget | the window is cut at whole lines up to `READ_LIMIT`; a `continue from N` trailer points to the next window | `OP-AP-READ-8` |

#### 4.2.2 `grep` (`OP-AP-GREP`)

| Case | Precondition | Effects | ID |
|---|---|---|---|
| scoped search | `path`, `include` and `exclude` are valid | an action and an observation with plain-text windows | `OP-AP-GREP-1` |
| paging | `from` and `count` | a new action and observation; a repeat of the same pattern from a new `from` is new | `OP-AP-GREP-2` |
| no hits or a bad scope | — | an empty result, or a failed observation | `OP-AP-GREP-3` |
| repeat | an identical scope and pattern against an unchanged world | refused with `repeated_action` | `OP-AP-GREP-4` |
| match window beyond the budget | a window would exceed the byte limit | whole trailing matches are dropped so that the window fits; a trailer `[showing N of M matches; continue from K]` points to the continuation; a single very large match is clipped by lines | `OP-AP-GREP-5` |
| count limits | `count` is absent or too large | the window is at most `GREP_COUNT_DEFAULT` (50) and never exceeds `MAX_GREP_MATCHES` (100) | `OP-AP-GREP-6` |

#### 4.2.3 `list` (`OP-AP-LIST`)

| Case | Precondition | Effects | ID |
|---|---|---|---|
| list scope | — | an action and an observation with paths as JSON | `OP-AP-LIST-1` |
| paging or empty result | `from` and `limit` | a new action and observation | `OP-AP-LIST-2` |
| page beyond the budget | a page would exceed the byte limit | whole trailing files are dropped so that the JSON fits; `returned` is below the page size and `next` is set | `OP-AP-LIST-3` |
| limit caps | `limit` is absent or too large | the page is at most `LIST_LIMIT_DEFAULT` (100) and never exceeds `MAX_LIST_FILES` (200) | `OP-AP-LIST-4` |

#### 4.2.4 `edit` (`OP-AP-EDIT`)

| Case | Precondition | Effects | Derived facts | Refusals | ID |
|---|---|---|---|---|---|
| replacement | the file was read and is unchanged since that read, and is not forbidden | add an `action` with `find` and `replace`; emit `mutate` for each changed file | file versions change; dependent facts become stale | `stale_base`; a forbidden pattern | `OP-AP-EDIT-1` |
| `find` absent | — | an action and a failed observation; the file is materialised and pinned | — | — | `OP-AP-EDIT-2` |
| forbidden path | a constraint forbids the path | — | — | a forbidden pattern | `OP-AP-EDIT-3` |
| stale base | the file changed after the last read | — | — | `stale_base` | `OP-AP-EDIT-4` |
| path outside the workspace | — | a failed observation, recorded as a refusal without a crash | — | — | `OP-AP-EDIT-5` |

#### 4.2.5 `run` (`OP-AP-RUN`)

A `run` is a single foreground command. There is no criterion, no `target` and no background-job
machinery.

| Case | Precondition | Effects | Derived facts | Refusals | ID |
|---|---|---|---|---|---|
| command | `command` is present | an action and an `observation` carrying `command` and `exitCode`; `mutate` for each changed file | versions change; older reads become stale | `repeated_action` | `OP-AP-RUN-1` |
| large output | a stream exceeds the byte limit | the observation keeps the tail inline, where the error and the exit status appear, with a note about the omission; the full stream remains behind `outputRef` and `errorRef` and is recalled by `recall` | — | — | `OP-AP-RUN-2` |
| workdir | `workdir` names an existing path inside the workspace | the command runs in that directory | — | a failed observation with `workdir does not exist` or `path escapes workspace` | `OP-AP-RUN-3` |

The fields `workdir` and `timeout` have the following meaning. `workdir` runs the command in a
subdirectory of the workspace instead of prefixing it with `cd … &&`. `timeout` caps this single
command in milliseconds. Both belong to the repeat signature, so the same text under a different
directory or cap counts as a new action.

#### 4.2.6 `write` (`OP-AP-WRITE`)

| Case | Precondition | Effects | Derived facts | Refusals | ID |
|---|---|---|---|---|---|
| create | the path does not exist | add an `action` with `path` and `content`; emit `mutate`; set the file version | — | — | `OP-AP-WRITE-1` |
| overwrite | the file was read and is unchanged since that read, and is not forbidden | add an action; emit `mutate`; increment the version | dependent facts become stale | `stale_base`; a forbidden pattern | `OP-AP-WRITE-2` |
| forbidden path | a constraint forbids the path | — | — | a forbidden pattern | `OP-AP-WRITE-3` |
| stale base | the file changed after the last read | — | — | `stale_base` | `OP-AP-WRITE-4` |
| unseen file | the file exists but was never read | — | — | a failed observation with `read it first` | `OP-AP-WRITE-5` |
| path outside the workspace | — | a failed observation, recorded as a refusal without a crash | — | — | `OP-AP-WRITE-6` |

#### 4.2.7 `fetch` (`OP-AP-FETCH`)

A `fetch` obtains external reference evidence, such as an upstream, published or sibling copy,
into the workspace, where it can be read and compared.

| Case | Precondition | Effects | Derived facts | Refusals | ID |
|---|---|---|---|---|---|
| fetch | the URL is reachable, the target does not exist and is not forbidden | an action; the file is written; `mutate` and `mutates`; an observation with `url`, `path` and `bytes` | the file version is set; older reads become stale | — | `OP-AP-FETCH-1` |
| download failure | a non-2xx response or a timeout | a failed observation | — | — | `OP-AP-FETCH-2` |
| target exists or path outside the workspace | — | a failed observation with `choose another path`, or a recorded refusal | — | — | `OP-AP-FETCH-3` |
| forbidden explicit path | a constraint forbids the path | — | — | a forbidden pattern | `REF-FETCH-CONSTRAINT` |

The default target is chosen by the engine (`refPathFor`, `.skein/ref/<hash>-<slug>`), so only an
explicit `path` is checked against constraints.

#### 4.2.8 `apply_patch` (`OP-AP-PATCH`)

An `apply_patch` applies a unified diff in the root of the workspace (`patch -p<strip>`, with a
default strip level of 1), for example an upstream change obtained by `fetch`.

| Case | Precondition | Effects | Derived facts | Refusals | ID |
|---|---|---|---|---|---|
| apply | the patch applies cleanly | an action; `mutate` for each changed file | versions change; older reads become stale | — | `OP-AP-PATCH-1` |
| does not apply | a hunk conflicts or was already applied | a failed observation | — | — | `OP-AP-PATCH-2` |
| forbidden target | a constraint forbids a path in `---` or `+++` | — | — | a forbidden pattern | `REF-PATCH-CONSTRAINT` |

### 4.3 `stop`

A `stop` closes a state and is the only way to finish it. The doxa produces it as a text reply
without a tool call; the engine records the same `stop` relation, taking the reply as the reason.
At the terminal state (`end`), which has no turns, the same closure ends the run. There is no
criterion and no check: the doxa decides while it works.

**Input.** `{ why? }`, the reason.

**Action.** If the focus is an open state — a `move` not yet stopped — the engine creates a `stop`
node `S` and links `M.stop = S`. The state becomes finished, and the next decision is the
transition (§4.1). If the focus is the terminal state, the same closure ends the request with
`request_addressed`. A `stop` at the request, or at an already finished state, is refused with
`not_addressed`.

| Case | Precondition | Effects | Derived facts | Refusals | ID |
|---|---|---|---|---|---|
| finish the work of a state | the focus is an open state | add a `stop` node and a `stop` relation from the state's `move` | the state is finished; the focus returns to its `move` | — | `OP-ST-1` |
| record the closure on the move | a state | the `stop` node hangs off the `move`, not off a turn; the reason is stored in `why` | the closure and its reason reside on the `move` | — | `OP-ST-2` |
| end the request | the focus is the terminal state (`end`) | add a `stop` node and a `stop` relation from the `move` | the run ends with stopReason `request_addressed` | — | `OP-ST-3` |
| not in a closeable state | the focus is the request or a non-terminal `move` | — | — | `not_addressed` | `REF-ST-STATE` |

- **Projection** (`PRJ-STOP`): the closure of a state renders as the marker `Finish state
  <label> — <why>`. The `stop` adds no tool call, and the turn messages of the state leave the
  tape.
- A state is closed only by `stop`, a relation on its `move`. The terminal state is closed in the
  same way. There is no `stop` on the request; the request ends when its terminal state is
  stopped.

### 4.4 `decline`

A `decline` finishes a request whose intent is not actionable, without inventing a state. It is
available only while the request has no `move`. It records an `unactionable` node under the
request and ends the run.

**Input.** `{ why? }`, the reason.

**Action.** The engine creates an `unactionable` node `U` and links `R.unactionable = U`. No
`move` or turns are created. The run ends with `request_unactionable`. At a `move` the move is
refused with `not_request`; on an already interpreted request with `interpreted`.

| Case | Precondition | Effects | Derived facts | Refusals | ID |
|---|---|---|---|---|---|
| decline the request | the focus is the request, with no `move` and no `unactionable` node | add an `unactionable` node and a relation from the request; the run ends | the request is terminal (`request_unactionable`) | — | `OP-DC-1` |
| not at the request | the focus is a `move` | — | — | `not_request` | `REF-DC-NOTREQ` |
| already started | the request already has a `move` | — | — | `interpreted` | `REF-DC-ADDR` |

- **Projection** (`PRJ-DC`): `decline` is offered at a fresh request alongside `move`.

### 4.5 `recall` and `search`

`recall` and `search` are read-only tools that address a stored result by its identifier. Neither
changes the tree. `recall` opens a body, optionally a window of lines; `search` finds a pattern
inside it. Both leave an `action` and its `observation` in the turns of the state, like any other
step, so that the fetched window remains on the state's tape while the state is open and is
elided when the state is stopped (§7). They are distinct tools so that the doxa does not confuse
reading a file or a result (`read`) with searching one (`grep` or `search`).

`recall { id, start?, end? }` (`OP-RC`):

| Case | Precondition | Effects | ID |
|---|---|---|---|
| by identifier | the identifier addresses a stored body, either an observation or an inline body | an `action` and an `observation` in the state's turns; the requested window is returned, with a `continue from N` cursor when the body is longer | `OP-RC-1` |
| window | `start` and `end` | a window of lines, continued by a new `recall` | `OP-RC-2` |
| large body | the body exceeds the byte budget | the window is reduced by whole lines (`QUERY_BODY_LIMIT`) and remains valid JSON, never clipped in the middle of a string; the error stream, if present, is the bounded inline tail | `OP-RC-3` |
| no body | the identifier denotes an action or another bodyless node | `(nothing to recall: <id> has no stored body)` | `OP-RC-4` |
| unknown identifier | — | `(nothing to recall: <id> is not a node)` | `OP-RC-5` |
| rendered in the state | — | the recall renders as a turn of the open state and is elided with the state on `stop`, with no TTL and no working set | `OP-RC-6` |

`search { id, pattern, before?, after? }` (`OP-SR`):

| Case | Precondition | Effects | ID |
|---|---|---|---|
| by pattern | the identifier addresses a stored body and `pattern` is a regular expression | an `action` and an `observation` with matching line windows over stdout and stderr as JSON, together with context | `OP-SR-1` |
| stderr | the body has an error stream | matches in the error stream carry `stream: "stderr"` | `OP-SR-2` |
| broad pattern | there are more matches than the window can hold | whole trailing results are dropped; a note states `showing N of M; narrow the pattern`, and no dangling `next` is produced because `search` has no paging | `OP-SR-3` |
| no match | — | an empty `results` array | `OP-SR-4` |
| invalid pattern | `pattern` is not a regular expression | `{ …, error: "invalid pattern" }` | `OP-SR-5` |
| no body | the identifier has no stored body | `(nothing to search: <id> has no stored body)` | `OP-SR-6` |
| context | `before` and `after` | the requested number of context lines per match, three by default | `OP-SR-7` |

- **Projection** (`PRJ-RC`): the recalled or searched body enters the tape as an `action` and an
  `observation`, is rendered while the state is open, and is elided on `stop`.
- **Projection** (`PRJ-REF`): a refused structural move creates no node; its reason enters the
  tape as a transient `tool` message, `rejected <move>: <reason>`, for the next turn.

### 4.6 Traversal, containers and derived facts

Traversal is the deterministic part of the logos: it computes the admissible moves at the focus.
Derived facts are read from the journal; nothing is stored.

| Case or predicate | Rule | ID |
|---|---|---|
| focus | the focus is `branch[last]`, or the root when the branch is empty | `TR-1` |
| descend | `focusEvents` descends into the current `move` of the request | `TR-2` |
| return | a finished top is popped on `stop` or on the next `move`; `return` is legal | `TR-3` |
| flat states | states are children of the request through `move` and are never nested; a `move` after a finished state is a sibling | `TR-4` |
| container choice | the request holds `move`s, a `move` holds `turns`, and `turns` holds `turn`s | `TR-5` |
| turn order | turns follow the order of `turn` relations; the last is current; the list only grows and has no cursor | `TR-6` |
| placement | an incoming `apply` appends the next turn (`OP-AP-PLACE`) | `TR-7` |
| frontier | `applicable` computes `move`, `apply`, `stop` and `decline` from the same facts used by the gates; the doxa chooses | `TR-8` |
| turn rendering | every command is rendered as its own native call and result pair, with no marker for alternatives | `TR-9` |
| state closed or finished | the `move` has a `stop` relation to a `stop` node | `DER-MOVE-1`, `DER-STATE-1` |
| request finished | an `unactionable` node exists, or the current `move` is the terminal state and is finished | `DER-REQ-1` |
| current state | the `state` of the last `move` child of the request | `DER-STATE-2` |
| structural forest | the work relations `move`, `turns`, `turn`, `stop` and `unactionable` form a forest with a single parent per node | `DER-FOREST-1` |
| action executed | the action has a `result` or a `mutates` relation | `DER-ACT-1` |
| run witness | the observation of a run carries a `witness`, the basis of staleness | `DER-STALE-1` |

## 5. Time, versions and the witness

- The version of a file is an identifier of its content, a hash. The content of previous versions
  is not stored in the IR; blobs reside in the workspace.
- `history(ref)` is the sequence of versions of `ref` in the order of `mutate` events, and
  `current(ref)` is the last of them. Both are derived.
- An observation obtained by reading a file carries the version it read. There is no stored
  "stale" flag: actuality is a relation between a fact and the current context, namely
  `actual(fact) ⇔ fact.version = current(fact.ref)`.
- The journal only grows. A change of knowledge — a new version, observation or hypothesis — is a
  new record; only the derived view is recomputed.
- The observation of a run carries a witness, a snapshot of the workspace at the time of the run.
  A later `mutate` makes facts about the earlier version stale, so a pass cannot silently remain
  valid.

## 6. Completion and honesty

| Condition | Closed by | Derived state |
|---|---|---|
| an open state | `stop`, with no gate | closed; the `stop` relation leads from move to stop; the state is finished and the focus remains on its `move` |
| the terminal state (`end`) | `stop`, with no gate | closed; the request ends with `request_addressed` |
| the request | ends when the terminal state is stopped (`request_addressed`) or when it is declined (`request_unactionable`); the request has no `stop` | the run ends |

**An error is a result.** On a persistent model error (`llm_error`), the engine closes the state
in which the call failed with an engine-owned `stop` carrying `error: true`, enters the terminal
state, and writes the final report there. If the reporting call also fails, the report falls back
deterministically to the `Finish` lines. The `stopReason` remains `llm_error`, and the terminal
`stop` is marked `error`, so the session derives `abandoned` rather than `completed`.

**The request is not closed in the IR.** There is no "accepted" node. The silence of the user
signifies agreement, and an objective harness judges the run from outside. **Honesty** requires
that the strength of a conclusion not exceed the strength of its premises. The `exitCode` of a run
is ordinary output; the request is never marked "achieved"; and no hypothesis is stored as an
assumption.

## 7. Context: the message tape

The context is what the model sees on the next step. It resembles an ordinary tape of messages,
but it is rebuilt from the tree on every turn: it is a projection, not an accumulating
transcript. The same events always produce the same tape. The full specification is
`docs/en/projection.md`.

**Roles.** `system` carries the stable base prompt, the constraints, the `instruction` of each
state, and, appended last and transiently, the instruction of the current situation. `user`
carries the request, which leads the tape on every turn, and the working prompt of the open
state. `assistant` carries the state markers and the calls of the doxa. `tool` carries the
results of commands. Working steps follow the native tool-calling contract: an `apply` is an
`assistant` message with `tool_calls`, and its result is a `tool` message with a
`tool_call_id`. A batch is one `assistant` message with N `tool_calls`, followed by the N `tool`
results in order.

**States and their messages.**

- `fact` is a session fact emitted as a `system` turn in the entry of the current state. A single
  `fact:session` carries `{ environment, material }`; the request turn and closed states carry
  none. Its source is an `add_node` event of kind `fact`, recorded once at the start of the
  request (`src/loop/probe.ts`).
- `move` is a decision, not a tool call. It renders as a `Start state <label>` marker and, while
  the state is open, as its brief and its turns. `buildMessages` then appends one `user` working
  prompt after the turns: `Goal: <island.what>`, the doxa's guess `Your earlier guess (may be
  wrong): <move.what>` when present, `Done when: <criterion>`, `Plan: <instruction>`, and the
  request marked as reference. The request is the second message of the tape on every turn.
- Returning to Patch leaves the failure on the tape in the `Finish` lines of the closed `patch`
  and `verification` states. On the transition `Verification → Patch`, the engine emits a
  `revert` event and restores the files to their pre-patch state; there is no separate "previous
  failed attempt" block. The `stop` still closes states only through the doxa.
- `apply` renders as an `assistant` message with `tool_calls` and a `tool` message with the
  observation. The first `apply` after a `move` seeds the turns of the state.
- `stop` renders the closure as `Finish state <label> — <why>`, read from the relation
  `move.stop`. It adds no tool call. At the terminal state, `stop` ends the request.
- `decline` renders as an `assistant` message carrying the reason.
- A refused structural move renders as a transient `assistant` message and a `tool` message with
  the reason, `rejected <move>: <reason>`, on the next turn. It creates no node.

**The tape is not monotone.** A finished state, whether it awaits the transition or has already
been left behind, collapses to `Start state <label>` and `Finish state <label> — <why>`. Its
brief and turn messages leave the tape, since the working prompt was never stored. Only the view
disappears; the data remain in the tree. The raw `thought` of the doxa is not stored, and its
meaning survives only in the `why` fields.

**Working with data.** Each result body is bounded by its own tool, according to a per-tool
budget. The `read` window is 32K, bounded by bytes and not by lines; `grep`, `list` and `bash`
are kept small, at 8K, because they are pointers rather than content. A larger fragment is
obtained as a `read` window or through `recall`, whose budget is 64K. `grep` and `search` return
plain text with line numbers (`path:line:match`, with context rendered as `path-line-text`). The
`tool` message shows its window whole and never cuts out the middle: an inspection result is
consumed from the beginning, so its head is preserved, while the output of a command matters at
its end, so `run` preserves the tail. Only a body that still exceeds the budget of its tool is
bounded, with a note about the omission. The full body is stored as a file, and the node keeps
an `outputRef`. Access is by identifier, not by path.

## 8. Invariants

1. The journal only grows, and nodes are never rewritten; only the view changes.
2. The projection is deterministic: the same events produce the same context.
3. A state is closed only through `stop`, the terminal state included; there is no criterion run
   and no gate on an exit code.
4. The doxa only proposes; the logos decides.
5. The exit code of a command is ordinary output, not a verdict of closure.
6. Every `move` is a child of the request and carries its own note (`what`). The goal of a state
   is the goal of its island. Turns hang off the `move`, and every action is exactly one turn of
   that state. A state is never a turn, and the request has no goal of its own.
7. `stop` is a relation on the `move`, never a turn.
8. The turns of a closed state leave the tape; only `Start state <label>` and `Finish state
   <label> — <why>` remain.
9. The `state` of a `move` is a label authored by the doxa. It never gates a `move` and never
   closes a state. It delimits the action surface of the open state; a tool outside that surface
   is refused with `not_in_state`, but the doxa can always leave the mode by a `move`.
10. The request ends when the terminal state (`end`) is stopped or when the request is declined.
    There is no `stop` on the request.
11. A command that did not run leaves an `action` and an `observation` with a reason. A structural
    move that is inadmissible is refused without creating a node.
12. The structural relations `move`, `unactionable`, `turns`, `turn`, `stop`, `result` and
    `mutates` form a directed acyclic graph, and a forest on the structural part.
13. A refused or failed move changes the projection.
14. Secrets reside only in `.env`; small results may be inlined, but secrets never are.

## 9. Open questions and non-goals

- The exact boundary between the base prompt and the node prompts remains the next stage.
- The turns list has removed the layer of items and alternatives. It should be revisited only if
  a future feature requires explicit grouping of retries.
- Non-goals: no abstract syntax tree or symbol table, no embeddings, no constraint solver or
  arithmetic, no user interface, no multi-language support and no multiple language-model
  providers. No `check`, `claim`, `decision` or `subgoal` node kinds, and no criterion gate.

## 10. Refusals and non-execution of commands

The gate `classify` (`src/loop/classify.ts`) refuses only structural moves. A refusal emits
`record_rejection` and must change the projection, as required by the invariants. A command is
handled by the engine (`src/tools/index.ts`); its non-execution is recorded as an `action` and an
`observation` with a reason, not as a nodeless refusal.

**Structural refusals (`record_rejection`).**

| Reason token | Trigger | Operator | ID |
|---|---|---|---|
| `empty_state` | a malformed `move` with an unknown `state` | `move` | `REF-MV-EMPTY` |
| `not_startable` | a `move` into a live state that cannot start a request | `move` | `REF-MV-NOT-STARTABLE` |
| `unreachable` | a `move` outside the `next` neighbours of the finished state | `move` | `REF-MV-UNREACHABLE` |
| `no_state` | an `apply` when the focus is not an open state | `apply` | `REF-AP-NO-STATE` |
| `no_state` | an `apply` when the focus is not an open state | `apply` | `REF-NO-STATE` |
| `not_in_state` | an `apply` with a tool outside the island's `applies` | `apply` | `REF-NOT-IN-STATE` |
| `state_open` | a `move` while the current state is still open | `move` | `REF-STATE-OPEN` |
| `not_addressed` | a `stop` when the focus is neither an open state nor the terminal state | `stop` | `REF-ST-STATE` |
| `not_request` | a `decline` at a focus other than the request | `decline` | `REF-DC-NOTREQ` |
| `interpreted` | a `decline` on a request that already has a `move` | `decline` | `REF-DC-ADDR` |

**Non-execution of commands, recorded as an `action` and an `observation` with a reason.**

| Reason | Trigger | Operator | ID |
|---|---|---|---|
| `repeated_action` | an identical `read`, `grep` or `run` against an unchanged world | `read`, `grep`, `run` | `REF-REPEAT` |
| `no_state` | a `recall` or `search` outside an open state | `recall`, `search` | `REF-RC-STATE` |
| run without a command | an empty `run` | `run` | `REF-RUN-EMPTY` |
| `stale_base` | an `edit` of a file changed after it was read | `edit` | `REF-EDIT-STALE` |
| a forbidden pattern | an `edit` of a forbidden path | `edit` | `REF-EDIT-CONSTRAINT` |
| `stale_base` | a `write` over a file changed after it was read | `write` | `REF-WRITE-STALE` |
| a forbidden pattern | a `write` to a forbidden path | `write` | `REF-WRITE-CONSTRAINT` |

Tool failures, by contrast, are recorded as failed observations: a missing file in `read`, a bad
scope in `grep` or `list`, an absent `find` in `edit`, and a non-zero exit, a timeout or a signal
in `run`.

## 11. The implementation

The system distinguishes four levels.

```
                 append-only              pure            pure
  actions ─▶ journal (Event[]) ──fold──▶ State ──project──▶ Context ──▶ LLM
     ▲                                                             │
     └─────────── proposal: one or more operators per turn (a batch) ◀────────┘
```

1. The **journal** (`src/ir/events.ts`) is append-only and is the single source of truth.
2. The **state** (`src/ir/graph.ts`, `src/ir/traversal.ts`) is `fold(events)`: it comprises the
   nodes, relations, container order, derived helpers, the focus and file versions.
3. The **context** (`src/ir/project.ts`) is `project(state)`, a deterministic message tape.
4. The **tape** is the only input-output surface: the system part, comprising the base prompt,
   the instruction of the node and the constraints; the request; and the history. The facts of
   the probe appear in the entry of the current state.

Before `project` runs, the engine reconciles active `ref`s with the filesystem
(`src/loop/observe.ts`), and any drift becomes a `mutate` event.

**Map of the code.**

| Area | Files |
|---|---|
| node and edge kinds, payloads | `src/ir/types.ts` |
| event schema and closed vocabulary | `src/ir/events.ts` |
| folding, derived facts, versions | `src/ir/graph.ts` |
| focus and admissible moves | `src/ir/traversal.ts` |
| islands, goals, criteria and apply surfaces | `src/ir/islands.ts` |
| projection | `src/ir/project.ts`, `src/loop/propose.ts` |
| gate for structural refusals | `src/loop/classify.ts` |
| commands, observations and refusals | `src/tools/index.ts` |
| tool schema and native names | `src/llm/schemas.ts`, `src/llm/tools.ts` |

## Coverage matrix

Every specification identifier has at least one offline test, and each family of operators also
has an online check. The random-tree properties in `tests/ops/ir_properties.test.ts` support the
invariants across 400 generated trees. The live step tests
(`tests/live/ir_operations_step.test.ts`, run deliberately with `SKEIN_LIVE=true npx vitest run
...`) build a projection offline and assert the shape of the next move of the live model.

| Spec ID | Offline test | Live |
|---|---|---|
| `OP-MV-1..3` | `tests/ops/move.test.ts` | steps `request-choose-state`, `transition-move`, `terminal-stop` |
| `OP-CG-1` | `tests/ops/apply.test.ts` | steps `move-concretize`, `goal-stop` |
| `OP-AP-READ-1..8` | `tests/ops/apply.test.ts` | scenario `locate-across-files` |
| `OP-AP-GREP-1..6` | `tests/ops/apply.test.ts` | scenario `locate-across-files` |
| `OP-AP-LIST-1..4` | `tests/ops/apply.test.ts` | scenario `locate-across-files` |
| `OP-AP-EDIT-1..5` | `tests/ops/apply.test.ts` | scenarios `stale-base`, `two-step-fix` |
| `OP-AP-WRITE-1..6` | `tests/ops/apply.test.ts` | scenario `command-from-package` |
| `OP-AP-RUN-1..3` | `tests/ops/apply.test.ts` | step `apply-next-action` |
| `OP-AP-FETCH-1..3`, `REF-FETCH-CONSTRAINT` | `tests/ops/apply.test.ts` | — |
| `OP-AP-PATCH-1..2`, `REF-PATCH-CONSTRAINT` | `tests/ops/apply.test.ts` | — |
| `OP-RC-1..6` | `tests/ops/recall.test.ts` | scenarios `retrieve-at-scale`, `reproduce-then-read` |
| `OP-SR-1..7` | `tests/ops/search.test.ts` | scenario `retrieve-at-scale` |
| `TR-1..9` | `tests/ops/traversal.test.ts` | steps `apply-next-action`, `continue-open-goal` |
| `DER-MOVE/STATE/REQ/ACT/STALE/FOREST` | `tests/ops/derivation.test.ts`, `tests/ops/ir_properties.test.ts` | — |
| `REF-MV-EMPTY`, `REF-MV-NOT-STARTABLE`, `REF-MV-UNREACHABLE`, `REF-STATE-OPEN` | `tests/ops/move.test.ts` | — |
| `REF-AP-NO-STATE`, `REF-NO-STATE` | `tests/ops/apply.test.ts`, `tests/ops/applicable.test.ts` | — |
| `REF-NOT-IN-STATE` | `tests/ops/applicable.test.ts` | — |
| `REF-RUN-EMPTY`, `REF-REPEAT`, `REF-RC-STATE` | `tests/ops/apply.test.ts`, `tests/ops/recall.test.ts` | — |
| `REF-EDIT-STALE`, `REF-EDIT-CONSTRAINT` | `tests/ops/apply.test.ts` | scenario `constraint-honored` |
| `REF-WRITE-STALE`, `REF-WRITE-CONSTRAINT` | `tests/ops/apply.test.ts` | — |
| `OP-ST-1..3`, `REF-ST-STATE` | `tests/ops/stop.test.ts` | step `stop-open-goal` |
| `OP-DC-1`, `REF-DC-NOTREQ`, `REF-DC-ADDR` | `tests/ops/decline.test.ts` | — |
| `OP-AP-PLACE-1..2` | `tests/ops/traversal.test.ts` | steps `apply-next-action` |
| `TR-8` | `tests/ops/applicable.test.ts` | step `stop-open-goal` |
| `TR-9` | `tests/ops/traversal.test.ts` | — |

The coverage gate (`tests/coverage.test.ts`) requires every identifier in this registry to appear
as a token in at least one test, and forbids a test from citing an identifier outside the
registry. In this way the document and the tests cannot drift apart.

## Extending the registry

1. Add the specification point here, with a new stable identifier and its precondition, effects,
   derived facts and refusals; if the refusal is new, add its token in §10.
2. Add an offline test that cites the identifier in its title.
3. Add a live scenario only if the family of operators requires end-to-end confirmation.
4. The coverage gate fails until the matrix lists the test.
