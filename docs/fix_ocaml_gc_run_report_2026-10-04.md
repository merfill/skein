# fix-ocaml-gc — 2026-10-04 run analysis: why it stalled on `locate`

> Russian mirror — `docs/fix_ocaml_gc_run_report_2026-10-04_ru.md`.
> Note: the design question in §8 was resolved later the same day — see
> `docs/plans/fix_ocaml_gc_investigation.md` §8 (level retention).

Related: `docs/fix_ocaml_gc_run_report.md` (the previous run),
`docs/fix_ocaml_gc_ideal.md` (the reference form), `docs/context_design.md`
(the projection as memory, §2 and §8), `docs/ir_semantics.md` (§2.6 traversal, §2.8
call summary, §8 projection), `docs/tools.md` (the tool contract).

Run: `bash bench/harbor/run.sh -d terminal-bench -i fix-ocaml-gc -k 1`.
Job: `~/.skein-bench/harbor/2026-10-04__08-36-31`, trial
`fix-ocaml-gc__oTqGXHS`. Log: `<trial>/agent/langgraph-run.log`.

---

## 1. Outcome

| Metric | Value |
|---|---|
| reward | **0** |
| steps | 60, `stopReason=null` (`summary.json`: "stopped (unknown) after 60 turns") |
| input / output tokens | 601 007 / 21 704; cache read 304 640 |
| peak context | **38 341** chars; first 754, last 25 896 |
| graph | createGoal 3, complete 4, goals 7, plans 5, actions 50, observations 51, **edits 0, checks 0** |
| operators | apply 52 (read 31, grep 14, run 6, list 1), create_goal 3, complete 4, query 1 |

Verifier: `tests.txt` = only `make: Entering/Leaving directory …/testsuite` →
no `"40 tests passed"` (the test did not pass).

## 2. Reference

The task's `solution/solve.sh` is a **one-liner**:
```sh
sed -i '650s/Whsize_hd(hd)/wh/' /app/ocaml/runtime/shared_heap.c
```
In `pool_sweep`, on a free block `p += Whsize_hd(hd)` must be `p += wh`.

## 3. Timeline

**T0.** A goal with objective `done_when` = `make -C testsuite one DIR=tests/basic`
(taken verbatim from the request); plan `reproduce → locate → fix → verify`. This is
correct: the root criterion is objective, the plan shape is on target.

**Reproduce, T1–T15.** `read HACKING.adoc`, `./configure`, `make -j4`; the segfault in
`boot/ocamlrun` while compiling `camlinternalFormatBasics.cmi` is caught. The stage is
closed with `complete` **three times** (T11, T13, T15), and `make -j4` runs **three
times** (T10, T12, T14).

**Locate, T16–T59.** 40 of the 45 `read`/`grep` calls hit `ocaml/runtime/shared_heap.c`.
At **T24 the model states the reference fix exactly**:
> "`p += wh * Wosize_hd(hd)`, then `p += Whsize_hd(hd)` … the second add should be
> `p += wh` not `p += Whsize_hd(hd)` … Bug confirmed"

Then **35 turns** of rediscovering the same spot: T25/T27/T29/T33 again "That seems
right / But there's a subtle bug", T30–T58 reading the same file. At T54–T59 the model
becomes aware of the budget, at T59 it closes `locate` with `complete`, the next turn is
`maxTurns`. `fix`/`verify` were never started.

## 4. The diagnosis was found and lost

The reference bug is named at T24. It was then not turned into a durable artifact (a goal
with `why` + a check) and never led to an `edit`. `thought` is not stored in the IR, and
past result bodies are not projected (beyond the latest and `need`), so each turn the
model re-derives the bug and oscillates between "right" and "there is a bug here".

## 5. What the projection actually shows: a per-turn measurement

**Principle (as recorded in the docs).** `docs/context_design.md` §2 and §8,
`docs/ir_semantics.md` §8: the projection shows

- **the whole branch structure** — `path` (the stack from the root to the focus, with goal
  fields, plans, item states, alternatives);
- **a call summary** `calls` — signature + `ok/fail/refused` + `note` + `id`, no bodies;
- **the full `lastResult`** — of the latest call only;
- plus the results requested via `need` (`shown`) — up to `MAX_NEED = 5`, for one turn.

