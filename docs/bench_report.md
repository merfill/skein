# Skein — experiment report (bench and Harbor)

> Russian mirror — `docs/bench_report_ru.md`. This is a working measurement report,
> not a specification. Harness code lives in `bench/` and `langgraph/`.

## 1. Why

Tier 1 (the work graph, path relevance, the check node) is implemented but its value
was never measured. The goal was to get the first real numbers: does the context
grow, how many tokens/cache and LLM calls are spent, what is the trajectory, and does
the model actually use the work graph. The results should drive what to fix next.

## 2. Harness

- **`bench/run.ts`** — `skein-plugin` synthetic cases (short tasks): copies the case
  repo, runs `runAgent` live, runs `check.sh`, computes the behavioural `detectLoops`
  metric (imported from the plugin, a single yardstick).
- **`langgraph/graph.ts` + `langgraph.json`** — a Skein adapter for Harbor's built-in
  `langgraph` agent: Harbor installs Node and the project dependencies, runs the graph
  in the task workspace (`/app`) and collects usage via callbacks.
- **`bench/harbor/*`** — config (template + generator + `run.sh`); jobs live outside
  the repository (`~/.skein-bench/harbor`) so the langgraph agent does not stage
  itself recursively.

## 3. Metrics

Per LLM call: `contextChars` (projection size), `input/output tokens`,
`cacheRead`/`cache%`, the number of real calls, `action`, elapsed. Aggregates:
context first/last/peak/growth, tokens, cache, cost, the behavioural
`loopScore`/`rereads`, and work-graph counts (claims/decisions/subgoals/checks).

## 4. Results

### 4.1 Synthetic (short tasks)

`hidden-hypotheses`: reward 1, 9 steps, `loop=25%`, graph: 1 claim, 0 decisions,
0 subgoals. The "repeat" is the test run twice (before/after the fix) — a re-verify,
not a loop; the baseline simply did not re-run the test.

`moving-target`: reward 1, 7 LLM calls, `loop=0`, context 1045 → 2983 chars (peak
3526, growth +1938), input 17 782 / output 600, `cacheRead` 11 648 (66%), graph empty
(0/0/0).

A cache observation, identical across runs: `cacheRead` is **always exactly 1664**
tokens per call — the stable system prefix (system prompt + tool schema). The
projection is never cached: its stable prefix ends at `goal`/`constraints`, then the
volatile `frontier` follows. As a result, the cache share falls as the context grows
(80% → 58%).

### 4.2 Harbor terminal-bench: `fix-ocaml-gc`

Baseline (saved job `2026-09-26__11-50-39`, opencode): **pass**, 36 steps, 41 tools,
peak context 60 208 tokens, input 38 852 / output 4 220, `loop=0`, `rereads=3`,
`track=0`.

Skein, two runs:

- **Run 1** (17:26): crashed on `ENOENT` (see §5) but the verifier rewarded **1** —
  the fix had been applied before the crash. No turn logs (the process died).
- **Run 2** (17:43): clean exit, but **reward 0**. 60 turns, actions: read 17,
  grep 18, run 23, **edit 1**, finish 1. Input 290 564 / output 11 536,
  `cacheRead` 129 792 (44.7%), context 1601 → 11 788 chars (peak 26 281, growth
  +10 187), `checks=23`, **graph empty (0 claims / 0 decisions / 0 subgoals)**, cost
  3.76 ₽.

Bottom line: the agent made one `edit` and then churned through ~58 turns of
read/grep/run without converging, then `finish`ed. Variance is high: the same task
passed in run 1 and failed in run 2.

A repeat after steps 1–6 of the roadmap (job `2026-10-02__09-47-57`, 3 tasks × 2
attempts, langgraph adapter): `fix-ocaml-gc` — **0/2**, both `no_progress`, 0
subgoals / 0 claims / 0 checks, only read/grep/run, no edit; `db-wal-recovery` —
1/2 (a success on `finish`); `custom-memory-heap-crash` — infrastructure error
(Docker build/start timeout 1200 s, not agent behaviour). The reference shape of the
route and the gap analysis — `docs/fix_ocaml_gc_ideal.md`.

**Solved (2026-10-06).** After the engine fixes in `docs/plans/engine_fixes_found.md`
(reasoning on, focus under a closed ancestor, crash diagnostics, projection retention,
4 CPU / 6 GB and a background `run`), `fix-ocaml-gc` passes: two acceptance runs, both
**reward 1.0** (`40 tests passed`) — `2026-10-06__10-57-47` and
`2026-10-06__14-53-22`. Report: `docs/fix_ocaml_gc_run_report_2026-10-06.md`.

### 4.3 Non-degradation gate (baseline)

