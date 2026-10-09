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
| Sandbox (offline) | `SKEIN_LIVE=false npx vitest run tests/sandbox` | engine over a virtual workspace; metric extraction | seconds, free |
| Live gate | `SKEIN_LIVE=true npx vitest run tests/gate.test.ts` | fixing bug fixtures with a live model | minutes, money |
| Live scenarios | `SKEIN_LIVE=true npx vitest run tests/live/scenarios.test.ts` | short scenarios per loop branch | minutes, money |
| Sandbox (live) | `SKEIN_LIVE=true npx tsx tests/sandbox/live-trace.ts` | one model run over the sandbox, with token breakdown | 1 run, money |
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

### IR operations

The tree operators are specified in `docs/ir_operations.md` (a registry of `OP-CG`,
`OP-AP`, `OP-QR`, `OP-ST`, `TR`, `DER`, `REF`, `PRJ` IDs). Their offline tests
are grouped by operator under `tests/ops/` (`create_goal`, `apply`, `query`, `stop`,
`applicable`, `traversal`, `derivation`); the invariants are exercised on 400 random legal trees
(`tests/ops/ir_properties.test.ts`); and `tests/coverage.test.ts` fails if any registry
ID has no test or a test cites an ID outside the registry.

## 3. Live gate

```sh
SKEIN_LIVE=true npx vitest run tests/gate.test.ts
```

Runs a live model over the `fixtures/bugfix/*` fixtures: the agent must fix a failing
test without editing the tests. Timeout — 300 s per fixture. Needs a key (§9).

### Live scenarios

Short scenarios for individual loop branches (query, hypothesis revision,
constraints, an answer without a mutation, plan, recovery after a failure, search over
many files). A separate group is the **"commands × actions" matrix**: `fail-recover`,
`script-two-bugs`, `make-command`, `verbatim-flag`, `command-from-package` — tasks whose
criterion involves a real command (in README / `package.json` / `Makefile` / verbatim)
and whose solver must perform a sequence of actions (`read`→`edit`→`run`, creating a
config via `run … >`, two independent edits). Two more are **strategy** scenarios:
`reference-diff` (a reference copy in the workspace → expect a `diff`, block B9) and
`no-vcs` (no `.git` → no repeated git, block B8). A fixture is
`fixtures/scenarios/<name>/{repo, request.txt, check.sh?, constraints.json?}`; `check.sh`
is optional (default `node --test`).

```sh
SKEIN_LIVE=true npx vitest run tests/live/scenarios.test.ts
SKEIN_SCENARIOS=two-outputs,revise-hypothesis SKEIN_LIVE=true npx vitest run tests/live/scenarios.test.ts
SKEIN_SCENARIO_REPEATS=3 SKEIN_SCENARIOS=script-two-bugs SKEIN_LIVE=true npx vitest run tests/live/scenarios.test.ts
```

Scenarios are independent (each has its own temp workspace and trace) and run **in
parallel**: `it.concurrent` + `test.maxConcurrency: 5` (`vitest.config.ts`), matching
Harbor's `n_concurrent_trials: 5`. Each test removes its own temp root, so there is no
shared `afterEach` cleanup (it would race the still-running scenarios). The whole set is
~3 minutes.

The scenario harness drives `runAgent` alone (mirrors `bench/run.ts`): there is no
program arbiter. A request ends at the doxa's own `stop`, gated by its chosen
interpretation's criterion (a pass, or a stopped interpretation) — so a request that
names no literal command still closes once the model runs and stops its interpretation.

Hard checks (fail the test): whether the criterion passed, whether the request was
settled (`stopReason=request_addressed` when the scenario sets `expect.addressed`), the
invariants (`tests/invariants.ts`), that `test/` (and explicit paths) is unchanged, the
number of **distinct** already-known results re-accessed (`maxRepeats`; one target,
however many refusals, counts once), no mutation where forbidden, and the shape of
`run` commands (`expect.commands`: a regexp plus `min`/`max` — e.g. `diff` is required
for `reference-diff`, git is bounded for `no-vcs`).
**Stability:** `SKEIN_SCENARIO_REPEATS=N` (default 1) runs each scenario N times and
collects every failure, so a flaky prompt shows as a pass-rate rather than a single
draw; the test timeout scales with N. A soft branch-coverage report
is printed to stdout (`branches=[…]`, `MISSING(soft)=[…]`) and deliberately
does not fail: it is the instrument for tuning the projection, branches are promoted to
hard as they stabilise. The full projection per turn and the journal land in
`bench/runs/live-<ts>-<name>/{contexts,events}.ndjson` for offline analysis; the
working-set telemetry is written alongside: `workset.ndjson` (per turn — `shownCount`,
`shownChars`, `requested`) and `workset.json` (`peakCount`, `peakChars`, `reacquired`),
and `run.json` records the verdict (`done`, `stopReason`, `turns`, and the external
`check` code/stdout/stderr). The soft report also prints `refuted=` — the goal checks that
failed — so a run that recovered from a wrong fix (`tempting-wrong`, `two-step-fix`) is
visible, not just the final reward.

