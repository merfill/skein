# Skein — IR operations: reference and test matrix

> Russian mirror — `docs/ir_operations_ru.md`.

Related: `docs/ir_semantics.md` (the formal semantics — this document is the
operational reference and the coverage contract, not a second formalism),
`docs/projection.md`, `docs/tools.md`, `docs/ir.md`, `docs/testing.md`.

Status: **Phase 1 — skeleton (agreed 2026-10-06).** §1–§4 specify the model and
every operator. §5 is the coverage matrix, filled as tests land (Phases 2–3). An ID
is **stable**: a spec point may gain tests, but its meaning does not change.

---

## 0. How to read this document

Every operator is specified as:

- **Pre** — when it is legal (the frontier/logos precondition).
- **Effects** — the journal events and the tree change it emits.
- **Derived** — the predicates that change as a result.
- **Refuses** — the reasons the logos can reject it (`classify`), with the catalogue
  in §3.
- **Projection** — how the result is seen in the next context (§ projection).
- **ID** — a stable identifier; a test cites it as the `ID` token in its title.

ID families: `OP-CG` create_goal, `OP-AP-READ|GREP|LIST|EDIT|RUN` apply sub-tools,
`OP-CP` complete, `OP-QR` query, `TR` traversal/containers, `DER` derived
predicates, `REF` refusals (the catalogue), `PRJ` projection points (referenced).

---

## 1. Model

### 1.1 Work nodes (`src/ir/types.ts`)

| Kind | Payload | Role |
|---|---|---|
| `request` | `{text}` | the arbiter's raw motivation; the root; never closed in the IR |
| `goal` | `{what, why?, done_when}` | an interpretation or a stage; objective or subjective `done_when` |
| `action` | `{command, ...}` | a single tool run; also a plan item of kind `action` |
| `plan` | — | ordered container of a goal's stage items (`item` edges) |
| `alternatives` | — | container of interchangeable goals/actions (`item` edges + `chosen`) |
| `observation` | `{ref?, version?, command?, verdict?, output?...}` | a tool result body |
| `check` | `{command, verdict, witness?, actor, output/error/...}` | the arbiter's verdict on a goal |
| `complete` | `{note?}` | a subjective closing |
| `constraint` | `{forbid: string[]}` | invariant; seeded at run start |
| `file` (artifact) | — | a referenced file; produced by `mutates` |

### 1.2 Edges (`src/ir/types.ts`)

| Kind | From → To | Meaning |
|---|---|---|
| `has_plan` | goal → plan | the goal's stage container |
| `item` | plan/alternatives → goal/action | ordered membership |
| `has_alternatives` | request/goal → alternatives | the option container |
| `chosen` | alternatives → option | the currently chosen option |
| `under` | check/complete → goal | the assumptions a closure relies on |
| `produces` | action → observation | the action's result body |
| `verifies` | check → goal | the goal(s) this verdict settles |
| `closes` | complete → goal | the subjective closure |
| `mutates` | action → file | the action changed the file |

### 1.3 Events (`src/ir/events.ts`)

`add_node`, `add_edge`, `descend`, `return`, `mutate`, `record_rejection`,
`record_check`. `fold` applies them in order; state (predicates, `children`,
`branch`, `focusOf`, versions) is **derived**, never stored.

### 1.4 Containers and traversal

- **branch** — the stack of goals from the request root to the focus; `descend`
  pushes, `return` pops (`TR-1`).
- **focus** — `branch[last]`, else the root (`TR-1`).
- **plan** — `has_plan` target; **items** — `item` edges in insertion order.
- **alternatives** — `has_alternatives` target; **chosen** — the target of the
  latest `chosen` edge (journal order).

---

## 2. Operators

### 2.1 `create_goal` (`OP-CG`)

| Case | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| at the request (interpretation) | focus is `request:open` | add `goal`; ensure `alternatives` on the request; `item` + `chosen` to it; `descend` into it | request stays `open`; goal `open` | `empty_what`, `empty_done_when`, `empty_plan`, `empty_item`, `repeat_hypothesis` | `OP-CG-1` |
| at an open goal (stage) | focus is `goal:open`, not refuted | add `goal`; ensure `plan`; `item` edge | goal `open` | as above; `all_plan_fulfilled` (must check, not grow) | `OP-CG-2` |
| revision (`revises`) | focus is `request` with failed options, or a `refuted` goal | add `goal`; `item` + `chosen` into the failed options' container; `descend` | failed options → `abandoned`; new goal `open` | `missing_revision` (not all failed options listed), `unknown_revision` (`revises` at a non-refuted point) | `OP-CG-3` |
| with a plan | any of the above, `plan` present | recursively add item goals/actions and `item` edges in order | items `open` | `empty_item` (a goal item with empty `what`) | `OP-CG-4` |
| nested plan | an item goal carries its own `plan` | a nested `plan` container per goal | — | — | `OP-CG-5` |

