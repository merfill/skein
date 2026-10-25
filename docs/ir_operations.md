# Skein — IR operations: reference and test matrix

> Russian mirror — `docs/ir_operations_ru.md`.

Related: `docs/ir_semantics.md` (the formal semantics — this document is the
operational reference and the coverage contract, not a second formalism),
`docs/projection.md`, `docs/tools.md`, `docs/ir.md`, `docs/walkthrough.md`,
`docs/testing.md`.

Status: **Specified (state protocol) — implementation in progress.** §1–§4 specify the model and
every operator; §5 is the coverage matrix (to be refilled as the state protocol lands,
`docs/plans/archive/state_protocol_plan.md`). An ID is **stable**: a spec point may gain tests, but its
meaning does not change.

> **State protocol** (`docs/plans/archive/state_protocol_plan.md`). The walk is a state machine over
> islands: `move` declares the state AND its goal text (a `move` node, a flat child of the request; the state IS its goal), the first `apply`
> concretizes that state's work (`what` + a plan seeded with the first action), `apply` works it,
> and `stop` closes it and forces the transition. A goal carries `what` only — the `state`
> lives on its `move`. Closure is dynamic: the doxa's `stop` closes a goal/state; there is no
> criterion, no exit-code gate, no `done_when`/`step`/`revises`, and no `state` on a goal
> (`exitCode` is ordinary output).

---

## 0. How to read this document

Every operator is specified as:

- **Pre** — when it is legal (the frontier/logos precondition).
- **Effects** — the journal events and the tree change it emits.
- **Derived** — the facts that change as a result.
- **Refuses** — the reasons the logos can reject it (`classify`), with the catalogue
  in §3.
- **Projection** — how the result is seen in the next context (§ projection).
- **ID** — a stable identifier; a test cites it as the `ID` token in its title.

ID families: `OP-MV` move, `OP-CG` a state's first plan item (its first `apply`), `OP-AP-READ|GREP|LIST|EDIT|WRITE|RUN|FETCH|PATCH`
apply sub-tools, `OP-AP-PLACE` how an `apply` lands in the tree, `OP-ST` stop, `OP-DC`
decline, `OP-RC`/`OP-SR` recall/search, `TR` traversal/containers, `DER` derived facts/predicates, `REF`
refusals (the catalogue), `PRJ` projection points (referenced).

---

## 1. Model

### 1.1 Work nodes (`src/ir/types.ts`)

| Kind | Payload | Role |
|---|---|---|
| `request` | `{text}` | raw motivation; the root; walked as a sequence of states; it ends when the terminal state is stopped |
| `move` | `{state, what}` | the doxa's declared state (island) and its goal; a flat child of the request |
| `goal` | `{what}` | the concrete work of one state (`move.goal`) |
| `plan` | — | ordered container of a goal's items (`items`); the LAST item is current |
| `item` | — | ordered container of a step's alternatives (`alts`: actions); the LAST is current |
| `action` | `{command, ...}` | a single tool run; an alternative of an item |
| `observation` | `{ref?, version?, command?, exitCode?, output/error/...}` | a tool result body; `exitCode` is ordinary output, not a closure oracle |
| `stop` | `{why?}` | closes the focused goal (goal stop), or the terminal state (move stop) |
| `unactionable` | `{why?}` | the request's intent is not actionable; the doxa declines to formulate a goal (`unactionable` relation) |
| `constraint` | `{forbid: string[]}` | invariant; seeded at run start |
| `file` (artifact) | — | a referenced file; produced by `mutates` |

### 1.2 Relations (`src/ir/types.ts`)

| Relation | From → To | Meaning |
|---|---|---|
| `move` | request → move | the request's states, in order (the LAST is current) |
| `unactionable` | request → unactionable | the doxa declined to formulate a goal for the request |
| `goal` | move → goal | the state's work |
| `stop` | move → stop | the terminal state was closed by the doxa |
| `plan` | goal → plan | the goal's plan container |
| `stop` | goal → stop | the goal was closed by the doxa |
| `items` | plan → item | ordered membership (order = sequence; the LAST item is current) |
| `alts` | item → action | an item's ordered alternatives (the LAST is current) |
| `result` | action → observation | the action's result body |
| `mutates` | action → file | the action changed the file |

