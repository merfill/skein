# Skein — IR operations and operator registry

> Russian mirror — `docs/ru/ir_operations.md`.
>
> This is the formal reference: the model surface, the operators, the closure record, the
> detailed tool tables, refusals and the coverage registry. The conceptual model is in
> `ir.md`; the message tape is in `projection.md`.

## 1. Model surface

The model calls `move`, `apply` and `decline`; `recall` and `search` are read-only tools. A state is closed by a plain text reply, which the executor records as a `stop`. There is no `stop` tool on the model surface.

## 2. Operators

The model has three callable operators: `move`, `apply` and `decline`. `recall` and `search` are
read-only tools. A state is closed by a plain text reply; the executor records it as a `stop`
record. Each operator and the closure record are specified by their precondition, their effects on
the journal and the work model, the derived facts they change, the reasons for which admissibility
may be refused, and their projection. Each specification carries a stable identifier, which a test
cites as the `ID` token in its title.

The identifier families are: `OP-MV` for `move`; `OP-CG` for the first turn of a state, created by
its first `apply`; `OP-AP-READ`, `OP-AP-GREP`, `OP-AP-LIST`, `OP-AP-EDIT`, `OP-AP-WRITE`,
`OP-AP-RUN`, `OP-AP-FETCH` and `OP-AP-PATCH` for the apply sub-tools (the `RUN` prefix denotes the
`bash` tool); `OP-AP-PLACE` for the placement of an `apply` in the state; `OP-ST` for `stop`;
`OP-DC` for `decline`; `OP-RC` and `OP-SR` for `recall` and `search`; `TR` for focus and
containers; `DER` for derived facts; `REF` for refusals; and `PRJ` for projection rules.

### 2.1 `move`

A `move` declares the state — the kind of work — in which the model will work. It is the transition
of the automaton.

**Input.** `{ state, what? }`. The field `state` is one of the state names offered by the request or
transition prompt. The field `what` is an optional note about the concrete subject — a guess that
may be wrong, not the goal of the state. The legacy field `done` is accepted in old journals but is
not offered to the model and is not rendered.

**Action.** The executor creates a `move` node `M` with payload `{ state, what }`, links it as the
newest `move` child of the request, and records the focus change. A `move` is legal at a fresh
request (no `move` yet) and at a finished state (a `move` carrying a `stop`). It is refused while a
state is still open (`state_open`) or when the state name is invalid (`empty_state`).

| Case | Precondition | Effects | Derived facts | Refusals | ID |
|---|---|---|---|---|---|
| open a state | the focus is the request and no `move` exists | add `move` (`state`, `what`); add the relation `move` from the request; move the focus | the state is declared; its turns are empty until the first `apply` | `empty_state` | `OP-MV-1` |
| transition to the next state | the current state is finished | add a `move` as a new child of the request, a sibling of the previous state; leave the finished state behind; move the focus | the finished state stays on the tape as `Start` + `Finish`; the focus is the new `move` | `empty_state`, `state_open`, `unreachable`, `not_startable` | `OP-MV-2` |
| enter the terminal state | the target is `end` | as above, without `what`; the terminal state accepts `stop` directly | entering the terminal state marks the end of the run | `empty_state` | `OP-MV-3` |

- **Projection** (`PRJ-MV`): an open state renders the `Start state <label>` marker (a `system`
  turn), the brief for that state (a `system` turn), and its turns. The per-turn working prompt is
  appended by `buildMessages` after the turns (a `user` turn) and carries `Goal`, the model's guess,
  `Done when` and `Plan`. Once the state is stopped, only `Start state <label>` and
  `Finish state <label> — <why>` remain (plus `Artifacts:` when the state wrote files); the brief,
  working prompt and turn messages are elided.
- A `move` is refused while a state is still open (`state_open`). The executor does not decide when
  a state is finished: the model closes it by stopping and chooses the next state. The field `what`
  is optional.

### 2.2 `apply`

An `apply` executes one command in the current state. It also gives birth to the state's turns: the
first `apply` after a `move` creates the `turns` container and its first `turn` (`OP-CG-1`). That
first turn is an ordinary tool call, not a separate operator.

**Input.** `{ tool, … }`, where `tool` is one of `read`, `grep`, `list`, `edit`, `write`, `bash`,
`fetch` or `apply_patch`, together with the parameters of that tool.