- **Projection** (`PRJ-CG`): the focus `path` gains the goal (`what`/`why`/
  `done_when`/`plan`); at the request, the `alternatives` list shows it `chosen`.
- **Notes.** `why` is the hypothesis and is surfaced on the item so a refuted
  attempt is not repeated (`PRJ-PATH-why`). A `what` equal (normalized) to a failed
  option is `repeat_hypothesis`.

### 2.2 `apply` (`OP-AP`)

The dispatch of one tool under the focus (`src/tools/index.ts`, `OP-AP-*`).

#### 2.2.1 `read` (`OP-AP-READ`)

| Case | Pre | Effects | ID |
|---|---|---|---|
| new window | path exists; world unchanged since a prior identical read | add `action`; add `observation` (`produces`); record observed version | `OP-AP-READ-1` |
| continue window | a different `start/end` | new action/observation | `OP-AP-READ-2` |
| missing file | — | action + fail observation | `OP-AP-READ-3` |
| repeat | identical window, world unchanged | refused `repeated_action` | `OP-AP-READ-4` |

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
| replace | file read and unchanged since that read; not forbidden | add `action` (`find`/`replace`); `mutate` per changed file | file version changes; dependent checks stale | `stale_base`, `constraint_violation:<pattern>` | `OP-AP-EDIT-1` |
| find not present | — | action + fail observation (file materialized, pinned) | — | — | `OP-AP-EDIT-2` |
| forbidden path | a constraint forbids it | — | — | `constraint_violation:<pattern>` | `OP-AP-EDIT-3` |
| stale base | file changed after the last read | — | — | `stale_base` | `OP-AP-EDIT-4` |

#### 2.2.5 `run` (`OP-AP-RUN`)

| Case | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| exploratory command | `command` present, no `target` | action + observation; `mutate` per changed file | versions; checks stale | `repeated_action` | `OP-AP-RUN-1` |
| check (`{target}`) | target is the focus, objective | `record_check` node + `verifies` edge | goal `achieved`/`refuted`/`open` | `invalid_target`, `subjective_goal_needs_complete`, command mismatch, `not_current_goal`, `repeated_action` | `OP-AP-RUN-2` |
| check with `under` | as above + assumptions | `under` edges on the check | `achieved_under` when pass | — | `OP-AP-RUN-3` |
| inconclusive (timeout) | check | `record_check` verdict `inconclusive` | goal stays `open` | a re-check is allowed (not a repeat) | `OP-AP-RUN-4` |
| background start | `background: true` + `command` | action; job started; turn returns with `job-N` | — | `background_run` (no command), `background_target` (a check) | `OP-AP-RUN-5` |
| poll (`{job}`) | a job id | action; carries state/exit/tail | — | `job_poll` (extra fields) | `OP-AP-RUN-6` |

**Note.** A bare `run {command}` whose command equals the focus objective goal's
`done_when.command` is treated as that goal's **check** (the target is inferred): the
criterion is run as the oracle, not as exploration.

- **Projection** (`PRJ-AP`): the result node is `lastResult`; stdout (`output`) and
  stderr (`error`) are separate; a crash adds `signal`/`core`/`backtrace`; a check's
  verdict is on the `check` node; the `calls` entry carries the `id` for a later
  `query`.

#### 2.2.6 `write` (`OP-AP-WRITE`)

| Case | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| create | `path` does not exist | add `action` (`path`/`content`); `mutate`; file version set | — | — | `OP-AP-WRITE-1` |
| overwrite | file read and unchanged since that read; not forbidden | add `action`; `mutate`; version bumps | dependent checks stale | `stale_base`, `constraint_violation:<pattern>` | `OP-AP-WRITE-2` |
| forbidden path | a constraint forbids it | — | — | `constraint_violation:<pattern>` | `OP-AP-WRITE-3` |
| stale base | file changed after the last read | — | — | `stale_base` | `OP-AP-WRITE-4` |
| unseen file | file exists but was never read | — | — | fail observation (`read it first`) | `OP-AP-WRITE-5` |

- **Projection** (`PRJ-AP`): as for `edit` — an `executed` `action` node with a `mutates`
  edge and a `mutate` event carrying the new version.

### 2.3 `complete` (`OP-CP`)

