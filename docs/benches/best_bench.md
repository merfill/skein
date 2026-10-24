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

> **2026-10-23, restored state layer, reasoning on, net off, K=3:** `fix-ocaml-gc` —
> **3/3 reward=1**, 25–29 steps, **1.342 / 1.412 / 1.437₽** (median **1.412₽**). L closed at
> t10 / t8 / t11; median input **163,568** (fresh 51,084 + cache 115,968, 71%) vs opencode
> net-off **981,082**; reasoning **3,812** vs **15,852**. See the 2026-10-23 batch below.

> **2026-10-23, rootless D + relative paths, net off, K=3:** `fix-ocaml-gc` — **3/3 reward=1**,
> 27–29 steps, **1.633 / 1.732 / 1.822₽** (median **1.732₽**). L closed at t8 / t10 / t10;
> median input **196,449** (fresh 64,353 + cache 135,680, 69%). Versus the pre-rootless batch
> median cost **+23%**; the gap is in Patch (8–9 steps vs 6–8), not Localization. See the
> 2026-10-23 rootless batch below.

> **2026-10-23, breadth:** `fix-code` / `fix-git` / `custom-memory` — **3/3 reward=1**;
> 25 / 19 / 60 steps, **0.942 / 0.847 / 3.822₽**. `fix-git` skipped Verification;
> `custom-memory` is a regression (60 steps, 4 cycles). See the 2026-10-23 breadth batch.

> **2026-10-23, breadth rootless D + relative paths:** `fix-code` / `fix-git` /
> `custom-memory` — **3/3 reward=1**; 20 / 20 / 60 steps, **0.769 / 0.833 / 3.114₽**.
> `fix-code`/`fix-git` are `request_addressed`; `custom-memory` is `reward=1` but
> **`max_turns`** (no self-closure). See the 2026-10-23 rootless breadth batch below.

> **2026-10-23, recovery (Research → Recovery), net off, K=1 per task:**
> `password-recovery` / `db-wal-recovery` / `crack-7z-hash` — **3/3 reward=1**, 26 / 22 / 23
> steps, **2.531 / 1.278 / 0.965₽**. All `request_addressed`, route
> `O → Research → Recovery → End`. See the 2026-10-23 recovery batch below.

> **2026-10-18, terminal-bench breadth:** `db-wal-recovery`, `log-summary-date-ranges`,
> `cobol-modernization`, `fix-code-vulnerability`, `password-recovery` — **5/5**;
> `crack-7z-hash` — **3/3** completed (2 aborted). Generalized states + workspace
> checkpoint/revert. See the 2026-10-18 batch below.

> **2026-10-17, final batch:** 5/5 `fix-ocaml-gc --net on`, 29–50 steps,
> **1.031–2.521₽** — see the final batch below. The leaderboard below is historical; the new
> best net-on is run4 `26-682` (1.031₽ / 32 steps) and run3 `25-612` (1.036₽ / 29 steps).

## Leaderboard

| # | date (UTC) | agent | task | condition | reward | steps | tool calls | in | out (vis + rea) | cache | time | run dir |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **★** | 2026-10-23 | Skein | `fix-ocaml-gc` | **net off** — restored state layer, reasoning on; **1.342₽**, best by cost | **1** | 26 | 32 | 163,568 | 6,796 (2,984 + 3,812) | 71% | — | `bench/runs/sandbox-tasks/2026-10-23T04-29-17-477Z-fix-ocaml-gc` |
| 1 | 2026-10-23 | Skein | `fix-ocaml-gc` | **net off** — restored state layer, reasoning on; **1.412₽**, best by input (151,935) | **1** | 25 | 33 | 151,935 | 6,944 (2,995 + 3,949) | 66% | — | `bench/runs/sandbox-tasks/2026-10-23T04-29-19-623Z-fix-ocaml-gc` |
| 2 | 2026-10-23 | Skein | `fix-ocaml-gc` | **net off** — restored state layer, reasoning on; **1.437₽** | **1** | 29 | 38 | 208,780 | 7,092 (3,322 + 3,770) | 76% | — | `bench/runs/sandbox-tasks/2026-10-23T04-29-21-776Z-fix-ocaml-gc` |
| 3 | 2026-10-17 | Skein | `fix-ocaml-gc` | **net off** † — reasoning on the tape (formerly ★: best by cost/input before 2026-10-23) | **1** | 27 | 34 | 159,475 | 10,681 (2,901 + 7,780) | 72% | — | `bench/runs/sandbox-tasks/2026-10-17T05-16-41-582Z-fix-ocaml-gc` |
| 4 | 2026-10-23 | Skein | `fix-ocaml-gc` | **net off** — rootless D + relative grep/list; **1.633₽** | **1** | 27 | 27 | 196,293 | 7,636 (3,031 + 4,605) | 69% | — | `bench/runs/sandbox-tasks/2026-10-23T16-32-18-116Z-fix-ocaml-gc-AAFw9y` |
| 5 | 2026-10-23 | Skein | `fix-ocaml-gc` | **net off** — rootless D + relative grep/list; **1.732₽** | **1** | 29 | 29 | 196,449 | 8,130 (3,798 + 4,332) | 67% | — | `bench/runs/sandbox-tasks/2026-10-23T16-32-18-094Z-fix-ocaml-gc-sVz2Qi` |
| 6 | 2026-10-23 | Skein | `fix-ocaml-gc` | **net off** — rootless D + relative grep/list; **1.822₽** | **1** | 29 | 29 | 239,499 | 9,046 (3,428 + 5,618) | 73% | — | `bench/runs/sandbox-tasks/2026-10-23T16-32-18-093Z-fix-ocaml-gc-bH2YAw` |
| 7 | 2026-10-17 | Skein | `fix-ocaml-gc` | **net off** † — reasoning on the tape (A/B) | **1** | 34 | 44 | 173,000 | 14,923 (3,296 + 11,627) | 71% | — | `bench/runs/sandbox-tasks/2026-10-17T04-57-57-012Z-fix-ocaml-gc` |
| 8 | 2026-10-17 | Skein | `fix-ocaml-gc` | **net off** † — reasoning on the tape (A/B) | **1** | 32 | 40 | 222,135 | 14,603 (3,274 + 11,329) | 75% | — | `bench/runs/sandbox-tasks/2026-10-17T05-16-41-598Z-fix-ocaml-gc` |
| 9 | 2026-10-14 | Skein | `fix-ocaml-gc` | **net on** † — **best net on and best Skein by cost without reasoning on the tape (Phase 18: active directives)** | **1** | 29 | 37 | 252,551 | 16,198 (3,177 + 13,021) | 78% | — | `bench/runs/sandbox-tasks/2026-10-14T05-37-29-796Z-fix-ocaml-gc` |
| 10 | 2026-10-09 | opencode 1.18.35 | `fix-ocaml-gc` | **net off** | **1** | 27 | 41 | 1,213,834 | 21,987 (3,398 + 18,589) | 96% | 322s | `bench/runs/sandbox-tasks/2026-10-09T15-51-47-367Z-fix-ocaml-gc-opencode-off` |