**Action.** The command runs. Its outcome is recorded either as `A.result = observation` (for
`read`, `grep`, `list`, `bash` and `fetch`) or as `A.mutates += file` (for `edit`, `write` and
`apply_patch`); if the command did not run, the outcome is an observation with a reason. The action
is appended to the state's turns (see `ir.md` §3). The focus does not move. An `apply` is admissible only
inside an open state; elsewhere it is refused with `no_state`.

**Placement.** Every `apply` appends exactly one turn to the `turns` of the open state, in order
(`OP-AP-PLACE-1`). After a carried-out turn, the next `apply` appends the next turn
(`OP-AP-PLACE-2`). There is no intermediate layer of plan items and no cursor. The executor never
enters the action.

**Batches.** The executor accepts one or more calls per move and applies them in order within the
same turn, sharing `payload.turn`. A terminal move (`move`, `stop` or `decline`) ends the batch, so
anything the model emits after it is discarded (`src/loop/graph.ts`, `executeNode`). The projection
renders a batch as one `assistant` message with N `tool_calls` followed by N `tool` results (`ir.md` §4).

| Case | Precondition | Effects | Derived facts | Refusals | ID |
|---|---|---|---|---|---|
| first turn | the focus is a non-terminal `move` with no turns | `apply` creates the `turns` node and its first `turn` for any tool; the executor executes it immediately | the state acquires its turns; the first turn is executed | none; an empty `bash` is a failed observation, `REF-RUN-EMPTY` | `OP-CG-1` |
| next turn | the focus is an open state that has turns | `apply` appends the next `turn` (`OP-AP-PLACE-1`); after a carried-out turn, the next `apply` appends the next turn (`OP-AP-PLACE-2`) | the turns grow in the order of addition | `no_state` | `OP-AP-PLACE-1`, `OP-AP-PLACE-2` |

#### 2.2.1 `read` (`OP-AP-READ`)

| Case | Precondition | Effects | ID |
|---|---|---|---|
| new window | the path exists; the requested window has not been read against the current version | add an `action`; add an `observation` as its `result`; record the observed version | `OP-AP-READ-1` |
| continued window | a different `start` or `end` | a new action and observation | `OP-AP-READ-2` |
| missing file | — | an action and a failed observation | `OP-AP-READ-3` |
| repeat | an identical window against an unchanged world | an action and an observation whose reason is `repeated_action`, naming the stored identifier | `OP-AP-READ-4` |
| path outside the workspace | — | an action and a failed observation, without a crash | `OP-AP-READ-5` |
| repeated windows of one file | several different windows of the same file | each different window is a new action and observation, with no per-file limit; an identical window is `OP-AP-READ-4` | `OP-AP-READ-6` |
| large window | the requested window exceeds the byte limit | the observation shows the whole window and never drops its middle; only a single over-long line is clipped, while the full window remains behind `outputRef` and is recalled by `recall` | `OP-AP-READ-7` |
| window beyond the budget | the file is longer than the byte budget | the window is cut at whole lines up to `READ_LIMIT`; a `continue from N` trailer points to the next window | `OP-AP-READ-8` |

#### 2.2.2 `grep` (`OP-AP-GREP`)

| Case | Precondition | Effects | ID |
|---|---|---|---|
| scoped search | `path`, `include` and `exclude` are valid | an action and an observation with plain-text windows | `OP-AP-GREP-1` |
| paging | `from` and `count` | a new action and observation; a repeat of the same pattern from a new `from` is new | `OP-AP-GREP-2` |
| no hits or a bad scope | — | an empty result, or a failed observation | `OP-AP-GREP-3` |
| repeat | an identical scope and pattern against an unchanged world | refused with `repeated_action` | `OP-AP-GREP-4` |
| match window beyond the budget | a window would exceed the byte limit | whole trailing matches are dropped so that the window fits; a trailer `[showing N of M matches; continue from K]` points to the continuation; a single very large match is clipped by lines | `OP-AP-GREP-5` |
| count limits | `count` is absent or too large | the window is at most `GREP_COUNT_DEFAULT` (50) and never exceeds `MAX_GREP_MATCHES` (100) | `OP-AP-GREP-6` |

#### 2.2.3 `list` (`OP-AP-LIST`)

