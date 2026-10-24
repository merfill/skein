# Skein vs opencode — task matrix

> Russian mirror — `docs/benches/compare_skein_opencode_ru.md`. Working report, not a
> specification: one section per task, appended as the matrix runs.

## 1. Method

Both agents run in the **same task image**, with the **same `tests/test.sh`** acceptance after
the agent (Harbor semantics, reward from `/logs/verifier/reward.txt`), the same model and the
same reasoning effort. The only intended difference is the agent.

- harness: `tests/sandbox/matrix.ts <task>` (one task per invocation);
- model: `routerai/~deepseek/deepseek-v4-flash-latest`, reasoning `low` (Skein temperature 0.1;
  opencode uses its own defaults);
- cells: `{skein, opencode} × {net on, off} × repeat 1..3`, concurrency 6, per-cell wall
  timeout 1200 s; `--net off` removes the network from the **agent** only — the verifier keeps
  it, so `test.sh` can bootstrap its runtime;
- turn budget: the task's `maxTurns` (Skein); opencode is capped by the same wall clock and
  `maxSeconds`;
- a task that declares `network` (crack-7z-hash) has no `off` cells: they are reported
  `unsupported`, not run.

### Metrics

From each cell's `metrics.json` (median over K=3; all values are per run):

| metric | meaning |
|---|---|
| reward | `1` = the task's own verifier passed |
| turns / steps | Skein turns of the engine; opencode agentic steps — **different units** |
| in | total input tokens, including cache reads |
| fresh | `in − cacheRead`: what the model actually re-read (the honest input axis) |
| out | output tokens, including reasoning |
| reason | reasoning tokens (inside `out`) |
| wall | full cell wall clock: agent + verifier |
| ₽ | Skein: provider-reported `cost`; opencode: derived (see below) |

Medians are over all attempts that recorded a reward, **including `reward0`** (the cost of a
failed try); `solved` counts only `reward=1`.

### Cost derivation for opencode

Skein's `costRub` is the provider's own `usage.cost`. opencode's `metrics.json` omits cost, but
its raw `reasoning.ndjson` still carries the provider's `usage.cost`; the actual agent cost for
`regex-log` is 1.524 / 0.934 / 2.216₽ on and 0.675 / 0.785 / 1.216₽ off (title call included),
so the token-derived estimate below matches it (1.521 vs 1.521 for on r1). The estimate is still
useful when only tokens were captured: it uses the **same per-token rates**, fitted by least
squares on the **Skein cells of the same task** (same model, provider and route at the same
time):

```
cost ≈ fresh·a + cacheRead·b + out·c       (₽ per token; out includes reasoning)
```

For `regex-log` (6 Skein cells) the fit is `a = 17.289`, `b = 0.340`, `c = 69.103` ₽/1M and it
reproduces all six Skein `costRub` values to < 0.001 ₽. The earlier handoff rates
(17.77 / 0.36 / 71.09) differ by ~3%; refit per task when possible. The estimate is marked
`≈` in the tables.

## 2. Status

> **Prompt version.** The Skein cells in §3–§4 were measured on 2026-10-24 **before** the
> Orientation rewrite (`what`/`instruction`/`hint`); opencode is unaffected. With the new
> Orientation, `regex-log` K=3 is 15 turns / 1.532₽ median (3/3) and `openssl` K=1 is 17 /
> 0.722₽ (reward=1). See `docs/plans/handoff_2026-10-24_session12_orientation_matrix_ru.md`.

| task | matrix run | result |
|---|---|---|
| regex-log | 2026-10-24 | 12/12 reward=1, see §3 |
| openssl-selfsigned-cert | 2026-10-24 | 11/12 reward=1 (one opencode `off` miss), see §4 |
| fix-git | — | pending |
| log-summary-date-ranges | — | pending |
| git-leak-recovery | — | pending |
| cobol-modernization | — | pending |
| modernize-scientific-stack | — | pending |
| fix-ocaml-gc | — | pending |
| custom-memory-heap-crash | — | pending |
| password-recovery | — | pending |
| crack-7z-hash | — | pending (no `off` cells) |
| db-wal-recovery | — | pending |
| fix-code-vulnerability | — | pending |