| Case | Pre | Effects | Derived | Refuses | ID |
|---|---|---|---|---|---|
| subjective focus | focus is a subjective `goal` | add `complete` (`note?`); `closes` edge | goal `achieved_under` | `objective_goal_needs_check`, `not_current_goal`, `root_not_completable`, `invalid_goal`, `no_current_goal` | `OP-CP-1` |
| with `under` | as above | add `under` edges from the `complete` to the assumptions | `achieved_under` | — | `OP-CP-2` |
| root | focus is the request | — | — | `root_not_completable` | `OP-CP-3` |

- **Projection** (`PRJ-CP`): a closed nested goal leaves the branch (trimmed under a
  closed ancestor); its `note` is surfaced as a `complete <goal>` entry in `calls`
  (`PRJ-CALLS-complete`).

### 2.4 `query` (`OP-QR`)

| Case | Pre | Effects | ID |
|---|---|---|---|
| by id, body | the id addresses a result (observation/check or inline/`Ref` body) | no node; body returned; id pinned into `shown` (TTL) | `OP-QR-1` |
| by id, no body | the id is an action/goal/etc. | node row + incident edges | `OP-QR-2` |
| by id, window | `start`/`end` | a line window; continues with a new `query` | `OP-QR-3` |
| state: `kind`/`predicate` | — | matching nodes (bounded) | `OP-QR-4` |
| state: `edgesOf` | — | incident edges of a node | `OP-QR-5` |
| redundant | id already in `shown` | refused `repeated_action` | `OP-QR-6` |

- **Projection** (`PRJ-QR`): the queried body enters `shown` in full for the next few
  turns and is dropped from explicit retention on expiry; state queries are not pinned.

### 2.5 Traversal and containers (`TR`)

| Case | Rule | ID |
|---|---|---|
| focus | the focus is `branch[last]`, else the root | `TR-1` |
| descend | `focusEvents` descends into the chosen interpretation at a request, or the first unfulfilled sub-goal | `TR-2` |
| return | a closed top is popped; `return` is legal | `TR-3` |
| trim under a closed ancestor | if any ancestor (other than the root) is closed, the branch is trimmed — not only when the top closes (invariant 17 extended) | `TR-4` |
| container choice | a goal's stage container is a `plan` (`has_plan`); a request or a `refuted` goal's option container is `alternatives` (`has_alternatives`) | `TR-5` |
| item order and cursor | items follow the `item` edge order; the cursor is the first not `itemFulfilled`; `itemFulfilled` (resolved, incl. refuted) vs `itemSucceeded` (only a success) differ | `TR-6` |
| variant branching | an unexecuted action item with the same command is reused; otherwise the new action becomes the `chosen` option of the first unfulfilled action item's `alternatives`; unselected variants become `abandoned` | `TR-7` |

### 2.6 Derived predicates (`DER`)

State is always derived from the incident events, never stored.

| Predicate | Rule | ID |
|---|---|---|
| request `addressed` | the chosen interpretation is `achieved`/`achieved_under`; else `open` | `DER-REQ-1` |
| goal `achieved` | the latest closing check has `verdict=pass` and no `under` | `DER-GOAL-1` |
| goal `achieved_under` | the latest closing check has `verdict=pass` with `under`, or a `complete` closes it | `DER-GOAL-2` |
| goal `refuted` | the latest closing check has `verdict=fail` | `DER-GOAL-3` |
| goal `open` | the latest closing check is `inconclusive`, or there is no closure | `DER-GOAL-4` |
| goal `abandoned` | it is an unselected variant of a container with a `chosen` sibling | `DER-GOAL-5` |
| closure order | the newer of the latest `verifies` check and the latest `closes` complete wins (by `seq`) | `DER-GOAL-6` |
| action `executed` | it has a `produces` or `mutates` edge | `DER-ACT-1` |
| action `abandoned` | its `alternatives` container chose a sibling | `DER-ACT-2` |
| check stale | a `witness` entry's ref version differs from the current version | `DER-STALE-1` |

---

## 3. Refusal catalogue (`REF`)

The `classify` gate (`src/loop/classify.ts`). A refusal emits `record_rejection` and
**must change the projection** (invariant).