So that the roadmap steps (`docs/plans/logos_roadmap_plan.md`) do not worsen short
tasks, a deterministic offline gate was introduced:

- `bench/baseline.json` — a frozen reference for the simple set (synthetic) with
  the recorded `reward`, steps, tokens, cost and context peak;
- `bench/compare.ts` — a pure `compareRun(baseline, run)`: `reward` not below the
  reference, and steps/tokens/cost/peak not above the reference ×`tolerance`
  (1.2 by default);
- CLI: `npm run bench:gate -- <runDir|metrics.json>` — reads a run's `metrics.json`,
  prints the deltas and exits with code 1 on a regression.

This is a smoke check, not a statistical test: LLM runs are noisy, so the threshold
is deliberately soft and the reference is extended as runs appear. The long
scenario (`fix-ocaml-gc`) is not part of the gate — it is tracked in §4.2; it now
passes (reward 1.0).

### 4.4 Skein vs opencode (long tasks)

The Tier 1 premise is that the projection gives an advantage on long tasks. To test
it head-on, both agents run under one Harbor job with identical resources and
reasoning (`bench/harbor/compare.template.yaml`):

```
SKEIN_HARBOR_CONFIG=compare.yaml bash bench/harbor/run.sh
npm run bench:compare -- ~/.skein-bench/harbor/2026-10-06__17-31-37
```

Protocol: `terminal-bench` 2.0, three tasks, same model
(`~deepseek/deepseek-v4-flash-latest`), `reasoningEffort: high` for both (Skein via
`configurable.reasoningEffort`; opencode via `--variant high` and the model option),
`override_cpus: 4`, `override_memory_mb: 5120`, `n_concurrent_trials: 5`,
`n_attempts: 3`, `timeout_multiplier: 2.0`. Skein `maxTurns` 60. Job
`2026-10-06__17-31-37`, 18 trials, ~1 h 23 min wall.

`ctx` below is per-LLM-call prompt tokens `min/median/mean/peak` (Skein: `SKEIN_TURN`;
opencode: `trajectory.json` `metrics.prompt_tokens` = input + cache). `tok in/out` is
the mean per trial.

**Overall (9 trials each):**

| agent | solved | LLM calls | tools | tok in/out | ctx (min/med/mean/peak) | cache |
|---|---|---|---|---|---|---|
| Skein (langgraph) | 4/9 | 41 | 30 | 607.8k / 207.8k | 7.2k / 16.2k / 20.0k / 60.1k | 60% |
| opencode | 6/9 | 21 | 26 | 697.9k / 3.0k | 7.4k / 30.7k / 32.9k / 79.7k | 96% |

**Per task:**

| task | Skein | opencode |
|---|---|---|
| `fix-ocaml-gc` | **3/3**, 69 call, med 16.4k, cache 56% | **3/3**, 26 call, med 43.1k, cache 96% |
| `db-wal-recovery` | 1/3 (2 × `AgentTimeoutError`) | **3/3**, cache 96% |
| `custom-memory-heap-crash` | 0/3 (2 × `no_progress`, 1 × exit 1) | 0/3 |

**Reading:**

- **On the task Skein was tuned for, `fix-ocaml-gc`, both agents are at 3/3 — no
  accuracy gain.** The projection does what it promises per call: Skein's median
  context is ~2.6× smaller (16.4k vs 43.1k) and its peak is lower (60.1k vs 79.7k).
  But Skein makes ~2.6× more LLM calls (69 vs 26) and caches far worse (56% vs 96%),
  so total input tokens land in the same place (1.04M vs 1.06M). The economy of the
  projection is spent on the extra calls and the non-cacheable frontier; it buys no
  solved tasks.
- **`db-wal-recovery` favours opencode (3/3 vs 1/3), but not on merit:** both Skein
  misses are 1800 s agent timeouts (`AgentTimeoutError`), i.e. the run is too slow,
  not wrong. The faster, better-cached agent finishes it.
- **`custom-memory-heap-crash` is non-discriminating:** neither agent solves it
  (Skein: two `no_progress` stops and one non-zero exit; opencode: three wrong
  answers).
- Variance is high (n = 3 per cell): the saved opencode baseline
  (`2026-09-26__11-50-39`, k = 1) had `db-wal-recovery` 1/1 and
  `custom-memory-heap-crash` 0/1; here `db-wal-recovery` is 3/3 and
  `custom-memory-heap-crash` 0/3.

**Per-example analysis.**

`fix-ocaml-gc` (both 3/3 — the task Skein was tuned on). Where Skein's calls go:

| attempt | turns | LLM calls | retries | job polls | bookkeeping | real work |
|---|---|---|---|---|---|---|
| `brVESz3` | 52 | 63 | 11 | 17 | 9 (17%) | 43 |
| `fNwUyxJ` | 48 | 63 | 15 | 1 | 20 (41%) | 28 |
| `fa7HV3F` | 57 | 82 | 25 | 1 | 36 (63%) | 21 |

opencode: 24–27 steps, 26–35 tool calls, 7–9 steps batching two tools, ~10k
reasoning tokens (reasoning is on). Three sources of the extra Skein calls:

1. **Background-job polling.** `brVESz3` launched the OCaml build as a background
   `run {background}` and then polled it with `run {job: …}` **17 times**. Each poll
   is a full-context LLM call. opencode runs the build with a blocking `bash`, so
   it pays no polling turns. The strategy is uneven: one attempt polled 17 times,
   the other two once each — but each poll is a wasted call opencode never makes.
2. **Structured-output retries.** `invokeStructured` re-invokes on a completion
   cap or a schema violation (`src/llm/structured.ts`): 11/15/25 extra calls, i.e.
   21–44% of all calls here, each resending the full projection. `db-wal`'s
   successful run had **0** retries, so this is model/context dependent, but on the
   long OCaml runs it is a large tax.
3. **IR bookkeeping.** `create_goal`/`complete`/`query` are 17–63% of turns on
   these runs and have no counterpart in opencode; Skein also does one action per
   turn, while opencode batches two.

What went right: all three attempts reached the fix and stopped with
`request_addressed`, and there was exactly one rejected proposal — the engine fixes
(focus under a closed ancestor, crash diagnostics, background `run`, reasoning) hold
on this task. The cost is efficiency, not correctness: the median context is ~2.6×
smaller but the retries, polls, and bookkeeping re-send it often enough that the
**total input tokens match opencode's (1.04M vs 1.06M)**.

`db-wal-recovery` (opencode 3/3, Skein 1/3). The one Skein success (`4YD4dB5`) was
efficient and clean: 18 turns / 18 calls / 0 retries / `request_addressed`, though
still 10 of 18 turns were bookkeeping. The two misses (`6BJGabb`, `F3YTvbt`) are
**`AgentTimeoutError` at 1800 s**, not wrong answers: both had reached turns 30–38
(38 and 34 proposals) when killed, so their `SKEIN_METRICS` never flushed. opencode
solves it in 7–22 steps, `bash`-only. Diagnosis: Skein is too slow here — the same
retry + bookkeeping + one-action-per-turn overhead, against a 30-minute budget.

`custom-memory-heap-crash` (both 0/3). Skein attempts `FdQ7oRm` and `c2nVLJQ` span
**22–25 `query` calls** (58–64% of turns bookkeeping) and stop on `no_progress`:
the model loops on retrieval instead of acting, and the engine correctly halts it.
The third attempt (`phqyVm8`) **crashed** at turn 26: it read
`/build/patches/locale_init.cc.patch` and the workspace guard threw
`path escapes workspace: /build`, which ended the process (`exit 1`). The task
instruction points into `/build`, outside the workspace, and `list` on the same path
is recorded as a refusal while `read` throws and kills the run — an inconsistency to
fix. opencode (19–34 steps, `bash`/`read`/`write`/`edit`, it runs valgrind and edits
`user.cpp`) does not solve it either, so the task does not discriminate.

**Caveats:** opencode's completion count excludes reasoning tokens (Harbor sums
`tokens.output` only), so its `out` undercounts; input tokens are the comparable
axis. opencode reports cost 0 from this provider, while Skein's cost is computed
locally, so cost is not comparable here. Reasoning level is set by config, not
verifiable from the artifacts.

**Problems found (2026-10-06 comparison) and what to do.** The projection's per-call
economy is real (median context ~2.6× smaller) but is currently spent on overhead.
The concrete defects:

1. **The turn-count comparison is confounded by strategy.** All three opencode runs
   found the bug by downloading the upstream `shared_heap.c` and diffing it
   (`curl`/`diff`/GitHub API; the `edit` is the last tool), while none of the Skein
   runs tried it and localized by hand (`edit` at turns 19/36/51). The raw turns
   compare a shortcut against manual localization, not two architectures. To measure
   the architecture, rerun with the network off (or on tasks with no public
   upstream). The per-turn overhead below is *not* confounded — Skein pays it under
   any strategy.
2. **A background `run` costs one full-context LLM call per poll.** `brVESz3` polled
   the OCaml build 17 times (`run {job}`); opencode's blocking `bash` pays zero. Fix:
   block, or let one turn consume the finished job instead of one poll per turn.