### 1.3 Events (`src/ir/events.ts`)

`add_node`, `add_edge`, `descend`, `return`, `mutate`, `record_rejection`. `fold`
applies them in order; state (`children`, `branch`, `focusOf`, versions) is **derived**,
never stored. There is no `record_check` and no `set_status`: a state change is a new
node-event (`move`/`observation`/`stop`). A run's result is a plain `observation`; its
`exitCode` is output, not a verdict.

### 1.4 Containers and traversal

- **branch** — the stack of state frames (`move` → `goal`) from the request root to the focus;
  `descend` pushes, `return` pops (`TR-1`).
- **focus** — `branch[last]`, else the root (`TR-1`).
- **plan** — the `plan` relation target; **items** — `items` edges in insertion order; the
  **last** item is the current one.
- **alternatives** — an item's children (`alts`); the **current** alternative is the last
  child (there is no `chosen` edge).
- **frontier** — the admissible moves at the focus, computed **once** and shared by the
  projection and `classify` (`TR-8`). The engine does not dictate a single next move.

---

## 2. Operators

### 2.1 `move` (`OP-MV`)

Declares the state (the island of work) the doxa will work in AND the state's goal text
(`what`) — the state **IS** its goal (docs/plans/archive/goal_into_move_plan.md); the plan hangs
directly off the `move`. The states are the request's **flat children** (`move` relation): a new
`move` after a finished state is a new child of the request (a sibling of the previous state),
never nested under it.

| Case | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| open a state | focus is the request with no `move` yet | add `move` (`state`, `what`); `move` relation request → move; `descend` | the state is declared; focus → the `move`; its plan is empty until the first `apply` | `empty_state` | `OP-MV-1` |
| transition to the next state | the current state is **finished** (it is stopped) | add a `move` (a new child of the request, a sibling of the previous state); `return` out of the finished state, then `descend` | the finished state is left behind; focus → the new `move` | `empty_state`, `state_open` | `OP-MV-2` |
| terminal | the state is `end` | as above (no `what`); the terminal state accepts `stop` directly (`OP-ST`) | moving to the terminal is the sign of the end | `empty_state` | `OP-MV-3` |

- **Projection** (`PRJ-MV`): an open state gains a `Start state <label>` marker (an `assistant`
  turn), the state's `instruction` (a `system` turn) and its goal (`user`). Once stopped it is
  only `Start state <label>` / `Finish state <label> — <why>` (from the `move.stop` relation);
  its brief, instruction, goal and plan turns are elided (§7).
- **Notes.** A `move` is refused while a state is still open (`state_open`). The engine does
  **not** gate a `move` by a criterion: the doxa decides when a state is finished (it `stop`s
  it) and where to go next. `what` is required except for the terminal `end`.

### 2.2 the state's first plan item (`OP-CG`)

The concrete work of a state is its plan, hung directly off the `move` (there is **no goal
node**). The first plan item is an ordinary `apply` — the first tool call the doxa makes after
the `move` seeds the plan (docs/plans/archive/goal_into_move_plan.md §3).

| Case | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| first plan item | focus is a non-terminal `move` with no plan | the `apply` builds the `plan` with one `item` whose sole alternative is the `action` (any tool); the engine runs it at once | the state gains its plan; the first item is executed | — (a bash with no command is a fail observation, `REF-RUN-EMPTY`) | `OP-CG-1` |

- **Projection** (`PRJ-CG`): the tape gains the `apply`'s native call + its `tool` result, under
  the state's `move` call; the plan's items and alternatives follow as history.
- **Notes.** The `action` is any tool (the same union as `apply`). There are no sub-states: one
  state holds one plan.

### 2.3 `apply` (`OP-AP`)

The dispatch of one tool under the focus (`src/tools/index.ts`, `OP-AP-*`).

**How an `apply` lands in the plan** — the engine places the incoming command by the
outcome of the current (first unfulfilled) item (`docs/ir_semantics.md` §2.7): when that item is
already fulfilled (its current alternative succeeded) the command becomes a new plan `item`
(`OP-AP-PLACE-2`); otherwise it becomes a new alternative of that item (`OP-AP-PLACE-1`). An
item's alternatives are **actions only** (a sub-goal alternative no longer exists). The engine
never moves into the action.

