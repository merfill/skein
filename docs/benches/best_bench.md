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

## Next

- Add other agents/tasks as they are run (`sandbox-tasks/`), keeping the top-10 by the rule
  above.