| Case | Precondition | Effects | ID |
|---|---|---|---|
| list scope | — | an action and an observation with paths as JSON | `OP-AP-LIST-1` |
| paging or empty result | `from` and `limit` | a new action and observation | `OP-AP-LIST-2` |
| page beyond the budget | a page would exceed the byte limit | whole trailing files are dropped so that the JSON fits; `returned` is below the page size and `next` is set | `OP-AP-LIST-3` |
| limit caps | `limit` is absent or too large | the page is at most `LIST_LIMIT_DEFAULT` (100) and never exceeds `MAX_LIST_FILES` (200) | `OP-AP-LIST-4` |

#### 2.2.4 `edit` (`OP-AP-EDIT`)

| Case | Precondition | Effects | Derived facts | Refusals | ID |
|---|---|---|---|---|---|
| replacement | the file was read and is unchanged since that read, and is not forbidden | add an `action` with `find` and `replace`; emit `mutate` for each changed file | file versions change; dependent facts become stale | `stale_base`; a forbidden pattern | `OP-AP-EDIT-1` |
| `find` absent | — | an action and a failed observation; the file is materialised and pinned | — | — | `OP-AP-EDIT-2` |
| forbidden path | a constraint forbids the path | — | — | a forbidden pattern | `OP-AP-EDIT-3` |
| stale base | the file changed after the last read | — | — | `stale_base` | `OP-AP-EDIT-4` |
| path outside the workspace | — | a failed observation, recorded as a refusal without a crash | — | — | `OP-AP-EDIT-5` |

#### 2.2.5 `bash` (`OP-AP-RUN`)

A `bash` call is a single foreground command. There is no `target` and no background-job
machinery. The registry prefix `RUN` is historical; the IR tool name is `bash`.

| Case | Precondition | Effects | Derived facts | Refusals | ID |
|---|---|---|---|---|---|
| command | `command` is present | an action and an `observation` carrying `command` and `exitCode`; `mutate` for each changed file | versions change; older reads become stale | `repeated_action` | `OP-AP-RUN-1` |
| large output | a stream exceeds the byte limit | the observation keeps the tail inline, where the error and the exit status appear, with a note about the omission; the full stream remains behind `outputRef` and `errorRef` and is recalled by `recall` | — | — | `OP-AP-RUN-2` |
| workdir | `workdir` names an existing path inside the workspace | the command runs in that directory | — | a failed observation with `workdir does not exist` or `path escapes workspace` | `OP-AP-RUN-3` |

`workdir` runs the command in a subdirectory of the workspace instead of prefixing it with
`cd … &&`. `timeout` caps this single command in milliseconds. Both belong to the repeat signature,
so the same text under a different directory or cap counts as a new action.

#### 2.2.6 `write` (`OP-AP-WRITE`)

| Case | Precondition | Effects | Derived facts | Refusals | ID |
|---|---|---|---|---|---|
| create | the path does not exist | add an `action` with `path` and `content`; emit `mutate`; set the file version | — | — | `OP-AP-WRITE-1` |
| overwrite | the file was read and is unchanged since that read, and is not forbidden | add an action; emit `mutate`; increment the version | dependent facts become stale | `stale_base`; a forbidden pattern | `OP-AP-WRITE-2` |
| forbidden path | a constraint forbids the path | — | — | a forbidden pattern | `OP-AP-WRITE-3` |
| stale base | the file changed after the last read | — | — | `stale_base` | `OP-AP-WRITE-4` |
| unseen file | the file exists but was never read | — | — | a failed observation with `read it first` | `OP-AP-WRITE-5` |
| path outside the workspace | — | a failed observation, recorded as a refusal without a crash | — | — | `OP-AP-WRITE-6` |

#### 2.2.7 `fetch` (`OP-AP-FETCH`)

A `fetch` obtains external reference evidence, such as an upstream, published or sibling copy,
into the workspace, where it can be read and compared. On the model surface this tool is named
`webfetch`.

| Case | Precondition | Effects | Derived facts | Refusals | ID |
|---|---|---|---|---|---|
| fetch | the URL is reachable, the target does not exist and is not forbidden | an action; the file is written; `mutate` and `mutates`; an observation with `url`, `path` and `bytes` | the file version is set; older reads become stale | — | `OP-AP-FETCH-1` |
| download failure | a non-2xx response or a timeout | a failed observation | — | — | `OP-AP-FETCH-2` |
| target exists or path outside the workspace | — | a failed observation with `choose another path`, or a recorded refusal | — | — | `OP-AP-FETCH-3` |
| forbidden explicit path | a constraint forbids the path | — | — | a forbidden pattern | `REF-FETCH-CONSTRAINT` |