**A move may be a batch.** The engine accepts one or more calls per move and applies each in
order in the same turn (same `payload.turn`); a terminal move (`move`/`stop`/
`decline`) ends the batch, so anything the model emitted after it is dropped (`src/loop/graph.ts`
`executeNode`). The projection renders a batch as one `assistant` with N `tool_calls` + N
`tool` results (`docs/ir_semantics.md` §7).

#### 2.3.1 `read` (`OP-AP-READ`)

| Case | Pre | Effects | ID |
|---|---|---|---|
| new window | path exists; world unchanged since a prior identical read | add `action`; add `observation` (`result`); record observed version | `OP-AP-READ-1` |
| continue window | a different `start/end` | new action/observation | `OP-AP-READ-2` |
| missing file | — | action + fail observation | `OP-AP-READ-3` |
| repeat | identical window, world unchanged | action + observation with the reason `repeated_action` (names the stored id) | `OP-AP-READ-4` |
| path outside the workspace | — | action + fail observation (no crash) | `OP-AP-READ-5` |
| read thrash | several different windows of one file | each different window is a new action/observation (no per-file cap); an identical window is `OP-AP-READ-4` | `OP-AP-READ-6` |
| large window | the requested window exceeds the byte limit | observation shows the window whole (the middle is never dropped); only a single over-long line is clipped, and the full window stays behind `outputRef`, recalled via `recall` | `OP-AP-READ-7` |
| read budget | the file is longer than the byte budget | the window is cut at whole lines to `READ_LIMIT`; a `continue from N` trailer points at the next window | `OP-AP-READ-8` |

#### 2.3.2 `grep` (`OP-AP-GREP`)

| Case | Pre | Effects | ID |
|---|---|---|---|
| scoped search | `path`/`include`/`exclude` valid | action + observation (plain-text windows) | `OP-AP-GREP-1` |
| paging | `from`/`count` | new action/observation; same-pattern repeat from a new `from` is new | `OP-AP-GREP-2` |
| no hits / bad scope | — | empty result / fail observation | `OP-AP-GREP-3` |
| repeat | identical scope+pattern, world unchanged | refused `repeated_action` | `OP-AP-GREP-4` |
| byte budget | a match window would exceed the byte limit | whole trailing matches are dropped so the window fits the limit; a `[showing N of M matches; continue from K]` trailer points to the continuation; a single huge match has its lines clipped | `OP-AP-GREP-5` |
| count caps | `count` absent or too large | the window is at most `GREP_COUNT_DEFAULT` (50), never more than `MAX_GREP_MATCHES` (100) | `OP-AP-GREP-6` |

#### 2.3.3 `list` (`OP-AP-LIST`)

| Case | Pre | Effects | ID |
|---|---|---|---|
| list scope | — | action + observation (paths as JSON) | `OP-AP-LIST-1` |
| paging / empty | `from`/`limit` | new action/observation | `OP-AP-LIST-2` |
| byte budget | a page would exceed the byte limit | whole trailing files are dropped so the JSON stays within the limit; `returned` is below the page and `next` is set | `OP-AP-LIST-3` |
| limit caps | `limit` absent or too large | the page is at most `LIST_LIMIT_DEFAULT` (100), never more than `MAX_LIST_FILES` (200) | `OP-AP-LIST-4` |

#### 2.3.4 `edit` (`OP-AP-EDIT`)

| Case | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| replace | file read and unchanged since that read; not forbidden | add `action` (`find`/`replace`); `mutate` per changed file | file version changes; dependent facts stale | `stale_base`, `constraint_violation:<pattern>` | `OP-AP-EDIT-1` |
| find not present | — | action + fail observation (file materialized, pinned) | — | — | `OP-AP-EDIT-2` |
| forbidden path | a constraint forbids it | — | — | `constraint_violation:<pattern>` | `OP-AP-EDIT-3` |
| stale base | file changed after the last read | — | — | `stale_base` | `OP-AP-EDIT-4` |
| path outside the workspace | — | fail observation (recorded refusal, no crash) | — | — | `OP-AP-EDIT-5` |

#### 2.3.5 `run` (`OP-AP-RUN`)

`run` is one plain **foreground** command. There is no criterion, no `target`, and no
background-job machinery.

