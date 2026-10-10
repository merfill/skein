# Skein — IR operations: reference and test matrix

> Russian mirror — `docs/ir_operations_ru.md`.

Related: `docs/ir_semantics.md` (the formal semantics — this document is the
operational reference and the coverage contract, not a second formalism),
`docs/projection.md`, `docs/tools.md`, `docs/ir.md`, `docs/walkthrough.md`,
`docs/testing.md`.

Status: **Implemented.** §1–§4 specify the model and every operator; §5 is the
coverage matrix (filled). An ID is **stable**: a spec point may gain tests, but its
meaning does not change.

> **Reduced goal model** (`docs/plans/goal_reduction_plan.md`). A goal is `what` plus
> a plan container seeded with the first command. Closure is
> dynamic: the doxa's `stop` closes a goal; there is no criterion, no exit-code gate,
> no `done_when`/`step`/`revises`, and no `state` (`exitCode` is ordinary output).

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

ID families: `OP-CG` create_goal, `OP-AP-READ|GREP|LIST|EDIT|WRITE|RUN|FETCH|PATCH` apply
sub-tools, `OP-AP-PLACE` how an `apply` lands in the tree, `OP-ST` stop, `OP-DC`
decline, `OP-RC`/`OP-SR` recall/search, `TR` traversal/containers, `DER` derived facts/predicates, `REF`
refusals (the catalogue), `PRJ` projection points (referenced).

---

## 1. Model

### 1.1 Work nodes (`src/ir/types.ts`)

| Kind | Payload | Role |
|---|---|---|
| `request` | `{text}` | raw motivation; the root; interpreted once (`goal`) or declined (`unactionable`); it ends when its goal is stopped |
| `goal` | `{what}` | the request's interpretation or a sub-goal |
| `plan` | — | ordered container of a goal's items (`items`); the LAST item is current |
| `item` | — | ordered container of a step's alternatives (`alts`: actions or sub-goals); the LAST is current |
| `action` | `{command, ...}` | a single tool run; an alternative of an item |
| `observation` | `{ref?, version?, command?, exitCode?, output/error/...}` | a tool result body; `exitCode` is ordinary output, not a closure oracle |
| `stop` | `{why?}` | closes the focused goal; a `stop` relation from the goal |
| `unactionable` | `{why?}` | the request's intent is not actionable; the doxa declines to formulate a goal (`unactionable` relation) |
| `constraint` | `{forbid: string[]}` | invariant; seeded at run start |
| `file` (artifact) | — | a referenced file; produced by `mutates` |

### 1.2 Relations (`src/ir/types.ts`)

| Relation | From → To | Meaning |
|---|---|---|
| `goal` | request → goal | the request's single interpretation (fixed) |
| `unactionable` | request → unactionable | the doxa declined to formulate a goal for the request |
| `plan` | goal → plan | the goal's plan container |
| `stop` | goal → stop | the goal was closed by the doxa |
| `items` | plan → item | ordered membership (order = sequence; the LAST item is current) |
| `alts` | item → action/goal | an item's ordered alternatives (the LAST is current) |
| `result` | action → observation | the action's result body |
| `mutates` | action → file | the action changed the file |

### 1.3 Events (`src/ir/events.ts`)

`add_node`, `add_edge`, `descend`, `return`, `mutate`, `record_rejection`. `fold`
applies them in order; state (`children`, `branch`, `focusOf`, versions) is **derived**,
never stored. There is no `record_check` and no `set_status`: a state change is a new
node-event (`observation`/`stop`). A run's result is a plain `observation`; its
`exitCode` is output, not a verdict.

### 1.4 Containers and traversal

- **branch** — the stack of goals from the request root to the focus; `descend`
  pushes, `return` pops (`TR-1`).
- **focus** — `branch[last]`, else the root (`TR-1`).
- **plan** — the `plan` relation target; **items** — `items` edges in insertion order; the
  **last** item is the current one.
- **alternatives** — an item's children (`alts`); the **current** alternative is the last
  child (there is no `chosen` edge).
- **frontier** — the admissible moves at the focus, computed **once** and shared by the
  projection and `classify` (`TR-8`). The doxa is handed the whole **arm** (the level's
  siblings) with the **cursor** on the current node only; the engine does not dictate a
  single next move.

