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

**Focused run** (one task, one attempt) — to avoid paying for the whole set: copy
`bench/harbor/skein.yaml`, leave a single task in `datasets[0].task_names`, set
`n_attempts: 1`, then

```sh
OPENAI_API_KEY=... harbor run --config <focused>.yaml -y
```

## 7. Instrumentation: where to look

`langgraph-run.log` receives these lines as the run proceeds (each one JSON):

| Line | Contents |
| --- | --- |
| `SKEIN_CONTEXT` | **the full projection** per turn: `{turn, chars, context}` |
| `SKEIN_PROPOSAL` | the proposed action (including command text) |
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
| `MAX_GREP_MATCHES` | 200 | `grep` matches per call |
| `MAX_RUN_OUTPUT` | 8000 | `run` output; beyond that head+tail and `outputRef` |
| `SKEIN_CTX_ITEMS` | 20 | items in the projection's `plan`/`alternatives` |

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