| Case | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| command | `command` present | action + `observation` (`command` + `exitCode`); `mutate` per changed file | versions; older reads stale | `repeated_action` | `OP-AP-RUN-1` |
| large output | a stream exceeds the byte limit | observation keeps the **tail** inline (the error and exit sit at the end) with an omission note; the full stream stays behind `outputRef`/`errorRef`, recalled via `recall` | — | — | `OP-AP-RUN-2` |
| workdir | `workdir` names a path inside the workspace that exists | the command runs in that directory | — | fail observation (`workdir does not exist` / `path escapes workspace`) | `OP-AP-RUN-3` |

- **`workdir`/`timeout`**: `workdir` runs the command in a workspace subdirectory (instead
  of a `cd … &&` prefix); `timeout` caps this single command in milliseconds. Both are part
  of the repeat signature, so the same text under a different directory or cap is a new
  action.
- **Projection** (`PRJ-AP`): the result node is `lastResult`; stdout (`output`) and
  stderr (`error`) are separate; a crash adds `signal`/`core`/`backtrace`; the `calls`
  entry carries the `id` for a later `recall`/`search`.

#### 2.3.6 `write` (`OP-AP-WRITE`)

| Case | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| create | `path` does not exist | add `action` (`path`/`content`); `mutate`; file version set | — | — | `OP-AP-WRITE-1` |
| overwrite | file read and unchanged since that read; not forbidden | add `action`; `mutate`; version bumps | dependent facts stale | `stale_base`, `constraint_violation:<pattern>` | `OP-AP-WRITE-2` |
| forbidden path | a constraint forbids it | — | — | `constraint_violation:<pattern>` | `OP-AP-WRITE-3` |
| stale base | file changed after the last read | — | — | `stale_base` | `OP-AP-WRITE-4` |
| unseen file | file exists but was never read | — | — | fail observation (`read it first`) | `OP-AP-WRITE-5` |
| path outside the workspace | — | fail observation (recorded refusal, no crash) | — | — | `OP-AP-WRITE-6` |

- **Projection** (`PRJ-AP`): an executed `action` node with a `mutates` edge and a
  `mutate` event carrying the new version.

#### 2.3.7 `fetch` (`OP-AP-FETCH`)

Obtains external reference evidence (an upstream/published/sibling copy) into the
workspace, so it can be read and diffed (B9, `docs/system_prompt.md`).

| Case | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| fetch | URL reachable; target does not exist; not forbidden | action; write the file; `mutate` + `mutates`; observation (`url`/`path`/`bytes`) | file version set; older reads stale | — | `OP-AP-FETCH-1` |
| download failure | non-2xx / timeout | fail observation | — | — (fail) | `OP-AP-FETCH-2` |
| target exists / path outside the workspace | — | fail observation (`choose another path` / recorded refusal) | — | — | `OP-AP-FETCH-3` |
| forbidden explicit path | a constraint forbids it | — | — | `constraint_violation:<pattern>` | `REF-FETCH-CONSTRAINT` |

The default target is engine-owned (`refPathFor`, `.skein/ref/<hash>-<slug>`), so only an
explicit `path` is constraint-checked.

#### 2.3.8 `apply_patch` (`OP-AP-PATCH`)

Applies a unified diff in the workspace root (`patch -p<strip>`, default 1), e.g. an
upstream change obtained with `fetch`.

| Case | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| apply | the patch applies cleanly | action; `mutate` per changed file (`patch -p<strip>`) | changed versions; older reads stale | — | `OP-AP-PATCH-1` |
| does not apply | conflicting/already-applied hunk | fail observation | — | — (fail) | `OP-AP-PATCH-2` |
| forbidden target | a constraint forbids a `---`/`+++` path | — | — | `constraint_violation:<pattern>` | `REF-PATCH-CONSTRAINT` |

### 2.4 `decline` (`OP-DC`)

The doxa proposes that the request's intent is **not actionable** (chit-chat, no task) and
declines to formulate a goal — instead of inventing one. Available
only while the request has no `move` yet; it records an `unactionable` node under
the request (`unactionable` relation) and ends the run
(`docs/plans/archive/request_goal_plan.md`).

