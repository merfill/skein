# Skein — testing and benchmarks

> Russian mirror — `docs/ru/testing.md`.
>
> How to run offline tests, live checks, sandbox tasks and step-by-step debugging.
> Related: `ir.md` (the model and the tape), `ir_operations.md` (the operator registry),
> `projection.md` (the tape), `sessions.md` (sessions and agents), `AGENTS.md` (the
> working rules).

## 1. Layers and commands

| Layer | Command | What it checks | Cost |
|---|---|---|---|
| Types | `npm run typecheck` | `tsc --noEmit` | seconds |
| Offline tests | `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'` | IR, projection, loop, gates | seconds |
| Sandbox, virtual | `SKEIN_LIVE=false npx vitest run tests/sandbox/fix-ocaml.test.ts` | the loop on a virtual workspace | seconds, free |
| Sandbox metrics | `SKEIN_LIVE=false npx vitest run tests/sandbox/metrics.test.ts` | token and call accounting | seconds, free |
| Live gate | `SKEIN_LIVE=true npx vitest run tests/gate.test.ts` | fixing bug fixtures with a live model | minutes, money |
| Live scenarios | `SKEIN_LIVE=true npx vitest run tests/live/scenarios.test.ts` | short scenarios per loop branch | minutes, money |
| Live sessions | `SKEIN_LIVE=true npx tsx tests/sandbox/session-live.ts` | general/respond/task routes and the report | minutes, money |
| Live plan | `SKEIN_LIVE=true npx tsx tests/sandbox/session-plan.ts <task-id> [--virtual]` | plan unit, item execution and the task's verifier | minutes, money (Docker for a real task) |
| Live operations | `SKEIN_LIVE=true npx vitest run tests/live/ir_operations_step.test.ts` | the next move of a live model on a built projection | minutes, money |
| Synthetic bench | `npm run bench -- <case>` | one case from `skein-plugin` | minutes, money |
| Bench gate | `npm run bench:gate -- <runDir>` | a run against `bench/baseline.json` | seconds |
| Step by step | `npx tsx bench/live-step.ts <task-id>` | the real loop, one turn at a time | minutes, money |
| Fast probe | `npx tsx bench/turn.ts <run>` | one recorded turn, no container | cents |

**Offline by default.** Live checks and benches run only with the owner's explicit go-ahead.

**Never run bare `npx vitest run`.** It collects `tests/sandbox/**`, which self-enable on a machine
with Docker and the task images and launch real containers and verifiers. For an ordinary check,
always use `--exclude 'tests/sandbox/**'`.

### 1.1 First-run acceptance (release)

A clean install must reach a working provider without a repo checkout. The offline half is free;
the live half needs a real key and the owner's go-ahead.

Offline (pack, install into an isolated HOME, no key):

```sh
npm run build
npm pack --pack-destination /tmp/skein-firstrun
mkdir -p /tmp/skein-firstrun/install && cd /tmp/skein-firstrun/install
npm init -y && npm install /tmp/skein-firstrun/skein-swe-0.1.0.tgz
export HOME=/tmp/skein-firstrun/home XDG_CONFIG_HOME=$HOME/.config XDG_DATA_HOME=$HOME/.local/share
node_modules/.bin/skein --version      # skein 0.1.0
node_modules/.bin/skein --help
node_modules/.bin/skein auth list      # no keys -> suggests `skein auth login`
node_modules/.bin/skein doctor         # not ready: API key is not set; exit 1
node_modules/.bin/skein </dev/null     # no TTY -> clear "run auth login" error; exit 1
```

Live (real key, network) — in the Docker image or a fresh HOME:

```sh
skein auth login          # provider, masked key, model
skein doctor              # models + one-token chat ok
skein --dir <project>     # the TUI starts
```

Then run one small task to completion, and confirm provider failures (401/404/timeout) print a
clear error. `npx skein-swe` itself is only testable after the package is published.

With Docker, `--env-file` does not strip quotes (a `SKEIN_MODEL='...'` value reaches the API with
the quotes). Source `.env` and pass variables with `-e VAR`, or keep the values unquoted.

## 2. Offline tests

`.env` is gitignored and sets `SKEIN_LIVE=true`; an environment variable wins over the file. For an
ordinary check:

```sh
npm run typecheck
SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'
```

The operator registry lives in `docs/en/ir_operations.md`; its tests are grouped by operator in
`tests/ops/` (`move`, `apply`, `recall`, `search`, `stop`, `applicable`, `traversal`,
`derivation`). The invariants are checked on 400 generated IRs
(`tests/ops/ir_properties.test.ts`). `tests/coverage.test.ts` fails if a registry id has no test,
or if a test cites an id outside the registry.