So **"project every result body in the stack" is not implemented and not recorded**: the
whole branch *structure* is projected, while bodies are the latest + an optional working
set. Bodies of all results are stored (small in the payload, large in
`.skein/observations/<id>.txt` via `outputRef`, `src/tools/index.ts:277`), but only `need`
pulls them into context; anything else is via `query`.

**Important (correction).** The `need` working set **was used**: the log's `SKEIN_PROPOSAL`
does not show it (the runner logs only `thought`+`action`, `langgraph/graph.ts:213`), but
`shown` in `SKEIN_CONTEXT` is non-empty. Over the run **37 distinct** results were pinned;
most often `obs:480` (7×), `obs:408` (6×). So the mechanism was not "unused" — it was used,
but the right set was not retained.

**Per-turn measurement** (component bytes, `len(JSON.stringify(...))`; `shown` = 2 for an
empty array). The full table is §9.

| Component | Mean | Dynamics |
|---|---|---|
| `path` (branch structure) | 3 881 | grows 536 → 5 185 (a plan of 36 action items), then plateaus |
| `calls` (summary, no bodies) | 2 119 | grows monotonically 2 → 5 470; 36 entries at the end |
| `lastResult` (body) | 4 809 | peaks 16.8k (a build), ~8k (a JSON grep) |
| `shown` (via `need`) | 6 659 | 0–4 entries, "flickering": the set changes every turn |

**What is lost, what remains** (at the end of the run):

- remains: the branch structure (7 goals, 5 plans, 50 actions with states), `calls` —
  **36** addressable entries with `id`, the latest call's body and ≤4 pinned bodies;
- lost from context: the bodies of the **other** results. **51** observations and 50 actions
  total, but 1 + ≤4 bodies visible. So ~47 of 51 bodies exist in the IR but not in context.

Bottom line: the mechanism works exactly as designed (all structure, bodies = last +
`need`), but the working set is **manual, one-turn, and capricious**: the model changes the
`shown` set (e.g. T26 `{408,424}` → T28 `{428,420}` → T29 `{432,424,436}` → T30 `{432,436}`),
so the needed code windows drop out and it **re-reads** the file (40 read/grep) instead of
re-pinning the old `id`.

## 6. Why it spins on `locate`

1. **The working set does not retain itself.** `need` lasts one turn, the limit is 5, and
   the model cycles through windows; old ones drop out and are re-read. The big bet is the
   **build output**: after T7 it left the context, and the build was run twice more (T12,
   T14), even though `make -j4` is the most expensive operation.
2. **Progress is measured by nodes, not by commitments.** `knowledgeKey`
   (`src/ir/progress.ts:8`, called at `src/loop/graph.ts:175`) counts new observation
   signatures. Any `read`/`grep` is a new observation → the key changes → `no_progress`
   never fires. 60 turns with no `edit`, stopping only on the budget.
3. **No stage discipline.** `locate` is a subjective goal, stays `open`; every `apply`
   extends the plan (actions: 50). The engine does not hint "you can close" and does not
   limit a stage's steps. Closure happens on the last turn.
4. **The hypothesis is not pinned.** An explanatory guess must become a goal node with
   `why` and a check (`context_design.md` §3.3); here the diagnosis stayed as `thought`
   text, which is not stored — hence the oscillation.
5. **The budget is noticed late.** `budget.remaining` is present from the start; the
   reaction comes at T54+.
6. **Dishonest `maxTurns` stop.** `route` in `src/loop/graph.ts:186` goes to `END` with no
   `stopReason`, so `stopReason=null` instead of `maxTurns`.
7. **IR bloat on the build.** 50 actions and **102** `mutate` edges: after a build, `run`
   treats the whole build tree as changed and creates a `file` node for each. It does not
   press the context directly, but it is the same T2/witness defect as §2 of the previous
   report.

## 7. Conclusions

- **The defect is not in search or context.** The context is manageable (38k peak vs
  803k), grep scope and windows work: `grep … path:…/shared_heap.c … count:60` →
   `20/54 matches; continue from 21`, and the scope is visible in `calls`.
- **The diagnosis (T24) was correct and got lost.** The main levers are **working-set
  memory** and **progress by commitments**, not grep.
- **The tree shape is correct**: an objective root `done_when`, stages, goals/plans.

Priorities:

1. **Progress by commitments** instead of `knowledgeKey`: goal closures, cursor moves, a
   verdict; "no mutations/closures for K turns" → `return`, then stop.
2. **Working-set retention**: do not rely on a manual one-turn `need` — automatically keep
   the latest/key results (at least the last build output) so expensive work is not
   re-run.
3. **Stage discipline**: a step budget per goal; insistently close a subjective stage once
   `done_when` is reached; "diagnosis named" → `edit` + `check`.
4. **Honest stop** `maxTurns` in `stopReason`.
5. **Log `need`** in `SKEIN_PROPOSAL` (the runner currently writes only `thought`+`action`)
   — otherwise projection analysis misleads.

## 8. Open question: "project every body in the branch"?

The current docs (`context_design.md` §2/§8, `ir_semantics.md` §8) record
**lastResult + `need`**, not all branch bodies. If the intent was "show the bodies of all
results in the current branch, caching large ones by reference", that **differs from what
is recorded** and needs a decision:

- option A (as now): all structure + last + `need` (up to 5); risk — a "flickering" working
  set and re-reading;
- option B: structure + the bodies of **all** branch results, the ones that do not fit by
  reference (`outputRef`) with on-demand expansion; risk — context growth, needs a cap;
- option C (intermediate): structure + last + the latest K bodies automatically (e.g.
  K=3–5) + manual `need` on top.

No code change until decided. **(Resolved: option C — level retention; see
`docs/plans/fix_ocaml_gc_investigation.md` §8.2.5.)**

## 9. Appendix: per-turn context measurement

`chars` — the sent context size; `path`/`calls`/`lastResult`/`shown` — the component bytes
(`len(JSON.stringify(...))`); `nShown` — the number of results pinned via `need`.