### IR operation steps

`SKEIN_LIVE=true npx vitest run tests/live/ir_operations_step.test.ts` builds each
operation family's projection **offline** (exactly what the engine would show) and
asserts the **shape** of the live model's next move: interpret the request, run a ready
criterion, poll a background job, retry a non-decisive (timeout) criterion, apply the
next plan action, follow a focus hint. `SKEIN_STEP_REPEATS=N` (default 3)
retries a step, so a stochastic miss is not a failure. The specification and the coverage
map are `docs/ir_operations.md` (EN + RU).

### Trace replay (without Harbor)

`npm run replay -- <trace-or-scenario> [--limit N] [--offset N] [--model M]` takes a
recorded trace (a short scenario's `bench/runs/live-<ts>-<name>/contexts.ndjson`, or just
the scenario name; a Harbor `agent/langgraph-run.log` with `SKEIN_CONTEXT` /
`SKEIN_PROPOSAL` lines), rebuilds `buildMessages(context)` per turn and runs the current
`invokeTools` on the **same context**. It prints per turn: the proposed and recorded
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

## 3.5 Sandbox (no Docker)

A miniature of the terminal-bench `fix-ocaml-gc` task, with the **real loop** and a
virtual workspace (`tests/sandbox/`): a small tree (`tests/sandbox/specs/fix-ocaml-gc.ts`)
and `make`/testsuite commands emulated from the file map, so editing the defect flips the
check from fail to pass — no Docker, no network. The same `runSandbox` drives a
**deterministic** (scripted) or a **live** (model) proposer, so the engine is exercised for
free before any model run.

```sh
# engine only, no model — classify/refusal/termination; <1s
SKEIN_LIVE=false npx vitest run tests/sandbox/fix-ocaml.test.ts
# metric extraction: token/call accounting, offline and free
SKEIN_LIVE=false npx vitest run tests/sandbox/metrics.test.ts
# one live run: real model, virtual workspace, ≤16 turns, writes a trace (money)
SKEIN_LIVE=true npx tsx tests/sandbox/live-trace.ts
```

`live-trace.ts` writes `bench/runs/sandbox-live-<ts>-fix-ocaml-gc/`:

| File | Contents |
| --- | --- |
| `contexts.ndjson` | the full projection per turn (`turn`, `chars`, `context`) |
| `result.json` | `stopReason`, `turns`, the IR journal (`events`) |
| `metrics.json` | `stopReason`, `turns`, `fixed`, `totals`, `byTool`, `byOperator`, `perTurn` |

**Recorded parameters.** Per turn (`perTurn`): `operator`/`tool`, `refused`, `chars`,
`llmCalls`, `inputTokens`, `outputTokens`, `reasoningTokens`, `cacheRead`, `cacheWrite`,
`cost`. Totals: `turns`/`toolCalls`/`accepted`/`refused`, `inputTokens` (`freshInput` +
`cacheRead`) and `outputTokens` (`visibleOutput` + `reasoningTokens`), `cacheHitRatio`,
`costRub`, `contextChars` `first/last/peak`; then the same split `byTool` and `byOperator`.

- `llmCalls` — actual model invocations (a completion-cap bump or a repair round adds one).
- `toolCalls` — one per turn (`tool_choice: "required"`); a **refused** proposal is still
  a call (`accepted`/`refused` split it). Retries add `llmCalls`, not `toolCalls`.
- `in` = fresh input + cache read (same convention as `bench/agents_compare.ts`, §6);
  `out` = visible output + reasoning.
- The accounting is `TurnMeter`/`extractUsage` (`bench/metrics.ts`), shared with the
  Harbor adapter; `tests/sandbox/metrics.ts` is the pure aggregation, verified offline in
  `metrics.test.ts`.

**Cost discipline.** A live run spends real money:

1. verify **offline first** — `npm run typecheck` and `SKEIN_LIVE=false npx vitest run
   tests/sandbox`; the metric code must already be green before a model is called;
2. one deliberate run at a time; a run is bounded by `maxTurns` (16) and the tiny
   workspace, so it stays cents, but the small tree is **synthetic**: compare the *shape*
   (per-call tokens, cache/reasoning shares, the context curve), not the absolute totals,
   against a Harbor run;