The default target is chosen by the executor (`refPathFor`, `.skein/ref/<hash>-<slug>`), so only an
explicit `path` is checked against constraints.

#### 2.2.8 `apply_patch` (`OP-AP-PATCH`)

An `apply_patch` applies a unified diff in the root of the workspace (`patch -p<strip>`, with a
default strip level of 1), for example an upstream change obtained by `fetch`.

| Case | Precondition | Effects | Derived facts | Refusals | ID |
|---|---|---|---|---|---|
| apply | the patch applies cleanly | an action; `mutate` for each changed file | versions change; older reads become stale | — | `OP-AP-PATCH-1` |
| does not apply | a hunk conflicts or was already applied | a failed observation | — | — | `OP-AP-PATCH-2` |
| forbidden target | a constraint forbids a path in `---` or `+++` | — | — | a forbidden pattern | `REF-PATCH-CONSTRAINT` |

### 2.3 Closure (`stop` record)

A `stop` is the closure record of a state, not a tool call. The model closes an open state by
replying with text; the executor records the `stop` relation, taking the reply as the reason. At
the terminal state (`end`), which has no turns, the same closure ends the run. The model decides
while it works.

**Input.** The reply text; it is stored in `why`.

**Action.** If the focus is an open state, the executor creates a `stop` node `S` and links
`M.stop = S`. The state becomes finished, and the next decision is the transition (§2.1). If the
focus is the terminal state, the same closure ends the request with `request_addressed`. A `stop`
at the request, or at an already finished state, is refused with `not_addressed`.

| Case | Precondition | Effects | Derived facts | Refusals | ID |
|---|---|---|---|---|---|
| finish the work of a state | the focus is an open state | add a `stop` node and a `stop` relation from the state's `move` | the state is finished; the focus returns to its `move` | — | `OP-ST-1` |
| record the closure on the move | a state | the `stop` node hangs off the `move`, not off a turn; the reason is stored in `why` | the closure and its reason reside on the `move` | — | `OP-ST-2` |
| end the request | the focus is the terminal state (`end`) | add a `stop` node and a `stop` relation from the `move` | the run ends with stopReason `request_addressed` | — | `OP-ST-3` |
| not in a closeable state | the focus is the request or a non-terminal `move` | — | — | `not_addressed` | `REF-ST-STATE` |

- **Projection** (`PRJ-STOP`): the closure of a state renders as `Finish state <label> — <why>`.
  The `stop` adds no tool call, and the turn messages of the state leave the tape.
- A state is closed only by `stop`, a relation on its `move`. The terminal state is closed in the
  same way. There is no `stop` on the request; the request ends when its terminal state is stopped.

### 2.4 `decline`

A `decline` finishes a request whose intent is not actionable, without inventing a state. It is
available only while the request has no `move`. It records an `unactionable` node under the request
and ends the run.

**Input.** `{ why? }`, the reason.

**Action.** The executor creates an `unactionable` node `U` and links `R.unactionable = U`. No
`move` or turns are created. The run ends with `request_unactionable`. At a `move` the move is
refused with `not_request`; on an already interpreted request with `interpreted`.

| Case | Precondition | Effects | Derived facts | Refusals | ID |
|---|---|---|---|---|---|
| decline the request | the focus is the request, with no `move` and no `unactionable` node | add an `unactionable` node and a relation from the request; the run ends | the request is terminal (`request_unactionable`) | — | `OP-DC-1` |
| not at the request | the focus is a `move` | — | — | `not_request` | `REF-DC-NOTREQ` |
| already started | the request already has a `move` | — | — | `interpreted` | `REF-DC-ADDR` |

- **Projection** (`PRJ-DC`): `decline` is offered at a fresh request alongside `move`.

### 2.5 `recall` and `search`

`recall` and `search` are read-only tools that address a stored result by its identifier. Neither
changes the work model. `recall` opens a body, optionally a window of lines; `search` finds a
pattern inside it. Both leave an `action` and its `observation` in the turns of the state, like any
other step, so that the fetched window remains on the state's tape while the state is open and is
elided when the state is stopped (`ir.md` §4). They are distinct tools so that the model does not confuse
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

