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
| 2 | 2026-10-09 | opencode 1.18.35 | `fix-ocaml-gc` | **net on** | **1** | 33 | 32 | 698,460 | 11,993 (3,245 + 8,748) | 97% | 434s | `bench/runs/sandbox-tasks/2026-10-09T16-01-20-117Z-fix-ocaml-gc-opencode-on` |
| 3 | 2026-10-10 | Skein | `fix-ocaml-gc` | **net on** | **1** | 41 | 41 | 2,139,649 | 94,123 (4,568 + 89,555) | 91% | — | `bench/runs/sandbox-tasks/2026-10-10T18-30-49-240Z-fix-ocaml-gc` |
| 4 | 2026-10-10 | Skein | `fix-ocaml-gc` | **net on** | **1** | 50 | 50 | 1,076,441 | 108,811 (4,307 + 104,504) | 93% | — | `bench/runs/sandbox-tasks/2026-10-10T08-40-34-457Z-fix-ocaml-gc` |

## opencode on `fix-ocaml-gc` (our sandbox)

Both runs: `tests/sandbox/opencode-run.ts` (Docker, **no Harbor**) runs opencode inside the
task image `alexgshaw/fix-ocaml-gc:20251031`; the task's own verifier scores the result
(`check.code = 0`, `PASS test_tests_output`). Model
`routerai/~deepseek/deepseek-v4-flash-latest`, `--variant low`.

- **net off (#1).** `--network bridge` + `HTTP(S)_PROXY` pointing at a host allowlist proxy
  that only permits `routerai.ru` (github 403). Localized by reading, no upstream copy:
  27 steps, 41 tool calls (`bash 27, read 12, grep 1, edit 1`). One edit; reward 1.
- **net on (#2).** Plain `--network bridge`: opencode clones `github.com/sadiqj/ocaml` and
  uses git history to find the breaking commit, then edits. 33 steps, 32 tool calls
  (`bash 31, edit 1`). Cheaper on tokens (the clone replaces the read-heavy localization),
  but slower and only possible with network.

Neither is a Skein row — this is the opencode baseline on the same task/sandbox. Recorded per
the owner's request.

## Skein on `fix-ocaml-gc` (our sandbox)

`npx tsx tests/sandbox/sandbox-run.ts fix-ocaml-gc` (Docker, **no Harbor**) runs the agent
inside the task image; the task's own verifier scores the result (`check.code = 0`,
`PASS test_tests_output`). Model `routerai/~deepseek/deepseek-v4-flash-latest`,
`SKEIN_REASONING_EFFORT=low`, task budget 60 turns.

- **net on (#3, `18-30`).** 41 steps, 41 tool calls (all accepted). The trimmed prompt — no
  `sketch`/`why`, plus a short-reasoning / no-recall-code rule in B13 — cut reasoning to 89,555
  (from 104,504 below) and closed cleanly (`stop = request_addressed`); 12.68₽. Same one-line
  edit in `pool_sweep` (`p += Whsize_hd(hd);` → `p += wh;`); verifier passed. It still fetched
  the upstream twice (the diff-seeking persists) and the context grew to 352k chars (peak); one
  completion-cap turn recovered via the reasoning-off retry. Per-turn reasoning is in
  `reasoning.ndjson`.
- **net on (#4, `08-40`).** 50 steps, 50 tool calls (48 ok / 2 refused). The first reward-1 run
  on the revised IR. It localized by reading (`read`/`grep` over `runtime/shared_heap.c`),
  fetched the upstream `shared_heap.c`, diffed it, and made the same edit; it ended on
  `llm_error` (a model failure), not a self-`stop` — the work was already done. Wall time was
  not recorded.

## Next

- Add other agents/tasks as they are run (`sandbox-tasks/`), keeping the top-10 by the rule
  above.