3. **`invokeStructured` retries re-send the whole projection** — 11/15/25 extra calls
   (21–44%) on the OCaml runs, 0 on the clean `db-wal` run. Size the completion
   cap/prompt so the retries drop.
4. **IR bookkeeping is a large share of turns** (`create_goal`/`complete`/`query`,
   17–64%), and only one action is allowed per turn (opencode batches two).
   `custom-memory-heap-crash` looped on `query` (22–25 calls) into `no_progress`.
5. **`read` on a path outside the workspace kills the run.** `phqyVm8` read
   `/build/…` (the task instruction points there); the workspace guard threw
   `path escapes workspace` and the process exited 1. `list` on the same path is a
   recorded refusal — `read` must behave the same.
6. **Speed is a first-class metric.** On `db-wal-recovery` both Skein misses are
   `AgentTimeoutError` (1800 s): slower than budget, not wrong.
7. **The stable-prefix cache stays the biggest structural gap:** 60% vs 96%
   (`implementation_plan.md`, backlog).

## 5. Problems (what broke or hurts)

These are from the early baseline runs (`2026-09-26`, `2026-10-02`); some are fixed
by now — the engine fixes and the current comparison are in §4.2 and §4.4.

1. **The work graph is unused on a long task.** 0 claims, 0 decisions, 0 subgoals.
   The model creates no hypotheses, so refusals, check staleness, and path relevance
   never engage; behaviour degrades to flat read/grep/run.
2. **The witness is the whole workspace — impractical and racy.** `run` hashes
   **every** file in the workspace (twice: before and after the command) to build the
   witness. On a large repo with an active build this is expensive (turns up to 33 s)
   and breaks: a build temporary disappears between listing and reading → `ENOENT`
   crashes the agent (run 1).
3. **Context grows within a run.** Mostly via `recent` (raw tool output:
   tests/builds). Peak 26k chars. Only the system prefix is cached, so context growth
   means a falling cache share.
4. **`loopScore` misleads on short tasks**: a re-run to verify (the same test
   before/after the fix) counts as a "repeat".

## 6. Hypotheses (why)

1. **Primary: the prompt is not tuned to this harness.** `SYSTEM_PROMPT`
   (`src/loop/propose.ts`) is one generic block written before Tier 1 and never
   tuned for real long tasks. It:
   - does not require creating a claim/subgoal **before** a non-trivial action, so the
     graph stays empty and there is no memory of what was already tried;
   - does not describe a working strategy for a long task (where to work, how to
     verify, how to leave a wrong branch);
   - with one action per turn and no claims, the agent re-reads/re-runs the same
     things (17 read / 18 grep / 23 run with almost no progress after a single edit).
   The prompts were deliberately left untouched and unmeasured — this is the first
   thing to fix.
2. **The model treats the agent as an ordinary read/grep/run tool.** No structural
   gate forces the IR, so it stays on the cheap strategy.
3. **The tools are poorer than the baseline's.** Only find/replace `edit` (opencode
   has patches/more tools); `run` counts as a "check" even with no claims (junk
   `check` nodes); the witness is impractical.
4. **`recent` growth** is a direct consequence of (1): unsystematic search fills the
   window with large outputs.

## 7. Next steps (item B)

1. **Rework the prompt for the harness** (priority): describe the tools and a working
   process for long tasks, require recording a claim/subgoal before acting, describe
   how to verify and how to abandon a branch.
2. **Consider an active gate** (as in the plugin): no `edit`/`run` without a recorded
   claim/subgoal. The Tier 1 structural gate (§5) proved insufficient on a long task.
3. **Remove witness brittleness/cost**: do not hash the whole workspace; at least do
   not treat `run` without claims as a check, and do not carry build artifacts.
4. After the changes, re-run `fix-ocaml-gc` and 2–3 more tasks and compare with the
   saved baseline.

Separately deferred: optimizing the projection for a stable prefix/cache
(`docs/plans/implementation_plan.md`, backlog).

## 8. Where the artifacts are

- Synthetic: `bench/runs/<ts>-<case>-skein/` (`metrics.json`, `turns.ndjson`,
  `trajectory.json`, `reward.txt`).
- Harbor: `~/.skein-bench/harbor/<job>/<trial>/` (`agent/langgraph-run.log` with
  `SKEIN_TURN`/`SKEIN_METRICS`, `verifier/reward.txt`, `result.json`).
- Plugin baseline: `skein-plugin/pilot/harbor/jobs/2026-09-26__11-50-39/`.
- Non-degradation gate: `bench/baseline.json`, `bench/compare.ts`, `bench/gate.ts`
  (`npm run bench:gate -- <runDir>`), test `tests/bench_gate.test.ts`.