| Case | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| decline the request | the focus is the request with no `move` and no `unactionable` node | add an `unactionable` node and an `unactionable` relation from the request; the run ends | the request is terminal (`request_unactionable`) | — | `OP-DC-1` |
| not at the request | the focus is a `move` or a goal | — | — | `not_request` | `REF-DC-NOTREQ` |
| already started | the request already has a `move` | — | — | `interpreted` | `REF-DC-ADDR` |

- **Projection** (`PRJ-DC`): the option `decline` is offered at a fresh request alongside
  `move`.

### 2.5 `stop` (`OP-ST`)

The doxa's terminal move and the **sole closure**. On an open **goal** it finishes the state's
work (the engine returns to the governing `move` and forces the transition decision); on the
**terminal state** (`end`, which has no goal) it ends the run. There is no criterion and no
check: the doxa decides while working.

| Case | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| finish a state's work | the focus is an open state | add a `stop` node and a `stop` relation from the state's `move` | the state is finished; focus returns to its `move` | — | `OP-ST-1` |
| closure recorded on the move | a state | the `stop` node is hung off the `move` (no plan item); the reason lives in its `why` | the closure and its reason sit on the `move` | — | `OP-ST-2` |
| the request ends | the focus is the terminal state (`end`) | add a `stop` node and a `stop` relation from the `move` | the run ends, stopReason `request_addressed` | — | `OP-ST-3` |
| not at a closeable state | the focus is the request, or a non-terminal `move` | — | — | `not_addressed` | `REF-ST-STATE` |

- **Projection** (`PRJ-STOP`): the state's closure renders as a `Finish state <label> — <why>`
  marker; the `stop` adds no tool call, and the state's plan turns leave the tape.
- A goal is closed only by `stop` (a `stop` relation); the terminal state is closed by a `stop`
  relation on its `move`. There is no `stop` on the request; the request ends when its terminal
  state is stopped.

### 2.6 `recall` and `search` (`OP-RC`, `OP-SR`)

Two moves read a stored result by id (the "index" mechanism, docs/ir_semantics.md §4.5):
`recall` opens a body (optionally a line window), `search` finds a pattern inside it. Both leave
a node — an `action` + its `observation` under the state's plan, like any other step — so the
fetched window stays on the state's tape while the state is open and is elided when the state is
stopped (docs/ir_semantics.md §7). They are separate tools so the doxa cannot conflate reading a
file / reading a result (`read`) with searching one (`grep` / `search`).

`recall { id, start?, end? }` (`OP-RC`):

| Case | Pre | Effects | ID |
|---|---|---|---|
| by id | the id addresses a stored body (observation or inline/`Ref` body) | an `action` + `observation` under the state's plan; the body window is returned; a `continue from N` cursor when the body is longer | `OP-RC-1` |
| window | `start`/`end` | a line window; continues with a new `recall` | `OP-RC-2` |
| large body | the body exceeds the byte budget | the window is shrunk by whole lines (`QUERY_BODY_LIMIT`, valid JSON, never clipped mid-string); the error stream, if any, is the bounded inline tail | `OP-RC-3` |
| no body | the id is an action/goal/etc. | `(nothing to recall: <id> has no stored body)` | `OP-RC-4` |
| unknown id | — | `(nothing to recall: <id> is not a node)` | `OP-RC-5` |
| stays in the state | — | the recall renders as a turn of the open state; it elides with the state on `stop` (no TTL, no working set) | `OP-RC-6` |

`search { id, pattern, before?, after? }` (`OP-SR`):

| Case | Pre | Effects | ID |
|---|---|---|---|
| by pattern | the id addresses a stored body; `pattern` is a regex | an `action` + `observation`; matching line windows over stdout **and** stderr as JSON, with context | `OP-SR-1` |
| stderr | the body has a stderr stream | matches in the error stream carry `stream: "stderr"` | `OP-SR-2` |
| broad pattern | more matches than the window holds | whole trailing results dropped; a `note` says `showing N of M; narrow the pattern` — never a dangling `next` (`search` has no paging) | `OP-SR-3` |
| no match | — | empty `results` | `OP-SR-4` |
| invalid pattern | `pattern` is not a regex | `{ …, error: "invalid pattern" }` | `OP-SR-5` |
| no body | the id has no stored body | `(nothing to search: <id> has no stored body)` | `OP-SR-6` |
| context | `before`/`after` | `before`/`after` context lines per match (default 3/3) | `OP-SR-7` |