---

## 2. Operators

### 2.1 `create_goal` (`OP-CG`)

| Case | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| at the request (interpretation) | focus is `request` with no goal yet | add `goal` (`what`); `goal` relation request → goal; add a `plan` with one `item` whose sole alternative is `command`; the logos runs `command` at once; `descend` | the interpretation is fixed; the goal's first item is executed | `empty_what`, `empty_command`, `interpreted` | `OP-CG-1` |
| decompose an open goal | focus is `goal` with a current item | add `goal`; append it as the current item's newest alternative (`alts`); add its plan/item with its first command (run at once); `descend` | the sub-goal is the item's newest alternative | as above; `no_current_item` | `OP-CG-2` |
| plan + first command | any of the above, `command` present | add exactly one item whose sole alternative is `command` under a new `plan` | the item is current; the command is executed | `empty_command` | `OP-CG-3` |
| one plan item | the seed is materialized as exactly one item | the plan holds one item (one command) | later moves append per the outcome (see `OP-AP-PLACE`) | — | `OP-CG-4` |

- **Projection** (`PRJ-CG`): the tape gains an `assistant` goal message; the goal carries
  its plan and its alternatives as history.
- **Notes.** Decomposing an open goal requires a current item; with none the move is refused
  (`no_current_item`). The first command is carried by `command` — it is not a special
  `step`, and the logos runs it at once.

### 2.2 `apply` (`OP-AP`)

The dispatch of one tool under the focus (`src/tools/index.ts`, `OP-AP-*`).

**How an `apply` lands in the plan** — the engine places the incoming command by the
outcome of the current (first unfulfilled) item (`docs/ir_semantics.md` §2.7): when that item is
already fulfilled (its current alternative succeeded) the command becomes a new plan `item`
(`OP-AP-PLACE-2`); otherwise it becomes a new alternative of that item (`OP-AP-PLACE-1`). A
sub-goal (`create_goal` on an open goal) always becomes a new alternative. The engine never
moves into the action.

#### 2.2.1 `read` (`OP-AP-READ`)

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

#### 2.2.2 `grep` (`OP-AP-GREP`)

| Case | Pre | Effects | ID |
|---|---|---|---|
| scoped search | `path`/`include`/`exclude` valid | action + observation (JSON windows) | `OP-AP-GREP-1` |
| paging | `from`/`count` | new action/observation; same-pattern repeat from a new `from` is new | `OP-AP-GREP-2` |
| no hits / bad scope | — | empty result / fail observation | `OP-AP-GREP-3` |
| repeat | identical scope+pattern, world unchanged | refused `repeated_action` | `OP-AP-GREP-4` |
| byte budget | a match window would exceed the byte limit | whole trailing results are dropped so the JSON stays within the limit; `returned` is below the count window and `next` is set; a single huge result has its lines clipped | `OP-AP-GREP-5` |
| count caps | `count` absent or too large | the window is at most `GREP_COUNT_DEFAULT` (50), never more than `MAX_GREP_MATCHES` (100) | `OP-AP-GREP-6` |

#### 2.2.3 `list` (`OP-AP-LIST`)

| Case | Pre | Effects | ID |
|---|---|---|---|
| list scope | — | action + observation (paths as JSON) | `OP-AP-LIST-1` |
| paging / empty | `from`/`limit` | new action/observation | `OP-AP-LIST-2` |
| byte budget | a page would exceed the byte limit | whole trailing files are dropped so the JSON stays within the limit; `returned` is below the page and `next` is set | `OP-AP-LIST-3` |
| limit caps | `limit` absent or too large | the page is at most `LIST_LIMIT_DEFAULT` (100), never more than `MAX_LIST_FILES` (200) | `OP-AP-LIST-4` |

#### 2.2.4 `edit` (`OP-AP-EDIT`)

| Case | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| replace | file read and unchanged since that read; not forbidden | add `action` (`find`/`replace`); `mutate` per changed file | file version changes; dependent facts stale | `stale_base`, `constraint_violation:<pattern>` | `OP-AP-EDIT-1` |
| find not present | — | action + fail observation (file materialized, pinned) | — | — | `OP-AP-EDIT-2` |
| forbidden path | a constraint forbids it | — | — | `constraint_violation:<pattern>` | `OP-AP-EDIT-3` |
| stale base | file changed after the last read | — | — | `stale_base` | `OP-AP-EDIT-4` |
| path outside the workspace | — | fail observation (recorded refusal, no crash) | — | — | `OP-AP-EDIT-5` |

