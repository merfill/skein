# Skein — testing on tasks

> Russian mirror — `docs/task_testing_ru.md`.
>
> How to test behaviour on real terminal-bench tasks: the sandbox without Harbor, Harbor,
> the step-by-step container driver, and the fast `bench/turn.ts` probe.
> Related: `docs/testing.md` (verification layers, gates, metrics),
> `docs/state_testing.md` (the tape and the states), `docs/live_step.md` (the live-step driver).

## 0. What to use

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

## 1. The sandbox without Harbor

The sandbox is the ported terminal-bench tasks under `tests/sandbox/`. It runs the **real
engine** (`runAgent`), the real tools and **the task's own verifier**, without Harbor:

- a task is described in `tests/sandbox/tasks/<id>.ts` (`SandboxTask`) and registered in
  `tests/sandbox/tasks/registry.ts`;
- the task files (`instruction.md`, `tests/`, `solution/`) come from the Harbor cache
  `~/.cache/harbor/tasks/<hash>/<id>/` and are never copied into the repository;
- a task with `image` runs in Docker: the image's `/app` is copied into a temp root, then
  `docker run -d --entrypoint sleep -v <root>:/app ...`; commands are `docker exec`. A task
  without `image` runs under `bwrap` (`tests/sandbox/container.ts`);
- `setup` runs before the agent; the **verifier is staged after the agent**
  (`stageVerifier`) so `test.sh` cannot leak into the workspace;
- `checkSetup` (e.g. an OCaml rebuild) runs before the verifier;
- the checkpoint layer (`createCheckpoint`) provides read-only snapshots and the failed-Patch
  revert;
- `runTask`/`openTaskWorkspace` (`tests/sandbox/harness.ts`) is the shared setup for the full
  run and the step driver.

Useful `SandboxTask` fields: `image`, `workdir`, `mountPoint`, `setup`, `check`,
`checkIn` (`"task"`/`"host"`), `checkSetup`, `maxTurns`, `network`.

### Full run

```sh
npx tsx tests/sandbox/sandbox-run.ts <task-id> [--turns N] [--net on|off]
```

- without `--turns`, `task.maxTurns` is used (e.g. 60 for `fix-ocaml-gc`), else 24;
- `--net off` (recommended) denies the **host-side** `fetch`/`run` via an allowlist proxy
  (model API only); the task container is still `--network none` unless the task sets
  `network`;
- each run writes `bench/runs/sandbox-tasks/<ts>-<id>/`:
  `contexts.ndjson`, `result.json`, `metrics.json`, `reward.txt`, `reasoning.ndjson`;
- `reward=1` — the task's verifier passed; `stop=request_addressed` — the engine closed the
  request.

### Offline task check (no model)

```sh
# no-op → 0, solution/solve.sh → 1; Docker + verifier, no model
SKEIN_LIVE=false npx vitest run tests/sandbox/tasks.test.ts
# the slow fix-ocaml-gc rebuild, on demand
SKEIN_SLOW_TASKS=1 SKEIN_LIVE=false npx vitest run tests/sandbox/tasks.test.ts -t fix-ocaml
```

These are **not** "free" tests: they start containers and use images. Run deliberately.

### Virtual spec

`tests/sandbox/specs/fix-ocaml-gc.ts` is a miniature of the task with emulated
`make`/testsuite, no Docker and no network:

```sh
SKEIN_LIVE=false npx vitest run tests/sandbox/fix-ocaml.test.ts
SKEIN_LIVE=true npx tsx tests/sandbox/live-trace.ts
```

`live-trace.ts` writes `bench/runs/sandbox-live-<ts>-fix-ocaml-gc/`; it is good for the
trajectory shape, not for the real task's reward.

### Opencode baseline

```sh
npx tsx tests/sandbox/opencode-run.ts <task-id> [--net on|off]
```

Same image and verifier, a different agent. Trace: `opencode.txt`, `metrics.json`,
`api-requests.ndjson`, `api-responses.ndjson`, `contexts.ndjson`, `reasoning.ndjson`.

## 2. Harbor

Harbor is the official terminal-bench runner. It runs a task end to end (environment, agent,
official verifier) in a Harbor job and is used for **official acceptance** and agent
comparison, not for step debugging.

```sh
bash bench/harbor/run.sh
# Skein vs opencode comparison
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

## 3. Step-by-step in the container

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

## 4. Fast probe: `bench/turn.ts`

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

## 5. Supporting tools

- `bench/rollout.ts <run> [--turns N] [--dry]` — builds a **fresh** tape with the current
  projection and rolls the model forward; observations are taken positionally from the
  recording. It is a decision replay, not an environment.
- `bench/replay.ts <trace-or-scenario> [--limit N] [--offset N]` — the same recorded contexts
  through the live model.
- `bench/minimal.ts` — a no-IR micro-agent (4 messages) for hint A/B.
- `tests/live/*` — live scenario/step tests (`SKEIN_LIVE=true`), see `docs/testing.md`.
- `bench/gate.ts` + `baseline.json` — a metrics regression gate.

## 6. Reading a trace

`metrics.json` (`tests/sandbox/metrics.ts`):

- `in` = `freshInput` + `cacheRead`; `out` = `visibleOutput` + `reasoningTokens`;
- `cacheHitRatio`, `costRub`, `contextChars` (`first/last/peak`);
- `perTurn`: `operator`/`tool`, `chars`, `llmCalls`, tokens, `refused`.

`contexts.ndjson` — the projection/messages per turn; `result.json` — `stopReason`, `reward`,
the verifier and the IR journal; `reward.txt` — the verdict.

## 7. Rules

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

## 8. Cheat sheet

```sh
npm run typecheck
SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'

# full task run (Docker + verifier)
npx tsx tests/sandbox/sandbox-run.ts fix-ocaml-gc --net off --turns 60

# step by step, with pauses
npx tsx bench/live-step.ts fix-ocaml-gc --net off --dir /tmp/opencode/loc
touch /tmp/opencode/loc/continue

# quick A/B of a recorded turn
npx tsx bench/turn.ts <run> --list
npx tsx bench/turn.ts <run> --turn 8 --dry
npx tsx bench/turn.ts <run> --turn 8 --repeat 3
npx tsx bench/turn.ts <run> --turns 6-8 --rebuild --append-system "..."

# official acceptance / comparison
bash bench/harbor/run.sh
SKEIN_HARBOR_CONFIG=compare.yaml bash bench/harbor/run.sh
npx tsx bench/agents_compare.ts ~/.skein-bench/harbor/<job>
```

## 9. Troubleshooting

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
- **Verifier sees its own `test.sh`?** — it is staged only after the agent
  (`stageVerifier`); if you touch the harness, do not move staging before the run.
- **A container is left behind** — `docker ps | grep skein`, then `docker rm -f <name>`;
  normally `cleanupContainers()` handles it.