3. decide **in advance** what you will compare, and read the recorded artifact
   (`metrics.json`, `contexts.ndjson`) instead of re-running;
4. do not run live to "see if it works" — that is what the scripted sandbox is for.

To compare a saved live run with Harbor, parse the job
(`npx tsx bench/agents_compare.ts ~/.skein-bench/harbor/<job>`, §6); opencode's per-call
tokens are in
`agent/opencode.txt` (`step-finish`), Skein's in `agent/langgraph-run.log`
(`SKEIN_TURN`/`SKEIN_METRICS`).

## 3.6 Sandbox tasks (real, no Harbor)

Real terminal-bench tasks run locally with the real engine and the task's own verifier, on
two backends:

- **Docker** (image tasks). The task's own image (`alexgshaw/<task>:20251031`) carries the
  exact environment, so nothing is installed on the host. The image's `/app` is copied into
  a temp root, then a `sleep` container bind-mounts that root at `/app`; `run` is `docker
  exec`. Network is `none` by default, a sane `--ulimit nofile` is set (valgrind), and git
  `safe.directory=*` (the image's files are owned by its own user, not root).
- **bwrap** (`container.ts`, used by `regex-log`). A host temp root mounted at `/app` under
  `bwrap`, sharing the host `/usr` read-only, network off — for a task with no dedicated
  image.

Ported (13): `regex-log`, `fix-git`, `log-summary-date-ranges`, `openssl-selfsigned-cert`,
`git-leak-recovery`, `cobol-modernization`, `modernize-scientific-stack`,
`custom-memory-heap-crash`, `password-recovery`, `db-wal-recovery`, `crack-7z-hash`,
`fix-code-vulnerability`, `fix-ocaml-gc`.

| File | Role |
| --- | --- |
| `tests/sandbox/docker.ts` | the Docker `Workspace` (image `/app` → temp root → `docker exec`) |
| `tests/sandbox/container.ts` | the bwrap `Workspace`; file tools rewrite the `/app/` prefix |
| `tests/sandbox/task.ts` | `SandboxTask` + Harbor-cache lookup + the pytest-free verifier runner and a `pytest` shim |
| `tests/sandbox/harness.ts` | `runTask`: materialize → setup → `runAgent` → `checkSetup` → verifier → reward |
| `tests/sandbox/tasks/<id>.ts` | one task's descriptor; `registry.ts` maps id → task |
| `tests/sandbox/sandbox-run.ts` | the live CLI |

Task files are read from `~/.cache/harbor/tasks/<hash>/<id>/` (they carry a benchmark
canary), never copied into the repository.

```sh
# offline: no model, real image(s) + verifier; a no-op scores 0, the task's own solution 1
SKEIN_LIVE=false npx vitest run tests/sandbox/tasks.test.ts
# the slow fix-ocaml-gc rebuild verifier (minutes), on demand
SKEIN_SLOW_TASKS=1 SKEIN_LIVE=false npx vitest run tests/sandbox/tasks.test.ts -t fix-ocaml
# one live run of a task, with the token breakdown (money)
npx tsx tests/sandbox/sandbox-run.ts <task-id> [--turns N]
```

A run uses the task's own `maxTurns` when set (a build-heavy task like `fix-ocaml-gc`
sets 60 — its criterion rebuilds the whole compiler and each background poll costs a
turn), else 24; an explicit `--turns N` overrides both.