Row numbers are current (2026-10-23); in the sections below, `(#N)` refers to the leaderboard at
the time of that run.

Newly out of the top-10: **`2026-10-15T19-24-07`** (net on, 52 steps, 7.30₽),
**`2026-10-11T13-21-36`** (net on, 33 steps, 2.93₽) and **`2026-10-11T05-13-47`** (net on,
35 steps, 4.85₽). Earlier drops: **`2026-10-13T11-39-19`** (net on, goal-into-move, 52 steps),
**`2026-10-11T13-50-03`** (net off, 45 steps), **`2026-10-13T11-51-44`** (net off,
goal-into-move, 49 steps), **`19-02`** (net on, 46 steps, 6.97₽), **`08-40`** (net on,
50 steps, no cost recorded), **`07-02`** (net off, 13.78₽) and **`18-30`** (net on, 12.68₽) —
their write-ups remain in the sections below. With the rootless batch added, these opencode
rows dropped out: **`2026-10-09T16-01-20`** (net on, 33 steps, 434s), **`2026-10-11T06-30-03`**
(net on, 33, 314s) and **`2026-10-11T06-52-33`** (net off, 24, 279s); their traces remain in
the run dirs.

**Condition notes.** † — a run **after the oracle was removed**: the task verifier (including
Harbor's `tests/test.sh`, which names the broken tag `tag_purposefully_broken_sweeping_changes`)
is no longer staged into the agent's workspace — it is added only after the agent, before the
check (`tests/sandbox/harness.ts`, `stageVerifier`). ‡ — a **leaked** run: the leaked `test.sh`
lay in the workspace and opencode read the benchmark author's repo and tag from it.

**The honest 2×2 (all reward=1, oracle removed).** Only network access changes across a row,
only the agent across a column.

| | opencode | Skein |
|---|---|---|
| **net on** | opencode `06-30`: 7,388 reasoning / 1,430,864 in / 33 steps | Skein `13-21`: 20,105 / 702,152 / 33 |
| **net off** | opencode `06-52`: 13,114 / 748,329 / 24 | Skein `13-50`: 77,717 / 981,165 / 45 |

Removing the network barely moves opencode (7,388→13,114) but sharply raises Skein's reasoning
(20,105→77,717, ×3.9) and steps (33→45): with no oracle (the upstream `webfetch` → 403) the model
churns through `bash` and burns reasoning. Offline the gap is even wider: **opencode 13,114 vs
Skein 77,717 (≈5.9×)**. Skein's cost does not reduce to oracle access — it grows precisely from
its absence. Both Skein columns are the same prompt (Phase 14), so this is an honest net on/off
pair.

## Batch 2026-10-23 — restored state layer, reasoning on, net off, K=3

`npx tsx tests/sandbox/sandbox-run.ts fix-ocaml-gc --net off --turns 60`, 3 in parallel, the
official verifier. Working tree on top of `b1ea154`, uncommitted: the state layer as in
`c97a34d` (entry `Start`/brief/instruction/`what` + per-turn tail
`hint → what → done → closure`, `planInstruction`/`turnInstruction`), B1–B4 as current;
`reasoningTape` defaults to **on**.

| run | steps | calls | in | fresh | cache | hit | out (vis + rea) | L stop | Patch | Verification | ₽ | reward |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|---|--:|--:|
| `04-29-17` | 26 | 32 | 163,568 | 47,600 | 115,968 | 71% | 6,796 (2,984 + 3,812) | t10 | t11–16 | t17–23 | **1.342** | **1** |
| `04-29-19` | 25 | 33 | 151,935 | 51,327 | 100,608 | 66% | 6,944 (2,995 + 3,949) | t8 | t9–15 | t16–22 | **1.412** | **1** |
| `04-29-21` | 29 | 38 | 208,780 | 51,084 | 157,696 | 76% | 7,092 (3,322 + 3,770) | t11 | t12–19 | t20–26 | **1.437** | **1** |
| **median** | **26** | **33** | **163,568** | **51,084** | **115,968** | **71%** | **6,944 (2,995 + 3,812)** | — | — | — | **1.412** | — |

All three `request_addressed`, `reward=1`; the same correct edit every time:
`p += Whsize_hd(hd)` → `p += wh` in `pool_sweep` (`runtime/shared_heap.c`). Run3 had one
transport retry (`No output generated`); no turns were lost.

**Against opencode in the same sandbox** (`bench/runs/sandbox-tasks/*-opencode-*`). Net-off is
the fair arm (no upstream); there were K=5 total (2 net-off + 3 net-on).

| metric | Skein K=3 | opencode net-off K=2 | opencode all K=5 |
|---|---:|---:|---:|
| steps | 25 / 26 / 29 (median 26) | 24 / 27 (median 25.5) | 24–33 (median 27) |
| total in | median **163,568** | median 981,082 | median 748,329 |
| fresh in | median **51,084** | median 39,642 | median 33,449 |
| cache read | median **115,968** | median 941,440 | median 714,880 |
| cache hit | **71%** | 96% | 96% |
| out | median **6,944** | median 18,911 | median 11,993 |
| visible out | median **2,995** | 3,059 | 3,245 |
| reasoning | median **3,812** | 15,852 | 8,748 |
| ₽ | median **1.412** | — (not in metrics) | — |

Versus opencode: total input **0.17×** (net-off) / **0.22×** (all); output **0.37×** / **0.58×**;
reasoning **0.24×** / **0.44×**. But **fresh input is higher** (1.29× / 1.53×) and cache hit is
worse (71% vs 96%): the projection elides closed states, so the total context is far shorter but
caches less. Visible output is essentially the same. K is small (3 vs 2/5), temp 0.1 — a
direction, not statistics.

Traces: `bench/runs/sandbox-tasks/2026-10-23T04-29-17-477Z-fix-ocaml-gc`,
`…04-29-19-623Z…`, `…04-29-21-776Z…`.

## Batch 2026-10-23 — rootless D + workspace-relative paths, net off, K=3

`npx tsx tests/sandbox/sandbox-run.ts fix-ocaml-gc --net off --turns 60`, 3 in parallel, the
official verifier. Current tree on `63563cb` + uncommitted D: the task image starts rootless,
file tools/`bash`/jobs/checkpoint run in the container (store `/tmp/.skein`), the verifier runs
in a separate container; `grep`/`listFiles` return **workspace-relative** paths like
`fsWorkspace` (not `/app/...`). State layer/prompt as in `8dc3102`. This is a clean batch: no
aborts, all three reached the official verifier.

| run | steps | calls | in | fresh | cache | hit | out (vis + rea) | peak chars | L stop | Patch | Verification | ₽ | reward |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|---|---|--:|--:|
| `16-32-18-116` | 27 | 27 | 196,293 | 60,613 | 135,680 | 69% | 7,636 (3,031 + 4,605) | 48,388 | t8 | t9–17 | t18–24 | **1.633** | **1** |
| `16-32-18-094` | 29 | 29 | 196,449 | 64,353 | 132,096 | 67% | 8,130 (3,798 + 4,332) | 58,812 | t10 | t11–18 | t19–26 | **1.732** | **1** |
| `16-32-18-093` | 29 | 29 | 239,499 | 65,035 | 174,464 | 73% | 9,046 (3,428 + 5,618) | 72,420 | t10 | t11–19 | t20–26 | **1.822** | **1** |
| **median** | **29** | **29** | **196,449** | **64,353** | **135,680** | **69%** | **8,130 (3,428 + 4,605)** | **58,812** | — | — | — | **1.732** | — |

All three `request_addressed`, `reward=1`, verifier `PASS test_tests_output`; the same correct
edit every time: `p += Whsize_hd(hd)` → `p += wh` in `pool_sweep` (`runtime/shared_heap.c`).
Each run had one retryable `No output generated` (in Verification); no turns were lost.

**Against the pre-rootless `04-29` batch** (host `/app` + host fast-path `grep/list`):
median steps **29 vs 26**, in **196,449 vs 163,568** (+20%), fresh **64,353 vs 51,084**
(+26%), cache hit **69% vs 71%**, out **8,130 vs 6,944** (+17%), ₽ **1.732 vs 1.412**
(+23%), peak chars **58,812 vs 58,504** (equal). Localization closes at the same/better turn
(t8/t10/t10 vs t10/t8/t11); the gap is in **Patch** (9/8/9 steps vs 6/7/8) and in more fresh
input. Relative paths removed the `/app/...` inflation but do not explain the remainder: it is
model/provider variance plus extra `grep`/`bash`/`read` in Patch. K=3, temp 0.1 — a direction,
not statistics.

Traces: `bench/runs/sandbox-tasks/2026-10-23T16-32-18-116Z-fix-ocaml-gc-AAFw9y`,
`…16-32-18-094Z-…-sVz2Qi`, `…16-32-18-093Z-…-bH2YAw`.

## Batch 2026-10-23 — breadth: `fix-code`, `fix-git`, `custom-memory` (net off, K=1)

The other three tasks of the `O → L → P → V` set, one run each, in parallel:
`npx tsx tests/sandbox/sandbox-run.ts <task> --net off --turns 60`. Same working tree as the
`fix-ocaml-gc` batch above (restored state layer, reasoning on).

| task | steps | calls | in | fresh | cache | hit | out (vis + rea) | L stop | route | ₽ | reward |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|---|--:|--:|
| `fix-code-vulnerability` | 25 | 29 | 131,597 | 38,669 | 92,928 | 71% | 3,399 (2,525 + 874) | t9 | L t3–9 → P t10–17 → V t18–23 → End t24 | **0.942** | **1** |
| `fix-git` | 19 | 24 | 90,466 | 30,306 | 60,160 | 67% | 4,297 (2,689 + 1,608) | t6 | L t3–6 → P t7–17 → **End t18** (V skipped) | **0.847** | **1** |
| `custom-memory-heap-crash` | 60 | 88 | 525,154 | 107,362 | 417,792 | 80% | 25,979 (8,000 + 17,979) | t9 | L t3–9 → P t10–21 → V t22–27 fail → L t28–42 → P t43–51 → V t52–58 pass → End t59 | **3.822** | **1** |

All `request_addressed`, reward 1.

- **`fix-code-vulnerability`.** Guards in `_hkey`/`_hval` for `\n`/`\r`/`\0` + `report.jsonl`
  with `["cwe-93","cwe-20"]`; pytest and the verifier passed.
- **`fix-git`.** Found the dangling commit `650dba4` ("Move to Stanford"), checked it against
  `resources/patch_files`, cherry-picked/merged it; `/tmp/recover.sh` is the checkable recipe.
  The model **skipped Verification**: `Patch → End`; the verifier still passed.
- **`custom-memory-heap-crash`.** Finally `user.cpp` calls `std::_Facet_Register_impl()` in
  `user_init()` — facet nodes are allocated before the custom heap is active; both builds and
  valgrind are clean. But the path is expensive: **4 cycles** and exactly 60 steps (the budget
  was exhausted on the last turn), 17,979 reasoning, 3.822₽.

**Against session3 (K=3, `docs/plans/handoff_2026-10-20_localization_session3_ru.md`):**
fix-code 0.942₽ (was 0.81–1.32), fix-git 0.847₽ (was 0.86–1.30), custom-memory 3.822₽
(best cmh3 — 32 steps / 2.15₽; cmh1 3.80₽ without closure). So fix-code/fix-git are in range,
**custom-memory is a regression** in steps and cost. K=1 per task, temp 0.1 — a direction, not
statistics.

Traces: `bench/runs/sandbox-tasks/2026-10-23T05-04-29-581Z-fix-code-vulnerability`,
`…05-04-31-786Z-fix-git`, `…05-04-33-824Z-custom-memory-heap-crash`.

## Batch 2026-10-23 — breadth, rootless D + workspace-relative paths (net off, K=1 per task)

`npx tsx tests/sandbox/sandbox-run.ts <task> --net off --turns 60`, three tasks in parallel,
one run each, official verifier. Current tree on `63563cb` + uncommitted D: rootless,
`grep`/`listFiles` return workspace-relative paths. State layer/prompt as in `8dc3102`.

| task | steps | LLM/tool | in | fresh | cache | hit | out (vis + rea) | peak chars | stop | ₽ | reward |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|---|--:|--:|
| `fix-code-vulnerability` | 20 | 20/20 | 89,667 | 30,019 | 59,648 | 67% | 3,240 (1,998 + 1,242) | 19,027 | `request_addressed` | **0.769** | **1** |
| `fix-git` | 20 | 20/24 | 84,542 | 33,726 | 50,816 | 60% | 3,285 (2,378 + 907) | 21,627 | `request_addressed` | **0.833** | **1** |
| `custom-memory-heap-crash` | 60 | 60/70 | 504,734 | 94,878 | 409,856 | 81% | 18,968 (6,892 + 12,076) | 69,266 | **`max_turns`** | **3.114** | **1** |

`fix-code`/`fix-git` are clean self-closures. `custom-memory` is `reward=1` by the verifier but
did **not** close itself: 60 steps, the last step is `move`, not `stop`. No provider retries in
these three.

**Against the pre-rootless `05-04` breadth batch:**

- `fix-code`: **20 vs 25** steps, **0.769 vs 0.942₽** (−18%), in **89,667 vs 131,597** (−32%).
- `fix-git`: **20 vs 19**, **0.833 vs 0.847₽** (−2%), in **84,542 vs 90,466** (−7%).
- `custom-memory`: **60 vs 60**, **3.114 vs 3.822₽** (−19%), in **504,734 vs 525,154** (−4%);
  but that run was `request_addressed`, this one is **`max_turns`** — better cost, worse
  closure. Do not rank it with the closed runs.

Traces: `bench/runs/sandbox-tasks/2026-10-23T17-15-08-536Z-fix-code-vulnerability-ztbKKL`,
`…17-15-08-508Z-fix-git-oYsqqe`, `…17-15-08-496Z-custom-memory-heap-crash-gUHPBo`.

## Batch 2026-10-23 — recovery (Research → Recovery), net off, K=1 per task

`npx tsx tests/sandbox/sandbox-run.ts <task> --net off --turns 40`, three tasks in parallel,
one run each, official verifier. Current tree on `63563cb` + uncommitted D: rootless,
`grep`/`listFiles` return workspace-relative paths. State layer/prompt as in `8dc3102`.
All three are Recovery-class: `O → Research → Recovery → End`, no Localization/Verification.

| task | steps | LLM/tool | in | fresh | cache | hit | out (vis + rea) | peak chars | route | ₽ | reward |
|---|--:|--:|--:|--:|--:|--:|--:|--:|---|---|--:|--:|
| `password-recovery` | 26 | 26/30 | 274,211 | 64,419 | 209,792 | 77% | 19,208 (6,337 + 12,871) | 66,760 | O → R → Recovery → End | **2.531** | **1** |
| `db-wal-recovery` | 22 | 22/25 | 133,968 | 39,888 | 94,080 | 70% | 7,924 (3,941 + 3,983) | 27,829 | O → R → Recovery → End | **1.278** | **1** |
| `crack-7z-hash` | 23 | 23/29 | 150,852 | 35,780 | 115,072 | 76% | 4,344 (2,653 + 1,691) | 28,365 | O → R → Recovery → End | **0.965** | **1** |

All `request_addressed`, `reward=1`; every tape contains `Start state Research` and
`Start state Recovery`; no provider retries.

**Against the 2026-10-18 recovery batch** (5×40 averages, different prompt/harness — an
indication, not statistics):

- `password-recovery`: 26 steps vs 34.2, in 274,211 vs 234.1k, out 19,208 vs 11.5k,
  **2.531 vs 1.590₽** — more expensive because of 12.9k reasoning; fewer steps.
- `db-wal-recovery`: 22 vs 28.4, in 133,968 vs 143.1k, out 7,924 vs 9.0k,
  **1.278 vs 1.160₽** — close.
- `crack-7z-hash`: 23 vs 30.7, in 150,852 vs 159.5k, out 4,344 vs 5.4k,
  **0.965 vs 0.925₽** — close.

Traces: `bench/runs/sandbox-tasks/2026-10-23T17-24-05-064Z-password-recovery-JqJ0AD`,
`…17-24-05-074Z-db-wal-recovery-4eqN0L`, `…17-24-05-071Z-crack-7z-hash-L9Gpoj`.

## Batch 2026-10-18 — generalized states, checkpoint/revert, terminal-bench breadth

> These are **not top-10 rows** (the leaderboard is `fix-ocaml-gc`): a summary of the other
> ported tasks and of the sandbox infrastructure. All runs use `tests/sandbox` (Docker, no
> Harbor), the same model, and a 40-step budget unless noted. Skein "steps" are LLM turns.

**Prompt/projection.** The four states are generalized without new islands: Orientation — "map
the material and how success is judged"; Localization — "find the target in the material";
Patch — "make the change the goal names"; Verification — "check the change against the goal's
acceptance". The `Start state` / `Finish state` markers are `system`, and closure reads
`Finish … — your stop reason: …`. Added: the provenance/honesty rule ("do not synthesize values;
a check that only reads your own output is not acceptance"), the state-specific
`bash`/`webfetch`/write contract (`toolDescriptionsFor`), the preserve invariant ("copy raw
artifacts before any command that may checkpoint, delete, or rewrite them"), and the default
`Verification → Patch` rule in `transitionInstruction`.

**Harness: workspace checkpoint.** A read-only snapshot of the task root at
`<root>/.skein/checkpoints`: content-addressed blobs plus hardlinked trees `trees/<n>/` (initial
after `setup`, then per turn), with `restore.sh`/`README`; mounted read-only into the container
(docker `-v :ro`, bwrap `--ro-bind`). Files the host cannot read (a root-owned
`john/run/john.log`) are **skipped best-effort**: otherwise the snapshot threw and the run ended
as `llm_error` — that produced the false 0/5 on crack in the first batch. Reverting the last
Patch now restores **only the paths it mutated** (bash/write/apply_patch/deletions) from the
pre-patch checkpoint; `reconcile` records one `mutate absent` for a vanished witnessed file.

**Results (5×40, reward):**

| task | reward | steps (range) | in (fresh + cache, hit) | out (vis + rea) | ₽/run | ₽ total |
|---|---:|---:|---:|---:|---:|---:|
| `db-wal-recovery` | 5/5 | 28.4 (23–38) | 143.1k (26.5k + 116.5k, 81%) | 9.0k (4.1k + 4.9k) | 1.160 | 5.801 |
| `log-summary-date-ranges` | 5/5 | 18.6 (18–19) | 76.2k (18.7k + 57.5k, 76%) | 4.5k (2.9k + 1.6k) | 0.675 | 3.377 |
| `cobol-modernization` | 5/5 | 32.4 (29–40) | 236.7k (46.9k + 189.8k, 80%) | 17.6k (6.6k + 11.1k) | 2.175 | 10.875 |
| `fix-code-vulnerability` | 5/5 | 21.4 (20–23) | 103.9k (21.4k + 82.5k, 79%) | 3.4k (2.5k + 0.9k) | 0.655 | 3.277 |
| `password-recovery` | 5/5 | 34.2 (25–40) | 234.1k (38.5k + 195.5k, 84%) | 11.5k (4.4k + 7.2k) | 1.590 | 7.948 |
| `crack-7z-hash` | 3/3* | 30.7 (28–32) | 159.5k (27.4k + 132.2k, 83%) | 5.4k (3.2k + 2.2k) | 0.925 | 2.774 |

\* crack: 3 runs completed **after the checkpoint fix**; 2 of 5 were killed by an abort. The
first batch (before the fix) was 0/5 `llm_error` — a harness bug, not a task failure. A clean
5/5 still needs another run.

**db-wal: two batches.** Checkpoint-only (before the revert integration): 5/5, **3.83₽**, 117
steps, 453.2k in (103.6k fresh + 349.6k cache, 77%), 25.7k out (14.8k + 11.0k). Checkpoint +
revert: 5/5, **5.80₽**, 142 steps, 715.4k in (132.7k + 582.7k, 81%), 44.8k out (20.5k + 24.3k).
The increase comes from two recovery runs (30 and 38 steps): in one `sqlite3` deleted the WAL and
the model restored it from `trees/1`; in the other a bash-XOR Patch failed Verification and the
checkpoint revert restored the pre-patch WAL. The three quick runs match checkpoint-only:
4.10k in/turn, 98 reason/turn, 0.0335₽/turn.

**opencode in our sandbox (local only; Harbor excluded).** opencode's cost comes from
`reasoning.ndjson` (`usage.cost`, same provider/model); one fix-ocaml run has no captured cost
and is estimated with the same rates (15₽/1M fresh, 0.41₽/1M cache, 83₽/1M output — within
0.03₽ of the reported cost).

| task | agent | reward | steps | in (fresh + cache, hit) | out (vis + rea) | ₽/run |
|---|---|---:|---:|---:|---:|---:|
| `password-recovery` | Skein (5) | 5/5 | 34.2 | 234.1k (38.5k + 195.5k, 84%) | 11.5k (4.4k + 7.2k) | 1.590 |
| `password-recovery` | opencode (5) | 5/5 | 13.2 | 276.6k (24.8k + 251.8k, 91%) | 6.3k (2.0k + 4.3k) | 0.992 |
| `fix-ocaml-gc` net on | Skein (5) | 4/5 | 37.8 | 272.1k (56.9k + 215.1k, 79%) | 15.8k (4.3k + 11.6k) | 2.235 |
| `fix-ocaml-gc` net on | opencode (3) | 3/3 | 30.7 | 943.6k (30.9k + 912.7k, 97%) | 11.5k (3.4k + 8.1k) | ~1.79 |

opencode is more step- and cost-efficient (`password` −38%, `fix-ocaml` −20%) but carries far
more cached context; Skein is cheaper **per step** but takes more steps. There are no local
opencode runs for `cobol`/`fix-code`/`log-summary`/`crack`/`db-wal`; Harbor is excluded by the
owner's instruction, so a separate local batch is needed for a fair comparison.

**What the old failures showed.** `log-summary` (`06-26-26-152`) closed in 6 steps: the old
orientation→finish, "only move" at the transition, and an artifact declared done without being
observed. The current prompt gave 5/5 (18–19 steps). `fix-code` false pass (`06-23-57`):
`pytest` passed while `report.jsonl` was missing; the old closed-state projection elided the
failed read. `cobol` 2/5 → 5/5, `fix-code` 3/5 → 5/5, `password` 4/5 → 5/5 after generalizing
the states and raising the budget to 40.

**Run dirs.** db-wal checkpoint-only: `2026-10-18T12-19-*`; db-wal checkpoint+revert:
`2026-10-18T12-35-*`; log-summary: `12-56-*`; cobol: `13-06-*`/`13-08-*`/`13-09-*`; fix-code:
`13-09-37`, `13-10-*`; password: `09-*`; crack: `13-14-51`, `13-15-04`, `13-15-42`; opencode
password: `06-54-*`; opencode fix-ocaml: `2026-10-09T16-01`, `2026-10-11T06-05`, `06-30`.

**Checks.** `npm run typecheck` is green; offline
`SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` — **346 passed**.

## Final batch (2026-10-17) — literal why, failed-attempt block, Verification→Patch

`fix-ocaml-gc --net on`, 5 parallel runs. **5/5 `reward=1`**, `request_addressed`, 0 refusals,
no `max_turns` and no final transport `llm_error`. This is the best net-on batch so far:
29–50 steps, **1.031–2.521₽**; all five runs are cheaper than the old net-on #4 (2.645₽).

| run | steps | calls | in | fresh | cache | hit | out (vis + rea) | reason/out | ₽ | run dir |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|---|
| run1 `23-095` | 31 | 31 | 168,981 | 40,469 | 128,512 | 76.1% | 9,662 (3,358 + 6,304) | 65.2% | 1.465 | `2026-10-17T18-13-23-095Z-fix-ocaml-gc` |
| run2 `24-334` | 31 | 32 | 196,317 | 37,472 | 158,845 | 80.9% | 7,441 (3,940 + 3,501) | 47.1% | 1.263 | `2026-10-17T18-13-24-334Z-fix-ocaml-gc` |
| run3 `25-612` | 29 | 29 | 169,773 | 32,176 | 137,597 | 81.0% | 5,703 (3,009 + 2,694) | 47.2% | 1.036 | `2026-10-17T18-13-25-612Z-fix-ocaml-gc` |
| run4 `26-682` | 32 | 32 | 165,380 | 35,207 | 130,173 | 78.7% | 4,914 (3,147 + 1,767) | 36.0% | 1.031 | `2026-10-17T18-13-26-682Z-fix-ocaml-gc` |
| run5 `27-653` | 50 | 50 | 299,093 | 57,304 | 241,789 | 80.8% | 19,605 (5,409 + 14,196) | 72.4% | 2.521 | `2026-10-17T18-13-27-653Z-fix-ocaml-gc` |
| **total** | **173** | **174** | **999,544** | **202,628** | **796,916** | **79.7%** | **47,325 (18,863 + 28,462)** | **60.1%** | **7.315** | — |

Averages: 5,778 input/turn, 274 output/turn, 165 reasoning/turn, 0.0423₽/turn, 1.463₽/run.
Context peak — 58,331 chars (run1). run5 — 34.5% of the cost and 49.9% of all reasoning.

**What changed.**

- **Verification `stop.why` is a literal retelling.** The command, exit status and actual error
  text; no code diagnosis and no "why the fix did not work". The model no longer writes "the
  applied patch is wrong" in place of the error.
- **`Previous failed attempt` in Localization and Patch** now uses the **model's `why`** from the
  failed Verification and the actual diff of the last Patch; the mechanical
  `lastFailingRun`/`git`/exit no longer leaks into the block. It says `has been reverted` and
  `Do not repeat this change`.
- **`Verification → Patch`** is a new edge: when the Localization coordinates still hold and only
  the change failed, the model may go straight back to Patch. `isFailedVerificationMove` reverts
  the failed Patch on both targets (`Patch`/`Localization`). run5 used it
  (`verification → patch → verification`, 1 revert, 50 steps); runs 1–4 were direct.
- **Per-state `Island.hint` + shared closure tail:** Orientation — `pwd`/build/check; Localization
  — sibling walkers; Patch — "only the named change, do not repeat the failed attempt";
  Verification — pass/fail/environment; Finish — `stop`. `turnInstruction` no longer mixes states.
- **Model layer — AI SDK:** `createOpenAICompatible`, `generateText`/`streamText`, reasoning/usage
  from the SDK; the LangChain adapter and SSE parser are gone, `@langchain/openai` removed.
  `SKEIN_STREAMING` (default on) chooses `streamText`; reasoning on the tape remains
  `SKEIN_REASONING_TAPE`.
- Tests: **336 passed** offline; typecheck clean. Plan/status — `docs/plans/ai_sdk_migration_plan.md`.

**Stage probe of the edge.** In two separate stage samples of sample1 (`624–627`) and then in
five more, the model chose Localization (2/2 and 5/5) despite the edge: at Verification it sees
the literal error and the closed Patch, but not the failed diff. In the full run5 the edge did
fire. One batch is not a statistic; the important part is that Localization closes after the
failure and Patch with the block applies the right tail.

Logs: `/tmp/opencode/fix-ocaml-final/run{1..5}.log`.

## Previous version (2026-10-17) — reasoning on the tape (A/B)

`fix-ocaml-gc --net off` (†), reward **1**, `request_addressed`, 0 refusals. The doxa now sees
**its own previous reasoning** on the tape — like opencode (Vercel AI SDK) / OpenAI Agents SDK.

**What was built.** A provider adapter (`src/llm/provider.ts`) round-trips `reasoning_content`
(RouterAI returns `reasoning`, which LangChain drops), the engine journals a turn's reasoning on
its action nodes (`payload.reasoning`), the projection shows it on the turn's assistant message;
the feature is **on** by default, `SKEIN_REASONING_TAPE=false` is an A/B switch.

**Runs (net off, †, all reward 1):**

| run | steps | calls | in | out (vis + rea) | cache | ₽ | Localization closed |
|---|--:|--:|--:|--:|--:|--:|--:|
| **runB** `05-16-41-582` (★) | **27** | 34 | **159,475** | 10,681 (2,901 + 7,780) | 72% | **1.60** | t11 |
| run1 `04-57-57-012` | 34 | 44 | 173,000 | 14,923 (3,296 + 11,627) | 71% | 2.00 | t14 |
| runA `05-16-41-598` | 32 | 40 | 222,135 | 14,603 (3,274 + 11,329) | 75% | 2.09 | t14 |

**Against opencode-off (†, `2026-10-11T06-52`):** input **159–222k vs 748,329** — **3.4–4.7×** smaller at the
same reward. This is structural: Skein's tape is a projection of the IR (closed states elided,
observations bounded), whereas opencode re-sends the whole transcript and its reasoning verbatim.
The state enter/exit overhead (5 `move` + 5 `stop` = 10 of runB's 34 calls) is the protocol's
price; it pays for itself because each state keeps its own cheap, drift-free tape.

**A/B (reasoning on/off; same code and harness, only `SKEIN_REASONING_TAPE` changes):**

| | Localization closed (t) | Localization reasoning | Run reasoning | fresh input | ₽ |
|---|---|---|---|---|---|
| **ON** (K=4) | 14, 15, 14, 11 | ~6.5k (median) | ~10.2k | ~49k | ~1.9 |
| **OFF** (K=3) | 14, 11, 14 | ~11.4k (median) | ~25.7k | ~49k | ~3.1 |

**Conclusion.** Reasoning on the tape does **not** move when Localization closes (median turns =
11 in both): the original hypothesis — "late closure because the model cannot see its own
conclusion" — **was not confirmed**; the old baseline n=30 was a harness artifact (the removed replay harness
(`bench/step.ts`) vs the full engine loop). But the feature yields **~2.5× less reasoning and ~40% lower cost**: the
added context almost all lands in `cacheRead` (fresh input equal at ~49k), while reasoning tokens
(output, the expensive tier) drop. So it is kept as the **default**.

## Streaming transport (A/B), 2026-10-17

`fix-ocaml-gc --net off` (†), K=3 per arm; one factor changes — `SKEIN_STREAMING` (on:
`model.stream()` + chunk concatenation; off: the previous non-streaming `invoke`). The prompt and
projection are the same (reasoning on the tape is on).

| arm | reward | turns | ₽ | fresh input | reason |
|---|---|---|---|---|---|
| **ON** | 1, 1, **0** | 29, 31, **60** | 2.13, 1.92, 5.23 | 55.6k, 49.6k, 126.3k | 12.2k, 11.0k, 32.1k |
| **OFF** | 1, 1, 1 | 32, 45, 30 | 1.98, 3.25, 1.62 | 53.1k, 72.3k, 46.7k | 10.0k, 20.3k, 7.4k |

**Mechanics.** Reasoning arrives as deltas (`delta.reasoning`) and is renamed by the adapter
(`fromChunk`); it is back on the tape (`payload.reasoning`, 56 records per run, `reasoning.ndjson`
written). No `llm_error`; usage/cost come from the terminal chunk; the
`finish_reason:"length"` retry fires (the ON failure: t58 `reason=8192` = the cap, then the brevity
retry). No idle timeout was observed.

**Verdict.** The transport works and is not worse by cost on successful runs; ON 2/3 vs OFF 3/3 is
within noise (the single ON failure is a wrong patch → a verification→localization cycle, the same
flakiness class as before; n is small). Kept **on by default**, `SKEIN_STREAMING=false` is the
fallback/A-B arm.

Runs: ON `2026-10-17T08-04-06-897Z`, `08-19-58-026Z`, `08-29-13-482Z`; OFF `08-10-30-333Z`,
`08-38-55-578Z`, `08-49-29-101Z`.

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

## 2026-10-24 — network modes, `test.sh` acceptance, network probe, Construction A/B

**Harness.** A Docker task is now accepted by the task's own `tests/test.sh` in the agent's
container after it; the reward comes from `/logs/verifier/reward.txt`, not the exit code.
`--net` controls the agent only: `on` = bridge, `off` = detached; the verifier always has
network because `test.sh` installs its own runtime (`uv`/Python). `checkIn`/
`SKEIN_VERIFIER_IMAGE` left the task path. The probe now carries an engine-owned
`network: on|off`, rendered in the environment brief.

**`regex-log`, old prompt + probe, K=3.** All reward=1.

| mode | turns (median) | ₽ median | reasoning median |
|---|---:|---:|---:|
| net off | **13** (13/13/13) | **1.842** | 17,362 |
| net on | 16 (18/13/16) | **1.599** | 10,641 |

**opencode in the same sandbox, `test.sh`.** net on — 15 steps / ~1.61₽; net off — 17 steps /
~1.62₽ (cost estimated from the provider rates). The image has no Python; with network on
opencode still does not install it and uses Perl.

**Construction A/B — negative.** The new prompt (declared engine, do not weaken) gave off
median 17 / 1.906₽, on 15 / 1.762₽ versus old+probe 13 / 1.842₽ and 16 / 1.599₽. The
`Orientation → Construction` edge gave off 17 / 2.022₽, on 13 / 2.025₽. Both reverted. The
cheap `bench/turn.ts --rebuild` check showed the transition choice is correct (`regex-log` 9/9
Construction, `cobol` 3/3 Research, `openssl` 3/3 Construction), but Research is structurally
useful: without it the reasoning moves into Construction and the cost rises.

Run dirs: `bench/runs/sandbox-tasks/2026-10-24T07-00-47-*` (old off),
`…07-11-47-*` (old on), `…06-21-55-*` / `…06-50-22-*` (prompt A/B),
`…07-08-30-*` / `…07-51-06-*` / `…07-54-46-*` (edge A/B),
`…05-41-47-*` / `…05-44-35-*` (opencode on/off).

## Next

- **2026-10-18:** checkpoint/revert and the generalized states gave 5/5 on
  db-wal/log-summary/cobol/fix-code/password; crack is 3/3 (a clean 5/5 is still needed). Local
  opencode runs exist only for password and fix-ocaml; the other tasks do not yet have a local
  comparison series.
- Add other agents/tasks as they are run (`sandbox-tasks/`), keeping the top-10 by the rule
  above.
- The `net off` pair (Skein and opencode, marker †) is **done**; the honest 2×2 is above.
  Implemented: `sandbox-run.ts --net off` (host `fetch`/background `run` via the allowlist proxy).
- The offline-reasoning gap is **closed**: the net-off evolution ~5.9× (goal-based) → ~3.0×
  (goal-into-move) → **~0.8×** (2026-10-17, reasoning on the tape: Skein ~10.2k vs opencode-off
  13,114). The remaining **input** gap now favours Skein thanks to the projection (159–222k vs
  748,329).