### 2.6 Focus, containers and derived facts

The focus is the deterministic part of the executor: it computes the admissible moves at the current
point. Derived facts are read from the journal; nothing is stored.

| Case or predicate | Rule | ID |
|---|---|---|
| focus | the focus is `branch[last]`, or the root when the branch is empty | `TR-1` |
| descend | `focusEvents` descends into the current `move` of the request | `TR-2` |
| return | a finished top is popped on `stop` or on the next `move`; `return` is legal | `TR-3` |
| flat states | states are children of the request through `move` and are never nested; a `move` after a finished state is a sibling | `TR-4` |
| container choice | the request holds `move`s, a `move` holds `turns`, and `turns` holds `turn`s | `TR-5` |
| turn order | turns follow the order of `turn` relations; the last is current; the list only grows and has no cursor | `TR-6` |
| placement | an incoming `apply` appends the next turn (`OP-AP-PLACE`) | `TR-7` |
| frontier | `applicable` computes `move`, `apply`, `stop` and `decline` from the same facts used by the structural checks; the model chooses | `TR-8` |
| turn rendering | every command is rendered as its own native call and result pair, with no marker for variants | `TR-9` |
| state closed or finished | the `move` has a `stop` relation to a `stop` node | `DER-MOVE-1`, `DER-STATE-1` |
| request finished | an `unactionable` node exists, or the current `move` is the terminal state and is finished | `DER-REQ-1` |
| current state | the `state` of the last `move` child of the request | `DER-STATE-2` |
| structural forest | the work relations `move`, `turns`, `turn`, `stop` and `unactionable` form a forest with a single parent per node | `DER-FOREST-1` |
| action executed | the action has a `result` or a `mutates` relation | `DER-ACT-1` |
| run witness | the observation of a run carries a `witness`, the basis of staleness | `DER-STALE-1` |

## 3. Versions and the witness

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

## 4. Completion and errors

| Condition | Closed by | Derived state |
|---|---|---|
| an open state | `stop`, with no additional condition | closed; the `stop` relation leads from move to stop; the state is finished and the focus remains on its `move` |
| the terminal state (`end`) | `stop`, with no additional condition | closed; the request ends with `request_addressed` |
| the request | ends when the terminal state is stopped (`request_addressed`) or when it is declined (`request_unactionable`); the request has no `stop` | the run ends |

**An error is a result.** On a persistent model error (`llm_error`), the executor closes the state
in which the call failed with an executor-owned `stop` carrying `error: true`, enters the terminal
state, and writes the final report there. If the reporting call also fails, the report falls back
deterministically to the `Finish` lines. The `stopReason` remains `llm_error`, and the terminal
`stop` is marked `error`, so the session derives `abandoned` rather than `completed`.

**The IR contains no evaluation of the request.** The terminal state ends the run, and the request
ends when it is closed. There is no "accepted" node and no pass/fail field: the journal records
what happened. The `exitCode` of a command is an ordinary observation. No hypothesis is stored as
an assumption.

## 5. Refusals and non-execution of commands

The structural check `classify` (`src/loop/classify.ts`) refuses only structural moves. A refusal emits
`record_rejection` and must change the projection, as required by the invariants. A command is
handled by the executor (`src/tools/index.ts`); its non-execution is recorded as an `action` and an
`observation` with a reason, not as a nodeless refusal.

**Structural refusals (`record_rejection`).**

| Reason token | Trigger | Operator | ID |
|---|---|---|---|
| `empty_state` | a malformed `move` with an unknown `state` | `move` | `REF-MV-EMPTY` |
| `not_startable` | a `move` into a live state that cannot start a request | `move` | `REF-MV-NOT-STARTABLE` |
| `unreachable` | a `move` outside the `next` neighbours of the finished state | `move` | `REF-MV-UNREACHABLE` |
| `no_state` | an `apply` when the focus is not an open state | `apply` | `REF-AP-NO-STATE`, `REF-NO-STATE` |
| `not_in_state` | an `apply` with a tool outside the state kind's `applies` | `apply` | `REF-NOT-IN-STATE` |
| `state_open` | a `move` while the current state is still open | `move` | `REF-STATE-OPEN` |
| `not_addressed` | a `stop` when the focus is neither an open state nor the terminal state | `stop` | `REF-ST-STATE` |
| `not_request` | a `decline` at a focus other than the request | `decline` | `REF-DC-NOTREQ` |
| `interpreted` | a `decline` on a request that already has a `move` | `decline` | `REF-DC-ADDR` |