#### 2.2.5 `run` (`OP-AP-RUN`)

`run` is one plain **foreground** command. There is no criterion, no `target`, and no
background-job machinery.

| Case | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| command | `command` present | action + `observation` (`command` + `exitCode`); `mutate` per changed file | versions; older reads stale | `repeated_action` | `OP-AP-RUN-1` |
| large output | a stream exceeds the byte limit | observation keeps the **tail** inline (the error and exit sit at the end) with an omission note; the full stream stays behind `outputRef`/`errorRef`, recalled via `recall` | — | — | `OP-AP-RUN-2` |

- **Projection** (`PRJ-AP`): the result node is `lastResult`; stdout (`output`) and
  stderr (`error`) are separate; a crash adds `signal`/`core`/`backtrace`; the `calls`
  entry carries the `id` for a later `recall`/`search`.

#### 2.2.6 `write` (`OP-AP-WRITE`)

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

#### 2.2.7 `fetch` (`OP-AP-FETCH`)

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

#### 2.2.8 `apply_patch` (`OP-AP-PATCH`)

Applies a unified diff in the workspace root (`patch -p<strip>`, default 1), e.g. an
upstream change obtained with `fetch`.

| Case | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| apply | the patch applies cleanly | action; `mutate` per changed file (`patch -p<strip>`) | changed versions; older reads stale | — | `OP-AP-PATCH-1` |
| does not apply | conflicting/already-applied hunk | fail observation | — | — (fail) | `OP-AP-PATCH-2` |
| forbidden target | a constraint forbids a `---`/`+++` path | — | — | `constraint_violation:<pattern>` | `REF-PATCH-CONSTRAINT` |

### 2.3 `decline` (`OP-DC`)

The doxa proposes that the request's intent is **not actionable** (chit-chat, no task) and
declines to formulate a goal — instead of inventing a goal. Available
only while the request has no interpretation yet; it records an `unactionable` node under
the request (`unactionable` relation) and ends the run
(`docs/plans/archive/request_goal_plan.md`).

| Case | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| decline the request | the focus is the request with no interpretation and no `unactionable` node | add an `unactionable` node and an `unactionable` relation from the request; the run ends | the request is terminal (`request_unactionable`) | — | `OP-DC-1` |
| not at the request | the focus is a goal | — | — | `not_request` | `REF-DC-NOTREQ` |
| already interpreted | the request already has an interpretation | — | — | `interpreted` | `REF-DC-ADDR` |

- **Projection** (`PRJ-DC`): the option `decline` is offered at a fresh request alongside
  `create_goal`.

### 2.4 `stop` (`OP-ST`)

The doxa's terminal move and the **sole closure**. On a **goal** it finishes the frame
(the engine returns to the parent on the next projection and continues); on the
**request** it ends the run. There is no criterion and no check: the doxa decides while
working.

| Case | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| finish an open goal | the focus is a goal | add a `stop` node and a `stop` relation from the goal | the goal is closed; the engine returns | — | `OP-ST-1` |
| closure recorded on the goal | a goal | the `stop` node is hung off the goal (no plan item); the reason lives in its `why` | the closure and its reason sit on the goal | — | `OP-ST-2` |
| the request ends | the request's goal has a `stop` relation | the run ends | stopReason `request_addressed` | — | `OP-ST-3` |
| not at a goal | the focus is the request | — | — | `not_addressed` | `REF-ST-STATE` |

- **Projection** (`PRJ-STOP`): the tape shows the closure message `stopped: <why>`; a closed
  goal's internals leave the tape.
- A goal is closed only by `stop` (a `stop` relation). There is no `stop` on the request; the
  request ends when its goal is stopped.

### 2.5 `recall` and `search` (`OP-RC`, `OP-SR`)

