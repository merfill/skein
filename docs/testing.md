# Skein — running tests and benches

> Russian mirror — `docs/testing_ru.md`.

A single place so the commands and output locations are not hunted for across the
repository. It covers `package.json` (scripts), `bench/` (the synthetic bench and
gate), `bench/harbor/` (real tasks) and `langgraph/graph.ts` (the instrumentation).

## 1. Layers of verification

| Layer | Command | What it checks | Cost |
| --- | --- | --- | --- |
| Types | `npm run typecheck` | `tsc --noEmit` | seconds |
| Offline tests | `SKEIN_LIVE=false npx vitest run` | IR invariants, projection, loop, gates | seconds |
| Live gate | `SKEIN_LIVE=true npx vitest run tests/gate.test.ts` | fixing bug fixtures with a live model | minutes, money |
| Live scenarios | `SKEIN_LIVE=true npx vitest run tests/live/scenarios.test.ts` | short scenarios per loop branch | minutes, money |
| Synthetic bench | `npm run bench -- <case>` | one case from `skein-plugin` | minutes, money |
| Bench gate | `npm run bench:gate -- <runDir>` | a run against `bench/baseline.json` | seconds |
| Harbor | `bash bench/harbor/run.sh` | real terminal-bench tasks | long, money |

**Offline by default.** The live gate and the benches are run deliberately.

## 2. Offline tests

`.env` (gitignored) holds `SKEIN_LIVE=true`, and `loadSettings` reads it via
`dotenv/config`. So `npm test` without an override would enable the expensive live
gate. For an ordinary check:

```sh
npm run typecheck
SKEIN_LIVE=false npx vitest run
```

`SKEIN_LIVE=false` is set in the process environment, and `dotenv` does not
overwrite an already-set variable. Live tests are marked `describe.skipIf(!settings.live)`
(`tests/gate.test.ts`); the invariants live in `tests/invariants.ts`.

## 3. Live gate

```sh
SKEIN_LIVE=true npx vitest run tests/gate.test.ts
```

Runs a live model over the `fixtures/bugfix/*` fixtures: the agent must fix a failing
test without editing the tests. Timeout — 300 s per fixture. Needs a key (§9).

### Live scenarios

Short scenarios for individual loop branches (`need`, `query`, hypothesis revision,
constraints, `complete` without a mutation, plan, recovery after a failure, search over
many files). A separate group is the **"commands × actions" matrix**: `fail-recover`,
`script-two-bugs`, `make-command`, `verbatim-flag`, `command-from-package` — tasks whose
criterion involves a real command (in README / `package.json` / `Makefile` / verbatim)
and whose solver must perform a sequence of actions (`read`→`edit`→`run`, creating a
config via `run … >`, two independent edits). A fixture is
`fixtures/scenarios/<name>/{repo, request.txt, check.sh?, constraints.json?}`; `check.sh`
is optional (default `node --test`).

```sh
SKEIN_LIVE=true npx vitest run tests/live/scenarios.test.ts
SKEIN_SCENARIOS=need-two-outputs,revise-hypothesis SKEIN_LIVE=true npx vitest run tests/live/scenarios.test.ts
SKEIN_SCENARIO_REPEATS=3 SKEIN_SCENARIOS=script-two-bugs SKEIN_LIVE=true npx vitest run tests/live/scenarios.test.ts
```

Hard checks (fail the test): whether `check` passed, whether the request was closed
(`stopReason=request_addressed` when the scenario sets `expect.addressed`), the
invariants (`tests/invariants.ts`), that `test/` (and explicit paths) is unchanged, the
number of **distinct** already-known results re-accessed (`maxRepeats`; one target,
however many refusals, counts once), and no mutation where forbidden.
**Stability:** `SKEIN_SCENARIO_REPEATS=N` (default 1) runs each scenario N times and
collects every failure, so a flaky prompt shows as a pass-rate rather than a single
draw; the test timeout scales with N. A soft branch-coverage report
is printed to stdout (`branches=[…]`, `MISSING(soft)=[…]`, `need=…`) and deliberately
does not fail: it is the instrument for tuning the projection, branches are promoted to
hard as they stabilise. The full projection per turn and the journal land in
`bench/runs/live-<ts>-<name>/{contexts,events}.ndjson` for offline analysis; the
working-set telemetry is written alongside: `workset.ndjson` (per turn — `shownCount`,
`shownChars`, `requested`) and `workset.json` (`peakCount`, `peakChars`, `reacquired`),
and `run.json` records the verdict (`done`, `stopReason`, `turns`, and the external
`check` code/stdout/stderr). The soft report also prints `refuted=` — the goal checks that
failed — so a run that recovered from a wrong fix (`tempting-wrong`, `two-step-fix`) is
visible, not just the final reward.

