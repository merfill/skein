# Skein — IR operations: reference and test matrix

> Russian mirror — `docs/ir_operations_ru.md`.

Related: `docs/ir_semantics.md` (the formal semantics — this document is the
operational reference and the coverage contract, not a second formalism),
`docs/projection.md`, `docs/tools.md`, `docs/ir.md`, `docs/walkthrough.md`,
`docs/testing.md`.

Status: **Implemented.** §1–§4 specify the model and every operator; §5 is the
coverage matrix (filled). An ID is **stable**: a spec point may gain tests, but its
meaning does not change.

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
sub-tools, `OP-AP-CONT|ALT` how an `apply` lands in the tree, `OP-ST` stop, `OP-DC`
decline, `OP-QR` query, `TR` traversal/containers, `DER` derived facts/predicates, `REF`
refusals (the catalogue), `PRJ` projection points (referenced).

---

## 1. Model

### 1.1 Work nodes (`src/ir/types.ts`)

| Kind | Payload | Role |
|---|---|---|
| `request` | `{text}` | raw motivation; the root; interpreted once (`has_goal`) or declined (`no_goal`); it ends when its goal is stopped |
| `goal` | `{what, why?, done_when, plan?}` | the request's interpretation or a sub-goal; `done_when` is the criterion command (a string); `plan` is the initial string sketch (I3) |
| `action` | `{command, ...}` | a single tool run; also a plan item of kind `action` |
| `plan` | — | ordered container of a goal's stage items (`item` edges); the LAST item is the current one |
| `alternatives` | — | container of variants (a revised goal, or a branched step); `item` edges, order = sequence, the LAST is current |
| `observation` | `{ref?, version?, command?, target?, exitCode?, witness?, output/error/...}` | a tool result body; a criterion run carries `target`+`exitCode` |
| `stop` | `{why?}` | finishes the focused goal: appended as its LAST plan item, with a `has_stopped` edge from the goal |
| `unactionable` | `{why?}` | the request's intent is not actionable; the doxa declines to formulate a goal (`no_goal` edge) |
| `constraint` | `{forbid: string[]}` | invariant; seeded at run start |
| `file` (artifact) | — | a referenced file; produced by `mutates` |

### 1.2 Edges (`src/ir/types.ts`)

