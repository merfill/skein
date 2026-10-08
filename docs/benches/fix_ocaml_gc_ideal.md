# fix-ocaml-gc — the reference route in the IR

> Russian mirror — `docs/benches/fix_ocaml_gc_ideal_ru.md`.

Related: `docs/ir_semantics.md` (the source of truth for the semantics),
`docs/logos_ir.md`, `docs/plans/archive/logos_roadmap_plan.md`, `docs/benches/bench_report.md`.
Reference run to compare against: `~/.skein-bench/harbor/2026-10-02__09-47-57`.

Status: reference. This is not an engine spec but a sample of the **shape** of a run in
our operators and the IR tree. The content (hypotheses, lines, commands) is supplied by
the LLM; what is fixed here is the structure by which we judge success and find gaps.

---

## 1. Why

A binary `reward` does not say *why* a run failed and sets no target. The reference
gives: (1) a shape to aim for; (2) a basis for comparing actual runs; (3) the
derivation of gaps — not from a guess, but from the mismatch between the reference and
the facts.

## 2. Task and criterion

The OCaml compiler crashes during bootstrap after run-length compression of free space
in the major heap was enabled. One must find and fix the cause. The objective criterion
is the command

```
make -C testsuite one DIR=tests/basic
```

finishing successfully. The symptom from the report: a segfault while compiling
`utils/config.cmi`; the suspicion is free-block handling in `pool_sweep` /
`pool_allocate` (`runtime/shared_heap.c`).

## 3. The principle: shape, not text

Ideal is not the exact text of a hypothesis (the model does not know it either) but the
**shape**:

- the plan is a **`plan` node** with ordered `item`s (subgoals/commands), not a "flat"
  stream of commands;
- the explanation ("why") is the goal's `why` field; a formal assumption is an `under`
  reference at the closing node;
- evidence is command **observations** (no "assertions");
- a **check** is a `check` node with a `verifies` edge to the goal; it settles its fate;
- a change of approach goes through an `alternatives` node and a chosen option
  (`chosen`), not a repeat;
- nodes have **no statuses**: state (executed, achieved, achieved_under, refuted) is
  **derived**;
- a request is not closed in the IR; acceptance is external (the Arbiter/harness).

## 4. The reference route

| Stage | Doxa operator | What appears in the tree | Why |
|---|---|---|---|
| setup | *(the Arbiter)* | a root `request` (the task text) + `constraint` (do not edit tests) | the motivation and the boundaries |
| reproduce | `create goal` (a plan with a command item) | a new `goal` as an `item` in the root's plan; it has its own `plan` with an `action` | see the crash, not assume it |
| | `apply` (a build `run`) | the `action` executed + `observation` (crash log) | evidence |
| | `complete` | a `complete` node → the goal `achieved_under` | the completion is visible from the observation |
| localize | `create goal` | a goal-item | narrow the problem site |
| | `apply` (`read`/`grep`/`run`) | `action` + `observation` + `file` | facts about the code |
| | `complete` | `complete` → `achieved_under` | an epistemic goal |
| fix | `create goal` (`why` = hypothesis) | a goal-item; the check references the assumption (`under`) | test the explanation |
| | `apply` (`edit`) | `action` + `mutate` `from → to` | an edit under the hypothesis |
| | `apply` (a check `run`) | `check` + `verifies` (+ `under`); the goal → `achieved`/`achieved_under`/`refuted` (derived) | the check settles its fate |
| revise | `create goal` (an option via `alternatives`) | an `alternatives` node + an option; `chosen` | replace, do not repeat |
| acceptance | `apply` (a criterion `run`, the command from `done_when`) | `check`; the request is `addressed`, acceptance external | close objectively |
| stop | *(the Arbiter)* | — | the request is addressed / stagnation |

Refuted approaches are not lost: the goal remains `refuted`, and the non-chosen options
of `alternatives` — `abandoned` (derived).

### 4.1 A concrete trajectory (turn by turn)

The task instruction: read `HACKING.adoc`, understand the build, fix the bootstrap
crash, then make `make -C testsuite one DIR=tests/basic` pass. Identifiers and `seq`
are illustrative; the shapes are as in `docs/ir_semantics.md`.

| Turn | Operator | LLM call: what it proposed | Tree: what appeared |
|---|---|---|---|
| 0 | *(the Arbiter)* | — | root `request` — the instruction text; `constraint` "do not edit tests"; no goals |
| 1 | `create goal` | an interpretation goal "fix the bootstrap" (plan: reproduce/localize/fix/verify) | `alternatives A0` under the request; `item A0 → I`; `chosen A0 → I`; `I` has its own `plan`; descend into the first item |
| 2 | `apply` | a build `run` | `A1` executed + `observation` (crash log) |
| 3 | `complete` | "G1 is reached" | a `complete` node → `G1`; derived `achieved_under` |
| 4 | `create goal` | goal "localize the cause" | `goal G2` as an item in the root's plan `P0` |
| 5 | `apply` | `read HACKING.adoc` | `action` + `observation` + `file` |
| 6 | `apply` | `grep "pool_sweep\|pool_allocate\|freelist"` | `action` + `observation` |
| 7 | `apply` | `read runtime/shared_heap.c` | `action` + `observation` + `file`@`V1` |
| 8 | `apply` | `grep "POOL_FREE_HEADER\|POOL_BLOCK_FREE\|Whsize_hd"` (the free-block run-length encoding) | `action` + `observation` (the macros and the skip invariant) |
| 9 | `complete` | "G2 is reached" | `complete` → `G2`; derived `achieved_under` |
| 10 | `create goal` | goal "fix the header" (`why` = "under compression `pool_sweep` does not move the free block's header", `done_when` = the build) | `goal G3` as an item in the root's plan `P0` |
| 11 | `apply` | `edit runtime/shared_heap.c` | `action` + `mutate` `V1 → V2` |
| 12 | `apply` | a build `run` (a check) | `check` + `verifies → G3` + `under → G2` (the localization assumption); derived `achieved_under`; otherwise `refuted` |
| 12b | `create goal` | on `refuted`: a new approach option | an `alternatives` node + option `G3'`; the Arbiter sets `chosen`; `G3` derived `refuted`, non-chosen — `abandoned` |
| 13 | `apply` | a `run` of the task criterion (the command from `done_when`) | `check`; the request is `addressed`; acceptance external |
| 14 | *(the Arbiter)* | stop | — |