| turn | chars | path | calls | lastResult | shown | nShown |
|---|---|---|---|---|---|---|
| 0 | 754 | 536 | 2 | 0 | 2 | 0 |
| 1 | 2919 | 2102 | 2 | 0 | 2 | 0 |
| 2 | 3265 | 2102 | 154 | 112 | 2 | 0 |
| 3 | 11262 | 2225 | 273 | 7734 | 2 | 0 |
| 4 | 28376 | 2323 | 356 | 16793 | 7736 | 1 |
| 5 | 4865 | 2515 | 533 | 571 | 2 | 0 |
| 6 | 38082 | 2613 | 533 | 16793 | 16795 | 1 |
| 7 | 21970 | 2613 | 732 | 16793 | 444 | 1 |
| 8 | 5602 | 3190 | 732 | 91 | 2 | 0 |
| 9 | 6563 | 3194 | 479 | 1330 | 2 | 0 |
| 10 | 6167 | 3799 | 479 | 89 | 2 | 0 |
| 11 | 8149 | 3803 | 576 | 1925 | 2 | 0 |
| 12 | 5720 | 3334 | 576 | 145 | 2 | 0 |
| 13 | 8478 | 3446 | 673 | 669 | 1879 | 1 |
| 14 | 4745 | 2741 | 479 | 144 | 2 | 0 |
| 15 | 6248 | 2853 | 576 | 669 | 623 | 1 |
| 16 | 3148 | 2145 | 2 | 143 | 2 | 0 |
| 17 | 11558 | 2297 | 147 | 8123 | 2 | 0 |
| 18 | 20333 | 2415 | 150 | 8555 | 8125 | 1 |
| 19 | 20718 | 2420 | 339 | 8271 | 8557 | 1 |
| 20 | 20971 | 2581 | 321 | 8598 | 8273 | 1 |
| 21 | 17496 | 2581 | 424 | 4979 | 8273 | 1 |
| 22 | 18192 | 2801 | 672 | 8387 | 4981 | 1 |
| 23 | 21112 | 2919 | 775 | 2561 | 13370 | 2 |
| 24 | 15585 | 3037 | 878 | 5126 | 4981 | 1 |
| 25 | 19756 | 3289 | 1158 | 8659 | 4981 | 1 |
| 26 | 23512 | 3407 | 1261 | 3397 | 13642 | 2 |
| 27 | 26110 | 3525 | 1364 | 5670 | 13642 | 2 |
| 28 | 17689 | 3644 | 1467 | 2032 | 8527 | 2 |
| 29 | 24547 | 3644 | 1467 | 1022 | 16367 | 3 |
| 30 | 18953 | 3760 | 1568 | 3796 | 7706 | 2 |
| 31 | 17418 | 3878 | 1671 | 1936 | 7706 | 2 |
| 32 | 29293 | 4148 | 1969 | 8390 | 12459 | 2 |
| 33 | 22364 | 4266 | 2072 | 5879 | 7706 | 2 |
| 34 | 26640 | 4516 | 2350 | 8875 | 8392 | 1 |
| 35 | 27629 | 4636 | 2455 | 3616 | 14273 | 2 |
| 36 | 20412 | 4756 | 2560 | 4490 | 5881 | 1 |
| 37 | 24421 | 4872 | 2661 | 4346 | 9679 | 2 |
| 38 | 25190 | 5069 | 2886 | 8419 | 5881 | 1 |
| 39 | 28194 | 5185 | 2886 | 4346 | 12740 | 2 |
| 40 | 21794 | 5185 | 2989 | 2433 | 8110 | 2 |
| 41 | 26719 | 5185 | 3216 | 8278 | 6927 | 2 |
| 42 | 24631 | 5185 | 3319 | 2267 | 10715 | 2 |
| 43 | 26782 | 5185 | 3422 | 1978 | 12984 | 3 |
| 44 | 19969 | 5185 | 3525 | 3336 | 4704 | 2 |
| 45 | 20545 | 5185 | 3628 | 3775 | 4704 | 2 |
| 46 | 25721 | 5185 | 3981 | 8562 | 4704 | 2 |
| 47 | 24323 | 5185 | 4084 | 3501 | 8192 | 3 |
| 48 | 38341 | 5185 | 4340 | 8621 | 16844 | 2 |
| 49 | 33896 | 5185 | 4443 | 3976 | 16903 | 2 |
| 50 | 20773 | 5185 | 4546 | 3663 | 3978 | 1 |
| 51 | 38128 | 5185 | 4546 | 4346 | 20555 | 4 |
| 52 | 24881 | 5185 | 4649 | 3055 | 8564 | 1 |
| 53 | 20301 | 5185 | 4649 | 3976 | 3057 | 1 |
| 54 | 25880 | 5185 | 4752 | 5036 | 7405 | 2 |
| 55 | 26884 | 5185 | 4991 | 8166 | 5038 | 1 |
| 56 | 24669 | 5185 | 5094 | 4092 | 6722 | 2 |
| 57 | 26596 | 5185 | 5367 | 8372 | 4094 | 1 |
| 58 | 22000 | 5185 | 5470 | 3635 | 4094 | 1 |
| 59 | 25896 | 5185 | 5470 | 3976 | 7615 | 2 |

Means: `chars` 19 719, `path` 3 881, `calls` 2 119, `lastResult` 4 809, `shown` 6 659.

## 10. Iteration: history index and the id collision (after the analysis)

Following §6–§8, a "history index" mechanism was introduced:

- `query { id, start?, end? }` returns a result body; a repeated `read`/`grep`/`run` with
  the same inputs and an unchanged world is **refused with the `id`** (a hard refusal);
- the `calls` summary is informative: `read` — file/window/size, `run` — verdict and error
  line, `grep`/`list` — `returned/total`;
- `lastResult.id` matches the shown body; a call with no node (`query`/`complete`) is shown
  **without** an `id` (previously after `complete` there was a foreign `id` — the model
  noticed);
- **the `calls` scope is the subtree of the current chosen interpretation**, not just the
  current path (semantics §2.8): `reproduce`-stage evidence is visible at `locate`/`fix`.

While debugging, an **id-generation bug** surfaced: every node called `next()` twice
(`id` + `seq`), while `fold` increments `seq` by 1 per event — the counters diverged, ids
were reused (`e:23` twice: a `chosen` edge overwritten by a later `has_plan`). As a result
`chosenInterpretation` could not find the interpretation and the new `calls` scope did not
work. Fixed: one `next()` per node (`seq` = the number in `id`), ids unique.

Effect (live, `off-by-one` fixture, 5 runs): 15–23 turns, **5/5** solved,
`stop=request_addressed`; `repeated_action` refusals — 0 in 3/5, 1 in 2/5 (the model
recovers and fetches the result by `id`). Before the iteration: 24 turns, 3–4 refusals, the
task often unsolved.