| Kind | From → To | Meaning |
|---|---|---|
| `has_goal` | request → goal | the request's single interpretation (fixed) |
| `has_plan` | goal → plan | the goal's stage container |
| `item` | plan/alternatives → goal/action/stop | ordered membership (order = sequence; the LAST item is current) |
| `has_alternatives` | goal / plan item → alternatives | a container of variants (a revised goal / a branched step) |
| `produces` | action → observation | the action's result body |
| `has_stopped` | goal → stop | the goal was finished by the doxa (the `stop` is also the goal's last plan item) |
| `no_goal` | request → unactionable | the doxa declined to formulate a goal for the request |
| `mutates` | action → file | the action changed the file |

### 1.3 Events (`src/ir/events.ts`)

`add_node`, `add_edge`, `descend`, `return`, `mutate`, `record_rejection`. `fold`
applies them in order; state (`children`, `branch`, `focusOf`, versions) is **derived**,
never stored. There is no `record_check` and no `set_status`: a state change is a new
node-event (`observation`/`stop`). A run's result is a plain `observation`; pass/fail is
read from its `exitCode`.

### 1.4 Containers and traversal

- **branch** — the stack of goals from the request root to the focus; `descend`
  pushes, `return` pops (`TR-1`).
- **focus** — `branch[last]`, else the root (`TR-1`).
- **plan** — `has_plan` target; **items** — `item` edges in insertion order; the **last**
  item is the current one.
- **alternatives** — `has_alternatives` target; the **current** option is the last `item`
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
| at the request (interpretation) | focus is `request` with no goal yet | add `goal`; `has_goal` request → goal; `descend` into it | goal `open`; the interpretation is fixed | `empty_what`, `empty_done_when`, `empty_plan`, `empty_step`, `interpreted` | `OP-CG-1` |
| decompose an open goal | focus is `goal:open`, criterion not failed, with a current action step | add `goal`; ensure `alternatives` on the current step; `item`; `descend` | the sub-goal is the step's newest option; the step is superseded | as above; `all plan items are fulfilled` (must check, not grow) | `OP-CG-2` |
| revision (`revises`) | focus is a goal whose criterion failed | add `goal`; `item` into the failed goal's own / current `alternatives` container; `descend` | the failed options become unselected; new goal `open` | `missing_revision` (not all failed options listed), `unknown_revision` (`revises` at a non-failed point) | `OP-CG-3` |
| plan + first step | any of the above, `plan` (string) and `step` present | store `plan` on the goal; add exactly one action item (`step`) under a new `plan` container | the step item `open` | `empty_plan` (blank sketch), `empty_step` (blank command) | `OP-CG-4` |

- **Projection** (`PRJ-CG`): the focus `path` gains the goal (`what`/`why`/
  `done_when`/`planHint`).
- **Notes.** `why` is the hypothesis and is surfaced on the item so a failed
  attempt is not repeated (`PRJ-PATH-why`). A `what` equal (normalized) to a failed
  option is `repeat_hypothesis`. Decomposing an open goal requires a current action
  step; with none, the engine records a fail observation
  (`create goal failed: no current step to decompose`).

### 2.2 `apply` (`OP-AP`)

The dispatch of one tool under the focus (`src/tools/index.ts`, `OP-AP-*`).

**How an `apply` lands in the plan** — the *continue* vs *alternative* distinction
(`docs/ir_semantics.md` §2.6): reuse an unexecuted action item with the same command
(`OP-AP-CONT-1`); else attach the new action as the newest alternative of the current
unfulfilled item (`OP-AP-ALT-1`); else create the action and append it as a new plan
`item` (`OP-AP-CONT-2`). The engine never moves into the action. At a settled request
(`requestSettled`) every `apply` is refused with `addressed` (only `stop` is accepted).

#### 2.2.1 `read` (`OP-AP-READ`)

| Case | Pre | Effects | ID |
|---|---|---|---|
| new window | path exists; world unchanged since a prior identical read | add `action`; add `observation` (`produces`); record observed version | `OP-AP-READ-1` |
| continue window | a different `start/end` | new action/observation | `OP-AP-READ-2` |
| missing file | — | action + fail observation | `OP-AP-READ-3` |
| repeat | identical window, world unchanged | refused `repeated_action` | `OP-AP-READ-4` |
| path outside the workspace | — | action + fail observation (recorded refusal, no crash) | `OP-AP-READ-5` |
| read thrash | the unchanged file was already read twice (no edit since) | refused `repeated_action` (point at the edit) | `OP-AP-READ-6` |

#### 2.2.2 `grep` (`OP-AP-GREP`)

| Case | Pre | Effects | ID |
|---|---|---|---|
| scoped search | `path`/`include`/`exclude` valid | action + observation (JSON windows) | `OP-AP-GREP-1` |
| paging | `from`/`count` | new action/observation; same-pattern repeat from a new `from` is new | `OP-AP-GREP-2` |
| no hits / bad scope | — | empty result / fail observation | `OP-AP-GREP-3` |
| repeat | identical scope+pattern, world unchanged | refused `repeated_action` | `OP-AP-GREP-4` |

#### 2.2.3 `list` (`OP-AP-LIST`)

| Case | Pre | Effects | ID |
|---|---|---|---|
| list scope | — | action + observation (paths as JSON) | `OP-AP-LIST-1` |
| paging / empty | `from`/`limit` | new action/observation | `OP-AP-LIST-2` |

#### 2.2.4 `edit` (`OP-AP-EDIT`)

| Case | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| replace | file read and unchanged since that read; not forbidden | add `action` (`find`/`replace`); `mutate` per changed file | file version changes; dependent facts stale | `stale_base`, `constraint_violation:<pattern>` | `OP-AP-EDIT-1` |
| find not present | — | action + fail observation (file materialized, pinned) | — | — | `OP-AP-EDIT-2` |
| forbidden path | a constraint forbids it | — | — | `constraint_violation:<pattern>` | `OP-AP-EDIT-3` |
| stale base | file changed after the last read | — | — | `stale_base` | `OP-AP-EDIT-4` |
| path outside the workspace | — | fail observation (recorded refusal, no crash) | — | — | `OP-AP-EDIT-5` |

#### 2.2.5 `run` (`OP-AP-RUN`)

| Case | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| exploratory command | `command` present, no `target` | action + `observation`; `mutate` per changed file | versions; older reads stale | `repeated_action` | `OP-AP-RUN-1` |
| criterion run (`{target}`) | target is the focus goal | action + `observation` carrying `target`+`exitCode`+`witness`; the command comes from `target.done_when` | `criterionPass` (`exitCode 0`) / `criterionFailed` (non-zero) | `invalid_target`, `not_current_goal`, command mismatch, `repeated_action` | `OP-AP-RUN-2` |
| non-decisive (timeout) | criterion run | observation **without** `exitCode` | no verdict: the goal stays `open` | a re-check is allowed (not a repeat) | `OP-AP-RUN-4` |
| background start | `background: true` + `command` | action; job started; turn returns with `job-N` | — | `background_run` (no command), `background_target` (a criterion) | `OP-AP-RUN-5` |
| poll (`{job}`) | a job id | action; carries state/exit/tail | — | `job_poll` (extra fields) | `OP-AP-RUN-6` |
| criterion of its own goal only | a criterion run on a goal | the observation's `target` is that goal only — no ancestor effect (A1 retired) | `criterionPass`/`criterionFailed` for that goal; the request may become settled | — | `OP-AP-RUN-7` |

- **Projection** (`PRJ-AP`): the result node is `lastResult`; stdout (`output`) and
  stderr (`error`) are separate; a crash adds `signal`/`core`/`backtrace`; a criterion
  run's `exitCode` is on the observation; the `calls` entry carries the `id` for a later
  `query`.

#### 2.2.6 `write` (`OP-AP-WRITE`)

| Case | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| create | `path` does not exist | add `action` (`path`/`content`); `mutate`; file version set | — | — | `OP-AP-WRITE-1` |
| overwrite | file read and unchanged since that read; not forbidden | add `action`; `mutate`; version bumps | dependent facts stale | `stale_base`, `constraint_violation:<pattern>` | `OP-AP-WRITE-2` |
| forbidden path | a constraint forbids it | — | — | `constraint_violation:<pattern>` | `OP-AP-WRITE-3` |
| stale base | file changed after the last read | — | — | `stale_base` | `OP-AP-WRITE-4` |
| unseen file | file exists but was never read | — | — | fail observation (`read it first`) | `OP-AP-WRITE-5` |
| path outside the workspace | — | fail observation (recorded refusal, no crash) | — | — | `OP-AP-WRITE-6` |

- **Projection** (`PRJ-AP`): as for `edit` — an `executed` `action` node with a `mutates`
  edge and a `mutate` event carrying the new version.

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
declines to formulate a goal — instead of inventing a goal with a fake criterion. Available
only while the request has no interpretation yet; it records an `unactionable` node under
the request (`no_goal` edge) and ends the run
(`docs/plans/archive/request_goal_plan.md`).

| Case | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| decline the request | the focus is the request with no interpretation and no `unactionable` node | add an `unactionable` node and a `no_goal` edge from the request; the run ends | the request is terminal (`request_unactionable`) | — | `OP-DC-1` |
| not at the request | the focus is a goal | — | — | `not_request` | `REF-DC-NOTREQ` |
| already interpreted | the request already has an interpretation | — | — | `interpreted` | `REF-DC-ADDR` |

- **Projection** (`PRJ-DC`): the option `decline` is offered at a fresh request alongside
  `create_goal`.

### 2.4 `stop` (`OP-ST`)

The doxa's terminal move and the **sole closure**. On a **goal** it finishes the frame
(the engine returns to the parent on the next projection and continues); on the
**request** it ends the run. It never settles a criterion: a pass is still a criterion
observation's `exitCode`, read by the gate.

| Case | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| finish a goal | the focus is a goal whose criterion has passed | add a `stop` node as the **last plan item** and a `has_stopped` edge from the goal | the goal is `stopped`; the engine returns; the request ends when its goal is stopped | — | `OP-ST-2` |
| criterion not passed | the focus is a goal whose criterion has not passed | — | — | `check_not_run` | `REF-ST-CHECK` |
| not at a goal | the focus is the request | — | — | `not_addressed` | `REF-ST-STATE` |

- **Projection** (`PRJ-STOP`): a stopped goal shows state `stopped`; the `stop` node is the
  goal's last plan item.
- A goal is closed only by `stop`; for now only **positive** stops are accepted (the
  criterion must have passed; the give-up cases are a later step —
  `docs/plans/archive/request_goal_plan.md`). The `stop` node is appended as the goal's **last plan
  item** and linked by `has_stopped` from the goal; the run ends when the request's goal is
  stopped. There is no `stop` on the request.

### 2.5 `query` (`OP-QR`)

| Case | Pre | Effects | ID |
|---|---|---|---|
| by id, body | the id addresses a result (observation or inline/`Ref` body) | no node; body returned; id pinned into `shown` (TTL) | `OP-QR-1` |
| by id, no body | the id is an action/goal/etc. | node row + incident edges | `OP-QR-2` |
| by id, window | `start`/`end` | a line window; continues with a new `query` | `OP-QR-3` |
| state: `kind` | — | matching nodes (bounded) | `OP-QR-4` |
| state: `edgesOf` | — | incident edges of a node | `OP-QR-5` |
| redundant | id already in `shown` | refused `repeated_action` | `OP-QR-6` |

- **Projection** (`PRJ-QR`): the queried body enters `shown` in full for the next few
  turns and is dropped from explicit retention on expiry; state queries are not pinned.

### 2.6 Traversal and containers (`TR`)

| Case | Rule | ID |
|---|---|---|
| focus | the focus is `branch[last]`, else the root | `TR-1` |
| descend | `focusEvents` descends into the request's goal (`has_goal`), or the last option of a step's `alternatives` | `TR-2` |
| return | a finished top is popped; `return` is legal | `TR-3` |
| trim under a finished ancestor | if any ancestor (other than the root) is finished, the branch is trimmed — not only when the top finishes (invariant 17 extended) | `TR-4` |
| container choice | a goal's stage container is a `plan` (`has_plan`); the request's interpretation is a `has_goal` edge; a revised goal / branched step uses `alternatives` (`has_alternatives`) | `TR-5` |
| item order and cursor | items follow the `item` edge order (the LAST is current); the cursor is the first not `itemFulfilled`; an item is fulfilled when its action executed or its newest option is done | `TR-6` |
| variant branching | an unexecuted action item with the same command is reused; otherwise the new action becomes the newest option of the current unfulfilled action item's `alternatives`; earlier options become unselected | `TR-7` |
| frontier | `applicable` computes create_goal/apply/stop/decline/checkReady from the same facts the gates use; the doxa chooses among them | `TR-8` |
| item revision history | a plan item's `alternatives` (the step's revision history) is rendered in the projection | `TR-9` |