Two moves read a stored result by id (the "index" mechanism, docs/ir_semantics.md §4.5):
`recall` opens a body (optionally a line window), `search` finds a pattern inside it. Neither
creates a node — the result is a transient `assistant`+`tool` pair on the tape for the next
turn (docs/ir_semantics.md §7). They are separate tools so the doxa cannot conflate reading a
file / reading a result (`read`) with searching one (`grep` / `search`).

`recall { id, start?, end? }` (`OP-RC`):

| Case | Pre | Effects | ID |
|---|---|---|---|
| by id | the id addresses a stored body (observation or inline/`Ref` body) | no node; the body window is returned; a `continue from N` cursor when the body is longer | `OP-RC-1` |
| window | `start`/`end` | a line window; continues with a new `recall` | `OP-RC-2` |
| large body | the body exceeds the byte budget | the window is shrunk by whole lines (`QUERY_BODY_LIMIT`, valid JSON, never clipped mid-string); the error stream, if any, is the bounded inline tail | `OP-RC-3` |
| no body | the id is an action/goal/etc. | `(nothing to recall: <id> has no stored body)` | `OP-RC-4` |
| unknown id | — | `(nothing to recall: <id> is not a node)` | `OP-RC-5` |
| transient | — | no node; appended to the tape as a transient pair | `OP-RC-6` |

`search { id, pattern, before?, after? }` (`OP-SR`):

| Case | Pre | Effects | ID |
|---|---|---|---|
| by pattern | the id addresses a stored body; `pattern` is a regex | no node; matching line windows over stdout **and** stderr as JSON, with context | `OP-SR-1` |
| stderr | the body has a stderr stream | matches in the error stream carry `stream: "stderr"` | `OP-SR-2` |
| broad pattern | more matches than the window holds | whole trailing results dropped; a `note` says `showing N of M; narrow the pattern` — never a dangling `next` (`search` has no paging) | `OP-SR-3` |
| no match | — | empty `results` | `OP-SR-4` |
| invalid pattern | `pattern` is not a regex | `{ …, error: "invalid pattern" }` | `OP-SR-5` |
| no body | the id has no stored body | `(nothing to search: <id> has no stored body)` | `OP-SR-6` |
| context | `before`/`after` | `before`/`after` context lines per match (default 3/3) | `OP-SR-7` |

- **Projection** (`PRJ-RC`): the recalled/searched body enters the tape as a transient
  `assistant`+`tool` pair for the next turn; it is not pinned into the tree.
- **Projection** (`PRJ-REF`): a refused structural move (no node) enters the tape as a
  transient `tool` message (`rejected <move>: <reason>`) for the next turn.

### 2.6 Traversal and containers (`TR`)

| Case | Rule | ID |
|---|---|---|
| focus | the focus is `branch[last]`, else the root | `TR-1` |
| descend | `focusEvents` descends into the request's goal (`goal`), or the current item's sub-goal alternative (`alts`) | `TR-2` |
| return | a finished top is popped; `return` is legal | `TR-3` |
| trim under a finished ancestor | if any ancestor (other than the root) is finished, the branch is trimmed — not only when the top finishes | `TR-4` |
| container choice | a goal's plan is a `plan` (`plan`); the request's interpretation is a `goal` relation; an item's alternatives are `alts` | `TR-5` |
| item order and cursor | items follow `items` order (the LAST is current); the cursor is the first not `itemFulfilled`; an item is fulfilled when its current alternative is a succeeded action or a stopped goal | `TR-6` |
| placement | the incoming command becomes a new plan item when the current item is fulfilled, else a new alternative of it (`OP-AP-PLACE`) | `TR-7` |
| frontier | `applicable` computes create_goal/apply/stop/decline from the same facts the gates use; the doxa chooses among them | `TR-8` |
| item alternatives | an item's alternatives (its history) are rendered in the tape with a marker | `TR-9` |

### 2.7 Derived facts (`DER`)

State is always derived from the incident events, never stored.

| Predicate | Rule | ID |
|---|---|---|
| goal closed | the goal has a `stop` relation to a `stop` node | `DER-GOAL-1` |
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
| `empty_what` / `empty_command` | malformed `create_goal` | `create_goal` | `REF-CG-EMPTY` |
| `no_current_goal` | no focus | create_goal | `REF-NO-FOCUS` |
| `interpreted` | a second `create_goal` at a request that already has a goal | create_goal | `REF-INTERPRETED` |
| `not_addressed` | `stop` when the focus is not a goal (the request) | stop | `REF-ST-STATE` |
| `not_request` | `decline` at a non-request focus | decline | `REF-DC-NOTREQ` |
| `interpreted` | `decline` on a request that already has a goal | decline | `REF-DC-ADDR` |

