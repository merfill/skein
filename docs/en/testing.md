# Skein — running tests and benches

> Russian mirror — `docs/ru/testing.md`.

A single place so the commands and output locations are not hunted for across the
repository. It covers `package.json` (scripts), `bench/` (the synthetic bench and
gate), `bench/harbor/` (real tasks) and `langgraph/graph.ts` (the instrumentation).

The same document also covers testing on real tasks (the sandbox, Harbor, the live-step
driver, and the fast `bench/turn.ts` probe).

## 1. Layers of verification

| Layer | Command | What it checks | Cost |
| --- | --- | --- | --- |
| Types | `npm run typecheck` | `tsc --noEmit` | seconds |
| Offline tests | `SKEIN_LIVE=false npx vitest run` | IR invariants, projection, loop, gates | seconds |
| Sandbox (offline) | `SKEIN_LIVE=false npx vitest run tests/sandbox` | engine over a virtual workspace; metric extraction | seconds, free |
| Live gate | `SKEIN_LIVE=true npx vitest run tests/gate.test.ts` | fixing bug fixtures with a live model | minutes, money |
| Live scenarios | `SKEIN_LIVE=true npx vitest run tests/live/scenarios.test.ts` | short scenarios per loop branch | minutes, money |
| Sandbox (live) | `SKEIN_LIVE=true npx tsx tests/sandbox/live-trace.ts` | one model run over the sandbox, with token breakdown | 1 run, money |
| Session live | `SKEIN_LIVE=true npx tsx tests/sandbox/session-live.ts` | general/respond/start routes, post-task report | minutes, money |
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

The tree operators are specified in `docs/en/ir.md` (a registry of `OP-MV`, `OP-CG`,
`OP-AP`, `OP-RC`, `OP-SR`, `OP-ST`, `TR`, `DER`, `REF`, `PRJ` IDs). Their offline tests
are grouped by operator under `tests/ops/` (`move`, `apply`, `recall`, `search`,
`stop`, `applicable`, `traversal`, `derivation`); the invariants are exercised on 400 random legal
trees (`tests/ops/ir_properties.test.ts`); and `tests/coverage.test.ts` fails if any registry
ID has no test or a test cites an ID outside the registry.

## 3. Live gate

```sh
SKEIN_LIVE=true npx vitest run tests/gate.test.ts
```

Runs a live model over the `fixtures/bugfix/*` fixtures: the agent must fix a failing
test without editing the tests. Timeout — 300 s per fixture. Needs a key (§9).

### Live scenarios

