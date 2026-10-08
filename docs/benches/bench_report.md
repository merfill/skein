# Skein — experiment report (bench and Harbor)

> Russian mirror — `docs/benches/bench_report_ru.md`. This is a working measurement report,
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
route and the gap analysis — `docs/benches/fix_ocaml_gc_ideal.md`.

**Solved (2026-10-06).** After the engine fixes in `docs/benches/engine_fixes_found.md`
(reasoning on, focus under a closed ancestor, crash diagnostics, projection retention,
4 CPU / 6 GB and a background `run`), `fix-ocaml-gc` passes: two acceptance runs, both
**reward 1.0** (`40 tests passed`) — `2026-10-06__10-57-47` and
`2026-10-06__14-53-22`. Report: `docs/benches/fix_ocaml_gc_run_report_2026-10-06.md`.

### 4.3 Non-degradation gate (baseline)

So that the roadmap steps (`docs/plans/archive/logos_roadmap_plan.md`) do not worsen short
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

### 4.4.1 Call- and token-level comparison

`npx tsx bench/agents_compare.ts ~/.skein-bench/harbor/2026-10-06__17-31-37`. The parser
was fixed to read opencode's per-call usage from `agent/opencode.txt` (each `step-finish`
carries `tokens.{input,output,reasoning,cache.read}`, each `tool_use` a tool call) —
`trajectory.json` has no reasoning/step breakdown, which is why reasoning read 0 before.

Columns: **llm** = LLM calls (Skein: `SKEIN_TURN` rows; opencode: `step-finish`), **tools**
= tool calls (`SKEIN_METRICS.toolCalls`; opencode: `tool_use` events), **in** = prompt
tokens incl. cache, **out** = total completion (visible + hidden reasoning), **reason** =
hidden reasoning inside `out` (opencode only), **cache** = cacheRead / in, **ctx** =
per-call prompt min/median/mean/peak. Means are over trials that flushed metrics (a
timeout does not).

**Aggregate** (job `2026-10-06__17-31-37`, 9 trials/agent at `high`):

| agent | solved | llm | tools | in | out | reason | cache | ctx (med) |
|---|---|---|---|---|---|---|---|---|
| Skein | 4/9 | 62¹ | 46¹ | 911.7k | 311.6k | n/a | 60% | 16.2k |
| opencode | 6/9 | 21 | 26 | 697.9k | 12.9k | 9.9k | 96% | 30.7k |

¹ metrics n=6 (three trials timed out without flushing).

**Per task:**

| task / agent | solved | llm | tools | in | out | reason | cache | ctx (med) |
|---|---|---|---|---|---|---|---|---|
| fix-ocaml-gc / Skein | 3/3 | 69 | 52 | 1044.6k | 327.5k | n/a | 56% | 16.4k |
| fix-ocaml-gc / opencode | 3/3 | 26 | 30 | 1063.4k | 13.5k | 10.5k | 96% | 43.1k |
| db-wal-recovery / Skein | 1/3 | 18² | 18² | 164.8k² | 22.8k² | n/a | 60% | 9.2k |
| db-wal-recovery / opencode | 3/3 | 13 | 15 | 241.2k | 9.3k | 7.5k | 96% | 12.8k |
| custom-memory-heap-crash / Skein | 0/3 | 72² | 50² | 1085.9k² | 432.3k² | n/a | 66% | 17.0k |
| custom-memory-heap-crash / opencode | 0/3 | 25 | 33 | 788.9k | 15.8k | 11.6k | 97% | 29.8k |

² metrics n=1 (db-wal) / n=2 (custom-memory); the rest timed out or exited non-zero without
flushing `SKEIN_METRICS`.

**Reading.** On the matched task, `fix-ocaml-gc` (both 3/3), Skein makes **~2.6× the LLM
calls** (69 vs 26) and **~24× the completion tokens** (327.5k vs 13.5k), while its median
per-call context is **~2.6× smaller** (16.4k vs 43.1k) and its cache far worse (56% vs
96%); total input lands in the same place (~1.04M vs 1.06M). opencode's completion is
mostly hidden reasoning (10.5k of 13.5k). Skein's reasoning is **not separable** in these
runs — `outputTokens` already contains it (the per-turn `reasoningTokens` field was added
later, commit `d06bcb2`), so only `out` is comparable across agents here.

### 4.4.2 Why Skein makes ~2.6× more calls than opencode