## 3. regex-log (2026-10-24)

`run`: `bench/runs/matrix/2026-10-24T11-36-31-regex-log/`

### 3.1 Per-cell results

| cell | reward | turns/steps | in | fresh | out | reason | wall | ₽ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| skein on r1 | 1 | 13 | 66.4k | 28.6k | 14.2k | 11.2k | 127 s | 1.485 |
| skein on r2 | 1 | 13 | 79.1k | 25.3k | 12.1k | 8.0k | 100 s | 1.292 |
| skein on r3 | 1 | 18 | 147.9k | 31.3k | 16.7k | 12.7k | 148 s | 1.731 |
| skein off r1 | 1 | 14 | 69.9k | 23.2k | 9.1k | 6.5k | 111 s | 1.047 |
| skein off r2 | 1 | 13 | 80.9k | 25.4k | 17.7k | 15.2k | 141 s | 1.679 |
| skein off r3 | 1 | 19 | 132.9k | 40.0k | 25.1k | 21.2k | 187 s | 2.457 |
| opencode on r1 | 1 | 7 | 123.3k | 14.5k | 17.8k | 16.0k | 158 s | ≈1.521 |
| opencode on r2 | 1 | 8 | 110.1k | 11.5k | 10.0k | 7.5k | 112 s | ≈0.925 |
| opencode on r3 | 1 | 15 | 317.8k | 30.3k | 23.0k | 19.1k | 202 s | ≈2.213 |
| opencode off r1 | 1 | 6 | 74.3k | 8.0k | 7.4k | 6.1k | 104 s | ≈0.671 |
| opencode off r2 | 1 | 6 | 74.5k | 6.7k | 9.3k | 8.1k | 93 s | ≈0.781 |
| opencode off r3 | 1 | 9 | 138.3k | 15.3k | 13.1k | 10.3k | 127 s | ≈1.211 |

### 3.2 Medians

| agent / net | turns/steps | in | fresh | out | reason | wall | ₽ |
|---|---:|---:|---:|---:|---:|---:|---:|
| skein / on | 13 | 79.1k | 28.6k | 14.2k | 11.2k | 127 s | 1.485 |
| skein / off | 14 | 80.9k | 25.4k | 17.7k | 15.2k | 141 s | 1.679 |
| opencode / on | 8 | 123.3k | 14.5k | 17.8k | 16.0k | 158 s | ≈1.521 |
| opencode / off | 6 | 74.5k | 8.0k | 9.3k | 8.1k | 104 s | ≈0.781 |

Totals for six runs per agent: Skein **9.69 ₽**, opencode **≈7.32 ₽**; whole matrix ≈17.0 ₽.

### 3.3 Observations

- 12/12 cells `reward=1`; no timeouts, no `max_turns`.
- **turns vs steps:** Skein closes in 13–14 engine turns; opencode needs 6–8 steps. These are
  different units (one Skein turn = a doxa move; one opencode step = an agent loop step).
- **Fresh input:** opencode reads markedly less (8.0–14.5k vs 23–31k). Its total `in` is
  inflated by prompt caching (r3: 317.8k total, 30.3k fresh), so compare `fresh`, not `in`.
- **Reasoning/output:** on `off`, opencode spends less of both (reason 8.1k vs 15.2k); on `on`
  they are comparable, and opencode's `out` is slightly higher.
- **Cost:** on `on` the two are practically tied (Skein 1.485 vs opencode ≈1.521); on `off`
  opencode is ~2.1× cheaper (≈0.781 vs 1.679). Skein's `off` is ~13% more expensive than its
  own `on`.
- **Caveat:** K=3, one task, one provider route; costs are noisy. Do not generalize yet.

## 4. openssl-selfsigned-cert (2026-10-24)

`run`: `bench/runs/matrix/2026-10-24T12-09-14-openssl-selfsigned-cert/`

Declarative acceptance: the task's `test_outputs.py` checks the key/cert/PEM files, the
subject (`O=DevOps Team`, `CN=dev-internal.company.local`), the validity window, the
combined PEM, and that `verification.txt` contains the subject, OpenSSL-format dates and a
colon-separated SHA-256 fingerprint.