Short scenarios for individual loop branches (recall/search, hypothesis revision,
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
separate acceptance program. A request ends at the doxa's own `stop` — the terminal move's `stop`
ends the request, with no criterion gate — so a request that names no literal command
still closes once the model moves to Hand-off and stops.

Hard checks (fail the test): whether the request was
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

### Session live

Two synthetic scripts exercise the session container with a real model and a fixed
workspace (run only with `SKEIN_LIVE=true`):

```sh
SKEIN_LIVE=true npx tsx tests/sandbox/session-live.ts  # general read -> task -> report
SKEIN_LIVE=true npx tsx tests/sandbox/general-live.ts  # analysis -> general, read-only, no task
```

`session-live` checks the dialogue across all three routes (`general`, `respond`, `start`) and the post-task report;
`general-live` asks a general question about a mini-project and asserts that the session agent
routes to `general`, the general unit uses `read`/`grep`/`list`, no coding task is opened, and
the answer is Markdown with paths. The scripts print every session call/result and the final
view.

### IR operation steps

`SKEIN_LIVE=true npx vitest run tests/live/ir_operations_step.test.ts` builds each
operation family's projection **offline** (exactly what the engine would show) and
asserts the **shape** of the live model's next move: interpret the request, run a ready
criterion, poll a background job, retry a non-decisive (timeout) criterion, apply the
next plan action, follow a focus hint. `SKEIN_STEP_REPEATS=N` (default 3)
retries a step, so a stochastic miss is not a failure. The specification and the coverage
map are `docs/en/ir.md` (EN + RU).

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
scripted proposer through the real loop and checks growth and the cut when a state closes
(a state's turns stay on the tape while it is open and elide on `stop`; there is no working
set — `recall`/`search` are nodes now, like any step); the metrics come from `tests/workset.ts`
(the same as in the live dump). This validates the policy over hundreds of turns
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
  An observer call counts too: it is a real model call and a real cost. Because the observer
  runs in `progress`, after the turn's delta, its call is charged to the **next** turn; with
  no next turn (it fired on the last one) it is charged to the last turn.
- `toolCalls` — one per turn (**no** forced `tool_choice`); a **refused** proposal is still
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

Real terminal-bench tasks run locally with the real engine and the task's own verifier. All 13
tasks take one path, **Docker rootless**:

- The task's own image (`alexgshaw/<task>:20251031`) carries the exact environment, so nothing
  is installed on the host. The container starts directly from the image; `/app` is **not**
  copied to the host or bind-mounted. File tools, `grep/list`, `bash`, background jobs and the
  checkpoint run through `docker exec`; `grep`/`listFiles` return workspace-relative paths like
  `fsWorkspace`. The store is `/tmp/.skein` in the container (`DockerBackend`). The agent's
  network follows `--net` (`on` = bridge, `off` = detached); a sane `--ulimit nofile` is set
  (valgrind), and git `safe.directory=*`.
- Acceptance is the task's own **`tests/test.sh`**, staged after the agent and run in the
  agent's container (Harbor's path). It bootstraps its runtime (`apt`/`uv`/`pip`), so
  `regex-log` needs no Python in its image. The verifier keeps its own network even when the
  agent is offline; the reward is `/logs/verifier/reward.txt`.
- **bwrap** (`container.ts`) remains only for `bench/minimal.ts` and the image-less fallback;
  the opencode baseline uses the legacy bind-mounted Docker path, and the task path is rootless.

Ported (13): `regex-log`, `fix-git`, `log-summary-date-ranges`, `openssl-selfsigned-cert`,
`git-leak-recovery`, `cobol-modernization`, `modernize-scientific-stack`,
`custom-memory-heap-crash`, `password-recovery`, `db-wal-recovery`, `crack-7z-hash`,
`fix-code-vulnerability`, `fix-ocaml-gc`.