### 2.7 Derived facts (`DER`)

State is always derived from the incident events, never stored.

| Predicate | Rule | ID |
|---|---|---|
| request `requestSettled` | the request's goal (through its current variant) has passed its criterion (`criterionPass`) | `DER-REQ-1` |
| goal criterion passed | the latest observation targeting the goal has `exitCode 0` | `DER-GOAL-1` |
| goal criterion failed | the latest observation targeting the goal has a non-zero `exitCode` | `DER-GOAL-3` |
| goal no verdict / `open` | there is no targeted observation, or its `exitCode` is absent (a timeout) | `DER-GOAL-4` |
| goal unselected | it is a variant of a container and is not the LAST option | `DER-GOAL-5` |
| criterion order | the newer targeted observation wins (by `seq`) | `DER-GOAL-6` |
| action `executed` | it has a `produces` or `mutates` edge | `DER-ACT-1` |
| action superseded | its `alternatives` container has a newer (last) option | `DER-ACT-2` |
| run witness | a criterion run's observation carries a `witness` (the basis for staleness) | `DER-STALE-1` |

---

## 3. Refusal catalogue (`REF`)

The `classify` gate (`src/loop/classify.ts`). A refusal emits `record_rejection` and
**must change the projection** (invariant).

| Reason (token) | Trigger | Operator | ID |
|---|---|---|---|
| `empty_what` / `empty_done_when` / `empty_plan` / `empty_step` | malformed `create_goal` | `create_goal` | `REF-CG-EMPTY` |
| `no_current_goal` | no focus | create_goal | `REF-NO-FOCUS` |
| `missing_revision` | `revises` omits a failed option | create_goal | `REF-REV-MISSING` |
| `unknown_revision` | `revises` at a non-failed point | create_goal | `REF-REV-UNKNOWN` |
| `repeat_hypothesis` | `what` repeats a failed option | create_goal | `REF-REPEAT-HYP` |
| `all plan items are fulfilled` | growing a goal whose plan is done | create_goal | `REF-PLAN-DONE` |
| `not_current_goal` | a criterion targets a non-focus | run | `REF-NOT-FOCUS` |
| `invalid_target` | criterion run of a non-goal | run | `REF-RUN-TARGET` |
| command mismatch | a criterion passes a different command | run | `REF-RUN-CMD` |
| `job_poll` | poll with extra fields | run | `REF-RUN-POLL` |
| `background_target` | background a criterion run | run | `REF-RUN-BGCHECK` |
| `background_run` | background with no command | run | `REF-RUN-BGCMD` |
| run without command/target | empty `run` | run | `REF-RUN-EMPTY` |
| `repeated_action` | identical read/grep/run, or re-query of a shown body | read/grep/run/query | `REF-REPEAT` |
| `stale_base` | edit on a file changed after the read | edit | `REF-EDIT-STALE` |
| `constraint_violation:<pattern>` | edit a forbidden path | edit | `REF-EDIT-CONSTRAINT` |
| `stale_base` | write over a file changed after the read | write | `REF-WRITE-STALE` |
| `constraint_violation:<pattern>` | write a forbidden path | write | `REF-WRITE-CONSTRAINT` |
| `not_addressed` | `stop` when the focus is not a goal (the request) | stop | `REF-ST-STATE` |
| `check_not_run` | `stop` on a goal whose criterion has not passed | stop | `REF-ST-CHECK` |
| `addressed` | any operator except `stop` at a settled request | create_goal/apply | `REF-ADDRESSED` |
| `not_request` | `decline` at a non-request focus | decline | `REF-DC-NOTREQ` |
| `interpreted` | a second `create_goal` at a request that already has a goal, or `decline` on it | create_goal/decline | `REF-DC-ADDR` |