The virtual sandbox (`tests/sandbox/specs/fix-ocaml-gc.ts`) runs the real loop on a small tree
without Docker: the defect edit switches the emulated check from fail to pass. It is free and is
the first place to test an executor change.

## 3. Live checks

### 3.1 Live gate

```sh
SKEIN_LIVE=true npx vitest run tests/gate.test.ts
```

The gate runs a live model on `fixtures/bugfix/*`: the agent must fix a failing test without
editing the tests. The timeout is 300 s per fixture. A key is required (see §7).

### 3.2 Live scenarios

Short scenarios cover individual loop branches: `recall`/`search`, revising a hypothesis,
constraints, answering without a change, and searching across many files. The command matrix
(`fail-recover`, `script-two-bugs`, `make-command`, `verbatim-flag`, `command-from-package`)
covers tasks whose condition includes a real command. The strategic scenarios are
`reference-diff` and `no-vcs`.

Fixtures live in `fixtures/scenarios/<name>/{repo, request.txt, check.sh?, constraints.json?}`;
`check.sh` is optional and defaults to `node --test`.

```sh
SKEIN_LIVE=true npx vitest run tests/live/scenarios.test.ts
SKEIN_SCENARIOS=two-outputs,revise-hypothesis SKEIN_LIVE=true npx vitest run tests/live/scenarios.test.ts
SKEIN_SCENARIO_REPEATS=3 SKEIN_SCENARIOS=script-two-bugs SKEIN_LIVE=true npx vitest run tests/live/scenarios.test.ts
```

Scenarios are independent and run in parallel (`it.concurrent`, `test.maxConcurrency: 5`). Each
test cleans its own temporary root.

The harness runs only `runAgent`; there is no separate verification program. A request ends when its
terminal state is closed, and no criterion gate exists. Hard checks are: whether the request was
addressed, the invariants (`tests/invariants.ts`), the immutability of `test/` and explicit paths,
the number of distinct repeated results (`maxRepeats`), forbidden edits, and the shape of `bash`
commands (`expect.commands`). `SKEIN_SCENARIO_REPEATS=N` runs each scenario N times and reports the
pass rate; a soft branch report goes to stdout.

Full projections and journals are written to
`bench/runs/live-<ts>-<name>/{contexts,events}.ndjson`, together with `workset.ndjson`,
`workset.json` and `run.json`.

### 3.3 Live sessions

```sh
SKEIN_LIVE=true npx tsx tests/sandbox/session-live.ts  # general -> task -> report
SKEIN_LIVE=true npx tsx tests/sandbox/general-live.ts  # analysis -> general, read-only, no task
```

`session-live` checks the three routes (`general`, `respond`, `task`) and the post-task report;
`general-live` checks that a question about the project routes to `general`, that the general unit
reads with `read`/`grep`/`list`, and that no coding task is opened. The `document` unit is covered
offline (`tests/document_unit.test.ts`); there is no dedicated live harness for its route yet.

### 3.3.1 Live plan sessions

```sh
SKEIN_LIVE=true npx tsx tests/sandbox/session-plan.ts fix-ocaml-gc --virtual --turns 20  # cheap
SKEIN_LIVE=true npx tsx tests/sandbox/session-plan.ts fix-ocaml-gc --turns 60            # Docker
SKEIN_LIVE=true npx tsx tests/sandbox/session-plan.ts custom-memory-heap-crash --turns 80
```