| File | Role |
| --- | --- |
| `tests/sandbox/docker.ts` | the Docker `Workspace` (rootless: image → `docker exec`; batched `signatures`) |
| `tests/sandbox/docker.test.ts` | rootless: `fetchTo` (docker cp) and `list`/`grep`/`listFiles` parity |
| `tests/sandbox/checkpoint-docker.ts` | `DockerBackend`: checkpoint store `/tmp/.skein` in the container |
| `tests/sandbox/container.ts` | the bwrap `Workspace` (`bench/minimal`, image-less fallback); file tools rewrite the `/app/` prefix |
| `tests/sandbox/task.ts` | `SandboxTask` + Harbor-cache lookup + the legacy pytest-free runner and shim |
| `tests/sandbox/network.ts` | `--net on/off`: agent attachment vs verifier attachment |
| `tests/sandbox/harness.ts` | `runTask`: materialize → setup → `runAgent` → stage `test.sh` → run → `reward.txt` |
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
npx tsx tests/sandbox/sandbox-run.ts <task-id> [--turns N] [--net on|off]
```

`--net on` (Harbor-like) gives the agent the bridge. `--net off` detaches it from the agent
and denies the HOST-side `fetch` (and host `run` where present) their internet: the CLI routes
their `curl` through an allowlist proxy that permits only the model API. The verifier is
independent and always has network — `test.sh` needs it to install its runtime. A task that
requires network for the agent (`crack-7z-hash`) is refused under `--net off`. The platform
baseline is the opencode `--net off` run (`opencode-run.ts`).

A run uses the task's own `maxTurns` when set (a build-heavy task like `fix-ocaml-gc`
sets 60 — its criterion rebuilds the whole compiler and each background poll costs a
turn), else 80; an explicit `--turns N` overrides both.

Output — `bench/runs/sandbox-tasks/<ts>-<id>-<random>/`: `contexts.ndjson` (the projection per
turn), `result.json` (`stopReason`, `reward`, the verifier result, the IR journal),
`metrics.json` (the same totals/splits as §3.5), `reward.txt` (the verifier's score).

The opencode baseline runs the same task in the same image (`npx tsx
tests/sandbox/opencode-run.ts <task-id> [--net on|off]`). Besides `opencode.txt` (the raw
`--format json` event stream) and `metrics.json`, its model calls are captured through a
logging reverse proxy on the `baseURL` (`api-log-proxy.mjs`): the raw
`api-requests.ndjson`/`api-responses.ndjson` are written, and the derived `contexts.ndjson`
(the exact context per call — messages + tools) and `reasoning.ndjson` (the streamed
reasoning) are the analogues of Skein's artifacts. `opencode run --format json` and
opencode's session DB expose neither the prompt nor the reasoning text.

The task's own `tests/` is copied to `/tests` **after** the agent has run, never before: the
agent's shell can read `/tests` otherwise, and the task's Harbor `test.sh` re-clones the exact
revision to fix (it names the solution). `test.sh` runs in the agent's container with its
environment, so an agent-installed package is visible to acceptance. The verifier is
re-materialized from the task cache at check time, so the reward stays reproducible.

**Verifier.** The reward is `/logs/verifier/reward.txt`, written by `test.sh`; its exit code is
not authoritative (the scripts end with a successful `echo` even when pytest failed). A
missing file is a verifier failure, not a pass. `test.sh` installs its own `uv`/Python/pytest
and, for `fix-ocaml-gc`, re-clones and rebuilds the compiler — the verifier runs with network
even when the agent is offline. `checkIn`/`checkSetup` remain only for the legacy/bwrap path;
opencode also runs the task's `test.sh`.

**Isolation / limitations.** `--net off` removes the agent's network (a task that requires it,
`crack-7z-hash`, is refused); the verifier keeps its own network. No host home is mounted, and
root-owned files are wiped from inside the container on teardown. `fetch` downloads on the host (allowlist/constraints) and copies the
bytes into the container; background jobs in rootless mode run in the container. bwrap
(`container.ts`) shares the host `/usr` and is used only by `bench/minimal` and the image-less
fallback.

**Adding a task.** Write `tests/sandbox/tasks/<id>.ts` with `{ id, image?, files?, setup?,
check?, workdir?, checkIn?, checkSetup?, network?, maxTurns? }` — `request` defaults to the cached
`instruction.md`; the Docker path uses the cached `tests/test.sh`; `files` mirror a Docker
`COPY`, `setup` a Dockerfile/`setup.sh` step. `check`/`checkIn`/`checkSetup` are legacy. Register it in `tasks/registry.ts`. Verify it
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
| `SKEIN_EVENTS` | IR diagnostics: states, plans, alternatives, `observations`, `mutates`, rejections |
| `SKEIN_METRICS` | summary: tokens, `context` `first/last/peak/growth`, graph |

`contextChars` is computed from the same `promptText(context)` that goes into
`buildMessages`, so the size in the log equals the sent context. Executed commands
appear in `SKEIN_PROPOSAL` (proposed) and in
`SKEIN_EVENTS.observations`/`.actions` (actual, including the run command). The local
bench writes the same into `bench/runs/<...>/` (§4).

## 8. Tool and projection limits

There is no global context budget: a tool honestly returns its result within declared
limits, and the projection does not cut it (`docs/en/tools.md`).

| Limit | Value | Meaning |
| --- | --- | --- |
| `GREP_COUNT_DEFAULT` | 50 | `grep` matches in a window by default |
| `MAX_GREP_MATCHES` | 100 | maximum `grep` matches per window; continuation via `next`/`from` |
| `GREP_BEFORE_DEFAULT` / `GREP_AFTER_DEFAULT` | 3 / 3 | `grep` context lines around each match |
| `MAX_LIST_FILES` | 200 | maximum files per `list` window |
| `READ_LIMIT` | 32768 | byte cap (32K) for a `read` window (bounded by bytes, no line cap; leaves room for the `continue from` trailer); a larger body is read as the next window or via `recall` |
| `GREP_LIMIT` / `LIST_LIMIT` | 8192 | small byte cap (8K) for a `grep`/`list` result: a localization pointer, not content; excess `grep` matches / `list` entries are dropped whole (for `grep`, a `continue from` trailer) |
| `RUN_LIMIT` | 8192 | small byte cap (8K) for `run`; the tail is shown, the full stream stays behind `outputRef`/`errorRef` (stdout/stderr separate) |
| `QUERY_BODY_LIMIT` | 65536 | cap for a `recall` body window; the window is shrunk by lines so the JSON-escaped result stays valid |
| `SKEIN_CTX_ITEMS` | 20 | items in the projection's `plan`/`alternatives` |

### 8.1 Robust structured output

The agent proposes through **native tool calls**: `src/llm/tools.ts` defines one flat
function tool per operation (`move`, `recall`, `search`, `read`, `grep`, `list`,
`edit`, `write`, `run`, `fetch`, `apply_patch`, `stop`) and `src/llm/structured.ts` `invokeTools` binds them with
no forced `tool_choice` (see `docs/en/state_testing.md` §7), reads `tool_calls[0]` and maps it to the IR `Action`. Flat,
per-operation schemas matter: one deeply nested discriminated union came back flat
(`operator` at the top level instead of nested under `action`), and JSON mode made the
model reason far more on hard turns (and hit the completion cap, whose retries re-sent
the whole projection). When a response is cut at the cap (`finish_reason: "length"`) and
carries no call, `invokeTools` retries ONCE at the ceiling with an explicit brevity
instruction (call the tool now, do not restate analysis) — it does **not** keep doubling
the cap, which only invites more reasoning (a live `fix-ocaml-gc` run turned one `read`
into 4 calls / 60.9k completion tokens); a bare no-call gets one repair round. A **thrown**
provider call (network/5xx/rate limit) is a different failure: the SAME request is resent
`SKEIN_LLM_RETRIES` times (default 2) with a small backoff, so a flaky provider does not sink
the run. Only when the retries and the repair rounds are exhausted does the loop stop with
`stopReason: "llm_error"` instead of crashing; the message is then recorded on `stopText`
(the run trace's `result.json`/`metrics.json`), not only in a transient turn.

`invokeStructured` remains the generic JSON path (schema spelled out in the prompt,
`response_format: json_object` through the provider options, manual parse, raised cap on a
completion cut, one repair round); it is covered offline in `tests/structured.test.ts` with
an AI SDK mock model and used by no agent path. The wire format itself is pinned by
`tests/wire.ts`, which drives the real `@ai-sdk/openai-compatible` serialization through a
stub `fetch`.

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

## Skein — testing on tasks

>
> How to test behaviour on real terminal-bench tasks: the sandbox without Harbor, Harbor,
> the step-by-step container driver, and the fast `bench/turn.ts` probe.
> Related: `docs/en/state_testing.md` (the tape, the states and the live-step driver).

### 0. What to use

| question | tool | container | model | cost |
|---|---|---|---|---|
| types, IR, projection, prompt | `npm run typecheck`; `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` | no | no | seconds, free |
| engine on a synthetic task | `tests/sandbox/live-trace.ts`, `tests/sandbox/fix-ocaml.test.ts` | bwrap/virtual workspace | optional | seconds–cents |
| full real task run + reward | `tests/sandbox/sandbox-run.ts` | Docker | yes | minutes, ₽ |
| behaviour turn by turn (real engine) | `bench/live-step.ts` | Docker, long-lived | yes | ₽ |
| quick wording A/B on one turn | `bench/turn.ts` | no | yes | cents |
| official terminal-bench | `bench/harbor/run.sh` | Harbor/Docker | yes | long, ₽ |
| compare with opencode | `tests/sandbox/opencode-run.ts`, `bench/agents_compare.ts` | Docker | yes | ₽ |

Rule: **check code and prompt offline first**; a live run is for questions about model
behaviour.

### 1. The sandbox without Harbor

The sandbox is the ported terminal-bench tasks under `tests/sandbox/`. It runs the **real
engine** (`runAgent`), the real tools and **the task's own verifier**, without Harbor:

- a task is described in `tests/sandbox/tasks/<id>.ts` (`SandboxTask`) and registered in
  `tests/sandbox/tasks/registry.ts`;
- the task files (`instruction.md`, `tests/`, `solution/`) come from the Harbor cache
  `~/.cache/harbor/tasks/<hash>/<id>/` and are never copied into the repository;
- every ported task (including `regex-log`) runs in Docker **rootless**: the container starts
  from the image; `/app` is **not** extracted to a host temp root or bind-mounted. File tools
  (`read/write/edit/grep/list`), `bash`, background jobs and the checkpoint run in the
  container via `docker exec`; `grep`/`listFiles` return workspace-relative paths. The store is
  `/tmp/.skein` inside the container (`DockerBackend`). A task without `image` (none today)
  would fall back to `bwrap`
  (`tests/sandbox/container.ts`), which is kept for the opencode baseline/`minimal`;
- `setup` runs before the agent; the task's own **`tests/test.sh`** runs after the agent, in
  the agent's container, exactly as Harbor runs it. The tests are copied to `/tests` only then,
  so they cannot leak into the workspace. `test.sh` bootstraps its own runtime (`apt`/`uv`/
  `pip`), and the reward is its `/logs/verifier/reward.txt` (not its exit code);
- the verifier keeps its own network: `--net off` detaches the network from the **agent** only
  (`tests/sandbox/network.ts`). `checkIn`/`checkSetup` are legacy/bwrap-only; opencode also
  runs the task's `test.sh`.

- the checkpoint layer (`CheckpointBackend`; `HostBackend` for bwrap/virtual,
  `DockerBackend` for Docker) provides read-only snapshots and the failed-Patch revert;
- `runTask`/`openTaskWorkspace` (`tests/sandbox/harness.ts`) is the shared setup for the full
  run and the step driver; Docker takes the rootless path.

Useful `SandboxTask` fields: `image`, `workdir`, `mountPoint`, `setup`, `maxTurns`,
`network` (the task requires network for the agent), and — for the legacy/opencode path only —
`check`, `checkIn`, `checkSetup`.

#### Full run

```sh
npx tsx tests/sandbox/sandbox-run.ts <task-id> [--turns N] [--net on|off]
```

- without `--turns`, `task.maxTurns` is used (e.g. 60 for `fix-ocaml-gc`), else 24;
- `--net on` (Harbor-like) gives the agent the bridge; `--net off` detaches it from the
  agent and denies the **host-side** `fetch` via an allowlist proxy (model API only). The
  verifier always keeps its network, so `test.sh` can install Python/pytest. A task that
  requires network for the agent (`crack-7z-hash`) is refused under `--net off`;
- `metrics.json` records `network` (requested), `networkAgent`, `networkVerifier`,
  `acceptance` (`test.sh`) and `rewardSource` (`reward.txt`);
- each run writes `bench/runs/sandbox-tasks/<ts>-<id>-<random>/` (a unique suffix keeps
  parallel runs separate): `contexts.ndjson`, `result.json`, `metrics.json`, `reward.txt`,
  `reasoning.ndjson`;
- `reward=1` — the task's verifier passed; `stop=request_addressed` — the engine closed the
  request;
- diagnostics: `SKEIN_TIMINGS=1` prints `capture`/`model` timing, `SKEIN_TRACE_ACTIONS=1`
  prints the action arguments.

#### Offline task check (no model)

```sh
## no-op → 0, solution/solve.sh → 1; Docker + verifier, no model
SKEIN_LIVE=false npx vitest run tests/sandbox/tasks.test.ts
## the slow fix-ocaml-gc rebuild, on demand
SKEIN_SLOW_TASKS=1 SKEIN_LIVE=false npx vitest run tests/sandbox/tasks.test.ts -t fix-ocaml
```

These are **not** "free" tests: they start containers and use images. Run deliberately.

#### Virtual spec

`tests/sandbox/specs/fix-ocaml-gc.ts` is a miniature of the task with emulated
`make`/testsuite, no Docker and no network:

```sh
SKEIN_LIVE=false npx vitest run tests/sandbox/fix-ocaml.test.ts
SKEIN_LIVE=true npx tsx tests/sandbox/live-trace.ts
```

`live-trace.ts` writes `bench/runs/sandbox-live-<ts>-fix-ocaml-gc/`; it is good for the
trajectory shape, not for the real task's reward.

#### Opencode baseline

```sh
npx tsx tests/sandbox/opencode-run.ts <task-id> [--net on|off]
```

Same image and verifier, a different agent. Trace: `opencode.txt`, `metrics.json`,
`api-requests.ndjson`, `api-responses.ndjson`, `contexts.ndjson`, `reasoning.ndjson`.

#### Matrix for one task

`matrix.ts` runs the whole `agent × net × repeat` grid for **one** task, each cell in its own
child process (isolated `--net off` proxy env, killable on a wall-clock timeout):

```sh
npx tsx tests/sandbox/matrix.ts regex-log \
  --agents skein,opencode --nets on,off --repeat 3 \
  --concurrency 6 --timeout 1200 --resume