The task image **removes `.git`** (`environment/Dockerfile`: *"We don't want it
cheating and just rolling back the recent changes"*), so `git log`/`git diff` is
unavailable: localization must come from the code and the free-block invariant, not from
a diff. The defect is a single token, so a named suspect is enough — the fix is a
hypothesis to be **checked**, not proven in `locate`.

The key difference from the facts: in the actual run the agent issued only commands
(`read/grep/run`) and **created no goal with a plan and no check** — the work was
"flat", without structure.

## 5. Expected tree shape

- **Root:** a `request` (the task text), not a goal.
- **Goals:** 1 interpretation of the request with a 3–5 item plan (`reproduce`,
  `localize`, `fix`, `verify`) plus possible alternative interpretations.
- **Plan:** a `plan` node(s) with `item`s; some goals may have no plan (unspecified).
- **Observations:** ≥1 (the crash, "compression was enabled by a recent commit").
- **Edits (`action` edit):** ≥1, under a goal with a non-empty `why`.
- **Checks (`check`):** ≥1, tied to a goal via `verifies`; with `under` edges when they
  rest on an assumption.
- **Completions (`complete`):** ≥1 at an epistemic goal.
- **Outcome:** the chosen interpretation `achieved` (a `pass` check, no `under`) or
  `achieved_under` (there is `under` or `complete`); the request `addressed`; acceptance
  external (the harness/the user).

## 6. Branch and backtracking

The path: `root → plan item (approach goal) → action → check`. Success — the goal is
`achieved`/`achieved_under`; failure — `refuted`, and a new approach appears as an
**option** in an `alternatives` node where the Arbiter marks `chosen`. Non-chosen
options — `abandoned` (derived); refuted ones — `refuted`. Nothing is lost: it all
remains in history.

## 7. Progress

Progress is relative to work on goals, not to "new nodes in general": a new plan item, a
new `alternatives` option, a new observation, a new check, a new derived goal state
(`achieved`/`refuted`/`abandoned`). Repeating the same command with nothing new is not
progress.

## 8. Stopping and honesty

- **Success:** the chosen interpretation is reached; the request is `addressed`; the final
  acceptance is given by the Arbiter (the harness) from outside — it does not enter the IR.
- **Honesty:** `achieved` — only if the closure does not rest on an assumption (no
  `under` edges); `achieved_under` — if there is `under` or the goal was closed by the
  doxa (`complete`).
- **Stagnation:** the Arbiter changes the branch or stops the loop.
- **Out of fragment:** if a needed capability is absent, not "I did not think of an
  explanation" — an honest `out_of_fragment` (the design is deferred).

## 9. Comparison with the facts (diagnosis)

The actual `fix-ocaml-gc` runs (job `2026-10-02__09-47-57`):

| Attempt | Turns | Actions | Tree | stopReason | reward |
|---|---|---|---|---|---|
| 1 | 10 | read/grep/run | 0 goals / 0 checks | `no_progress` | 0 |
| 2 | 20 | read/grep/run | 0 goals / 0 checks | `no_progress` | 0 |

The reference and the facts diverge completely: the agent stayed in "flat" commands
and never created a goal with a plan and never performed a check. The causes visible
from the model:

1. **No goal structure.** The work went as commands without enclosing goals and plans;
   there was nothing to close and nothing to tie checks to.
2. **No checks tied to a goal.** There were many runs, but not one settled a goal's
   fate.
3. **No plan traversal.** The plan-execution mechanism (the stack) and the
   operator-selection policy were absent, so the structure was not forced.
4. **No completion of epistemic goals.** They could not be closed even when the
   reconnaissance had in fact ended.

## 10. What follows for the engine

- **Three operators** (`create goal`, `apply`, `complete`) are not implemented yet; the
  code has the old model's tools and modes.
- **The request** is set by the Arbiter — this must be built in explicitly.
- **Plan traversal and the Arbiter's policy** are deferred but are needed for the
  structure.
- **Versions:** `mutate` with `from`/`to`, `restore`; there is no separate `stale` —
  actualness is computed from the current version and assumptions.
- **Closure:** `check`/`complete` nodes, `under` (assumptions) and `verifies` edges, the
  `alternatives` container with a `chosen` selection.
- **Honesty:** `achieved` vs `achieved_under` (whether there is `under`, or a doxa
  closure).

## 11. Acceptance metrics for a long run

Primary: `reward` (success) or an honest stop without a false "done".

Shape (compared with §5):

- ≥1 approach goal; ≥1 `edit` under it; ≥1 `check` with `verifies` to the goal (with
  `under` when resting on an assumption); ≥1 goal `achieved`/`achieved_under`; the root
  closed.
- Sequence: `goal creation → commands → checks → (alternative → again) → acceptance`.
- The context reaches a plateau; repeats of identical `read`/`grep`/`run` are bounded.