Cost fit on this task's 6 Skein cells: `a = 17.275`, `b = 0.346`, `c = 69.102` ₽/1M
(reproduces all six `costRub` values < 0.001 ₽; the same route as regex-log).

### 4.1 Per-cell results

| cell | reward | turns/steps | in | fresh | out | reason | wall | ₽ |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| skein on r1 | 1 | 20 | 110.4k | 28.4k | 5.1k | 1.3k | 98 s | 0.870 |
| skein on r2 | 1 | 19 | 86.5k | 26.3k | 4.2k | 1.6k | 73 s | 0.762 |
| skein on r3 | 1 | 12 | 48.1k | 17.5k | 2.9k | 0.7k | 56 s | 0.513 |
| skein off r1 | 1 | 16 | 76.8k | 25.5k | 4.6k | 0.8k | 90 s | 0.777 |
| skein off r2 | 1 | 16 | 73.7k | 18.9k | 3.9k | 0.9k | 69 s | 0.611 |
| skein off r3 | 1 | 15 | 69.2k | 21.1k | 3.8k | 0.7k | 64 s | 0.641 |
| opencode on r1 | 1 | 7 | 62.1k | 3.7k | 2.1k | 0.9k | 61 s | ≈0.231 |
| opencode on r2 | 1 | 9 | 79.0k | 3.1k | 2.0k | 0.8k | 78 s | ≈0.215 |
| opencode on r3 | 1 | 8 | 68.9k | 2.9k | 1.4k | 0.3k | 74 s | ≈0.171 |
| opencode off r1 | 1 | 7 | 58.7k | 2.2k | 1.4k | 0.4k | 50 s | ≈0.152 |
| opencode off r2 | **0** | 8 | 70.9k | 3.1k | 1.9k | 0.6k | 55 s | ≈0.205 |
| opencode off r3 | 1 | 6 | 54.0k | 3.6k | 2.5k | 1.3k | 58 s | ≈0.253 |

### 4.2 Medians

| agent / net | turns/steps | in | fresh | out | reason | wall | ₽ |
|---|---:|---:|---:|---:|---:|---:|---:|
| skein / on | 19 | 86.5k | 26.3k | 4.2k | 1.6k | 73 s | 0.762 |
| skein / off | 16 | 73.7k | 21.1k | 3.9k | 0.9k | 69 s | 0.641 |
| opencode / on | 8 | 68.9k | 3.1k | 2.0k | 0.8k | 74 s | ≈0.215 |
| opencode / off | 7 | 58.7k | 3.1k | 1.9k | 0.6k | 55 s | ≈0.205 |

Totals: Skein **4.17 ₽**, opencode **≈1.23 ₽**; whole matrix ≈5.40 ₽ (one reward0 included).

### 4.3 Observations

- 11/12 `reward=1`. The miss is a real agent error, not a harness one: `opencode off r2`
  wrote the SHA-256 fingerprint **without colons** (`tr -d ':'`), and the verifier requires
  colon-separated hex pairs — the other five checks passed.
- **Fresh input:** opencode ~3k vs Skein 19–28k (7–9× less); output and reasoning are also
  2–3× smaller. This task is Construction from a spec, and opencode goes almost straight to
  the artifact.
- **Cost:** with the same rates, opencode is ~3–3.7× cheaper here (median ≈0.21 vs
  0.64–0.76 ₽) — unlike regex-log, where `on` was a tie.
- **Turns:** Skein 12–20 vs opencode 6–9; Skein's `on` median is higher than `off` (19 vs 16),
  which is noise at K=3 (r3 needed 12).
- **Caveat:** K=3; the declarative acceptance is strict on formatting, so one wording slip
  costs the whole reward.

## 5. Adding a task

```sh
npx tsx tests/sandbox/matrix.ts <task> --agents skein,opencode --nets on,off \
  --repeat 3 --concurrency 6 --timeout 1200
```

Then append a `§N. <task>` section with the per-cell and median tables, refit the cost rates
on that task's Skein cells, and update §2. A killed cell leaves `.timeout`; rerun the same
command with `--resume`.