### Trace replay (without Harbor)

`npm run replay -- <trace-or-scenario> [--limit N] [--offset N] [--model M]` takes a
recorded trace (a short scenario's `bench/runs/live-<ts>-<name>/contexts.ndjson`, or just
the scenario name; a Harbor `agent/langgraph-run.log` with `SKEIN_CONTEXT` /
`SKEIN_PROPOSAL` lines), rebuilds `buildMessages(context)` per turn and runs the current
`invokeStructured` on the **same context**. It prints per turn: the proposed and recorded
`operator`/tool (`=`/`≠`), `thought` length, output tokens, `finish_reason`; and a final
summary `ok/fail/match/mismatch/outTokens/maxOut/finish=[…]`. This tunes the prompt/schema
on the real context distribution for cents: e.g. `th=8661 out=31531 finish=length` before
the `thought` fix vs `th≈120 out≈200 finish=stop` after.

### Working-set policy simulation (offline)

The long horizon is checked without a model: `tests/workingset.test.ts` drives a
scripted proposer through the real loop and checks growth, cap eviction, re-acquisition,
stale drop and compression. Limits (`turns`/`max`/`chars`) are passed via
`AgentDeps.held` and varied in the tests; the metrics come from `tests/workset.ts` (the
same as in the live dump). This validates the policy over hundreds of turns
deterministically and for free, before the expensive live runs.

## 4. Synthetic bench

```sh
npm run bench -- <case> [--model provider/model] [--max-turns N] [--compare]
```

Cases and the behavioural metric come from the neighbouring repository
(`../skein-plugin/pilot/synthetic`, overridable via `SKEIN_PLUGIN_ROOT`). A run copies
the case `repo` into a fresh workdir, drives the agent, then runs `check.sh`.

Output — `bench/runs/<ts>-<case>-skein>/`:

| File | Contents |
| --- | --- |
| `trajectory.json` | proposed actions per turn |
| `turns.ndjson` | per turn: tokens/cache/`contextChars`/time |
| `contexts.ndjson` | **the full projection** per turn (`turn`, `chars`, `context`) |
| `events.ndjson` | the IR journal: nodes, edges, `record_check`, `record_rejection` |
| `metrics.json` | summary: reward, context `first/last/peak/growth`, graph, loops |
| `reward.txt`, `check.out.txt`, `summary.txt` | the `check.sh` verdict and output |

## 5. Gate against the baseline

```sh
npm run bench:gate -- bench/runs/<ts>-<case>-skein
```

Compares `metrics.json` with `bench/baseline.json` and prints `PASS`/`FAIL` with
per-metric deltas (tokens, context, loops). A non-zero exit code means failure.

## 6. Harbor (real tasks)

```sh
bash bench/harbor/run.sh
```

`run.sh` renders `bench/harbor/skein.yaml` from `skein.template.yaml` (the absolute
project path), substitutes the key and runs `harbor run`. The key comes from
`ROUTERAI_API_KEY` → `OPENAI_API_KEY` → `SKEIN_API_KEY` → `~/.config/opencode/opencode.json`.

Results live outside the repository: `~/.skein-bench/harbor/<ts>/`. Per trial:
`<task>__<id>/agent/langgraph-run.log` (the `SKEIN_*` lines, §7),
`<task>__<id>/verifier/reward.txt`.

**Focused run** (one case, not the whole set). `run.sh` forwards its arguments to
`harbor run`, so the dataset/task/number of attempts are set with Harbor flags after
`run.sh`:

```sh
# one case, one attempt (iterating on the engine)
bash bench/harbor/run.sh -d terminal-bench -i fix-ocaml-gc -k 1
# two attempts (as in the run reports)
bash bench/harbor/run.sh -d terminal-bench -i fix-ocaml-gc -k 2
```