Output — `bench/runs/sandbox-tasks/<ts>-<id>/`: `contexts.ndjson` (the projection per
turn), `result.json` (`stopReason`, `reward`, the verifier result, the IR journal),
`metrics.json` (the same totals/splits as §3.5), `reward.txt` (the verifier's score).

**Verifier.** The task's `tests/test_outputs.py` is run by a pytest-free wrapper; a `pytest`
shim is staged so `import pytest` resolves without installing it. `checkIn: "host"` runs the
verifier via bwrap for an image without Python (`git-leak-recovery`, `password-recovery`,
`crack-7z-hash`); `checkSetup` runs a pre-verifier command in the task container
(`fix-ocaml-gc` rebuilds the compiler and regenerates `tests.txt`).

**Isolation / limitations.** Docker tasks keep the network off (except `crack-7z-hash`,
which installs p7zip), mount no host home, and root-owned files are wiped from inside the
container on teardown. bwrap tasks share the host `/usr`, so they need the tool on the host.
A background `run {background: true}` and `fetch` still use the host implementation.

**Adding a task.** Write `tests/sandbox/tasks/<id>.ts` with `{ id, image?, files?, setup?,
check?, workdir?, checkIn?, checkSetup?, network?, maxTurns? }` — `request` defaults to the cached
`instruction.md`, `check` to the cached `tests/test_outputs.py`; `files` mirror a Docker
`COPY`, `setup` a Dockerfile/`setup.sh` step. Register it in `tasks/registry.ts`. Verify it
offline first (a no-op proposer → `reward=0`, the task's `solution/solve.sh` → `reward=1`),
then run live.

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
| `events.ndjson` | the IR journal: nodes, edges, `mutate`, `record_rejection` |
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
| `SKEIN_PROPOSAL` | the proposed action (including command text) |
| `SKEIN_TURN` | per turn: tokens/cache/`contextChars`/time |
| `SKEIN_LLM_ERROR` | a model-call error (with the attempt number) |
| `SKEIN_EVENTS` | IR diagnostics: goals, plans, alternatives, `observations`, `mutates`, rejections |
| `SKEIN_METRICS` | summary: tokens, `context` `first/last/peak/growth`, graph |

`contextChars` is computed from the same `promptText(context)` that goes into
`buildMessages`, so the size in the log equals the sent context. Executed commands
appear in `SKEIN_PROPOSAL` (proposed) and in
`SKEIN_EVENTS.observations`/`.actions` (actual, including the run command). The local
bench writes the same into `bench/runs/<...>/` (§4).

## 8. Tool and projection limits

There is no global context budget: a tool honestly returns its result within declared
limits, and the projection does not cut it (`docs/tools.md`).

| Limit | Value | Meaning |
| --- | --- | --- |
| `MAX_READ_LINES` | 400 | `read` window per call; the tool reports "lines X–Y of Z" |
| `GREP_COUNT_DEFAULT` | 100 | `grep` matches in a window by default |
| `MAX_GREP_MATCHES` | 200 | maximum `grep` matches per window; continuation via `next`/`from` |
| `MAX_LIST_FILES` | 500 | maximum files per `list` window |
| `OUTPUT_LIMIT` | 8000 | byte cap for a `grep`/`list` JSON result and for `run` output; excess `grep`/`list` results are dropped whole, run output becomes head+tail with `outputRef`/`errorRef` (stdout/stderr separate) |
| `SKEIN_CTX_ITEMS` | 20 | items in the projection's `plan`/`alternatives` |

### 8.1 Robust structured output

The agent proposes through **native tool calls**: `src/llm/tools.ts` defines one flat
function tool per operation (`create_goal`, `query`, `read`, `grep`, `list`,
`edit`, `write`, `run`, `fetch`, `apply_patch`, `stop`) and `src/llm/structured.ts` `invokeTools` binds them with
`tool_choice: "required"`, reads `tool_calls[0]` and maps it to the IR `Action`. Flat,
per-operation schemas matter: one deeply nested discriminated union came back flat
(`operator` at the top level instead of nested under `action`), and JSON mode made the
model reason far more on hard turns (and hit the completion cap, whose retries re-sent
the whole projection). When a response is cut at the cap (`finish_reason: "length"`) and
carries no call, `invokeTools` retries ONCE at the ceiling with an explicit brevity
instruction (call the tool now, do not restate analysis) — it does **not** keep doubling
the cap, which only invites more reasoning (a live `fix-ocaml-gc` run turned one `read`
into 4 calls / 60.9k completion tokens); a bare no-call gets one repair round; if that
fails the loop stops with `stopReason: "llm_error"` instead of crashing.

`invokeStructured` remains the generic JSON path (schema spelled out in the prompt,
`response_format: json_object`, manual parse, raised cap on a completion cut, one repair
round); it is covered offline in `tests/structured.test.ts` and used by no agent path.

## 9. Keys and secrets

The key lives only in `.env` (gitignored) or `~/.config/opencode/opencode.json`. It is
never written into the repository or the logs. `run.sh` forwards it into the container
as `OPENAI_API_KEY`.

## 10. Principles

- **Offline by default.** `SKEIN_LIVE=false` for an ordinary check; live and Harbor
  only deliberately. The sandbox is free offline (engine + metric extraction); a live
  sandbox run is one deliberate run with a defined comparison, never a "does it work" probe
  (§3.5).
- **Before an expensive run, save what will be measured.** The full projection and
  the executed commands must reach the log/files (§4, §7), otherwise the analysis is
  impossible.
- **One case, one attempt** while iterating on the engine; the full set is for
  acceptance.
- **Compare against a saved run**, not memory: `context first/last/peak` and `reward`
  from `metrics.json` / `SKEIN_METRICS`.
- **Minimal diff.** A harness change does not alter the engine's semantics; the
  invariants live in `tests/invariants.ts`.