Method: `SKEIN_TURN` (`turn`, `llmCalls`, `accepted`), `SKEIN_PROPOSAL` (operator/tool) and
`SKEIN_EVENTS.rejections`. `retries = Σ(llmCalls − 1)` counts the repair rounds inside
`invokeTools` (no tool call / malformed / completion-cap); every turn is otherwise one call.

**On the matched task, `fix-ocaml-gc` (old engine):**

| attempt | turns | llm | retries | run shell/check/poll | IR bookkeeping |
|---|---|---|---|---|---|
| `brVESz3` | 52 | 63 | 11 | 3 / 11 / **17** | 9 |
| `fNwUyxJ` | 48 | 63 | 15 | 3 / 4 / 1 | 20 |
| `fa7HV3F` | 57 | 82 | 25 | 4 / 3 / 1 | 36 |

Three sources there: **repair retries** (11–25 = 20–44 % of calls), **IR bookkeeping**
(`create_goal`/`complete`/`query`, 9–36 turns), **background-build polling** (one attempt
polled 17×; the current engine no longer polls — 0 in §4.7).

**The current engine (§4.7, `maxTurns: 60`) has a different, larger driver — refused `stop`:**

| run | turns | llm | retries | refused `stop` | other refusals |
|---|---|---|---|---|---|
| fix-git `6yMDVuU` | 60 | 60 | 0 | **28** | 2 repeated_action |
| crack `AyRhoAz` | 57 | 70 | 13 | **18** | 0 |
| cobol `3U2yRLB` | 60 | 79 | 19 | **16** | 8 revision |
| openssl `D3KLzq9` | 60 | 64 | 4 | **16** | 1 revision |
| log-summary `xQqCnF7` | 60 | 71 | 11 | **8** | 3 revision |
| fix-git `6R6p3Lw` | 60 | 71 | 11 | **4** | 0 |