**Command non-execution (an `action` + `observation` with a reason):**

| Reason | Trigger | Operator | ID |
|---|---|---|---|
| `repeated_action` | identical read/grep/run with an unchanged world | read/grep/run | `REF-REPEAT` |
| `repeated_action` | a bare recall of a body already in view (a windowed recall is new content) | recall | `REF-RECALL-REPEAT` |
| run without command | empty `run` | run | `REF-RUN-EMPTY` |
| `stale_base` | edit on a file changed after the read | edit | `REF-EDIT-STALE` |
| `constraint_violation:<pattern>` | edit a forbidden path | edit | `REF-EDIT-CONSTRAINT` |
| `stale_base` | write over a file changed after the read | write | `REF-WRITE-STALE` |
| `constraint_violation:<pattern>` | write a forbidden path | write | `REF-WRITE-CONSTRAINT` |

Tool **failures** (a fail observation): missing file (`read`), bad scope (`grep`/`list`),
`find` not present (`edit`), non-zero/timeout/signal (`run`).

---

## 4. Invariants

- a goal is closed only by `stop` (a `stop` relation on the goal); there is no criterion run
  and no exit-code gate.
- the request ends when its goal is stopped (there is no `stop` on the request); a request
  is interpreted once (`goal`) or declined (`unactionable`).
- a run is an ordinary `observation`; its `exitCode` is output, not a verdict.
- a command that did not run leaves an `action` + `observation` with a reason (never a
  node-less refusal); a structural move that is inadmissible is refused without a node.
- a `stale` fact is never shown as active.
- `project` is deterministic: same events → same `Context`.
- structural relations (`goal`/`unactionable`/`plan`/`stop`/`items`/`alts`) form a DAG.
- every non-root goal is bound by a `goal` or an `alts` relation.
- a refusal/failure changes the projection.
- a finished goal (and its descendants) does not remain the focus (`TR-4`); a closed goal's
  internals leave the tape.
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
| `OP-CG-1..4` | `tests/ops/create_goal.test.ts` | step `interpret-request`; scenario `multi-step-plan` |
| `OP-AP-READ-1..8` | `tests/ops/apply.test.ts` | scenario `locate-across-files` |
| `OP-AP-GREP-1..6` | `tests/ops/apply.test.ts` | scenario `locate-across-files` |
| `OP-AP-LIST-1..4` | `tests/ops/apply.test.ts` | scenario `locate-across-files` |
| `OP-AP-EDIT-1..5` | `tests/ops/apply.test.ts` | scenarios `stale-base`, `two-step-fix` |
| `OP-AP-WRITE-1..6` | `tests/ops/apply.test.ts` | scenario `command-from-package` |
| `OP-AP-RUN-1` | `tests/ops/apply.test.ts` | step `apply-next-action` |
| `OP-AP-FETCH-1..3`, `REF-FETCH-CONSTRAINT` | `tests/ops/apply.test.ts` | — |
| `OP-AP-PATCH-1..2`, `REF-PATCH-CONSTRAINT` | `tests/ops/apply.test.ts` | — |
| `OP-RC-1..6` | `tests/ops/recall.test.ts` | scenarios `retrieve-at-scale`, `reproduce-then-read` |
| `OP-SR-1..7` | `tests/ops/search.test.ts` | scenario `retrieve-at-scale` |
| `TR-1..9` | `tests/ops/traversal.test.ts` | steps `apply-next-action`, `continue-open-goal` |
| `DER-GOAL/ACT/STALE` | `tests/ops/derivation.test.ts` | — |
| `REF-CG`, `REF-NO-FOCUS`, `REF-INTERPRETED` | `tests/ops/create_goal.test.ts`, `tests/ops/applicable.test.ts` | — |
| `REF-RUN-EMPTY`, `REF-REPEAT`, `REF-RECALL-REPEAT` | `tests/ops/apply.test.ts`, `tests/ops/recall.test.ts` | — |
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