Tool **failures** (a fail observation, not a refusal): missing file (`read`),
bad scope (`grep`/`list`), `find` not present (`edit`), non-zero/timeout/signal
(`run`).

---

## 4. Invariants

- a goal is closed only by `stop` (a `has_stopped` edge, and the `stop` node is the goal's
  last plan item); a criterion run settles nothing by itself (`DER-GOAL`).
- the request ends when its goal is stopped (there is no `stop` on the request); a request
  is interpreted once (`has_goal`) or declined (`no_goal`).
- a criterion run is an ordinary `observation`; `exitCode 0` = pass, non-zero = fail,
  absent = no verdict.
- a `stale` fact is never shown as active; a stale fact is not active content.
- `project` is deterministic: same events → same `Context`.
- structural edges (`has_goal`/`has_plan`/`item`/`has_alternatives`/`has_stopped`/`no_goal`)
  form a DAG (a `stop` node is both the plan's last item and the goal's `has_stopped`
  target, so the structure is not a tree).
- every non-root goal is bound by a `has_goal` or an `item` edge.
- a refusal/failure changes the projection.
- a finished goal (and its descendants) does not remain the focus (`TR-4`).
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
| `OP-AP-READ-1..6` | `tests/ops/apply.test.ts` | scenario `locate-across-files` |
| `OP-AP-GREP-1..4` | `tests/ops/apply.test.ts` | scenario `locate-across-files` |
| `OP-AP-LIST-1..2` | `tests/ops/apply.test.ts` | scenario `locate-across-files` |
| `OP-AP-EDIT-1..5` | `tests/ops/apply.test.ts` | scenarios `stale-base`, `two-step-fix` |
| `OP-AP-WRITE-1..6` | `tests/ops/apply.test.ts` | scenario `command-from-package` |
| `OP-AP-RUN-1`, `2`, `4..7` | `tests/ops/apply.test.ts` | steps `apply-next-action`, `check-ready-objective`, `poll-background-job`, `retry-inconclusive` |
| `OP-AP-FETCH-1..3`, `REF-FETCH-CONSTRAINT` | `tests/ops/apply.test.ts` | — |
| `OP-AP-PATCH-1..2`, `REF-PATCH-CONSTRAINT` | `tests/ops/apply.test.ts` | — |
| `OP-QR-1..6` | `tests/ops/query.test.ts` | scenarios `retrieve-at-scale`, `reproduce-then-read` |
| `TR-1..9` | `tests/ops/traversal.test.ts` | steps `apply-next-action`, `follow-focus-hint` |
| `DER-REQ/GOAL/ACT/STALE` | `tests/ops/derivation.test.ts` | — |
| `REF-CG/REV/NO-FOCUS` | `tests/ops/create_goal.test.ts` | step `follow-focus-hint`; scenario `revise-hypothesis` |
| `REF-RUN/REPEAT` | `tests/ops/apply.test.ts`, `tests/ops/query.test.ts` | step `poll-background-job`; scenario `two-outputs` |
| `REF-EDIT` | `tests/ops/apply.test.ts` | scenario `constraint-honored` |
| `REF-WRITE-STALE`, `REF-WRITE-CONSTRAINT` | `tests/ops/apply.test.ts` | — |
| `OP-ST-2`, `REF-ST-STATE`, `REF-ST-CHECK` | `tests/ops/stop.test.ts` | step `stop-addressed` |
| `OP-DC-1`, `REF-DC-NOTREQ`, `REF-DC-ADDR` | `tests/ops/decline.test.ts` | — |
| `OP-AP-CONT/ALT` | `tests/ops/apply.test.ts`, `tests/ops/create_goal.test.ts` | steps `apply-next-action` |
| `TR-8` | `tests/ops/applicable.test.ts` | steps `check-ready-objective`, `stop-addressed` |
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
