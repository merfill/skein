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

## 5. Problems (what broke or hurts)

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