**Bug 1 — arbiter goals cannot be settled in an autonomous run (the biggest source).**
Every §4.7 root goal is `done_when.kind = "arbiter"`: the requests name no literal check
command (fix-git "…merge them into master", crack-7z-hash "create /app/solution.txt", cobol
"…identical content-wise"), so they are not `objective`. An arbiter goal is settled **only**
by external acceptance (I5), which Harbor never provides. Once the work is done the doxa
proposes `stop`; `classify` refuses `not_addressed` ("settle the focus first by its own
check") — a move an arbiter goal cannot make — and the model proposes `stop` again, for the
rest of the budget. 28/60 turns on `fix-git`, 16/60 on `cobol`/`openssl`, 18/57 on `crack`:
each a full-context LLM call on non-work. The synthetic runner avoids this by playing the
program arbiter (`AgentDeps.arbiter`); Harbor does not. `applicable` correctly excludes
`stop` on those turns, yet the model proposes it anyway and is refused.

**Bug 2 — `invokeTools` repair retries.** 0–32 per run; each repair resends the whole
projection (cache-hostile). On the old `custom-memory` run, 32/85 = 38 % of calls.

**Bug 3 — one action per turn.** opencode batches (30 tool calls in 26 steps); Skein is
strictly one action per turn.

**Bug 4 — refusals beyond `stop`** (`repeated_action`, `unknown_revision`, 1–9) — minor
but non-zero.

**Design gap — no termination.** Because an arbiter goal never becomes addressed, the run
always reaches `maxTurns` (or the 1800 s timeout) even when the verifier would pass.

**Word on tokens.** The extra calls *are* the extra tokens: each call resends the
projection, and opencode's cache covers 96 % vs Skein's 56–66 %. It is not "bigger context
per call" — Skein's median per-call context is the smaller one.

**Recommended, in order.** (a) Give the autonomous harness an arbiter (Harbor plays
acceptance / the verifier), or let `stop` settle an arbiter goal whose plan is carried out
when no arbiter is wired; (b) cap and terminate on repeated refused `stop`; (c) remove the
repair resend (isolate the cause; reuse the cache); (d) allow batching independent actions.

### 4.5 Controlled experiment: the reference strategy (Phase 5)

Tests whether **B9** (obtain a canonical reference and diff) changes behavior and cost.
The design is an A/B on one synthetic task: `fixtures/synthetic/ref-localize-{on,off}`.
The repository is identical (a broken `src/ledger.mjs`, 540 lines, a one-token defect in
`applyTax`); only the presence of `reference/src/ledger.mjs` (the pristine copy) differs.
The prompt is **identical** and points at a reference if one exists.

Run: `SKEIN_CASES=fixtures/synthetic npx tsx bench/run.ts ref-localize-<on|off>`, Flash,
`reasoningEffort=low`, `maxTurns=24`, three runs per condition (2026-10-07, after the logos
closure and the A1–A4 step reduction with the A4 verification fix —
`docs/plans/step_reduction_plan.md` §3).

| condition | run | reward | steps | checks | tok in | tok out | cache | `diff` | rereads |
|---|---|---|---|---|---|---|---|---|---|
| on (reference present) | 1 | 1 | 5 | 1 | 44,916 | 1,326 | 47% | 1 | 0 |
| on | 2 | 1 | 6 | 1 | 54,143 | 2,083 | 83% | 1 | 0 |
| on | 3 | 1 | 5 | 1 | 42,209 | 1,505 | 84% | 1 | 0 |
| off (no reference) | 1 | 1 | 7 | 1 | 77,860 | 3,189 | 69% | 0 | 1 |
| off | 2 | 1 | 7 | 1 | 82,442 | 5,320 | 57% | 0 | 1 |
| off | 3 | 0 | 12 | 0 | 144,118 | 1,942 | 84% | 0 | 0 |
| **on, mean** | | 1.0 | **5.3** | **1.0** | **47,089** | **1,638** | **71%** | 3/3 | 0 |
| **off, mean** | | 0.67 | 8.7 | 0.67 | 101,473 | 3,484 | 70% | 0/3 | 0–1 |

`checks` is the number of objective checks per run; the closure keeps it at **one** (the
same check closes the whole chain above, a `chk→root` edge).

opencode on the same cases (local `opencode run --variant low --auto --pure`,
`--format json`, three runs each; `prompt tok` = `input + cache.read`):

| condition | reward | steps | tools | prompt tok | out tok | cache | `diff` |
|---|---|---|---|---|---|---|---|
| on, mean | 1.0 | 6.0 | 6.0 | 58,432 | 493 | 83% | 3/3 |
| off, mean | 1.0 | 6.0 | 8.0 | 81,085 | 574 | 82% | 0/3 |

**Reading.**

- **The step reduction put Skein ahead on `on`.** A1–A4 (closure, dropping `complete`, the
  working set, hypothesis + leading actions in one call) cut Skein from 10.3 steps / 95k
  prompt to **5.3 / 47k** in `on` — now below opencode (6.0 / 58k) on both axes. This is
  the reference-strategy case the design targets.
- **The A4 verification bug is fixed.** The auto-run of the leading action `node --test`
  used to match the goal's `done_when.command` and be **implicitly** promoted to a check,
  refuting the goal at the reproduce step (runs `09:31`, `09:48`). A verdict now comes
  **only from an explicit check** (`run {target}`); a bare run is an observation
  (`docs/plans/traversal_stack_spec.md` §9). All successful runs again show exactly one
  check.
- **The reference strategy holds:** `on` — `diff` 3/3 (proposed or auto-run by A4); `off`
  — manual localization, `diff` 0/3.
- **`off` is still opencode's:** 8.7 steps / 101k prompt vs 6.0 / 81k, and one Skein run
  failed (`off#3`, reward 0). Its trace shows the model oscillating between `query obs:16`
  (the test output) and `query obs:26` (the 400-line source read): with no reference it
  needs both bodies in view, but the working-set char cap evicts one when the other is
  fetched, so it never reaches the edit. This is a working-set/context-limit failure, not a
  localization failure — the next front.

**Caveats.** n=3, one task, a one-token defect; the cost is noisy. opencode is the local
CLI (not Harbor): it sees the whole disk, so the `off` runs were launched with the
references **isolated** — every `ledger.mjs` on disk hidden except the case's own source,
covering both pristine references and **fixed copies left by prior run workspaces**
(`/tmp/skein-bench/*/src/ledger.mjs`); one un-isolated `off` run was caught diffing such a
fixed copy and rerun. Residual noise: opencode can read arbitrary host files, which Skein
(a workspace sandbox) cannot; Skein's `out` includes reasoning while opencode's does not,
so the comparable axis is **prompt tokens**. The reference is **local**, not networked;
the network channel goes through Harbor's `network_mode`, a next step.

Artifacts: `bench/runs/2026-10-07T12-1{7,8,9}-*-ref-localize-{on,off}-skein/`.

> **Note (later).** A1 (objective ancestor closure) and A4 (auto-run of leading actions)
> were subsequently **retired** by the step-by-step redesign (§4.6): a goal is now settled
> only by its own check, and the engine never auto-runs a plan. The §4.5 numbers are the
> snapshot taken while they were in force.

### 4.6 Step-by-step redesign and the synthetic suite (Phase 6)

The long-task regression (§4.4) and the `fix-ocaml-gc` funnel (nine `llm_error` trials;
the trace built six nested `arbiter` goals) were traced to the **plan representation**: a
plan item could be a `goal`, `create_goal` appended sub-goals to a plan, and A4 auto-ran a
new plan in the same turn, so an `arbiter` goal with an exhausted plan left only
`create_goal` on the frontier. The engine was reworked
(`docs/plans/archive/plan_stepwise_redesign.md`): a goal carries a `plan` **string sketch** and only
its first `step` materializes as an action (I1–I3); a sub-goal enters **only** as an
alternative to a step (I4, I6); A4 is removed and A1 retired (a goal is settled only by its
own check); `create_goal` takes `{plan, step}` and refuses `empty_plan`/`empty_step`. The
prompt gained a **command rule** (B6): a request that names a verification command must be
`objective`, never `arbiter`; and the `unknown_revision` / `no current step to decompose`
messages now name the correct next move.

The whole synthetic suite (`skein-plugin/pilot/synthetic`, 10 cases), Flash,
`reasoningEffort=low`, one run each (2026-10-07):

| case | reward | steps | checks | tok in | cost |
|---|---|---|---|---|---|
| defeasible-rules | 1 | 10 | 2 | 81,950 | 0.81₽ |
| early-fact | 1 | 8 | 1 | 64,549 | 0.73₽ |
| hidden-hypotheses | 1 | 14 | 2 | 127,925 | 1.29₽ |
| linked-decisions | 1 | 15 | 3 | 122,919 | 2.18₽ |
| log-flood | 1 | 5 | 1 | 51,540 | 0.72₽ |
| moving-target | 1 | 7 | 1 | 55,429 | 0.37₽ |
| multi-bug-calc | 1 | 9 | 1 | 76,362 | 0.86₽ |
| rounding-trap | 1 | 6 | 1 | 47,026 | 0.30₽ |
| stale-obvious-fix | 1 | 6 | 1 | 46,847 | 0.31₽ |
| tempting-wrong | 1 | 6 | 1 | 46,761 | 0.28₽ |

- **The recursion is gone.** Before, `multi-bug-calc` built **40 goals / 39 plans / 0
  checks** and hit `maxTurns` (the model repeated `create_goal` with a goal plan item).
  Now it is 1 goal, 1 check, solved.
- **Arbiters are a first-class outcome.** `defeasible-rules` used to strand an `arbiter`
  interpretation (8 × `unknown_revision` + 8 × `no current step to decompose`, 0 checks,
  `maxTurns`). An arbiter goal is settled **only** by external acceptance (I5), so the
  synthetic runner now plays the **program arbiter** (`AgentDeps.arbiter`): while an open
  arbiter interpretation is in focus it runs the case's `check.sh` and, on success, emits
  `record_check {actor:"user"}`. The case then closes cleanly (2 checks: the objective
  stage check plus the arbiter's acceptance). Without the hook the same run can only end at
  `maxTurns` — pinned by `tests/loop.test.ts` ("an arbiter goal is settled only by the
  external arbiter (I5)").

**Caveat.** n=1 per case; one `linked-decisions` run exceeded the 420 s harness timeout and
was rerun clean (15 steps). Per-run cost/steps are noisy; the **reward** is the signal.

Artifacts: `bench/runs/2026-10-07T18-*` and later `*-skein/`.

### 4.7 Breadth run: the ten other terminal-bench tasks (Phase 7)

Goal: run Skein on terminal-bench tasks it had never seen — beyond the three of §4.4 —
**online**, to widen the coverage map. Config `bench/harbor/skein-unrun.template.yaml`:
terminal-bench 2.0, DeepSeek V4 Flash, `reasoningEffort: low`, `maxTurns: 60`,
`n_attempts: 2`, network on (no `network_mode` override), 4 CPU / 5120 MB,
`n_concurrent_trials: 5`. Only Skein ran (no opencode half).

**Blocker found and fixed first.** The draft long run `2026-10-07__16-42-30` had failed
**9/9 with `llm_error`** (`model returned no tool call`). The smoke
(`2026-10-08__13-53-04`, `password-recovery`) reproduced it at turn 15: replaying the
recorded turns through the live model showed a turn at **out = 7427 tokens against the
8192 cap** (`finish_reason: "length"` is what a cut produces), and the tools path — unlike
the JSON path — had no completion-cap bump, so a truncated no-call was treated as a bare
no-call and the run stopped. Fix in `src/llm/structured.ts` `invokeTools`: on
`finish_reason === "length"` raise `max_tokens` and retry (rebuild + re-bind), as
`invokeStructured` already did. After the fix the same smoke reached **reward 1.0 with 0
`llm_error`** (`2026-10-08__14-04-29`); `stopReason` is never `llm_error` in §4.7.

**Harness (not the agent).** `force_build: true` made Harbor rebuild each task's Dockerfile
per trial; concurrent builds contended and hit `EnvironmentStartTimeoutError` (2400 s). The
tasks ship prebuilt images (`alexgshaw/<task>:20251031`); switching to `force_build: false`
uses them. On this host Docker Hub pulls were themselves slow/throttled, so several trials
lost their environment start; the images were built locally from the task `environment/`
Dockerfiles to unblock.

**Results** (only attempts where the agent actually ran; `steps`/`out`/`rea` from
`SKEIN_METRICS` when it flushed, i.e. on a clean exit):

| task | valid/k | solved | exception | steps (out / reasoning) |
|---|---|---|---|---|
| `password-recovery` | 1/1 | 1 | AgentTimeout | — |
| `crack-7z-hash` | 2/2 | 2 | — | 57–60 (163k–304k / 156k–277k) |
| `fix-git` | 2/2 | 2 | — | 60 (86k, 312k / 74k, 304k) |
| `log-summary-date-ranges` | 2/2 | 2 | 1 × AgentTimeout | 60 (329k / 316k) |
| `regex-log` | 2/2 | 2 | 1 × AgentTimeout | 27 (189k / 184k) |
| `openssl-selfsigned-cert` | 2/2 | 2 | — | 8 (3k / 1.4k); 60 (137k / 128k) |
| `modernize-scientific-stack` | 1/2 | 1 | AgentTimeout | — |
| `cobol-modernization` | 1/2 | 1 | AgentTimeout | 60 (431k / 416k) |
| `fix-code-vulnerability` | 0/2 | — | 2 × infra | no agent run |
| `git-leak-recovery` | 0/2 | — | 2 × infra | no agent run |

**Reading.**

- **Every attempt that reached the agent solved its task: 13/13, all at `low`.** This
  includes the loop-heavy tasks from `tier1_plan.md` §8 (`cobol-modernization`,
  `openssl-selfsigned-cert`, `modernize-scientific-stack`), where the plugin baseline had a
  measured loop.
- **The failures were infrastructure, not model.** 6 attempts (`fix-git` 2,
  `log-summary` 2 in the first job, `cobol` 1, `modernize` 1) and the 4 fix-code/git-leak
  attempts were lost to Docker environment start / build, never to a wrong answer. They are
  excluded from "valid/k".
- **Runs are slow and expensive.** Half the valid runs hit `maxTurns: 60`, and four hit
  `AgentTimeoutError` (1800 s) even though the verifier still rewarded 1 — the agent keeps
  working instead of proposing `stop` once the task is addressed. Output is ~90 % hidden
  reasoning (`out` ≈ `rea`). Visible per-trial cost 8–77 ₽; the breadth run's visible total
  is ~330 ₽ across the two batches (timeouts do not flush `SKEIN_METRICS`, so the true
  total is higher).
- **No opencode half**, so §4.7 is a capability map, not a head-to-head. (§4.4 remains the
  matched comparison.)

**Caveats.** n = 1–2 per task; reward is the signal, steps/tokens are noisy. `fix-code-vulnerability`
and `git-leak-recovery` have **no valid agent attempt** — the Docker Hub pull of their prebuilt
images failed; they were not re-run. Two `AgentTimeout` cells have no `steps`/tokens (metrics
not flushed). `force_build`/local-image changes are harness-only and do not touch the engine.

Artifacts: jobs `~/.skein-bench/harbor/2026-10-08__14-04-29` (smoke),
`2026-10-08__14-38-28` + `2026-10-08__15-38-44` (batch A), `2026-10-08__16-18-02` (batch B).

### 4.8 Local sandbox: all thirteen tasks, a working-set fix, and the token comparison

`tests/sandbox/` (`docs/testing.md` §3.6) runs the thirteen terminal-bench tasks we had on
Harbor **without Harbor**: each task's own image (`alexgshaw/<task>:20251031`) carries the
environment, the real engine runs in a `bwrap`/Docker-isolated container, and the task's own
verifier scores it. A smoke pass (N=1, 24-turn cap, 5-way parallel, reasoning `low`) solved
**11/13** for ~44₽. Both misses hit the turn cap: `fix-ocaml-gc` and
`custom-memory-heap-crash` (reward 0), and `fix-code-vulnerability` solved but did not stop.

**A working-set bug was found and fixed.** `fix-ocaml-gc` and `fix-code-vulnerability`
ended on `no_progress`; `fix-code`'s trace shows a `query` loop — the agent could not keep
the source window it was editing in view. Root cause: the working set had a
**total-character cap** (`HELD_CHARS = 2 × OUTPUT_LIMIT = 16,000`) that **silently dropped
any body larger than the cap** (`src/loop/graph.ts`). A 400-line window of `bottle.py` is
~15.6k, so it was dropped as soon as another body was pinned; the `repeated_action` refusal
then told the model to `query` again, and the anti-stall ended the run (`no_progress`). This
is the same failure already flagged in §4.4 (the "next front"). Fix: removed the
total-character cap; the set is bounded by `MAX_HELD` (5) bodies, each bounded per tool by
`OUTPUT_LIMIT` (`read` included now). After the fix `fix-code-vulnerability` solves
(reward 1, 18 turns, 2.33₽) and `fix-ocaml-gc` no longer loops (55 → 14 turns), though it
still stops without editing — a model/prompt issue, not a limit.

**Token comparison** (`fix-ocaml-gc`; sandbox reasoning `low`, Harbor `high` — see caveat):

| run | reward | llm | tools | in | out (visible + reasoning) | cache | cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| sandbox (new engine) | 0 | 14 | 14 | 172.9k (fresh 68.0k) | 14.5k (1.4k + 13.1k) | 61% | 2.38₽ |
| Harbor Skein (old) | 3/3 | 69 | 52 | 1044.6k | 327.5k (−) | 56% | — |
| Harbor opencode | 3/3 | 26 | 30 | 1063.4k | 13.5k (3.0k + 10.5k) | 96% | — |

`fix-code-vulnerability`: sandbox reward 1, 18 llm / 18 tools, in 269.5k (fresh 117.2k) /
out 9.3k (1.7k + 7.6k), cost 2.33₽ — **no Harbor/opencode record** (batch B trials are empty,
an infra failure). opencode's cache share is 96% (of its 1063.4k `in`, 1015.7k is cache
reads), so its fresh input is only ~47.7k.

Caveat: the sandbox runs at reasoning `low` while the Harbor runs used `high`, so the
sandbox numbers are not yet matched; the sandbox can be re-run at `high` (plan §3).

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
5. **Comparative testing (§4.8, plan §3 item 4):** re-run the sandbox on the same tasks at
   reasoning `high`, k = 3, and compare turns / LLM calls / tool calls / tokens / cost
   against opencode on matched tasks; fix the premature `stop` before trusting accuracy.

Separately deferred: optimizing the projection for a stable prefix/cache
(`docs/plans/implementation_plan.md`, backlog).

## 8. Where the artifacts are

- Synthetic: `bench/runs/<ts>-<case>-skein/` (`metrics.json`, `turns.ndjson`,
  `trajectory.json`, `reward.txt`).
- Harbor: `~/.skein-bench/harbor/<job>/<trial>/` (`agent/langgraph-run.log` with
  `SKEIN_TURN`/`SKEIN_METRICS`, `verifier/reward.txt`, `result.json`).
- Local sandbox (`tests/sandbox/`, §4.8): `bench/runs/sandbox-tasks/<ts>-<id>/`
  (`contexts.ndjson`, `result.json`, `metrics.json`, `reward.txt`).
- Plugin baseline: `skein-plugin/pilot/harbor/jobs/2026-09-26__11-50-39/`.
- Non-degradation gate: `bench/baseline.json`, `bench/compare.ts`, `bench/gate.ts`
  (`npm run bench:gate -- <runDir>`), test `tests/bench_gate.test.ts`.
