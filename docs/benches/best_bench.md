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
| 1 | 2026-10-09 | opencode 1.18.35 | `fix-ocaml-gc` | **net off** | **1** | 27 | 41 | 1,213,834 | 21,987 (3,398 + 18,589) | 96% | 322s | `bench/runs/sandbox-tasks/2026-10-09T15-51-47-367Z-fix-ocaml-gc-opencode-off` |
| 2 | 2026-10-09 | opencode 1.18.35 | `fix-ocaml-gc` | **net on** ‡ | **1** | 33 | 32 | 698,460 | 11,993 (3,245 + 8,748) | 97% | 434s | `bench/runs/sandbox-tasks/2026-10-09T16-01-20-117Z-fix-ocaml-gc-opencode-on` |
| 3 | 2026-10-11 | opencode 1.18.35 | `fix-ocaml-gc` | **net on** † | **1** | 33 | 36 | 1,430,864 | 11,399 (4,011 + 7,388) | 97% | 314s | `bench/runs/sandbox-tasks/2026-10-11T06-30-03-965Z-fix-ocaml-gc-opencode-on` |
| 4 | 2026-10-11 | opencode 1.18.35 | `fix-ocaml-gc` | **net off** † | **1** | 24 | 31 | 748,329 | 15,834 (2,720 + 13,114) | 96% | 279s | `bench/runs/sandbox-tasks/2026-10-11T06-52-33-197Z-fix-ocaml-gc-opencode-off` |
| 5 | 2026-10-11 | Skein | `fix-ocaml-gc` | **net on** | **1** | 35 | 35 | 908,678 | 57,946 (2,947 + 54,999) | 91% | — | `bench/runs/sandbox-tasks/2026-10-11T05-13-47-307Z-fix-ocaml-gc` |
| 6 | 2026-10-10 | Skein | `fix-ocaml-gc` | **net on** | **1** | 41 | 41 | 2,139,649 | 94,123 (4,568 + 89,555) | 91% | — | `bench/runs/sandbox-tasks/2026-10-10T18-30-49-240Z-fix-ocaml-gc` |
| 7 | 2026-10-10 | Skein | `fix-ocaml-gc` | **net on** | **1** | 50 | 50 | 1,076,441 | 108,811 (4,307 + 104,504) | 93% | — | `bench/runs/sandbox-tasks/2026-10-10T08-40-34-457Z-fix-ocaml-gc` |
| 8 | 2026-10-11 | Skein | `fix-ocaml-gc` | **net off** † | **1** | 31 | 31 | 702,484 | 80,872 (2,930 + 77,942) | 92% | — | `bench/runs/sandbox-tasks/2026-10-11T07-02-41-446Z-fix-ocaml-gc` |
| 9 | 2026-10-11 | Skein | `fix-ocaml-gc` | **net off** † — **current, best net off** | **1** | 32 | 32 | 560,230 | 61,389 (2,838 + 58,551) | 93% | — | `bench/runs/sandbox-tasks/2026-10-11T10-38-01-061Z-fix-ocaml-gc` |
| 10 | 2026-10-11 | Skein | `fix-ocaml-gc` | **net on** † — **current** | **1** | 40 | 40 | 922,297 | 65,495 (3,057 + 62,438) | 93% | — | `bench/runs/sandbox-tasks/2026-10-11T10-25-39-226Z-fix-ocaml-gc` |

