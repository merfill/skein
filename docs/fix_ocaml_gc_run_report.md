# fix-ocaml-gc — a run on the new engine and a comparison with the reference

> Russian mirror — `docs/fix_ocaml_gc_run_report_ru.md`.

Related: `docs/fix_ocaml_gc_ideal.md` (the shape reference),
`docs/ir_semantics.md` (the semantics),
`docs/plans/ir_semantics_migration_plan.md` (the code migration),
`docs/bench_report.md`.

Run: `bash bench/harbor/run.sh -d terminal-bench -i fix-ocaml-gc -k 2`.
Job: `~/.skein-bench/harbor/2026-10-03__09-17-17` (2 attempts).
Reference: `~/.skein-bench/harbor/2026-10-02__09-47-57`
(`fix-ocaml-gc__336fvtA`, `fix-ocaml-gc__bnFAPtw`).

## 1. Reward outcome

| Run | Attempt | reward | pass@2 |
|---|---|---|---|
| reference (old model) | 336fvtA | 0 | 0.0 |
| reference (old model) | bnFAPtw | 0 | 0.0 |
| new engine | 8kTXAD4 | 0 | 0.0 |
| new engine | cjUsoRL | 0 | 0.0 |

The binary outcome **did not change**: the task is still unsolved. The difference
is in the shape of the trajectory and in how it stops.

## 2. Metrics and shape

| Metric | ref 336fvtA | ref bnFAPtw | new 8kTXAD4 | new cjUsoRL |
|---|---|---|---|---|
| steps | 10 | 20 | 60 | 60 |
| input tokens | 41,570 | 76,565 | 399,752 | 1,068,767 |
| output tokens | 993 | 1,382 | 11,668 | 13,889 |
| cache read | 25,984 | 47,744 | 155,520 | 168,064 |
| peak context, chars | 9,539 | 11,444 | 24,956 | **803,558** |
| stop | `no_progress` | `no_progress` | budget (maxTurns) | `root_closed` |
| goals / plans | 0 / 0 | 0 / 0 | 7 / 7 | 5 / 5 |
| create_goal | 0 | 0 | 6 | 3 |
| edits | 0 | 0 | 0 | 2 |
| checks | 0 | 0 | 0 | 2 |
| complete | 0 | 0 | 0 | 3 |

The reference graph counters on the old scale (`subgoals/decisions/claims/checks`)
are all zero; the new engine produces `createGoal/complete/edits/checks/goals/plans`.

## 3. Comparison with the shape reference (§5 of `fix_ocaml_gc_ideal.md`)

| Expected shape | reference | new A | new B |
|---|---|---|---|
| ≥1 approach goal | ✗ | ✓ (6) | ✓ (3) |
| plan (`plan` node + `item`) | ✗ | ✓ (7) | ✓ (5) |
| ≥1 `edit` under a goal | ✗ | ✗ | ✓ (2) |
| ≥1 `check` with `verifies` | ✗ | ✗ | ✓ (2) |
| ≥1 `achieved`/`achieved_under` | ✗ | ✗ | ✓ (root closed) |
| root closed | ✗ | ✗ | ✓ (self-report) |
| `reward` | 0 | 0 | 0 |

The structure moved in the right direction: goals and plans appeared, and in the
second attempt edits, checks and root closure. But the root closure **did not match
the task criterion**: the verifier got an empty testsuite run (`"40 tests passed"`
not found), i.e. `root_closed` is false confidence, not a solution.

## 4. Observations (defects the run exposed)

1. **The root is closed not by the task criterion.** The Harbor adapter creates the
   root without `done_when` (subjective by default), so the engine does not know
   the objective criterion `make -C testsuite one DIR=tests/basic`. Attempt B ran
   its own `run` with `target=g1`, it passed — and the root became `achieved`, even
   though the task is unsolved. The root's `done_when` must be the criterion
   (objective), and the root must be closable only by it; otherwise `root_closed`
   is unsound.
2. **The projection is unbounded — the context explodes.** Attempt B peaked at
   **803,558** context chars, 1.07M input tokens (~14× the reference). The cause is
   `artifacts`: after a build, `run` adds a `file` node for every changed file, and
   the artifact list in the projection is unbounded. The coarse `witness` (the
   whole workspace) in the check payload compounds it. This violates T2 ("necessary
   and sufficient") and cost.
3. **Stagnation is not detected.** Attempt A: 6 `create_goal`, 0 edits/checks, and
   it stopped on the budget, not on `no_progress`. `knowledgeKey` counts new nodes
   (goals, actions, observations), so a growing frontier masks the absence of
   closures — exactly the §7.6 risk in `logos_ir.md` (a closure-rate / step-terminus
   metric is needed).
4. **The starting context is larger.** `first context` = 7,214 chars vs the
   reference's 2,200 — the projection is excessive before any work.
5. **Repeats are gated but not redirected.** Many late `read` turns in A/B were
   refused (`repeated_action`, `accepted:false`); the repeat is recorded, but doxa
   does not switch to another move and spends turns.

## 5. Conclusions

- **The shape moved toward the target, but the result did not improve.** The engine
  now carries a tree of goals/plans and can close the root; on the binary scale the
  task is still 0.
- **The main defect is not the semantics but the root arbiter.** If the task
  criterion is not injected as the root's objective `done_when`, the honest closure
  machinery runs idle: an `achieved` root is indistinguishable from a guess. This
  is the first fix.
- **The second defect is cost/T2.** Unbounded `artifacts` and the coarse witness
  make the projection unbounded; on a real repository with a build this is fatal.
  Needed: cap/aggregate artifacts, sharpen the witness (or exclude build paths at
  the mutation level), and a context budget.
- **The third defect is stagnation detection.** Progress must be measured by
  obligation closure, not by node count.

## 6. Next steps (priority)

1. Pass the task criterion into the root's `done_when` (objective) via the
   adapter/harness; forbid `root_closed` otherwise.
2. Bound `artifacts` in the projection (a window/summary like `index`) and stop
   creating a `file` node for every build-changed file; narrow the `witness`.
3. Replace `knowledgeKey` with an obligation-based progress metric (goal closures,
   cursor shift, verdict) so `no_progress` catches stagnation under a growing
   frontier.
4. Re-run `fix-ocaml-gc` after (1)–(3) and compare against this report.

## 7. Appendix: raw metrics

Reference, 336fvtA:
`graph {claims:0, checks:0, subgoals:0}; context {first:2200, peak:9539}; stop no_progress`.

Reference, bnFAPtw:
`graph {claims:0, checks:0, subgoals:0}; context {first:2200, peak:11444}; stop no_progress`.

New, 8kTXAD4:
`graph {createGoal:6, complete:0, edits:0, checks:0, goals:7, plans:7, actions:41}; context {first:7214, peak:24956}; stop maxTurns; reward 0`.

New, cjUsoRL:
`graph {createGoal:3, complete:3, edits:2, checks:2, goals:5, plans:5, actions:38}; context {first:7214, peak:803558}; stop root_closed; reward 0`.

Verifier B: `AssertionError: Could not determine that tests passed`
(`make: Entering/Leaving directory '/app/ocaml/testsuite'` without `40 tests passed`).