- **Projection** (`PRJ-RC`): the recalled/searched body enters the tape as an `action` +
  `observation` (a node), rendered while the state is open and elided on `stop`.
- **Projection** (`PRJ-REF`): a refused structural move (no node) enters the tape as a
  transient `tool` message (`rejected <move>: <reason>`) for the next turn.

### 2.7 Traversal and containers (`TR`)

| Case | Rule | ID |
|---|---|---|
| focus | the focus is `branch[last]`, else the root | `TR-1` |
| descend | `focusEvents` descends into the request's current `move` (`move`), or the `move`'s goal (`goal`) | `TR-2` |
| return | a finished top is popped (`goal → move` on a goal `stop`; `move → request` when the next `move` is emitted); `return` is legal | `TR-3` |
| flat states | the states are the request's children (`move`), never nested; a new `move` after a finished state is a new child (a sibling) | `TR-4` |
| container choice | a goal's plan is a `plan` (`plan`); a state's work is a goal (`move.goal`); an item's alternatives are `alts` | `TR-5` |
| item order and cursor | items follow `items` order (the LAST is current); the cursor is the first not `itemFulfilled`; an item is fulfilled when its current alternative is a succeeded action (no goal alternative) | `TR-6` |
| placement | the incoming command becomes a new plan item when the current item is fulfilled, else a new alternative of it (`OP-AP-PLACE`) | `TR-7` |
| frontier | `applicable` computes move/apply/stop/decline from the same facts the gates use; the doxa chooses among them | `TR-8` |
| item alternatives | an item's alternatives (its history) are rendered in the tape with a marker | `TR-9` |

### 2.8 Derived facts (`DER`)

State is always derived from the incident events, never stored.

| Predicate | Rule | ID |
|---|---|---|
| state closed | the `move` has a `stop` relation to a `stop` node | `DER-MOVE-1` |
| state finished | a `move` with a `stop` relation (the terminal `move` closes the request) | `DER-STATE-1` |
| request finished | an `unactionable` node, or the current `move` is the terminal state and is finished | `DER-REQ-1` |
| current state | the state (`move.state`) of the last `move` child of the request | `DER-STATE-2` |
| structural forest | the work relations (`move`/`plan`/`items`/`alts`/`stop`) form a forest (a DAG with single parents) | `DER-FOREST-1` |
| action `executed` | it has a `result` or `mutates` relation | `DER-ACT-1` |
| run witness | a run's observation carries a `witness` (the basis for staleness) | `DER-STALE-1` |

---

## 3. Refusals and command non-execution (`REF`)

The `classify` gate (`src/loop/classify.ts`) refuses only a **structural** move: it emits
`record_rejection` and **must change the projection** (invariant). A **command** is handled
by the engine (`src/tools/index.ts`): its non-execution is recorded as an `action` +
`observation` with a reason, not a refusal without a node.

**Structural refusals (`record_rejection`):**

| Reason (token) | Trigger | Operator | ID |
|---|---|---|---|
| `empty_state` | malformed `move` (unknown `state`) | `move` | `REF-MV-EMPTY` |
| `no_state` | `apply` when the focus is not an open state (the request, or a finished state) | apply | `REF-AP-NO-STATE` |
| `no_state` | `apply` when the focus is not an open state | apply | `REF-NO-STATE` |
| `not_in_state` | `apply` choosing a tool outside the focused state's island `applies` | apply | `REF-NOT-IN-STATE` |
| `state_open` | `move` while the current state is still open (not stopped) | move | `REF-STATE-OPEN` |
| `not_addressed` | `stop` when the focus is neither an open state nor the terminal state (the request) | stop | `REF-ST-STATE` |
| `not_request` | `decline` at a non-request focus | decline | `REF-DC-NOTREQ` |
| `interpreted` | `decline` on a request that already has a `move` | decline | `REF-DC-ADDR` |

**Command non-execution (an `action` + `observation` with a reason):**