The two identifiers `REF-AP-NO-STATE` and `REF-NO-STATE` name the same refusal; they are kept as
registry tokens because separate test families cite them.

**Non-execution of commands, recorded as an `action` and an `observation` with a reason.**

| Reason | Trigger | Operator | ID |
|---|---|---|---|
| `repeated_action` | an identical `read`, `grep` or `bash` against an unchanged world | `read`, `grep`, `bash` | `REF-REPEAT` |
| `no_state` | a `recall` or `search` outside an open state | `recall`, `search` | `REF-RC-STATE` |
| an empty command | an empty `bash` | `bash` | `REF-RUN-EMPTY` |
| `stale_base` | an `edit` of a file changed after it was read | `edit` | `REF-EDIT-STALE` |
| a forbidden pattern | an `edit` of a forbidden path | `edit` | `REF-EDIT-CONSTRAINT` |
| `stale_base` | a `write` over a file changed after it was read | `write` | `REF-WRITE-STALE` |
| a forbidden pattern | a `write` to a forbidden path | `write` | `REF-WRITE-CONSTRAINT` |

Tool failures, by contrast, are recorded as failed observations: a missing file in `read`, a bad
scope in `grep` or `list`, an absent `find` in `edit`, and a non-zero exit, a timeout or a signal
in `bash`.

## 6. The implementation

The system distinguishes four levels.

```
                 append-only              pure            pure
  actions ─▶ journal (Event[]) ──fold──▶ State ──project──▶ Context ──▶ LLM
     ▲                                                             │
     └─────────── proposal: one or more operators per turn ◀────────┘
```

1. The **journal** (`src/ir/events.ts`) is append-only and is the single source of truth.
2. The **state** (`src/ir/graph.ts`, `src/ir/traversal.ts`) is `fold(events)`: it comprises the
   nodes, relations, container order, derived helpers, the focus and file versions.
3. The **context** (`src/ir/project.ts`) is `project(state)`, a deterministic message tape.
4. The **tape** is the only input-output surface: the system part, comprising the base prompt, the
   state's brief and the constraints; the request; and the history. The facts of the probe appear
   in the entry of the current state.

Before `project` runs, the executor reconciles active `ref`s with the filesystem
(`src/loop/observe.ts`), and any drift becomes a `mutate` event.

**Map of the code.**

| Area | Files |
|---|---|
| node and edge kinds, payloads | `src/ir/types.ts` |
| event schema and closed vocabulary | `src/ir/events.ts` |
| folding, derived facts, versions | `src/ir/graph.ts` |
| focus and admissible moves | `src/ir/traversal.ts` |
| states, goals, criteria and apply surfaces | `src/ir/islands.ts` |
| projection | `src/ir/project.ts`, `src/loop/propose.ts` |
| structural-refusal check | `src/loop/classify.ts` |
| commands, observations and refusals | `src/tools/index.ts` |
| tool schema and native names | `src/llm/schemas.ts`, `src/llm/tools.ts` |

## Coverage matrix

Every specification identifier has at least one offline test, and each family of operators also
has an online check. The random-tree properties in `tests/ops/ir_properties.test.ts` support the
invariants across 400 generated IRs. The live step tests (`tests/live/ir_operations_step.test.ts`,
run deliberately with `SKEIN_LIVE=true npx vitest run ...`) build a projection offline and assert
the shape of the next move of the live model.

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

The coverage check (`tests/coverage.test.ts`) requires every identifier in this registry to be cited
as a token by at least one test, and forbids a test from citing an identifier outside the registry.
The document and the tests therefore cannot drift apart.

## Extending the registry

1. Add a specification point to this document with a new stable identifier, its precondition,
   effects, derived facts and refusals; if the refusal is new, add its token in §5.
2. Add an offline test that cites the identifier in its title.
3. Add a live scenario only if the operator family needs an end-to-end check.
4. The coverage check fails until the matrix contains a test.