```

- the task is an argument, not a baked-in list: the full campaign is one invocation per task
  (a shell loop outside); there is no "all tasks" default;
- `--turns` (Skein) defaults to `task.maxTurns`; `--max-steps` caps opencode; `--timeout` is
  the hard wall clock of a cell (agent + verifier);
- cells with `--net off` for a task that declares `network` (crack) are `unsupported`, not run;
- `--resume` skips finished cells; `--only-failed` reruns everything not `ok`; `--dry` prints
  the grid without spawning;
- output: `bench/runs/matrix/<ts>-<task>/` with `manifest.json` (updated per cell),
  `summary.json`, and `cells/<agent>-net<mode>-r<n>/` (the usual trace files plus `run.log`).
  A killed cell leaves `.timeout`; `--resume` reruns it.

### 2. Harbor

Harbor is the official terminal-bench runner. It runs a task end to end (environment, agent,
official verifier) in a Harbor job and is used for **official acceptance** and agent
comparison, not for step debugging.

```sh
bash bench/harbor/run.sh
## Skein vs opencode comparison
SKEIN_HARBOR_CONFIG=compare.yaml bash bench/harbor/run.sh
```

`run.sh`:

- renders `bench/harbor/*.template.yaml` through `prepare.mjs` (absolute project/jobs paths,
  RouterAI key; the rendered `.yaml` files are gitignored);
- resolves the key from `ROUTERAI_API_KEY`, `OPENAI_API_KEY`, `SKEIN_API_KEY`, or the global
  `~/.config/opencode/opencode.json`;
- runs `harbor run --config ... -y`.

Jobs live **outside the repository**: `~/.skein-bench/harbor/<job>/`. They hold `agent/` logs
(`langgraph-run.log`, `opencode.txt`) and artifacts; analyze with:

```sh
npx tsx bench/agents_compare.ts ~/.skein-bench/harbor/<job>
```

The Harbor task cache (`~/.cache/harbor/tasks/<hash>/<id>/`) is also needed by the sandbox:
without it `materializeTask` cannot find `instruction.md`/the verifier.

### 3. Step-by-step in the container

`bench/live-step.ts` is the **only** step-by-step driver. The engine runs on the host; the
tools run in the task's long-lived container. Each turn is a `runAgent` continuation
(`seed`/`startTurn`), so transitions, refusals, revert and reasoning on the tape are the
engine's.

```sh
npx tsx bench/live-step.ts <task-id> --net off --dir /tmp/opencode/<run>
```

Flags: `--turn N` (stop after absolute turn N), `--auto` (no pauses), `--net on|off`,
`--dir`, `--signal`.

Without `--auto` the process prints the turn and waits:

```sh
touch /tmp/opencode/<run>/continue   # next turn
touch /tmp/opencode/<run>/quit       # stop
```

Files in `--dir`:

| file | contents |
|---|---|
| `contexts/tNNN.txt` | exactly the messages sent to the model |
| `reasoning.ndjson` | the provider's hidden reasoning (diagnostics, not the tape) |
| `turns.ndjson` | calls, usage, cost, stop reason |
| `journal.ndjson` | the full event journal after each turn |

Watch: which state closed the turn (`stop`/`move`), the `reasoning` volume, the calls, the
tree diff; on `plan`/`working` the tape ends with the per-turn tail.

### 4. Fast probe: `bench/turn.ts`

Replays **one recorded turn** from a `sandbox-tasks` trace through the live model — no
container. It is the cheap way to compare wordings on the same input.

```sh
npx tsx bench/turn.ts <run-dir-or-trace> --turn N
```

Flags:

| flag | meaning |
|---|---|
| `--turn N` / `--turns A-B` / `--turns 6,8,10` | which turns to replay |
| `--list` | list the trace's turns |
| `--dry` | build the messages and the tool surface, no model call |
| `--repeat K` | K samples of one turn |
| `--append-system "..."` | append a system message |
| `--patch patch.json` | edit the recorded messages (append/insert/remove/replace) |
| `--rebuild` | re-render the prompt from the current code over the recorded `history` |
| `--reasoning` | print the reasoning |
| `--responses` | print the raw model responses per attempt |
| `--dump out.txt` | save the resulting messages |
| `--model M` | another model |

`--rebuild` is for changing **projection/prompt code**: it takes `history` from the trace and
calls the current `buildMessages`. `--patch` edits the recorded messages without rebuilding;
it cannot be combined with `--rebuild`. `--append-system` works in both modes.

`--rebuild` reuses the recorded `history` as-is. On an old trace a closed state may still carry
the instruction/workspace blocks of the former projection, which invites a spurious second look:
a single `L → P` transition probe on such a history chose `Research` in 3/10 samples, while a
fresh tape (a closed state is only `Start`/`Finish`) chose `Patch` 10/10. For transition probes,
build a fresh tape or a minimal synthetic `history`, not an old `--rebuild` trace.

Example patch file:

```json
[
  { "op": "replace", "match": "A suspected cause is enough", "text": "Stop now." },
  { "op": "append", "role": "system", "text": "Do not compare with upstream." }
]
```

Limits: no container, no real transitions/revert, the tool surface is reconstructed from
`situation` (and the island), not from `Context.applicable`. So `turn.ts` is for wordings and
tool selection, not for proving engine behaviour. At temp 0.1 use `K≥3`.

### 5. Supporting tools

- `bench/rollout.ts <run> [--turns N] [--dry]` — builds a **fresh** tape with the current
  projection and rolls the model forward; observations are taken positionally from the
  recording. It is a decision replay, not an environment.
- `bench/replay.ts <trace-or-scenario> [--limit N] [--offset N]` — the same recorded contexts
  through the live model.
- `bench/minimal.ts` — a no-IR micro-agent (4 messages) for hint A/B.
- `tests/live/*` — live scenario/step tests (`SKEIN_LIVE=true`).
- `bench/gate.ts` + `baseline.json` — a metrics regression gate.

### 6. Reading a trace

`metrics.json` (`tests/sandbox/metrics.ts`):

- `in` = `freshInput` + `cacheRead`; `out` = `visibleOutput` + `reasoningTokens`;
- `cacheHitRatio`, `costRub`, `contextChars` (`first/last/peak`);
- `perTurn`: `operator`/`tool`, `chars`, `llmCalls`, tokens, `refused`.

`contexts.ndjson` — the projection/messages per turn; `result.json` — `stopReason`, `reward`,
the verifier and the IR journal; `reward.txt` — the verdict.

### 7. Rules

- **Live runs need the owner's explicit go-ahead.** They cost time and money.
- **Never** run `npx vitest run` without `--exclude 'tests/sandbox/**'` for an ordinary check:
  the sandbox tests self-enable with Docker + images and start containers.
- Offline: `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'`.
- One factor at a time; `SKEIN_TEMPERATURE=0.1` is noisy — `K≥3`, not a single sample.
- Compare only within one harness: `turn.ts`, `live-step`, `sandbox-run` and Harbor differ in
  turn counts and in what they actually test.
- Secrets live only in `.env` (gitignored).
- After a run, containers/temp trees must be gone (`cleanupContainers`, `cleanupSandboxes` run
  in `finally`; after a manual kill, check `docker ps`).

### 8. Cheat sheet

```sh
npm run typecheck
SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'

## full task run (Docker + verifier)
npx tsx tests/sandbox/sandbox-run.ts fix-ocaml-gc --net off --turns 60

## step by step, with pauses
npx tsx bench/live-step.ts fix-ocaml-gc --net off --dir /tmp/opencode/loc
touch /tmp/opencode/loc/continue

## matrix for one task (agents × net × repeat), resumable
npx tsx tests/sandbox/matrix.ts regex-log --agents skein,opencode --nets on,off --repeat 3 --dry
npx tsx tests/sandbox/matrix.ts regex-log --agents skein,opencode --nets on,off --repeat 3 --concurrency 6 --timeout 1200 --resume

## quick A/B of a recorded turn
npx tsx bench/turn.ts <run> --list
npx tsx bench/turn.ts <run> --turn 8 --dry
npx tsx bench/turn.ts <run> --turn 8 --repeat 3
npx tsx bench/turn.ts <run> --turns 6-8 --rebuild --append-system "..."

## official acceptance / comparison
bash bench/harbor/run.sh
SKEIN_HARBOR_CONFIG=compare.yaml bash bench/harbor/run.sh
npx tsx bench/agents_compare.ts ~/.skein-bench/harbor/<job>
```

### 9. Troubleshooting

- **`Harbor task cache not found` / `task not cached`** — no
  `~/.cache/harbor/tasks/<hash>/<id>/`; both the sandbox and Harbor need it.
- **Docker image missing** — the task looks for `alexgshaw/<id>:20251031`; check
  `docker images`.
- **`stop=max_turns`** — the budget ran out; raise `--turns` (but first understand why the
  model did not close).
- **`--net off` and `fetch`/`curl` → 403** — expected: the allowlist permits only the model
  API.
- **No reasoning on the tape** — `SKEIN_REASONING_TAPE=false`; reasoning on the tape is on by
  default. `bench/turn.ts` replays the recorded messages by default; `--reasoning` prints the
  reasoning, `--responses` the raw responses.
- **Transport `llm_error`/retry** — check `turns.ndjson`/the log; an internal retry does not
  lose turns but costs more.
- **Verifier sees its own `test.sh`?** — it is copied to `/tests` only after the agent and
  runs in its container; if you touch the harness, do not move staging before the run.
- **`test.sh` failed at apt/uv/pip** — the verifier keeps its own network even under
  `--net off`; inspect stderr in `result.json`. `rewardSource:"missing"` means
  `/logs/verifier/reward.txt` never appeared.
- **A container is left behind** — `docker ps | grep skein`, then `docker rm -f <name>`;
  normally `cleanupContainers()` handles it.