| Reason | Trigger | Operator | ID |
|---|---|---|---|
| `repeated_action` | identical read/grep/run with an unchanged world | read/grep/run | `REF-REPEAT` |
| `no_state` | `recall`/`search` outside an open state (a closed state's turns are elided; a fresh request has nothing stored) | recall, search | `REF-RC-STATE` |
| run without command | empty `run` | run | `REF-RUN-EMPTY` |
| `stale_base` | edit on a file changed after the read | edit | `REF-EDIT-STALE` |
| `constraint_violation:<pattern>` | edit a forbidden path | edit | `REF-EDIT-CONSTRAINT` |
| `stale_base` | write over a file changed after the read | write | `REF-WRITE-STALE` |
| `constraint_violation:<pattern>` | write a forbidden path | write | `REF-WRITE-CONSTRAINT` |

Tool **failures** (a fail observation): missing file (`read`), bad scope (`grep`/`list`),
`find` not present (`edit`), non-zero/timeout/signal (`run`).

---

## 4. Invariants

- a state is closed only by `stop` (a `stop` relation on the `move`); there is no criterion run
  and no exit-code gate.
- the request ends when its terminal state is stopped (there is no `stop` on the request); a
  request is started (`move`) or declined (`unactionable`).
- a run is an ordinary `observation`; its `exitCode` is output, not a verdict.
- a command that did not run leaves an `action` + `observation` with a reason (never a
  node-less refusal); a structural move that is inadmissible is refused without a node.
- a `stale` fact is never shown as active.
- `project` is deterministic: same events → same `Context`.
- structural relations (`move`/`unactionable`/`plan`/`stop`/`items`/`alts`) form a DAG.
- a state is its own goal (`what` on the `move`); the states are the request's flat `move`
  children; the plan hangs off the `move`.
- a refusal/failure changes the projection.
- a finished state (a closed state, or the stopped terminal) does not remain the focus; its
  turns leave the tape and only its `Start state` / `Finish state` remains.
- secrets live only in `.env`; small results may be inlined, never secrets.

Helpers already implement the first four: `tests/invariants.ts`.

---

## 5. Coverage matrix

Each spec ID has at least one offline test; the operator families also have an online
check. The random-tree properties (`tests/ops/ir_properties.test.ts`) back the
invariants across 400 generated trees. The live step tests
(`tests/live/ir_operations_step.test.ts`, run deliberately:
`SKEIN_LIVE=true npx vitest run ...`) build a projection offline and assert the shape
of the live model's next move (each step retries `SKEIN_STEP_REPEATS=3`).

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
| `DER-MOVE/STATE/REQ/ACT/STALE` | `tests/ops/derivation.test.ts` | — |
| `REF-MV-EMPTY`, `REF-STATE-OPEN` | `tests/ops/move.test.ts` | — |
| `REF-AP-NO-STATE`, `REF-NO-STATE` | `tests/ops/apply.test.ts`, `tests/ops/applicable.test.ts` | — |
| `REF-NOT-IN-STATE` | `tests/ops/applicable.test.ts` | — |
| `REF-RUN-EMPTY`, `REF-REPEAT`, `REF-RC-STATE` | `tests/ops/apply.test.ts`, `tests/ops/recall.test.ts` | — |
| `REF-EDIT` | `tests/ops/apply.test.ts` | scenario `constraint-honored` |
| `REF-WRITE-STALE`, `REF-WRITE-CONSTRAINT` | `tests/ops/apply.test.ts` | — |
| `OP-ST-1..3`, `REF-ST-STATE` | `tests/ops/stop.test.ts` | step `stop-open-goal` |
| `OP-DC-1`, `REF-DC-NOTREQ`, `REF-DC-ADDR` | `tests/ops/decline.test.ts` | — |
| `OP-AP-PLACE` | `tests/ops/traversal.test.ts` | steps `apply-next-action` |
| `TR-8` | `tests/ops/applicable.test.ts` | step `stop-open-goal` |
| `TR-9` | `tests/ops/traversal.test.ts` | — |

**Coverage gate** (`tests/coverage.test.ts`): every ID in this registry must appear
as a token in at least one test, and no test may cite an ID outside the registry —
the document and the tests cannot drift apart.

---

## 6. Extending

1. Add the spec point here with a new stable ID and its Pre/Effects/Derived/Refuses
   (and, if new, the refusal token in §3).
2. Add an offline test that cites the ID in its title.
3. Add a live scenario only if the operator family needs end-to-end confirmation.
4. The coverage gate fails until the matrix has the test.
