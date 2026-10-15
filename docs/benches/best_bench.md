# Skein — best benchmark runs (leaderboard)

> English mirror of `docs/benches/best_bench_ru.md`.
> A living leaderboard of the best runs. The top-10 stay here.

## How the ranking works

Higher is better, in this order:

1. **`reward`** — the task verifier's verdict (1 before 0);
2. **a positive self-close** (Skein: `stop = request_addressed`; an agent with no stop
   protocol ties here) before a run that only exhausted its budget;
3. **lower cost** (₽; when the agent reports no cost, elapsed wall time is the proxy),
   then fewer steps.

One row per run. The run dir holds the trace (`metrics.json`, `result.json`; opencode also
writes `opencode.txt`).

## Leaderboard

| # | date (UTC) | agent | task | condition | reward | steps | tool calls | in | out (vis + rea) | cache | time | run dir |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **★** | 2026-10-15 | Skein | `fix-ocaml-gc` | **net on** — **latest version** (observable state criteria; reworked `stop`, nudge and transition hint) | **1** | 52 | 53 | 950,833 | 69,562 (7,019 + 62,543) | 88% | — | `bench/runs/sandbox-tasks/2026-10-15T19-24-07-130Z-fix-ocaml-gc` |
| 1 | 2026-10-09 | opencode 1.18.35 | `fix-ocaml-gc` | **net off** | **1** | 27 | 41 | 1,213,834 | 21,987 (3,398 + 18,589) | 96% | 322s | `bench/runs/sandbox-tasks/2026-10-09T15-51-47-367Z-fix-ocaml-gc-opencode-off` |
| 2 | 2026-10-09 | opencode 1.18.35 | `fix-ocaml-gc` | **net on** ‡ | **1** | 33 | 32 | 698,460 | 11,993 (3,245 + 8,748) | 97% | 434s | `bench/runs/sandbox-tasks/2026-10-09T16-01-20-117Z-fix-ocaml-gc-opencode-on` |
| 3 | 2026-10-11 | opencode 1.18.35 | `fix-ocaml-gc` | **net on** † | **1** | 33 | 36 | 1,430,864 | 11,399 (4,011 + 7,388) | 97% | 314s | `bench/runs/sandbox-tasks/2026-10-11T06-30-03-965Z-fix-ocaml-gc-opencode-on` |
| 4 | 2026-10-11 | opencode 1.18.35 | `fix-ocaml-gc` | **net off** † | **1** | 24 | 31 | 748,329 | 15,834 (2,720 + 13,114) | 96% | 279s | `bench/runs/sandbox-tasks/2026-10-11T06-52-33-197Z-fix-ocaml-gc-opencode-off` |
| 5 | 2026-10-11 | Skein | `fix-ocaml-gc` | **net on** † — **best Skein by cost** | **1** | 33 | 33 | 702,152 | 23,003 (2,898 + 20,105) | 88% | — | `bench/runs/sandbox-tasks/2026-10-11T13-21-36-838Z-fix-ocaml-gc` |
| 6 | 2026-10-11 | Skein | `fix-ocaml-gc` | **net on** | **1** | 35 | 35 | 908,678 | 57,946 (2,947 + 54,999) | 91% | — | `bench/runs/sandbox-tasks/2026-10-11T05-13-47-307Z-fix-ocaml-gc` |
| 7 | 2026-10-13 | Skein | `fix-ocaml-gc` | **net on** † — **new architecture (goal-into-move)** | **1** | 52 | 71 | 507,700 | 23,758 (5,040 + 18,718) | 63% | — | `bench/runs/sandbox-tasks/2026-10-13T11-39-19-740Z-fix-ocaml-gc` |
| 8 | 2026-10-11 | Skein | `fix-ocaml-gc` | **net off** † — **best net off by cost** | **1** | 45 | 45 | 981,165 | 81,294 (3,577 + 77,717) | 92% | — | `bench/runs/sandbox-tasks/2026-10-11T13-50-03-723Z-fix-ocaml-gc` |
| 9 | 2026-10-13 | Skein | `fix-ocaml-gc` | **net off** † — **new architecture (goal-into-move)** | **1** | 49 | 72 | 537,153 | 44,498 (5,044 + 39,454) | 64% | — | `bench/runs/sandbox-tasks/2026-10-13T11-51-44-681Z-fix-ocaml-gc` |
| 10 | 2026-10-13 | Skein | `fix-ocaml-gc` | **net on** † — **anti-VCS prompt cleanup (B19 + B7)** | **1** | 46 | 66 | 761,596 | 48,548 (4,699 + 43,849) | 83% | — | `bench/runs/sandbox-tasks/2026-10-13T19-02-00-767Z-fix-ocaml-gc` |