| Reason (token) | Trigger | Operator | ID |
|---|---|---|---|
| `empty_what` / `empty_done_when` / `empty_plan` / `empty_item` | malformed `create_goal` | `create_goal` | `REF-CG-EMPTY` |
| `no_current_goal` | no focus | create_goal/complete | `REF-NO-FOCUS` |
| `missing_revision` | `revises` omits a failed option | create_goal | `REF-REV-MISSING` |
| `unknown_revision` | `revises` at a non-refuted point | create_goal | `REF-REV-UNKNOWN` |
| `repeat_hypothesis` | `what` repeats a failed option | create_goal | `REF-REPEAT-HYP` |
| `all_plan_fulfilled` | growing an objective goal whose plan is done | create_goal | `REF-PLAN-DONE` |
| `invalid_goal` / `root_not_completable` | complete a non-goal / the request | complete | `REF-CP-TARGET` |
| `not_current_goal` | a closing move (`complete`/check) targets a non-focus | complete/run | `REF-NOT-FOCUS` |
| `objective_goal_needs_check` | `complete` on an objective goal | complete | `REF-CP-OBJ` |
| `subjective_goal_needs_complete` | check of a subjective goal | run | `REF-RUN-SUBJ` |
| `invalid_target` | check of a non-goal | run | `REF-RUN-TARGET` |
| command mismatch | check passes a different command | run | `REF-RUN-CMD` |
| `job_poll` | poll with extra fields | run | `REF-RUN-POLL` |
| `background_target` | background a check | run | `REF-RUN-BGCHECK` |
| `background_run` | background with no command | run | `REF-RUN-BGCMD` |
| run without command/target | empty `run` | run | `REF-RUN-EMPTY` |
| `repeated_action` | identical read/grep/run, or re-query of a shown body | read/grep/run/query | `REF-REPEAT` |
| `stale_base` | edit on a file changed after the read | edit | `REF-EDIT-STALE` |
| `constraint_violation:<pattern>` | edit a forbidden path | edit | `REF-EDIT-CONSTRAINT` |
| `stale_base` | write over a file changed after the read | write | `REF-WRITE-STALE` |
| `constraint_violation:<pattern>` | write a forbidden path | write | `REF-WRITE-CONSTRAINT` |

Tool **failures** (a `fail` observation, not a refusal): missing file (`read`),
bad scope (`grep`/`list`), `find` not present (`edit`), non-zero/timeout/signal
(`run`).

---

## 4. Invariants

- a goal is `achieved` only via a passing `check` without `under`; `achieved_under`
  needs a passing check with `under` or a `complete` (`DER-GOAL`).
- a `stale` check is never shown as active; a stale fact is not active content.
- `project` is deterministic: same events → same `Context`.
- structural edges (`has_plan`/`item`/`has_alternatives`/`chosen`) form a forest.
- every non-root goal is an item of a plan or alternatives.
- a refusal/failure changes the projection.
- a closed goal (and its descendants) does not remain the focus (`TR-4`).
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
| `OP-CG-1..5` | `tests/ops/create_goal.test.ts` | step `interpret-request`; scenario `multi-step-plan` |
| `OP-AP-READ-1..4` | `tests/ops/apply.test.ts` | scenario `locate-across-files` |
| `OP-AP-GREP-1..4` | `tests/ops/apply.test.ts` | scenario `locate-across-files` |
| `OP-AP-LIST-1..2` | `tests/ops/apply.test.ts` | scenario `locate-across-files` |
| `OP-AP-EDIT-1..4` | `tests/ops/apply.test.ts` | scenarios `stale-base`, `two-step-fix` |
| `OP-AP-WRITE-1..5` | `tests/ops/apply.test.ts` | scenario `command-from-package` |
| `OP-AP-RUN-1..6` | `tests/ops/apply.test.ts` | steps `apply-next-action`, `check-ready-objective`, `poll-background-job`, `retry-inconclusive` |
| `OP-CP-1..3` | `tests/ops/complete.test.ts` | step `complete-subjective`; scenario `no-mutation-answer` |
| `OP-QR-1..6` | `tests/ops/query.test.ts` | scenarios `retrieve-at-scale`, `reproduce-then-read` |
| `TR-1..7` | `tests/ops/traversal.test.ts` | steps `apply-next-action`, `follow-focus-hint` |
| `DER-REQ/GOAL/ACT/STALE` | `tests/ops/derivation.test.ts` | — |
| `REF-CG/REV/CP/NO-FOCUS` | `tests/ops/create_goal.test.ts`, `tests/ops/complete.test.ts` | step `follow-focus-hint`; scenario `revise-hypothesis` |
| `REF-RUN/REPEAT` | `tests/ops/apply.test.ts`, `tests/ops/query.test.ts` | step `poll-background-job`; scenario `two-outputs` |
| `REF-EDIT` | `tests/ops/apply.test.ts` | scenario `constraint-honored` |

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