**Condition notes.** † — a run **after the oracle was removed**: the task verifier (including
Harbor's `tests/test.sh`, which names the broken tag `tag_purposefully_broken_sweeping_changes`)
is no longer staged into the agent's workspace — it is added only after the agent, before the
check (`tests/sandbox/harness.ts`, `stageVerifier`). ‡ — a **leaked** run: the leaked `test.sh`
lay in the workspace and opencode read the benchmark author's repo and tag from it.

**The honest 2×2 (all reward=1, oracle removed).** Only network access changes across a row,
only the agent across a column.

| | opencode | Skein |
|---|---|---|
| **net on** | 7,388 reasoning / 1,430,864 in / 33 steps (#3) | 54,999 / 908,678 / 35 (#5) |
| **net off** | 13,114 / 748,329 / 24 (#4) | 58,551 / 560,230 / 32 (#9) |

Removing the network slightly raised reasoning for both (opencode 7,388→13,114, Skein
54,999→58,551), but the gap persists: **offline, opencode 13,114 vs Skein 58,551 (≈4.5×)**. So
Skein's cost does not reduce to oracle access.

## Baseline (reference point, 2026-10-11)

Two fresh runs on the current working tree — the reference point for subsequent changes (rows
**#9** net off and **#10** net on in the leaderboard). State
at recording: the `list`↔`glob` rename was **reverted** (`list { path?, include?, from? }`); in
place are the native tool surface, `bash workdir`/`timeout`, the seed-action `call` fix (no
`human OBSERVATION`) and the crash rendering. Both reward 1, one `edit`, the same one-line fix
`p += Whsize_hd(hd);` → `p += wh;`, clean `stop = request_addressed`.

| condition | steps | tool calls | in | out (vis + rea) | cache | cap-hits (retries) | cost | run dir |
|---|---|---|---|---|---|---|---|---|
| **net on** | 40 | 40 | 922,297 | 65,495 (3,057 + 62,438) | 93% | 25, 29, 30 (3) | 12.06₽ | `bench/runs/sandbox-tasks/2026-10-11T10-25-39-226Z-fix-ocaml-gc` |
| **net off** | 32 | 32 | 560,230 | 61,389 (2,838 + 58,551) | 93% | 21 (1) | 10.43₽ | `bench/runs/sandbox-tasks/2026-10-11T10-38-01-061Z-fix-ocaml-gc` |

For contrast, the same day's **reward-0 runs** (kept for the record, not in the top-10):
`2026-10-11T09-18-55` (60 turns, 142,270 rea, 25.46₽) and `2026-10-11T10-04-08`
(the `glob` rename experiment: 60 turns, 154,361 rea, 27.16₽ — `glob` never called).

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

- **net on (#5, `05-13`).** 35 steps, 35 tool calls (all accepted), a clean
  `stop = request_addressed`; 4.85₽ — the best Skein run. The first run after the native-role
  and deduplication fixes: the alternative marker no longer re-inlines a failure body, and for
  native nodes there is no marker at all. Context peak fell from 352k to 94,450 chars (−73%),
  fresh input to 79,494 (−59%), reasoning to 54,999 (−39%), cost by half. Same one-line edit in
  `pool_sweep` (`p += Whsize_hd(hd);` → `p += wh;`); the verifier passed. Per-turn reasoning is
  in `reasoning.ndjson`.
- **net on (#6, `18-30`).** 41 steps, 41 tool calls (all accepted). The trimmed prompt — no
  `sketch`/`why`, plus a short-reasoning / no-recall-code rule in B13 — cut reasoning to 89,555
  (from 104,504 below) and closed cleanly (`stop = request_addressed`); 12.68₽. Same one-line
  edit in `pool_sweep` (`p += Whsize_hd(hd);` → `p += wh;`); verifier passed. It still fetched
  the upstream twice (the diff-seeking persists) and the context grew to 352k chars (peak); one
  completion-cap turn recovered via the reasoning-off retry. Per-turn reasoning is in
  `reasoning.ndjson`.
- **net on (#7, `08-40`).** 50 steps, 50 tool calls (48 ok / 2 refused). The first reward-1 run
  on the revised IR. It localized by reading (`read`/`grep` over `runtime/shared_heap.c`),
  fetched the upstream `shared_heap.c`, diffed it, and made the same edit; it ended on
  `llm_error` (a model failure), not a self-`stop` — the work was already done. Wall time was
  not recorded.
- **net off, † (#8).** The honest "no oracle and no network": the host `fetch`/background `run`
  go through an allowlist proxy (github → 403; `fetch` was called 2× and failed). 31 steps, 31
  tool calls (all accepted), a clean `stop = request_addressed`; 13.78₽. Reasoning rose to
  **77,942** (in 702,484, fresh 55,060, cache 92%; context peak 78,572) — higher than with the
  network (#5): without an oracle Skein has to derive the line by hand. Same one-line edit
  `p += Whsize_hd(hd);` → `p += wh;`.

## Next

- Add other agents/tasks as they are run (`sandbox-tasks/`), keeping the top-10 by the rule
  above.
- The `net off` pair (Skein and opencode, marker †) is **done**; the honest 2×2 is above.
  Implemented: `sandbox-run.ts --net off` (host `fetch`/background `run` via the allowlist proxy).
- Next: work out **why** Skein spends ~6× the reasoning on the same task with no oracle, and add
  other agents/tasks.