- `-d/--dataset` — the dataset (`terminal-bench`), `-i/--include-task-name` — the task
  (globs supported), `-k/--n-attempts` — attempts per trial; `-x/--exclude-task-name`
  excludes, `-l/--n-tasks` caps the number of tasks.
- Alternative (as in the sibling `skein-plugin`): set a single task and `n_attempts`
  directly in `bench/harbor/skein.template.yaml` (`datasets[0].task_names`), render via
  `node bench/harbor/prepare.mjs`, then `harbor run --config bench/harbor/skein.yaml -y`.

Results land in the same place, outside the repository:
`~/.skein-bench/harbor/<ts>/<task>__<id>/`.

## 7. Instrumentation: where to look

`langgraph-run.log` receives these lines as the run proceeds (each one JSON):

| Line | Contents |
| --- | --- |
| `SKEIN_CONTEXT` | **the full projection** per turn: `{turn, chars, context}` |
| `SKEIN_PROPOSAL` | the proposed action (including command text) and `need` (requested ids) |
| `SKEIN_TURN` | per turn: tokens/cache/`contextChars`/time |
| `SKEIN_LLM_ERROR` | a model-call error (with the attempt number) |
| `SKEIN_EVENTS` | IR diagnostics: goals, plans, alternatives, `checks`, `observations`, `mutates`, rejections |
| `SKEIN_METRICS` | summary: tokens, `context` `first/last/peak/growth`, graph |

`contextChars` is computed from the same `renderContext(context)` that goes into
`buildMessages`, so the size in the log equals the sent context. Executed commands
appear in `SKEIN_PROPOSAL` (proposed) and in
`SKEIN_EVENTS.checks`/`.observations`/`.actions` (actual, including the command from
`done_when`). The local bench writes the same into `bench/runs/<...>/` (§4).

## 8. Tool and projection limits

There is no global context budget: a tool honestly returns its result within declared
limits, and the projection does not cut it (`docs/tools.md`).

| Limit | Value | Meaning |
| --- | --- | --- |
| `MAX_READ_LINES` | 400 | `read` window per call; the tool reports "lines X–Y of Z" |
| `GREP_COUNT_DEFAULT` | 100 | `grep` matches in a window by default |
| `MAX_GREP_MATCHES` | 200 | maximum `grep` matches per window; continuation via `next`/`from` |
| `MAX_LIST_FILES` | 500 | maximum files per `list` window |
| `OUTPUT_LIMIT` | 8000 | byte cap for a `grep`/`list` JSON result; excess results are dropped whole |
| `MAX_RUN_OUTPUT` | 8000 | `run` output; beyond that head+tail and `outputRef` |
| `SKEIN_CTX_ITEMS` | 20 | items in the projection's `plan`/`alternatives` |

### 8.1 Robust structured output

The provider does not hold tool calling well under the long agent prompt: the call
arguments arrive flat (`operator` at the top level instead of nested under `action`) or as
invalid JSON, and the library returns `parsed: null` with no `parsing_error`. The agent
therefore does not use `withStructuredOutput` at all: `src/llm/structured.ts` puts the
**raw JSON schema** in the prompt (`response_format: json_object` as a hint) and parses
the reply manually. On a truncated body (`max_tokens`) or a schema violation it retries
with a higher `max_tokens` (`SKEIN_MAX_TOKENS_CEILING`, bounded by `SKEIN_MAX_TOKENS_BUMPS`)
and one repair round carrying the validator's message. If everything fails, the loop stops
with `stopReason: "llm_error"` instead of crashing the run. Covered offline in
`tests/structured.test.ts`.

## 9. Keys and secrets

The key lives only in `.env` (gitignored) or `~/.config/opencode/opencode.json`. It is
never written into the repository or the logs. `run.sh` forwards it into the container
as `OPENAI_API_KEY`.

## 10. Principles

- **Offline by default.** `SKEIN_LIVE=false` for an ordinary check; live and Harbor
  only deliberately.
- **Before an expensive run, save what will be measured.** The full projection and
  the executed commands must reach the log/files (§4, §7), otherwise the analysis is
  impossible.
- **One case, one attempt** while iterating on the engine; the full set is for
  acceptance.
- **Compare against a saved run**, not memory: `context first/last/peak` and `reward`
  from `metrics.json` / `SKEIN_METRICS`.
- **Minimal diff.** A harness change does not alter the engine's semantics; the
  invariants live in `tests/invariants.ts`.