Rows **`08-40`** (net on, 50 steps, no cost recorded), **`07-02`** (net off, 13.78₽) and
**`18-30`** (net on, 12.68₽) fell out of the top-10 by the rule (more expensive / no cost) —
their write-ups remain in the sections below.

**Condition notes.** † — a run **after the oracle was removed**: the task verifier (including
Harbor's `tests/test.sh`, which names the broken tag `tag_purposefully_broken_sweeping_changes`)
is no longer staged into the agent's workspace — it is added only after the agent, before the
check (`tests/sandbox/harness.ts`, `stageVerifier`). ‡ — a **leaked** run: the leaked `test.sh`
lay in the workspace and opencode read the benchmark author's repo and tag from it.

**The honest 2×2 (all reward=1, oracle removed).** Only network access changes across a row,
only the agent across a column.

| | opencode | Skein |
|---|---|---|
| **net on** | 7,388 reasoning / 1,430,864 in / 33 steps (#3) | 20,105 / 702,152 / 33 (#5) |
| **net off** | 13,114 / 748,329 / 24 (#4) | 77,717 / 981,165 / 45 (#6) |

Removing the network barely moves opencode (7,388→13,114) but sharply raises Skein's reasoning
(20,105→77,717, ×3.9) and steps (33→45): with no oracle (the upstream `webfetch` → 403) the model
churns through `bash` and burns reasoning. Offline the gap is even wider: **opencode 13,114 vs
Skein 77,717 (≈5.9×)**. Skein's cost does not reduce to oracle access — it grows precisely from
its absence. Both Skein columns are the same prompt (Phase 14), so this is an honest net on/off
pair.

## Latest version (2026-10-15) — observable state criteria

`fix-ocaml-gc --net on`, reward **1**, `request_addressed`, 52 turns, 7.30₽
(`bench/runs/sandbox-tasks/2026-10-15T19-24-07-130Z-fix-ocaml-gc`). Per-state breakdown:

| state | turns | closure |
|---|---|---|
| Orientation | t1–t4 | layout/build known |
| **Localization** | t5–t36 | `why`: "Offending file: **ocaml/runtime/shared_heap.c** — function **pool_sweep** (line 650): `p += Whsize_hd(hd)`…" |
| **Patch** | t37–t40 | a single `edit`: `p += Whsize_hd(hd);` → `p += wh;` (the correct one-line fix) |
| **Verification** | t41–t50 | `make -C testsuite one DIR=tests/basic` → passes |
| Finish | t51 | `request_addressed` |

**What changed** (to be hand-edited): observable criteria in `src/ir/islands.ts` — `Localization`
= "the failure is located — the file(s) and the offending code are named", `Patch` = "the fix is
applied in the workspace", `Verification` = "the request's acceptance command now passes"; the
`stop` description = the state's outcome (no "next state"), `why` required; `turnInstruction`
names the criterion (the "otherwise … single next step" and the next-state fragment removed);
`transitionInstruction` points at the just-finished state's `Finish state <label>` line as the
source of `what`/`done`; `done` is required on `move`.

**Key effect:** Localization **closed** (observable criterion) naming file:function:line + the
offending code; Patch **carried the file** and made one focused edit — no `stale_base` storm. Cf.
the regression `2026-10-15T15-36-50` (reward 0, Localization never closed in 60 turns). Open:
Localization is still long (32 turns); the batch-`stale_base` root is untouched (the fix was
one-line).

## New reference point and the tool-index A/B (B12), 2026-10-11

The new reference point is row **#5**: net on, reward 1, a **self-`stop`**, **33 steps / 2.93₽** —
today's best Skein run. State at recording: the prompt was structurally rewritten (Phase 14,
S1–S4 — contract, request situation, goal situation); block **B12** (the tool index) is removed;
in place are the native tool surface, `bash workdir`/`timeout`, the seed-action `call` fix (no
`human OBSERVATION`) and the crash rendering; the `list`↔`glob` rename is **reverted**
(`list { path?, include?, from? }`). The one-line fix `p += Whsize_hd(hd);` → `p += wh;` in
`pool_sweep`; the model called `stop` itself.

**How it came about.** The hypothesis was that the model's drift into a `bash` storm was caused
by removing the tool index. We ran a controlled A/B: two `--net on --turns 40` runs on the same
tree, differing **only** in whether B12 is in the prompt.

| B12 | steps | tool calls | `edit` | `stop` | in | out (vis + rea) | cache | cost | run dir |
|---|---|---|---|---|---|---|---|---|---|
| **on** | 40 | 40 | 1 | **max_turns** | 1,043,903 | 56,162 (3,314 + 52,848) | 95% | 6.44₽ | `bench/runs/sandbox-tasks/2026-10-11T13-06-44-848Z-fix-ocaml-gc` |
| **off** (#5) | 33 | 33 | 3 | **request_addressed** | 702,152 | 23,003 (2,898 + 20,105) | 88% | 2.93₽ | `bench/runs/sandbox-tasks/2026-10-11T13-21-36-838Z-fix-ocaml-gc` |

Both solved the task (reward 1) — the model finds the edit either way. But with the index it read
and diffed more, made **one** edit and **never stopped** (hit `max_turns`, rea 52,848); without
it — **three** edits, a clean `stop` and **half** the cost. The reason: the tool descriptions in
the prompt act as (badly written) anchoring examples the model imitates. **Decision: B12 is
removed**; the descriptions stay only in the request's `tools` (invariant §1.4 of
`docs/system_prompt.md`). Caveat: one run per arm — the direction is clear, but it is not
statistics.

**The current net on/off pair (Phase 14).** `--net off` on the same prompt — row **#6**: reward 1,
self-`stop` at t44, but **45 steps / 6.04₽** (rea **77,717**, vis 3,577; in 981,165, fresh 80,301,
cache 92%). Offline the upstream `webfetch` goes through the host allowlist proxy and gets **403**
— all **4** attempts failed (t13, t18, t23, t31); the model fell into a `bash` storm (**27** calls
vs 16 with network) and made the edit only at **t39** (vs t20). Two cap-hits (t32, t39, 8,192 rea
each) are **24%** of the cost; the top-8 turns by reasoning are 63%. Net: without the oracle,
reasoning ×3.9 and cost ×2.1, at nearly the same fresh input.

For the record — the previous reference point (same tree, but the prompt **before** Phase 14,
without B12): `2026-10-11T10-38-01` (net off, 32 steps, 58,551 rea, 10.43₽) and
`2026-10-11T10-25-39` (net on, 40 steps, 62,438 rea, 12.06₽). The same day's **reward-0 runs**:
`2026-10-11T09-18-55` (60 turns, 142,270 rea, 25.46₽) and `2026-10-11T10-04-08`
(the `glob` rename experiment: 60 turns, 154,361 rea, 27.16₽ — `glob` never called).

## The goal-into-move architecture (state = goal), 2026-10-13

Redesign: the `goal` node and the `create_goal` operator are removed — a state (`move`) carries
its own goal text (`what`), the plan hangs directly off the `move`, and the first plan item is an
ordinary `apply` (`docs/plans/archive/goal_into_move_plan.md`). The tool surface IS the frontier
(`applicable`), so after a `stop` only `move` is offered (the post-stop loop is impossible by
construction). The prompt is Phase 14 plus these changes. Two `fix-ocaml-gc` runs:

| | opencode (baseline) | Skein goal-based (Phase 14) | Skein goal-into-move |
|---|---|---|---|
| **net on** — reward | 1 | 1 | **1** |
| net on — steps / calls | 33 / 36 | 33 / 33 | 52 / 71 |
| net on — in | 1,430,864 | 702,152 | **507,700** |
| net on — out (vis + rea) | 11,399 (4,011 + 7,388) | 23,003 (2,898 + 20,105) | 23,758 (5,040 + 18,718) |
| net on — cache | 97% | 88% | 63% |
| net on — cost / time | ~314 s | **2.93₽** | 5.04₽ |
| **net off** — reward | 1 | 1 | **1** |
| net off — steps / calls | 24 / 31 | 45 / 45 | 49 / 72 |
| net off — in | 748,329 | 981,165 | **537,153** |
| net off — out (vis + rea) | 15,834 (2,720 + 13,114) | 81,294 (3,577 + 77,717) | **44,498** (5,044 + 39,454) |
| net off — cache | 96% | 92% | 64% |
| net off — cost / time | ~279 s | **6.04₽** | 6.70₽ |

**Tokens.** Input is **halved** (net off: 981,165 → 537,153; net on: 702,152 → 507,700), but the
mix changed: *fresh* input **grew** (net off 194,497 vs ~80,301; net on 186,292 vs ~84,258) while
`cacheRead` **fell** (≈322–343k vs ~618–900k), hence the lower cache-hit (63–64% vs 88–92%). The
reason: the tape is rebuilt per state — `move` carries `what`, states and transitions change the
prefix, the plan is re-seeded by the first `apply` — so prefix reuse is worse; the total is still
smaller. `out` is about the same size, but with more **visible** output (≈5,040 vs 2,898–3,577:
the model writes `what` per state) and, crucially, less **reasoning**.

**The headline: offline reasoning halves** (77,717 → **39,454**, ×0.51). With network the
reasoning is about the same (20,105 → 18,718). Cost is comparable (net off +11%: 6.04 → 6.70₽;
net on is pricier: 2.93 → 5.04₽, though steps rose 33 → 52). Steps are higher (52/49 vs 33/45):
several states and transitions are now actually declared, not just one.

**Versus opencode.** The offline-reasoning gap narrowed from ≈5.9× to **≈3.0×** (13,114 → 39,454);
net on from ≈2.7× to ≈2.5× (7,388 → 18,718). By input the new architecture is now **below**
opencode in both modes (507,700 vs 1,430,864 with network; 537,153 vs 748,329 without).

**The motivating run.** The previous (goal-based) intermediate version on the same tree scored
reward 0 (`no_progress`, 46 turns): after its single `stop` the doxa alternated
`create_goal`/`apply` for 19 turns, because the inadmissible tool was still offered. The new
architecture removes the operator itself — these runs show just **2** refusals (net on) and **5**
(net off).

## Anti-VCS prompt cleanup (B19 + B7), 2026-10-13

A prompt review found the cause of the `git` reflex documented in `docs/tools.md` §5–6: the
mandatory "do not rely on a VCS" clause was **missing**, and `bash`'s description named
`git status/diff/log`. Changes:

- **B19** (new, in the base): "the workspace is the source of truth: do not assume a VCS, `git`,
  a diff or history; a `git` failure is not retried".
- **B7** rewritten — "make the first action a DISCOVERY one (e.g. `bash ls`)" is gone; now "take
  the state's first step … act on the goal and the tape; do not look for a change history".
- The **state description** (`What / Done when`) moved from a per-turn injected block to a single
  `system` turn on the tape (shown once at entry); the situation instruction is now appended
  **last** and temporary (never stored in the history). Block cleanup: B0+B1 merged, B18 removed,
  the trust / "apply refused" dups dropped.

Run (net on, †): reward 1, `request_addressed`, 46 steps / 66 calls, in 761,596 (fresh 127,228 +
cache 634,368, hit 83%), out 48,548 (4,699 + 43,849), **6.97₽**. Versus the **same-day run on the
pre-cleanup prompt** (goal-into-move): reward 1 but `max_turns`, 60 steps, 22.64₽ — now it
self-closes in 46 steps at a third of the cost. Two `git` probes survive (t9, t24) but do not
spiral; 0 refusals. By steps it is mid-pack (33 is the best, #5); by input it sits below the older
rows (900k–2.1M) and above goal-into-move (507k).

## opencode on `fix-ocaml-gc` (our sandbox)

Runs: `tests/sandbox/opencode-run.ts` (Docker, **no Harbor**) runs opencode inside the
task image `alexgshaw/fix-ocaml-gc:20251031`; the task's own verifier scores the result
(`check.code = 0`, `PASS test_tests_output`). Model
`routerai/~deepseek/deepseek-v4-flash-latest`, `--variant low`.

- **net off (#1).** `--network bridge` + `HTTP(S)_PROXY` pointing at a host allowlist proxy
  that only permits `routerai.ru` (github 403). Localized by reading, no upstream copy:
  27 steps, 41 tool calls (`bash 27, read 12, grep 1, edit 1`). One edit; reward 1.
- **net on, ‡ (#2).** Plain `--network bridge`: opencode clones `github.com/sadiqj/ocaml` and
  uses git history to find the breaking commit, then edits. 33 steps, 32 tool calls
  (`bash 31, edit 1`). Cheaper on tokens (the clone replaces the read-heavy localization),
  but slower and only possible with network. **Note:** it took the repo and tag from the leaked
  `tests/test.sh` (marker ‡), so this is a run with the oracle in the tree.
- **net on, † (#3).** After the oracle was removed (`stageVerifier`): the author's tag is no
  longer in the tree. opencode still solves it (reward 1) by a different route — hand-derivation
  (a reasoning peak of ~10,426 chars on one turn) and then a search of the **public** upstream
  via the GitHub API: it finds the real OCaml commit/PR, downloads `shared_heap.c`, diffs and
  edits. 33 steps, 36 tool calls (`bash 30, read 5, edit 1`); input rose to 1,430,864 (network
  search) while reasoning stayed at 7,388 — it did not grow. Context peak 215,100 chars.
  Conclusion: removing the leak is necessary, but on **net on** the public upstream remains a
  legitimate oracle for a real OCaml bug.
- **net off, † (#4).** After the oracle removal and with the network closed (allowlist proxy:
  `webfetch` and `curl` to github → **403**). opencode still solves it (reward 1) by
  **reading + comparing**: the anomalous line `p += Whsize_hd(hd)` in `pool_sweep` against the
  correct `p += wh` pattern in the neighbouring loops of the same file (`pool_finalise`,
  `verify_pool`, `calc_pool_stats`). 24 steps, 31 tool calls (`bash 19, read 10, webfetch 1,
  edit 1`), in 748,329, reasoning **13,114** (peak 10,156 on one turn), 279 s. **The cheapest
  run by steps, and with no oracle at all.**

None is a Skein row — this is the opencode baseline on the same task/sandbox. Recorded per
the owner's request.

## Skein on `fix-ocaml-gc` (our sandbox)

`npx tsx tests/sandbox/sandbox-run.ts fix-ocaml-gc` (Docker, **no Harbor**) runs the agent
inside the task image; the task's own verifier scores the result (`check.code = 0`,
`PASS test_tests_output`). Model `routerai/~deepseek/deepseek-v4-flash-latest`,
`SKEIN_REASONING_EFFORT=low`, task budget 60 turns.

- **net on (#10, `19-02`) — current net on (anti-VCS cleanup).** 46 steps, 66 calls (all
  accepted), a clean `stop = request_addressed`; **6.97₽** (in 761,596: fresh 127,228 + cache
  634,368 = 83%; out 48,548: 4,699 + 43,849; context peak 142,602). The first run after B19/B7 and
  moving the state description onto the tape. Localized by reading, one `edit`, then `./configure`
  `make` `make -C testsuite one DIR=tests/basic`; the verifier passed. Two `git` probes (t9, t24)
  did not spiral.

- **net on (#5, `13-21`) — new best.** 33 steps, 33 tool calls, `edit` 3×, a clean
  `stop = request_addressed`; **2.93₽** (rea 20,105; ~2.3k-char starting context — no tool
  index). Phase 14 prompt (S1–S4), **B12 removed** — see the A/B above. Same one-line edit
  `p += Whsize_hd(hd);` → `p += wh;` in `pool_sweep`; the verifier passed.
- **net off, † (#6, `13-50`) — current net off.** 45 steps, 45 tool calls, `edit` 1×, a clean
  `stop = request_addressed` at t44; **6.04₽** (rea 77,717; `bash` 27, `fetch` 4 — all 403).
  With no oracle the edit came only at t39, after two cap-hits (t32, t39). Phase 14 prompt (B12
  removed), the same one-line `pool_sweep` edit; the verifier passed.
- **net on (#7, `05-13`).** 35 steps, 35 tool calls (all accepted), a clean
  `stop = request_addressed`; 4.85₽. The first run after the native-role
  and deduplication fixes: the alternative marker no longer re-inlines a failure body, and for
  native nodes there is no marker at all. Context peak fell from 352k to 94,450 chars (−73%),
  fresh input to 79,494 (−59%), reasoning to 54,999 (−39%), cost by half. Same one-line edit in
  `pool_sweep` (`p += Whsize_hd(hd);` → `p += wh;`); the verifier passed. Per-turn reasoning is
  in `reasoning.ndjson`.
- **net on (#8, `18-30`).** 41 steps, 41 tool calls (all accepted). The trimmed prompt — no
  `sketch`/`why`, plus a short-reasoning / no-recall-code rule in B13 — cut reasoning to 89,555
  (from 104,504 below) and closed cleanly (`stop = request_addressed`); 12.68₽. Same one-line
  edit in `pool_sweep` (`p += Whsize_hd(hd);` → `p += wh;`); verifier passed. It still fetched
  the upstream twice (the diff-seeking persists) and the context grew to 352k chars (peak); one
  completion-cap turn recovered via the reasoning-off retry. Per-turn reasoning is in
  `reasoning.ndjson`.
- **net on (#9, `08-40`).** 50 steps, 50 tool calls (48 ok / 2 refused). The first reward-1 run
  on the revised IR. It localized by reading (`read`/`grep` over `runtime/shared_heap.c`),
  fetched the upstream `shared_heap.c`, diffed it, and made the same edit; it ended on
  `llm_error` (a model failure), not a self-`stop` — the work was already done. Wall time was
  not recorded.
- **net off, † (#10).** The honest "no oracle and no network": the host `fetch`/background `run`
  go through an allowlist proxy (github → 403; `fetch` was called 2× and failed). 31 steps, 31
  tool calls (all accepted), a clean `stop = request_addressed`; 13.78₽. Reasoning rose to
  **77,942** (in 702,484, fresh 55,060, cache 92%; context peak 78,572) — higher than with the
  network (#7): without an oracle Skein has to derive the line by hand. Same one-line edit
  `p += Whsize_hd(hd);` → `p += wh;`.

## Next

- Add other agents/tasks as they are run (`sandbox-tasks/`), keeping the top-10 by the rule
  above.
- The `net off` pair (Skein and opencode, marker †) is **done**; the honest 2×2 is above.
  Implemented: `sandbox-run.ts --net off` (host `fetch`/background `run` via the allowlist proxy).
- Next: work out **why** Skein spends ~2.5× the reasoning with network (goal-into-move: 18,718
  vs opencode 7,388) and ~3× without (39,454 vs 13,114), and add other agents/tasks. The offline
  gap's evolution: ~5.9× (goal-based) → **~3.0×** (goal-into-move).