`session-plan` forces the first operation to `plan`, then executes the items with the real
session agent, planner and task/general agents, and scores the result with the task's own
acceptance (`test.sh` for a Docker task, the spec's command for `--virtual`). It prints the plan,
each item's outcome and the reward; `plan.json`, `run.json` and `session.json` land under
`bench/runs/session-plan/`. The virtual run is cheap; a real Docker task costs minutes and money.

### 3.4 Live operation steps

```sh
SKEIN_LIVE=true npx vitest run tests/live/ir_operations_step.test.ts
```

The test builds the projection offline, then checks the shape of the live model's next move.
`SKEIN_STEP_REPEATS=N` (default 3) repeats a step, so a stochastic miss is not a failure.

### 3.5 Trace replay

```sh
npm run replay -- <trace-or-scenario> [--limit N] [--offset N] [--model M]
```

The replay takes a recorded trace (a scenario's `contexts.ndjson` or a saved agent log with
`SKEIN_CONTEXT`/`SKEIN_PROPOSAL` lines), rebuilds `buildMessages(context)`
for every turn and runs the current `invokeTools` on the same context. It prints the proposed and
recorded operator, output tokens and finish reason, then a summary. This is the cheap way to debug
a prompt or schema on a real distribution of contexts.

The long-horizon tape is also simulated offline: `tests/workingset.test.ts` runs a scripted
proposer through the real loop and checks growth and the cut on closure. The metrics come from
`tests/workset.ts`.

## 4. Sandbox tasks (real tasks)

Real terminal-bench tasks run locally with the real loop and the task's own verifier. All thirteen
tasks use the same **Docker rootless** path:

- the task image (`alexgshaw/<task>:20251031`) carries the exact environment; nothing is installed
  on the host;
- the container starts from the image; `/app` is neither copied to the host nor bind-mounted;
- file tools, `bash`, jobs and checkpoints run through `docker exec`; `grep`/`list` return
  workspace-relative paths; the checkpoint store is `/tmp/.skein` in the container;
- the task's native `tests/test.sh` runs after the agent, in the agent's container, and writes
  `/logs/verifier/reward.txt`; the verifier has its own network even when the agent is offline;
- `--net on|off` controls the agent's network. A task that needs the network (`crack-7z-hash`) is
  refused with `--net off`.

Ported tasks: `regex-log`, `fix-git`, `log-summary-date-ranges`, `openssl-selfsigned-cert`,
`git-leak-recovery`, `cobol-modernization`, `modernize-scientific-stack`,
`custom-memory-heap-crash`, `password-recovery`, `db-wal-recovery`, `crack-7z-hash`,
`fix-code-vulnerability`, `fix-ocaml-gc`.

Task files are read from the benchmark task cache (`~/.cache/harbor/tasks/<hash>/<id>/`) and are
never copied into the repository.

```sh
# offline: no model, real image(s) and verifier; no-op -> 0, native solution -> 1
SKEIN_LIVE=false npx vitest run tests/sandbox/tasks.test.ts
# the slow fix-ocaml-gc rebuild (minutes), on request
SKEIN_SLOW_TASKS=1 SKEIN_LIVE=false npx vitest run tests/sandbox/tasks.test.ts -t fix-ocaml
# one live task run, with a token breakdown
npx tsx tests/sandbox/sandbox-run.ts <task-id> [--turns N] [--net on|off]
```

`--turns` defaults to the task's `maxTurns` (60 for `fix-ocaml-gc`), otherwise 80; an explicit
`--turns` overrides both.

The run writes `bench/runs/sandbox-tasks/<ts>-<id>-<random>/`: `contexts.ndjson` (the projection
per turn), `result.json` (`stopReason`, reward, verifier output, IR journal), `metrics.json`
(the same totals and breakdowns as §5) and `reward.txt`.

### 4.1 The matrix

`matrix.ts` runs the whole `agent × net × repeat` grid for one task, each cell in its own child
process:

```sh
npx tsx tests/sandbox/matrix.ts regex-log \
  --agents skein,opencode --nets on,off --repeat 3 \
  --concurrency 6 --timeout 1200 --resume
```

The task is an argument; a full campaign is one call per task. `--turns` (Skein) defaults to
`task.maxTurns`; `--max-steps` limits opencode; `--timeout` is a hard wall-clock limit for a cell.
`--resume` skips finished cells; `--only-failed` restarts anything not `ok`; `--dry` prints the grid.
The result is `bench/runs/matrix/<ts>-<task>/` with `manifest.json`, `summary.json` and
`cells/<agent>-net<mode>-r<n>/`.

The full campaign (`tests/sandbox/campaign.ts`) runs all 13 tasks. It runs **one task at a
time**, so `--concurrency` is the total number of simultaneous cells (containers): `5` means
five cells in flight, not five per task. `net on|off` are ordinary grid values; each cell is its
own child process, so the `off` allowlist proxy stays isolated. No wall-clock timeout is passed.

```sh
# free: print the grid and the per-task commands without running anything
npx tsx tests/sandbox/campaign.ts --repeat 5 --concurrency 5 --dry

# the campaign (owner's go-ahead; real containers and model calls)
SKEIN_LIVE=true npx tsx tests/sandbox/campaign.ts --repeat 5 --concurrency 5

# a CPU-heavy task (the OCaml verifier rebuilds) gets its own lower cell limit
SKEIN_LIVE=true npx tsx tests/sandbox/campaign.ts --repeat 5 \
  --concurrency 10 --task-concurrency fix-ocaml-gc=3
```

The result is `bench/runs/matrix/campaign-<ts>/` with `manifest.json` (protocol: commit, node,
Skein/opencode models, K, nets, concurrency, no timeout), `summary.json`, `summary.md`,
`summary.csv`, and one `<task>/` directory per matrix. `--resume` and `--only-failed` pass
through; a task that needs the network is `unsupported` for `net=off`.

### 4.2 The opencode baseline

```sh
npx tsx tests/sandbox/opencode-run.ts <task-id> [--net on|off]
```

The same image and verifier, a different agent. The trace is `opencode.txt`, `metrics.json`,
`api-requests.ndjson`, `api-responses.ndjson`, `contexts.ndjson` and `reasoning.ndjson`.

### 4.3 Adding a task

Write `tests/sandbox/tasks/<id>.ts` with `{ id, image?, files?, setup?, check?, workdir?,
checkIn?, checkSetup?, network?, maxTurns? }`. `request` defaults to the cached `instruction.md`;
the Docker path uses the cached `tests/test.sh`; `files` mirrors Docker `COPY`, and `setup` is the
Dockerfile/`setup.sh` step. Register the task in `tasks/registry.ts`. Check it offline first
(no-op → `reward=0`, native `solution/solve.sh` → `reward=1`), then run it live.

## 5. Step-by-step debugging

### 5.1 `bench/live-step.ts` — the real loop, one turn at a time

This is the only step-by-step driver. The executor and the projection run on the host; the file
tools, `bash`, jobs and checkpoints run in a long-lived task container. Each step continues
`runAgent` through `seed`/`startTurn`, so transitions, refusals, reverts and tape reasoning belong
to the executor.

```sh
npx tsx bench/live-step.ts <task-id> --net off --dir /tmp/opencode/<run>
```

Flags: `--turn N` stops after absolute turn N; `--auto` runs without waiting; `--net on|off`;
`--dir`; `--signal`.

Without `--auto` the process prints a turn and waits:

```sh
touch /tmp/opencode/<run>/continue   # next turn
touch /tmp/opencode/<run>/quit       # stop
```

Files in `--dir`:

| File | Content |
|---|---|
| `contexts/tNNN.txt` | exactly the messages sent to the model |
| `reasoning.ndjson` | the provider's hidden reasoning (diagnostics, not the tape) |
| `turns.ndjson` | calls, usage, cost, stop reason |
| `journal.ndjson` | the full event journal after each turn |

Use this for behavior: when a state closed, where it moved, how much reasoning it spent, what it
called, and the tree diff.

### 5.2 `bench/turn.ts` — one recorded turn, no container

This replays a recorded turn through the live model without a container. It is the cheap way to
compare wordings on the same input.

```sh
npx tsx bench/turn.ts <run-dir-or-trace> --turn N
```

Flags: `--turn N`, `--turns A-B`, `--turns 6,8,10`, `--list`, `--dry`, `--repeat K`,
`--append-system "..."`. `--rebuild` re-renders the current projection over the recorded turn; for
`working` and `terminal` it passes `allowText`, like `propose`, otherwise a text stop is repaired
as a missing tool call and the probe lies.

`turn.ts` is for wordings and single-turn decisions, not for the environment.

### 5.3 `bench/replay.ts` — recorded contexts, as-is

This replays recorded contexts through the live model without rebuilding the projection. Use it to
compare a prompt change on exactly the contexts that were recorded.

### 5.4 Rules

- **One factor at a time.** Streaming, temperature and prompt edits are separate arms.
- **K≥3.** One sample at `temperature=0.1` is not a conclusion.
- **Compare within one harness.** `turn.ts`, `live-step` and `sandbox-run` differ in turn counts
  and environment; a comparison across harnesses is not a comparison.
- **Judge by the action and the reasoning**, not by impression.
- **Offline first.** Code and prompt changes are checked offline before any live run.

## 6. Artifacts and keys

- Every live run writes `contexts`, `turns`, `journal` and (where applicable) `reasoning.ndjson`;
  the exact files depend on the harness and are listed next to the command above.
- `metrics.json` carries the token, cache, reasoning and cost breakdown.
- A key lives only in `.env` (gitignored) or `~/.config/opencode/opencode.json`; it is never
  written to the repository or the logs.

## 7. Principles

- **Offline by default.** Live checks and benches are intentional, expensive runs.
- **Heavy tests need the owner's go-ahead.** This covers `tests/sandbox/**` that launches Docker,
  any `SKEIN_LIVE=true` run and benches.
- **Save what you measure.** The full projection and the commands must land in the artifacts,
  otherwise the run cannot be analyzed.
- **One case, one attempt for executor iterations; the full set for verification.**
- **Compare with a saved run**, not with memory.
- **Minimal diff.** A harness change does not change the executor semantics; the invariants live in
  `tests/invariants.ts`.
