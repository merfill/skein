# Skein — per-task benchmarks

> Russian version — `docs/benches/task_benchmarks_ru.md`.
>
> This is a working record of measurements for the article. It has one section per task in
> our set: what the task is, how Skein and opencode solve it, and what the measurements show.
> The document grows as runs are made, so some tasks do not have a section yet.
>
> Method and cost accounting — `compare_skein_opencode.md` §1. Task catalogue and
> trajectories — `docs/plans/task_catalog_2026-10-18_ru.md`. Batch history — `best_bench.md`.

## 1. Where the tasks come from

Our set consists of 13 tasks from **terminal-bench**, a public benchmark of terminal tasks for
agents. Each task has its own Docker image (`alexgshaw/<id>:20251031`) with a ready-made
environment and its own verifier, the `tests/test.sh` script that decides whether the task was
completed. We rewrite neither the environment nor the acceptance: the agent works in the same
image, and the verdict comes from the same script as in an official run.

The tasks are ported into `tests/sandbox/tasks/`. Their files (`instruction.md`, `tests/`,
`solution/`) are read from the local Harbor cache
(`~/.cache/harbor/tasks/<hash>/<id>/`) and are never copied into the repository: they carry the
benchmark's canary, which is used to track leaks. The cache is therefore required to run a
task, but the tasks themselves never enter git.

The tasks were chosen so that together they cover five kinds of work:

| class | what is required | tasks |
|---|---|---|
| Repair | find a defect in existing code and fix it | `fix-ocaml-gc`, `fix-code-vulnerability`, `custom-memory-heap-crash` |
| Recovery | recover hidden data: a password, a WAL journal, an archive password | `password-recovery`, `db-wal-recovery`, `crack-7z-hash` |
| Construction | build a new artefact from a specification or from the source's behaviour | `log-summary-date-ranges`, `cobol-modernization`, `modernize-scientific-stack`, `openssl-selfsigned-cert`, `regex-log` |
| History | investigate a repository's history and restore or merge changes | `fix-git` |
| Hybrid | recover a secret and purge it from history | `git-leak-recovery` |

Each task follows a route through Skein's states:

- `O` — Orientation: read the workspace map and the declared acceptance, changing nothing;
- `L` — Localization: name the artefact and a suspected cause;
- `R` — Research: describe the situation and the method;
- `P` — Patch: modify an existing artefact;
- `Recovery` — recover hidden data with a script and a check;
- `Construction` — build a new artefact and check it against the acceptance;
- `V` — Verification: build and run the tests;
- `End` — close the request.

The route is not rigid: depending on the task, the agent may skip a state or return to an
earlier one. The tables below show the typical route, not the exact path of every run.

## 2. How the runs work

### 2.1 Why not Harbor

Harbor is the official terminal-bench runner, and we still need it for official acceptance:
`bash bench/harbor/run.sh`. But it is not suitable for series measurements.

First, Harbor's agent adapter prepares the agent environment inside the task image. For
langgraph it installs Node (`node_version: 22`), and the opencode adapter brings its own
runtime, including Python, although the task does not need it. The image is no longer the one
the benchmark shipped: it gains packages that were not there, and the verifier can
accidentally use what the agent installed. In the sandbox the image starts as is, and
`tests/` is copied into the container only after the agent, so the environment stays clean.

Second, Harbor does not give uniform, complete accounting. For Skein it writes the `SKEIN_*`
records, but for opencode the completion-token count excludes reasoning, the provider reports
zero cost, and some trials leave no records at all. Such artefacts cannot support an honest
comparison of turns, tokens and money. The sandbox writes the same `metrics.json` for both
agents: turns and steps, input and fresh, cache, reasoning, cost.

Third, Harbor runs a whole job: it is slow, expensive and awkward for iterative K=3 grids, and
the results live outside the repository. The sandbox runs one task locally, keeps the trace
next to it, and lets us repeat and resume individual cells (`matrix.ts`, `--resume`). Harbor
also overrides container resources and the reasoning level in its config (`override_cpus`,
`override_memory_mb`, `force_build`, `reasoningEffort: high`), adding more variables that the
bare image does not have.

We therefore use Harbor for official acceptance and run the article's measurements in the
sandbox. This does not invalidate the Harbor results: they are useful as an independent check,
but not as a source of comparable metrics.

### 2.2 How a sandbox run works

Both agents run in the same task image, and the task's own `tests/test.sh` runs after the
agent. This mirrors an official run: the `tests/` files are copied into the container only
after the agent has finished, so the agent cannot peek at them, and the verdict comes from
`/logs/verifier/reward.txt` (`reward = 1` means the acceptance passed).

The container runs in **rootless Docker**: the image starts as is, and `/app` is neither copied
to the host nor mounted into it. The agent's tools (`read`, `write`, `edit`, `grep`, `bash`,
background jobs and checkpoints) run inside the container through `docker exec`.

The network is controlled by `--net`:

- `--net on` gives the agent a network, as in Harbor;
- `--net off` disconnects **only the agent**; the verifier keeps its network because
  `test.sh` installs the runtime it needs (`apt`, `uv`, `pip`). Host-side `fetch` calls in
  this mode go through an allowlist proxy that permits only the model API;
- `crack-7z-hash` needs the network for the agent itself, so it has no `net off` cells.

The main commands:

```sh
# one full task run
npx tsx tests/sandbox/sandbox-run.ts fix-ocaml-gc --net off --turns 60

# the agent × network × repeat grid for one task
npx tsx tests/sandbox/matrix.ts fix-ocaml-gc \
  --agents skein,opencode --nets on,off --repeat 3 \
  --turns 60 --concurrency 4 --timeout 2400

# the opencode baseline
npx tsx tests/sandbox/opencode-run.ts fix-ocaml-gc --net off
```

The turn budget comes from the task (`maxTurns`) when it is set, otherwise 24; `--turns`
overrides both. `fix-ocaml-gc` has a budget of 60 turns: its acceptance rebuilds the compiler,
and one such run takes a long time. `matrix.ts` runs each cell in a separate child process and
limits it by wall-clock time, so a hung cell can be killed and restarted with `--resume`.

All runs use the model `routerai/~deepseek/deepseek-v4-flash-latest` with reasoning level
`low`. Skein uses temperature 0.1, so a single run proves nothing: in the tables below K is the
number of repeats, and the comparison uses medians.

### 2.3 What the numbers mean

- `turns` — Skein turns, including `move` and `stop`; `steps` — opencode steps. These are
  different units and cannot be compared directly;
- `in` — all input tokens, including those read from the cache;
- `fresh` — `in − cacheRead`, that is, what the model actually re-read;
- `cache hit` — the share of the input served from the cache;
- `reason` — reasoning tokens (they are part of `out`);
- `₽` — cost. For Skein this is the provider's `costRub`; for opencode it is the sum of
  `usage.cost` from `reasoning.ndjson` (including the call that generates the session title).
  If `reasoning.ndjson` was not saved, the cost is not recorded and the table shows `—`;
- `K` — the number of repeats; at K=1 the table shows the single run.

`sandbox-run` does not record wall-clock time, so the `fix-ocaml-gc` section has no timing;
`matrix.ts` does record it, and later sections will include it.

## 3. Task status

| task | class | route | status |
|---|---|---|---|
| fix-ocaml-gc | Repair | `O→L→P→V→End` | **done** (§4; same-day 10-24, `net off`) |
| modernize-scientific-stack | Construction | `O→R→Construction→End` | **done** (§5) |
| regex-log | Construction | `O→R→Construction→End` | **done** (§6) |
| log-summary-date-ranges | Construction | `O→R→Construction→End` | **done** (§7) |
| openssl-selfsigned-cert | Construction | `O→R→Construction→End` | **done** (§8) |
| fix-code-vulnerability | Repair | `O→L→P→V` | **done** (§9) |
| fix-git | History | `O→L→P→V` | **done** (§10) |
| git-leak-recovery | Hybrid | `O→R→Recovery→P→V→End` | **done** (§11) |
| custom-memory-heap-crash | Repair | `O→L→P→V` | **done** (§12, `net off`) |
| password-recovery | Recovery | `O→R→Recovery→End` | **done** (§13, K=1) |
| db-wal-recovery | Recovery | `O→R→Recovery→End` | **done** (§14, K=1) |
| crack-7z-hash | Recovery | `O→R→Recovery→End` | **done** (§15, K=1, `net on`) |
| cobol-modernization | Construction | `O→R→Construction→End` | **done** (§16, K=1) |

## 4. fix-ocaml-gc

### 4.1 The task

`/app/ocaml` holds the OCaml source tree; there is no version control. A change in the garbage
collector that rewrote RLE free-space handling broke the compiler bootstrap. The agent must
find the regression, fix it, build the compiler and run
`make -C testsuite one DIR=tests/basic` — 40 tests.

Acceptance is the task's own `test.sh`. It re-clones a pristine testsuite, rebuilds the
compiler and runs the tests, so the verifier takes several minutes. Wall-clock therefore
mostly measures acceptance, not the agent's work.

### 4.2 How it is solved

Both agents find the same bug in `runtime/shared_heap.c`, in `pool_sweep`: the free-space
sweep advances by the header (`p += Whsize_hd(hd)`) instead of the actual block size
(`p += wh`). The fix replaces one line.

- **Skein** follows `O → L → P → V → End`. In Localization it names `pool_sweep` and rules out the
  neighbouring loops; in Patch it reads the file and makes the one-line edit; in Verification
  it builds the compiler and runs the testsuite.
- **opencode** reads `runtime/shared_heap.c`, compares the suspicious line with the
  neighbouring loops (`pool_finalise`, `verify_pool`, `calc_pool_stats`) and makes the same
  edit. With `net on` it can clone upstream and use it as an oracle; with `net off` it derives
  the line by reading and comparison.

### 4.3 Results

Measurements on 2026-10-24, `net off`, K=3, both agents: same-day, same backend
(`deepseek-v4.1-flash-1017` / BytePlus). `net on` was not measured on the current model.
The table shows medians, with the range in parentheses.

| agent | net | K | reward | turns / steps | ₽ | reasoning | total in | fresh | cache hit |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|
| Skein | off | 3 | 3/3 | **27** (26–30) | **1.500** | 4 549 | 190 525 | 55 869 | 71% |
| opencode | off | 3 | 3/3 | **27** (24–44) | **1.599** | 6 216 | 783 251 | 42 547 | 95% |

| run | turns/steps | tool calls | total in | fresh | cache | cache hit | out (visible + reasoning) | peak | ₽ | reward | cell time |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|
| Skein r1 | 27 | 37 | 175 218 | 56 946 | 118 272 | 67.5% | 9 447 (3 407 + 6 040) | 58 172 | 1.677 | 1 | 1 228 s |
| Skein r2 | 30 | 40 | 190 525 | 55 869 | 134 656 | 70.7% | 6 069 (3 568 + 2 501) | 51 180 | 1.431 | 1 | 1 283 s |
| Skein r3 | 26 | 36 | 194 942 | 51 838 | 143 104 | 73.4% | 8 036 (3 487 + 4 549) | 71 998 | 1.500 | 1 | 1 234 s |
| opencode r1 | 24 | 33 | 699 955 | 42 547 | 657 408 | 93.9% | 8 956 (2 740 + 6 216) | — | 1.599 | 1 | 983 s |
| opencode r2 | 27 | 36 | 783 251 | 38 035 | 745 216 | 95.1% | 7 457 (3 091 + 4 366) | — | 1.454 | 1 | 922 s |
| opencode r3 | 44 | 44 | 2 072 845 | 66 189 | 2 006 656 | 96.8% | 16 253 (5 090 + 11 163) | — | 2.967 | 1 | 1 026 s |

### 4.4 Comments

- The median number of LLM calls is **the same: 27 versus 27** (opencode 24–44, Skein 26–30).
  On this task opencode is not faster in steps.
- opencode's total input is 4.1× larger (783k versus 190k), but almost all of it is cache.
  Fresh is the other way round: Skein reads more — 55.9k versus 42.5k (1.3×). Cache hit:
  71% versus 95%.
- Output is comparable. opencode spends more on reasoning (6.2k versus 4.5k), Skein has more
  visible output (3.5k versus 3.1k).
- Cost medians are nearly equal: **1.500 ₽** for Skein versus **1.599 ₽** for opencode.
  opencode's only expensive run is r3: 44 steps, 2.97 ₽.
- Cell time: Skein 1 228–1 283 s, opencode 922–1 026 s. But Skein's figure includes the old
  full-tree checkpoint (measured separately on this host: ~18 s initial and ~13 s per changed
  turn; since replaced by delta snapshots — ~1 s initial, ~0.4 s per changed turn), which
  opencode does not have; Skein's agent time is not recorded, opencode's is 444–560 s.
  Wall-clock is therefore not a clean agent comparison.
- K=3, one backend, same-day. This is a direction, not statistics; the old 10-23/10-11 data
  used a different model (`deepseek-flash`/DeepSeek) and is not comparable with 10-24.

**Historical note (outside the table).** Skein 2026-10-18, K=5, `net on`: median 40 turns,
2.026 ₽, 8 689 reasoning tokens, reward 4/5 (old four-state set). opencode 2026-10-09/10-11:
24–33 steps, reasoning 7.4–18.6k; cost is not recorded everywhere. The model then was
`deepseek-flash`/DeepSeek, a different one. See `best_bench.md`.

### 4.5 Traces

- Current matrix: `bench/runs/matrix/2026-10-24-fix-ocaml/` — cells under
  `cells/<agent>-netoff-r<n>/`, summary in `summary.json`.
- Old Skein series: `bench/runs/sandbox-tasks/2026-10-23T04-29-17-477Z-fix-ocaml-gc`,
  `…16-32-18-116Z-fix-ocaml-gc-AAFw9y` and neighbours.
- Old opencode series: `bench/runs/sandbox-tasks/2026-10-11T06-05-26-806Z-fix-ocaml-gc-opencode-on`,
  `…06-52-33-197Z-fix-ocaml-gc-opencode-off`.

## 5. modernize-scientific-stack

### 5.1 The task

`/app/climate_analyzer` contains an old `analyze_climate.py` written for Python 2.7; it does
not run on modern Python. The agent must create `/app/analyze_climate_modern.py` and a
dependency file (`requirements.txt` or `pyproject.toml`) without modifying the original. The
verifier runs the new script, checks the output format
(`Station {id} mean temperature: {value:.1f}°C`) and the means for stations 101 and 102, and
confirms that the source file is untouched.

### 5.2 How it is solved

- **Skein** follows `O → R → Construction → End`. In Research it reads the legacy script, the
  CSV and `config.ini`, and checks the installed pandas and numpy versions; in Construction it
  writes the new script and the dependency file, runs it and compares the means with an
  independent calculation. Some runs add Localization or a second Research/check loop: the
  route is not fixed.
- **opencode** reads the same files, writes the script and dependencies, runs it and checks
  the output. This usually takes 4–7 steps.

The task has no hidden data and needs no network, so `net on` and `net off` should give the
same result; differences between them are noise.

### 5.3 Results

All 12 cells (two agents × two network modes × three repeats) returned `reward = 1`. The table
shows medians, with the range in parentheses.

| agent | net | K | reward | turns / steps | ₽ | reasoning | total in | fresh | cache hit |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|
| Skein | on | 3 | 3/3 | **17** (14–19) | **0.757** | 688 | 86 068 | 27 700 | 68% |
| Skein | off | 3 | 3/3 | **17** (16–24) | **0.680** | 782 | 90 385 | 21 972 | 71% |
| opencode | on | 3 | 3/3 | **6** (5–7) | **0.215** | 445 | 63 358 | 4 633 | 92% |
| opencode | off | 3 | 3/3 | **6** (4–6) | **0.245** | 983 | 65 052 | 5 086 | 92% |

| agent | net | repeat | turns/steps | tool calls | total in | fresh | cache | cache hit | out (visible + reasoning) | peak | ₽ | reward | cell time |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|
| Skein | on | 1 | 19 | 30 | 87 488 | 28 096 | 59 392 | 68% | 5 066 (3 468 + 1 598) | 20 460 | 0.856 | 1 | 104 s |
| Skein | on | 2 | 17 | 25 | 86 068 | 27 700 | 58 368 | 68% | 3 736 (3 048 + 688) | 22 585 | 0.757 | 1 | 94 s |
| Skein | on | 3 | 14 | 22 | 60 677 | 22 149 | 38 528 | 64% | 3 228 (2 723 + 505) | 18 952 | 0.619 | 1 | 85 s |
| Skein | off | 1 | 16 | 26 | 75 476 | 21 972 | 53 504 | 71% | 3 488 (3 054 + 434) | 20 090 | 0.639 | 1 | 109 s |
| Skein | off | 2 | 24 | 33 | 120 688 | 38 128 | 82 560 | 68% | 5 707 (3 698 + 2 009) | 22 512 | 1.082 | 1 | 106 s |
| Skein | off | 3 | 17 | 25 | 90 385 | 21 905 | 68 480 | 76% | 4 019 (3 237 + 782) | 24 144 | 0.680 | 1 | 177 s |
| opencode | on | 1 | 5 | 9 | 51 000 | 4 280 | 46 720 | 92% | 1 652 (926 + 726) | — | 0.208 | 1 | 75 s |
| opencode | on | 2 | 6 | 12 | 63 358 | 5 246 | 58 112 | 92% | 1 395 (1 159 + 236) | — | 0.215 | 1 | 68 s |
| opencode | on | 3 | 7 | 11 | 73 241 | 4 633 | 68 608 | 94% | 1 746 (1 301 + 445) | — | 0.228 | 1 | 58 s |
| opencode | off | 1 | 4 | 7 | 38 263 | 3 191 | 35 072 | 92% | 1 260 (952 + 308) | — | 0.158 | 1 | 181 s |
| opencode | off | 2 | 6 | 12 | 65 052 | 5 404 | 59 648 | 92% | 2 734 (1 383 + 1 351) | — | 0.307 | 1 | 65 s |
| opencode | off | 3 | 6 | 9 | 62 814 | 5 086 | 57 728 | 92% | 1 906 (923 + 983) | — | 0.245 | 1 | 57 s |

### 5.4 Comments

This is the shortest task in the set, and the state transitions are most visible here. Skein
takes 14–24 turns against opencode's 4–7 steps and costs 0.68–0.76 ₽ against 0.21–0.24 ₽, that
is, 2.8–3.5× more. It also re-reads much more: 22–28k tokens against 4.6–5.1k, with a cache
hit of 68–71% (by medians) against 92%. Reasoning is roughly the same (0.7–0.8k versus 0.4–1.0k), and the
visible output is nearly identical.

The cause is the protocol, not the work: of 14–24 turns, 8–12 go to `move` and `stop`. In one
run's breakdown there were 9 productive turns against opencode's 6 steps, but four of those
nine were re-reading and `recall`. On a short task Skein pays the full management cost and
loses; this is expected and does not depend on the task's wording.

This is the cleanest comparison in the document: both agents were measured on the same day,
with the same model, K=3, in both network modes. The task does not need the network, so `on`
and `off` differ only by noise.

### 5.5 Traces

`bench/runs/matrix/2026-10-24-modernize/` — cells under `cells/<agent>-net<mode>-r<n>/`,
summary in `summary.json`.

## 6. regex-log

### 6.1 The task

`/app` is empty. The agent must write a regular expression to `/app/regex.txt` that finds the
last `YYYY-MM-DD` date in lines containing an IPv4 address; the date boundaries are
non-alphanumeric characters, and February may go up to the 29th. The verifier applies the
expression with `re.findall(..., re.MULTILINE)` and compares the result.

### 6.2 How it is solved

- **Skein** follows `O → R → Construction → End`. In Research it analyses the requirement and
  designs the strategy and the check; in Construction it writes `regex.txt` and a small test
  harness, then closes the request.
- **opencode** designs the expression, writes the file and a test harness, and fixes one wrong
  expectation. This usually takes 6–15 steps.

There is no target artefact: the work is synthesising an expression from a specification, so
Localization and Patch are unnecessary.

### 6.3 Results

All 12 cells returned `reward = 1`. The table shows medians, with the range in parentheses.

| agent | net | K | reward | turns / steps | ₽ | reasoning | total in | fresh | cache hit |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|
| Skein | on | 3 | 3/3 | **13** (13–18) | **1.485** | 11 183 | 79 108 | 28 554 | 68% |
| Skein | off | 3 | 3/3 | **14** (13–19) | **1.679** | 15 179 | 80 904 | 25 352 | 69% |
| opencode | on | 3 | 3/3 | **8** (7–15) | **1.524** | 15 951 | 123 298 | 14 498 | 90% |
| opencode | off | 3 | 3/3 | **6** (6–9) | **0.786** | 8 054 | 74 541 | 8 040 | 89% |

| agent | net | repeat | turns/steps | tool calls | total in | fresh | cache | cache hit | out (visible + reasoning) | peak | ₽ | reward | cell time |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|
| Skein | on | 1 | 13 | 14 | 66 442 | 28 554 | 37 888 | 57% | 14 157 (2 974 + 11 183) | 29 067 | 1.485 | 1 | 127 s |
| Skein | on | 2 | 13 | 13 | 79 108 | 25 348 | 53 760 | 68% | 12 092 (4 107 + 7 985) | 33 509 | 1.292 | 1 | 100 s |
| Skein | on | 3 | 18 | 18 | 147 865 | 31 257 | 116 608 | 79% | 16 655 (3 914 + 12 741) | 39 649 | 1.731 | 1 | 148 s |
| Skein | off | 1 | 14 | 14 | 69 929 | 23 209 | 46 720 | 67% | 9 117 (2 595 + 6 522) | 21 263 | 1.047 | 1 | 111 s |
| Skein | off | 2 | 13 | 13 | 80 904 | 25 352 | 55 552 | 69% | 17 688 (2 509 + 15 179) | 33 335 | 1.679 | 1 | 141 s |
| Skein | off | 3 | 19 | 19 | 132 906 | 39 978 | 92 928 | 70% | 25 090 (3 920 + 21 170) | 48 888 | 2.457 | 1 | 187 s |
| opencode | on | 1 | 7 | 6 | 123 298 | 14 498 | 108 800 | 88% | 17 842 (1 891 + 15 951) | — | 1.524 | 1 | 158 s |
| opencode | on | 2 | 8 | 7 | 110 054 | 11 494 | 98 560 | 90% | 10 022 (2 511 + 7 511) | — | 0.934 | 1 | 112 s |
| opencode | on | 3 | 15 | 14 | 317 812 | 30 324 | 287 488 | 90% | 23 024 (3 939 + 19 085) | — | 2.216 | 1 | 202 s |
| opencode | off | 1 | 6 | 5 | 74 344 | 8 040 | 66 304 | 89% | 7 376 (1 284 + 6 092) | — | 0.675 | 1 | 104 s |
| opencode | off | 2 | 6 | 5 | 74 541 | 6 701 | 67 840 | 91% | 9 292 (1 238 + 8 054) | — | 0.786 | 1 | 93 s |
| opencode | off | 3 | 9 | 8 | 138 277 | 15 269 | 123 008 | 89% | 13 104 (2 784 + 10 320) | — | 1.216 | 1 | 127 s |

### 6.4 Comments

With `net on` the agents cost almost the same (1.49 ₽ versus 1.52 ₽), but opencode takes 8
steps against Skein's 13–14 turns and uses more total input (123k versus 79k — though largely
because of the cache). With `net off` opencode is about 2.1× cheaper (0.79 ₽ versus 1.68 ₽),
takes 6 steps against 14, and spends 8.1k reasoning tokens against 15.2k. Skein re-reads more
(25–29k versus 8–14.5k), and its cache hit is lower (68–69% versus 89–90%).

This is a Construction task where opencode is strong: the work is synthesising an expression,
not navigating states, so Skein's overhead does not pay off. The result agrees with
`compare_skein_opencode.md` §3.

**Important caveat.** The Skein cells in this table were recorded before the Orientation
rewrite. After it, Skein K=3 gave 15/12/15 turns and a median of 1.532 ₽. opencode's prompt is
not affected by this, but its cells were recorded in the same matrix run as the old Skein
cells; there is no same-day run with the new Skein. The comparison here is therefore a
direction, not a final number.

### 6.5 Traces

`bench/runs/matrix/2026-10-24T11-36-31-regex-log/` — cells under
`cells/<agent>-net<mode>-r<n>/`, summary in `summary.json`. New Orientation:
`bench/runs/prompt-tests/2026-10-24T14-48-38-regex-log-k3/`.


## 7. log-summary-date-ranges

### 7.1 The task

`/app/logs` holds a tree of logs (164 files) with ERROR, WARNING and INFO entries. The agent
must count them by date range relative to the reference date 2025-08-12 and write the result to
`/app/summary.csv`. Acceptance is the task's native verifier: it checks the CSV, not how the
work was done. The task needs no network.

### 7.2 How it is solved

- **Skein** follows `O → R → Construction → End`. In Research it describes the log schema and
  the range boundaries; in Construction it writes the CSV and recalculates the values, then
  closes the request.
- **opencode** walks the logs with `awk`/`grep`, counts lines by level and range, writes the
  CSV and checks the number of matched lines. This usually takes 4–5 steps.

This is a Construction task with data aggregation: there is no target artefact, only a
specification and a source to count over.

### 7.3 Results

All 12 cells returned `reward = 1`. The table shows medians, with the range in parentheses.

| agent | net | K | reward | turns / steps | ₽ | reasoning | total in | fresh | cache hit |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|
| Skein | on | 3 | 3/3 | **15** (13–15) | **0.698** | 1 121 | 64 067 | 23 584 | 63% |
| Skein | off | 3 | 3/3 | **13** (13–15) | **0.645** | 1 071 | 50 785 | 21 569 | 65% |
| opencode | on | 3 | 3/3 | **5** (3–5) | **0.263** | 341 | 68 376 | 8 984 | 87% |
| opencode | off | 3 | 3/3 | **4** (4) | **0.222** | 283 | 52 358 | 7 716 | 85% |

| agent | net | repeat | turns/steps | tool calls | total in | fresh | cache | cache hit | out (visible + reasoning) | peak | ₽ | reward | cell time |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|
| Skein | on | 1 | 15 | 17 | 65 312 | 23 584 | 41 728 | 64% | 4 499 (3 378 + 1 121) | 16 657 | 0.733 | 1 | 69 s |
| Skein | on | 2 | 13 | 15 | 49 376 | 19 552 | 29 824 | 60% | 3 187 (2 482 + 705) | 13 802 | 0.568 | 1 | 59 s |
| Skein | on | 3 | 15 | 17 | 64 067 | 23 875 | 40 192 | 63% | 3 930 (2 563 + 1 367) | 15 354 | 0.698 | 1 | 105 s |
| Skein | off | 1 | 13 | 15 | 50 632 | 23 240 | 27 392 | 54% | 3 386 (2 271 + 1 115) | 13 841 | 0.645 | 1 | 61 s |
| Skein | off | 2 | 13 | 14 | 50 785 | 17 889 | 32 896 | 65% | 2 756 (2 239 + 517) | 14 096 | 0.511 | 1 | 86 s |
| Skein | off | 3 | 15 | 17 | 64 321 | 21 569 | 42 752 | 67% | 3 921 (2 850 + 1 071) | 15 656 | 0.658 | 1 | 67 s |
| opencode | on | 1 | 3 | 2 | 28 803 | 3 715 | 25 088 | 87% | 588 (473 + 115) | — | 0.124 | 1 | 66 s |
| opencode | on | 2 | 5 | 4 | 68 376 | 8 984 | 59 392 | 87% | 1 226 (885 + 341) | — | 0.263 | 1 | 51 s |
| opencode | on | 3 | 5 | 4 | 114 225 | 20 017 | 94 208 | 83% | 1 388 (880 + 508) | — | 0.477 | 1 | 56 s |
| opencode | off | 1 | 4 | 3 | 89 195 | 20 715 | 68 480 | 77% | 956 (645 + 311) | — | 0.451 | 1 | 77 s |
| opencode | off | 2 | 4 | 3 | 52 260 | 7 716 | 44 544 | 85% | 1 031 (748 + 283) | — | 0.222 | 1 | 42 s |
| opencode | off | 3 | 4 | 3 | 52 358 | 7 686 | 44 672 | 85% | 702 (583 + 119) | — | 0.199 | 1 | 41 s |

### 7.4 Comments

Skein takes 13–15 turns against opencode's 4–5 steps and costs 0.65–0.70 ₽ against
0.22–0.26 ₽, that is, 2.6–3.1× more. It also re-reads more: 22–24k tokens against 7.7–9.0k,
with a cache hit of 63–65% against 85–87%. Skein spends 1.1k reasoning tokens against 0.3k.

As with modernize, the cause is the protocol, not the amount of work: the task is short, and
8–10 turns go to `move` and `stop`. opencode is especially efficient here: 4–5 steps, of which
2–4 are tool calls. The task needs no network, so `on` and `off` differ only by noise; opencode
has one cost outlier in `off` (0.45 ₽ in the first repeat), but the median is 0.22 ₽.

Same-day comparison: both agents were measured on 2026-10-24, K=3, in both network modes.

### 7.5 Traces

`bench/runs/matrix/2026-10-24-log-summary/` — cells under
`cells/<agent>-net<mode>-r<n>/`, summary in `summary.json`.


## 8. openssl-selfsigned-cert

### 8.1 The task

`/app` is empty. The agent must create a self-signed certificate and key, a combined PEM, a
`verification.txt` file and a `check_cert.py` script in `/app/ssl`. Acceptance is declarative:
`test_outputs.py` checks the files, the subject (`O=DevOps Team`,
`CN=dev-internal.company.local`), the validity period, the combined PEM, and that
`verification.txt` contains the subject, OpenSSL-formatted dates and a SHA-256 fingerprint
written as hex pairs separated by colons. The task needs no network.

### 8.2 How it is solved

- **Skein** follows `O → R → Construction → End`. In Research it fixes the commands, the
  certificate fields and the acceptance requirements; in Construction it creates the artefacts
  and checks them, then closes the request.
- **opencode** runs `genrsa`, `req -x509`, assembles the PEM and `verification.txt`, writes
  `check_cert.py` and verifies the result with `openssl verify`. This usually takes 6–9 steps.

This is Construction from a specification: there is no target artefact, only a new set of
files to build.

### 8.3 Results

11 of 12 cells returned `reward = 1`. The single miss is `opencode net off, repeat 2`: the
agent wrote the fingerprint without colons (`tr -d ':'`) and the verifier rejected it; the
other checks passed. The table shows medians, with the range in parentheses; the medians
include the failed run.

| agent | net | K | reward | turns / steps | ₽ | reasoning | total in | fresh | cache hit |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|
| Skein | on | 3 | 3/3 | **19** (12–20) | **0.762** | 1 340 | 86 478 | 26 318 | 70% |
| Skein | off | 3 | 3/3 | **16** (15–16) | **0.641** | 770 | 73 658 | 21 067 | 70% |
| opencode | on | 3 | 3/3 | **8** (7–9) | **0.231** | 787 | 68 928 | 3 063 | 96% |
| opencode | off | 3 | 2/3 | **7** (6–8) | **0.214** | 615 | 58 654 | 3 078 | 96% |

| agent | net | repeat | turns/steps | tool calls | total in | fresh | cache | cache hit | out (visible + reasoning) | peak | ₽ | reward | cell time |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|
| Skein | on | 1 | 20 | 20 | 110 438 | 28 390 | 82 048 | 74% | 5 086 (3 746 + 1 340) | 25 867 | 0.870 | 1 | 98 s |
| Skein | on | 2 | 19 | 19 | 86 478 | 26 318 | 60 160 | 70% | 4 153 (2 585 + 1 568) | 18 147 | 0.762 | 1 | 73 s |
| Skein | on | 3 | 12 | 12 | 48 133 | 17 541 | 30 592 | 64% | 2 882 (2 134 + 748) | 16 525 | 0.513 | 1 | 56 s |
| Skein | off | 1 | 16 | 18 | 76 781 | 25 453 | 51 328 | 67% | 4 619 (3 849 + 770) | 22 030 | 0.777 | 1 | 90 s |
| Skein | off | 2 | 16 | 16 | 73 658 | 18 874 | 54 784 | 74% | 3 856 (2 919 + 937) | 18 982 | 0.611 | 1 | 69 s |
| Skein | off | 3 | 15 | 15 | 69 195 | 21 067 | 48 128 | 70% | 3 771 (3 099 + 672) | 19 954 | 0.641 | 1 | 64 s |
| opencode | on | 1 | 7 | 8 | 62 103 | 3 735 | 58 368 | 94% | 2 122 (1 241 + 881) | — | 0.240 | 1 | 61 s |
| opencode | on | 2 | 9 | 8 | 78 967 | 3 063 | 75 904 | 96% | 1 971 (1 184 + 787) | — | 0.231 | 1 | 78 s |
| opencode | on | 3 | 8 | 7 | 68 928 | 2 880 | 66 048 | 96% | 1 428 (1 109 + 319) | — | 0.193 | 1 | 74 s |
| opencode | off | 1 | 7 | 6 | 58 654 | 2 206 | 56 448 | 96% | 1 359 (946 + 413) | — | 0.155 | 1 | 50 s |
| opencode | off | 2 | 8 | 7 | 70 918 | 3 078 | 67 840 | 96% | 1 851 (1 236 + 615) | — | 0.214 | **0** | 55 s |
| opencode | off | 3 | 6 | 5 | 54 013 | 3 581 | 50 432 | 93% | 2 514 (1 198 + 1 316) | — | 0.256 | 1 | 58 s |

### 8.4 Comments

Skein takes 16–19 turns against opencode's 7–8 steps and costs 0.64–0.76 ₽ against
0.21–0.23 ₽, roughly 3–3.3× more. It re-reads 6.8–8.6× more (21–26k tokens against 3.1k),
with a cache hit of 70% against 96%. Skein also spends more reasoning: 1.3k against 0.8k with
`on`, and 0.77k against 0.62k with `off`.

This is Construction from a specification: opencode goes almost straight to the artefact,
while Skein pays for Research, Construction and transitions. opencode's miss with `off` is a
substantive agent error (the fingerprint format), not a harness failure; it is honestly
included in the medians (2/3).

The opencode cost here is the actual sum of `usage.cost`, not a rate-based estimate, so it
differs slightly from the numbers in `compare_skein_opencode.md` §4 (which were marked `≈`).
Same-day comparison: both agents were measured on 2026-10-24, K=3, in both network modes.

### 8.5 Traces

`bench/runs/matrix/2026-10-24T12-09-14-openssl-selfsigned-cert/` — cells under
`cells/<agent>-net<mode>-r<n>/`, summary in `summary.json`.


## 9. fix-code-vulnerability

### 9.1 The task

`/app` is a git repository with `bottle.py` and tests. The agent must find a vulnerability
(header injection) in `bottle.py`, fix it, write a report to `/app/report.jsonl` and run the
tests. Acceptance checks both the repository's tests and the report. The task needs no
network: the image already ships bottle and pytest.

### 9.2 How it is solved

- **Skein** follows `O → L → P → V → End`. In Localization it finds `_hkey`/`_hval` and the missing
  CRLF/NUL checks; in Patch it restores them and writes the report; in Verification it runs
  `pytest`.
- **opencode** sees the removed checks through `git diff`, restores them, writes
  `report.jsonl` and runs `pytest`. This usually takes 8–15 steps.

This is Repair: the cause is found in Localization, and the Patch is comparatively small.

### 9.3 Results

All 12 cells returned `reward = 1`. The table shows medians, with the range in parentheses.

| agent | net | K | reward | turns / steps | ₽ | reasoning | total in | fresh | cache hit |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|
| Skein | on | 3 | 3/3 | **29** (26–34) | **1.075** | 1 408 | 159 287 | 38 336 | 77% |
| Skein | off | 3 | 3/3 | **22** (21–26) | **0.750** | 1 080 | 121 589 | 28 333 | 78% |
| opencode | on | 3 | 3/3 | **9** (8–15) | **0.297** | 506 | 120 118 | 9 526 | 92% |
| opencode | off | 3 | 3/3 | **9** (8–14) | **0.339** | 500 | 131 098 | 10 650 | 92% |

| agent | net | repeat | turns/steps | tool calls | total in | fresh | cache | cache hit | out (visible + reasoning) | peak | ₽ | reward | cell time |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|
| Skein | on | 1 | 29 | 34 | 159 287 | 42 935 | 116 352 | 73% | 4 554 (3 146 + 1 408) | 37 129 | 1.097 | 1 | 100 s |
| Skein | on | 2 | 34 | 40 | 175 296 | 38 336 | 136 960 | 78% | 5 281 (3 416 + 1 865) | 19 906 | 1.075 | 1 | 109 s |
| Skein | on | 3 | 26 | 30 | 143 071 | 32 735 | 110 336 | 77% | 3 646 (2 607 + 1 039) | 26 432 | 0.856 | 1 | 92 s |
| Skein | off | 1 | 22 | 25 | 121 589 | 25 461 | 96 128 | 79% | 3 657 (2 486 + 1 171) | 24 527 | 0.726 | 1 | 81 s |
| Skein | off | 2 | 21 | 25 | 108 717 | 28 333 | 80 384 | 74% | 3 370 (2 290 + 1 080) | 26 101 | 0.750 | 1 | 76 s |
| Skein | off | 3 | 26 | 30 | 147 516 | 31 932 | 115 584 | 78% | 3 721 (2 809 + 912) | 25 111 | 0.849 | 1 | 85 s |
| opencode | on | 1 | 15 | 22 | 257 745 | 22 993 | 234 752 | 91% | 3 802 (1 685 + 2 117) | — | 0.762 | 1 | 71 s |
| opencode | on | 2 | 8 | 9 | 93 205 | 6 805 | 86 400 | 93% | 1 056 (634 + 422) | — | 0.232 | 1 | 46 s |
| opencode | on | 3 | 9 | 12 | 120 118 | 9 526 | 110 592 | 92% | 1 336 (830 + 506) | — | 0.297 | 1 | 51 s |
| opencode | off | 1 | 9 | 14 | 131 098 | 10 650 | 120 448 | 92% | 1 565 (1 065 + 500) | — | 0.339 | 1 | 55 s |
| opencode | off | 2 | 14 | 16 | 224 194 | 13 506 | 210 688 | 94% | 2 968 (1 365 + 1 603) | — | 0.516 | 1 | 66 s |
| opencode | off | 3 | 8 | 12 | 101 976 | 8 408 | 93 568 | 92% | 1 202 (938 + 264) | — | 0.269 | 1 | 50 s |

### 9.4 Comments

Skein takes 22–29 turns against opencode's 9 steps and costs 0.75–1.07 ₽ against
0.30–0.34 ₽, that is, 2.2–3.6× more. It re-reads 2.6–4× more (28–38k tokens against
9.5–10.7k), with a cache hit of 77–78% against 92%; it also spends 2–3× more on reasoning.
Total input is comparable (122–159k versus 120–131k), but almost all of opencode's input comes
from the cache.

**This task is noisier than the others.** An earlier K=3 on the same day (14:31) gave
20/18/38 turns and a median of 20 at 0.688 ₽; the current one gives 29/34/26 and a median of
29 at 1.075 ₽. The prompt and model are the same, and the turn budget was not reached. This is
model variance, not a network effect: Skein's `net on` and `net off` differ by 29 versus 22
turns, but with this spread no conclusion about the network can be drawn. For the article this
task needs a larger K, or an explicit caveat that a K=3 median is unstable.

### 9.5 Traces

- Current matrix: `bench/runs/matrix/2026-10-24-fix-code/` — cells under
  `cells/<agent>-net<mode>-r<n>/`, summary in `summary.json`.
- Earlier Skein K=3: `bench/runs/prompt-tests/2026-10-24T14-31-54-fix-code-k3/`.


## 10. fix-git

### 10.1 The task

`/app/personal-site` contains a git repository in which the good commit never reached
`master`. The agent must find the lost changes and merge them into `master`. Acceptance
compares the site files with the reference. The task needs no network.

### 10.2 How it is solved

- **Skein** follows `O → L → P → V → End`. In Localization it finds the dangling commit `143acb6`
  ("Move to Stanford"); in Patch it merges and resolves the conflict in `about.md`; in
  Verification it checks the result.
- **opencode** finds the same commit through `git reflog`, merges, resolves the conflict and
  commits. This usually takes 8–10 steps.

This is a History task: the work is in the repository's history, not in individual files.

### 10.3 Results

All 12 cells returned `reward = 1`. The table shows medians, with the range in parentheses.

| agent | net | K | reward | turns / steps | ₽ | reasoning | total in | fresh | cache hit |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|
| Skein | on | 3 | 3/3 | **20** (20–22) | **0.777** | 853 | 82 377 | 31 469 | 64% |
| Skein | off | 3 | 3/3 | **22** (19–22) | **0.804** | 1 200 | 85 505 | 30 593 | 67% |
| opencode | on | 3 | 3/3 | **9** (8–10) | **0.216** | 600 | 93 721 | 4 892 | 94% |
| opencode | off | 3 | 3/3 | **9** (8–10) | **0.208** | 408 | 91 040 | 4 667 | 94% |

| agent | net | repeat | turns/steps | tool calls | total in | fresh | cache | cache hit | out (visible + reasoning) | peak | ₽ | reward | cell time |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|
| Skein | on | 1 | 22 | 23 | 90 837 | 32 981 | 57 856 | 64% | 3 358 (2 311 + 1 047) | 19 838 | 0.822 | 1 | 78 s |
| Skein | on | 2 | 20 | 23 | 78 829 | 31 469 | 47 360 | 60% | 3 142 (2 473 + 669) | 15 975 | 0.777 | 1 | 72 s |
| Skein | on | 3 | 20 | 23 | 82 377 | 28 489 | 53 888 | 65% | 3 363 (2 510 + 853) | 19 298 | 0.743 | 1 | 77 s |
| Skein | off | 1 | 22 | 24 | 85 505 | 30 593 | 54 912 | 64% | 3 709 (2 463 + 1 246) | 17 741 | 0.804 | 1 | 84 s |
| Skein | off | 2 | 19 | 21 | 69 677 | 22 701 | 46 976 | 67% | 2 880 (2 327 + 553) | 13 442 | 0.607 | 1 | 67 s |
| Skein | off | 3 | 22 | 25 | 98 754 | 31 426 | 67 328 | 68% | 3 668 (2 468 + 1 200) | 21 654 | 0.820 | 1 | 97 s |
| opencode | on | 1 | 8 | 11 | 79 518 | 4 766 | 74 752 | 94% | 1 453 (853 + 600) | — | 0.216 | 1 | 50 s |
| opencode | on | 2 | 10 | 9 | 98 204 | 4 892 | 93 312 | 95% | 1 249 (775 + 474) | — | 0.205 | 1 | 51 s |
| opencode | on | 3 | 9 | 10 | 93 721 | 5 785 | 87 936 | 94% | 1 840 (1 118 + 722) | — | 0.262 | 1 | 52 s |
| opencode | off | 1 | 9 | 9 | 91 040 | 5 152 | 85 888 | 94% | 1 260 (852 + 408) | — | 0.208 | 1 | 75 s |
| opencode | off | 2 | 10 | 9 | 93 069 | 4 365 | 88 704 | 95% | 1 615 (1 096 + 519) | — | 0.220 | 1 | 132 s |
| opencode | off | 3 | 8 | 9 | 80 571 | 4 667 | 75 904 | 94% | 1 109 (753 + 356) | — | 0.185 | 1 | 47 s |

### 10.4 Comments

Skein takes 20–22 turns against opencode's 9 steps and costs 0.78–0.80 ₽ against
0.21–0.22 ₽, that is, 3.6–3.9× more. It re-reads 6.3–6.7× more (30–31k tokens against
4.7–4.9k), with a cache hit of 64–67% against 94%; it also spends about twice as much on
reasoning. Total input is comparable (82–86k versus 91–94k), but almost all of opencode's
input comes from the cache.

The task is short and stable: an earlier Skein K=3 on the same day (14:30) gave 22/22/24 turns
and a median of 22 at 0.810 ₽; the current one gives 20/20/22 and 0.777 ₽ with `on`. The
spread is small, unlike `fix-code`. The task needs no network, so `on` and `off` differ only
by noise.

### 10.5 Traces

- Current matrix: `bench/runs/matrix/2026-10-24-fix-git/` — cells under
  `cells/<agent>-net<mode>-r<n>/`, summary in `summary.json`.
- Earlier Skein K=3: `bench/runs/prompt-tests/2026-10-24T14-30-11-fix-git-k3/`.


## 11. git-leak-recovery

### 11.1 The task

`/app/repo` contains a git repository with a secret hidden in an unreachable object. The agent
must recover the secret, write it to `/app/secret.txt`, and purge it from the repository's
history without touching other files or commit messages. Acceptance checks both the secret
and the cleaned history. The task needs no network.

### 11.2 How it is solved

- **Skein** follows `O → R → Recovery → P → V → End`. In Research it finds the object and the
  purge method; in Recovery it extracts the secret; in Patch it purges the history
  (`reflog expire`, `gc --prune=now`); in Verification it scans the objects.
- **opencode** does the same through `git reflog`/`fsck`: it finds the secret, writes
  `secret.txt`, cleans the reflog and objects, and checks the result. This usually takes 5–8
  steps.

This is a Hybrid task: a single request asks both to recover data and to modify the repository.

### 11.3 Results

All 12 cells returned `reward = 1`. The table shows medians, with the range in parentheses.

| agent | net | K | reward | turns / steps | ₽ | reasoning | total in | fresh | cache hit |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|
| Skein | on | 3 | 3/3 | **26** (22–30) | **1.415** | 2 521 | 120 918 | 43 694 | 63% |
| Skein | off | 3 | 3/3 | **20** (19–33) | **0.869** | 1 552 | 75 247 | 33 775 | 63% |
| opencode | on | 3 | 3/3 | **6** (5–7) | **0.157** | 361 | 54 359 | 3 159 | 95% |
| opencode | off | 3 | 3/3 | **7** (6–8) | **0.189** | 663 | 62 175 | 3 039 | 95% |

| agent | net | repeat | turns/steps | tool calls | total in | fresh | cache | cache hit | out (visible + reasoning) | peak | ₽ | reward | cell time |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|
| Skein | on | 1 | 22 | 25 | 90 054 | 34 118 | 55 936 | 62% | 5 148 (3 202 + 1 946) | 15 758 | 0.964 | 1 | 83 s |
| Skein | on | 2 | 30 | 34 | 154 542 | 43 694 | 110 848 | 72% | 8 999 (6 478 + 2 521) | 25 765 | 1.415 | 1 | 126 s |
| Skein | on | 3 | 26 | 32 | 120 918 | 44 502 | 76 416 | 63% | 11 255 (5 182 + 6 073) | 28 927 | 1.573 | 1 | 139 s |
| Skein | off | 1 | 20 | 23 | 75 247 | 33 775 | 41 472 | 55% | 3 930 (2 378 + 1 552) | 14 112 | 0.869 | 1 | 99 s |
| Skein | off | 2 | 19 | 23 | 69 764 | 25 732 | 44 032 | 63% | 3 140 (2 397 + 743) | 12 028 | 0.677 | 1 | 86 s |
| Skein | off | 3 | 33 | 36 | 159 818 | 51 786 | 108 032 | 68% | 8 923 (5 407 + 3 516) | 22 607 | 1.549 | 1 | 130 s |
| opencode | on | 1 | 7 | 9 | 64 283 | 3 355 | 60 928 | 95% | 1 564 (1 000 + 564) | — | 0.200 | 1 | 55 s |
| opencode | on | 2 | 5 | 4 | 42 518 | 2 070 | 40 448 | 95% | 753 (539 + 214) | — | 0.113 | 1 | 60 s |
| opencode | on | 3 | 6 | 9 | 54 359 | 3 159 | 51 200 | 94% | 1 196 (835 + 361) | — | 0.157 | 1 | 88 s |
| opencode | off | 1 | 8 | 10 | 70 748 | 2 908 | 67 840 | 96% | 1 575 (912 + 663) | — | 0.216 | 1 | 55 s |
| opencode | off | 2 | 6 | 7 | 53 633 | 3 073 | 50 560 | 94% | 1 491 (827 + 664) | — | 0.189 | 1 | 52 s |
| opencode | off | 3 | 7 | 10 | 62 175 | 3 039 | 59 136 | 95% | 1 366 (797 + 569) | — | 0.178 | 1 | 122 s |

### 11.4 Comments

Skein takes 20–26 turns against opencode's 6–7 steps and costs 0.87–1.42 ₽ against
0.16–0.19 ₽, that is, 4.6–9× more. It re-reads 10–14× more (34–44k tokens against
3.0–3.2k), with a cache hit of 63% against 95%; it spends 2–7× more on reasoning. Skein's
total input is also higher (75–121k versus 54–62k).

**The task is noisy.** Skein ranges from 19 to 33 turns and from 0.68 to 1.57 ₽: one `off`
run took 33 turns, one `on` run 30. An old 10-18 run on the old prompt gave 18 turns and
0.375 ₽, so the current median is noticeably higher. At K=3 this is more a property of the
task and the model than a network effect; `on` and `off` are semantically identical here
because the task needs no network.

opencode is especially strong on this task: 5–8 steps, minimal re-reading, a 95% cache hit.

### 11.5 Traces

- Current matrix: `bench/runs/matrix/2026-10-24-git-leak/` — cells under
  `cells/<agent>-net<mode>-r<n>/`, summary in `summary.json`.
- Old Skein run: `bench/runs/sandbox-tasks/2026-10-18T06-25-14-883Z-git-leak-recovery`
  (18 turns, old prompt).


## 12. custom-memory-heap-crash

### 12.1 The task

`/app` contains a program with a custom allocator and two versions of libstdc++. It crashes
in release but not in debug. Only `/app/user.cpp` may be edited; valgrind must report no leaks.
Acceptance builds and runs the program and checks valgrind. The task needs no network.

### 12.2 How it is solved

- **Skein** follows `O → L → P → V → End`. In Localization it looks for the crash cause (static
  destruction and the custom heap) in `user.cpp`; in Patch it edits `user.cpp`; in
  Verification it builds release/debug and runs valgrind.
- **opencode** reads `main.cpp`, `user.cpp` and `user.h`, forms a hypothesis about static
  facet destruction, edits `user.cpp`, builds both versions and runs valgrind. This usually
  takes 18–27 steps.

This is Repair with a long state: the work is in one file, but it requires builds and a memory
check.

### 12.3 Results

By the owner's decision only `net off` was measured: the task does not need network, and a full
`net on` grid would cost several more tens of roubles and minutes. All 6 cells returned
`reward = 1`. The table shows medians, with the range in parentheses.

| agent | net | K | reward | turns / steps | ₽ | reasoning | total in | fresh | cache hit |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|
| Skein | off | 3 | 3/3 | **57** (49–59) | **3.615** | 17 795 | 578 748 | 104 284 | 82% |
| opencode | off | 3 | 3/3 | **20** (18–27) | **1.398** | 7 110 | 608 338 | 31 826 | 94% |

| agent | net | repeat | turns/steps | tool calls | total in | fresh | cache | cache hit | out (visible + reasoning) | peak | ₽ | reward | cell time |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|
| Skein | off | 1 | 57 | 80 | 562 268 | 104 284 | 457 984 | 82% | 23 957 (8 721 + 15 236) | 82 815 | 3.615 | 1 | 306 s |
| Skein | off | 2 | 59 | 78 | 578 748 | 115 644 | 463 104 | 80% | 26 227 (8 432 + 17 795) | 82 166 | 3.970 | 1 | 318 s |
| Skein | off | 3 | 49 | 60 | 910 313 | 94 057 | 816 256 | 90% | 24 253 (6 259 + 17 994) | 142 158 | 3.583 | 1 | 281 s |
| opencode | off | 1 | 27 | 26 | 608 338 | 31 826 | 576 512 | 95% | 9 288 (3 339 + 5 949) | — | 1.398 | 1 | 151 s |
| opencode | off | 2 | 20 | 22 | 454 846 | 28 734 | 426 112 | 94% | 10 465 (3 355 + 7 110) | — | 1.370 | 1 | 141 s |
| opencode | off | 3 | 18 | 26 | 637 400 | 48 728 | 588 672 | 92% | 15 511 (3 305 + 12 206) | — | 2.127 | 1 | 176 s |

### 12.4 Comments

Skein takes 49–59 turns against opencode's 18–27 steps and costs 3.58–3.97 ₽ against
1.37–2.13 ₽, that is, 1.7–2.9× more (2.6× by medians). It re-reads 2–4× more (94–116k tokens
against 29–49k), with a cache hit of 80–90% against 92–95%; it spends 1.5–2.6× more on
reasoning.

This is exactly the long task where transitions amortise: Skein's relative loss here is
noticeably smaller than on the short tasks (2.6–3.9×, and up to 9× on git-leak), although
its absolute cost is
higher because the task is long. The hypothesis "Skein is closer on long states" is largely
supported, but opencode is still cheaper and faster.

Separately: in the old Harbor run opencode got `reward 0` on this task; in the sandbox it
solves 3/3. These are different harnesses and agent versions, so the numbers are not directly
comparable — but for the current sandbox the result is as shown.

### 12.5 Traces

`bench/runs/matrix/2026-10-24-custom-memory/` — cells under
`cells/<agent>-netoff-r<n>/`, summary in `summary.json`.

## 13. password-recovery

### 13.1 The task

`/app/varsea` holds a disk image, `ae3f4c.dat`, from which `launchcode.txt` was deleted. The
agent must recover a password of the form `PASSWORD=`, 23 characters, `8XD…W54` (uppercase and
digits), and write candidates to `/app/recovered_passwords.txt`. The verifier checks the file
and the exact password. The task needs no network.

### 13.2 How it is solved

- **Skein** follows `O → R → Recovery → End`: in Research it finds the fragments, the CRC and
  the enumeration method; in Recovery it assembles candidates with a script and closes.
- **opencode** finds the fragments in the image, takes the CRC from the ZIP central directory,
  assembles the candidate and writes the file.

### 13.3 Results

K=1, `net off`; one run per agent.

| agent | net | K | reward | turns / steps | ₽ | reasoning | total in | fresh | cache hit |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|
| Skein | off | 1 | 1/1 | **33** | **1.938** | 8 846 | 213 508 | 53 252 | 75% |
| opencode | off | 1 | 1/1 | **13** | **1.003** | 6 688 | 208 977 | 20 305 | 90% |

### 13.4 Comments

Skein makes 33 LLM calls against opencode's 13 and costs 1.94 ₽ against 1.00 ₽ (1.9× more).
It re-reads 53.3k tokens against 20.3k, with a cache hit of 75% against 90%; reasoning is
8.8k against 6.7k. K=1 is a single measurement, not a median.

### 13.5 Traces

`bench/runs/matrix/2026-10-24-password/` — cells under `cells/<agent>-netoff-r1/`.

## 14. db-wal-recovery

### 14.1 The task

The WAL of `main.db` is damaged/encrypted. The agent must recover it so that SQLite reads all
11 records and write them to `/app/recovered.json`, sorted by `id`. The verifier checks the
JSON. The task needs no network.

### 14.2 How it is solved

- **Skein** follows `O → R → Recovery → End`: in Research it works out the WAL/XOR/frames; in
  Recovery it decodes them and writes the JSON.
- **opencode** handles the WAL with `sqlite3`, restores the records and writes the JSON.

### 14.3 Results

K=1, `net off`.

| agent | net | K | reward | turns / steps | ₽ | reasoning | total in | fresh | cache hit |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|
| Skein | off | 1 | 1/1 | **17** | **1.035** | 2 694 | 87 445 | 29 333 | 67% |
| opencode | off | 1 | 1/1 | **8** | **0.242** | 380 | 87 409 | 7 153 | 92% |

### 14.4 Comments

opencode takes 8 steps against 17 and costs 0.24 ₽ against 1.03 ₽ — 4.3× cheaper. Skein
re-reads 29.3k tokens against 7.2k and spends 2.7k reasoning tokens against 0.38k. K=1.

### 14.5 Traces

`bench/runs/matrix/2026-10-24-db-wal/` — cells under `cells/<agent>-netoff-r1/`.

## 15. crack-7z-hash

### 15.1 The task

`secrets.7z` is a password-protected archive; the image ships John the Ripper. The agent must
crack the password, extract the word and write it to `/app/solution.txt`. The task needs
network: the agent installs `p7zip` and a Perl module. The verifier checks the word.

### 15.2 How it is solved

- **Skein** follows `O → R → Recovery → End`: in Research it works out the archive/hash/method;
  in Recovery it runs John and extracts the word.
- **opencode** installs `p7zip`, runs `7z2john` and `john`, extracts the archive and writes the
  file.

### 15.3 Results

K=1, `net on` (the task does not run offline).

| agent | net | K | reward | turns / steps | ₽ | reasoning | total in | fresh | cache hit |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|
| Skein | on | 1 | 1/1 | **21** | **0.901** | 2 027 | 94 033 | 32 337 | 66% |
| opencode | on | 1 | 1/1 | **12** | **0.308** | 348 | 142 948 | 9 572 | 93% |

### 15.4 Comments

opencode takes 12 steps against 21 and costs 0.31 ₽ against 0.90 ₽ (2.9× cheaper). Skein
re-reads 32.3k tokens against 9.6k; cache hit 66% against 93%. Only `net on` is possible: the
task needs network for the agent. K=1.

### 15.5 Traces

`bench/runs/matrix/2026-10-24-crack/` — cells under `cells/<agent>-neton-r1/`.

## 16. cobol-modernization

### 16.1 The task

`/app/src/program.cbl` is a COBOL program; the `.DAT` files it produces must match the output
of a Python version. The agent must rewrite the program in Python and preserve its behaviour.
Acceptance is differential: it compares the output `.DAT` files. The task needs no network.

### 16.2 How it is solved

- **Skein** follows `O → R → Construction → End`: in Research it analyses the COBOL, the record
  formats and the differential check; in Construction it writes the Python and a harness.
- **opencode** reads the COBOL, compiles and runs the original, works out the behaviour, writes
  the Python and a differential harness.

### 16.3 Results

K=1, `net off`.

| agent | net | K | reward | turns / steps | ₽ | reasoning | total in | fresh | cache hit |
|---|---|---:|---|---:|---:|---:|---:|---:|---:|
| Skein | off | 1 | 1/1 | **38** | **3.654** | 19 746 | 768 941 | 75 565 | 90% |
| opencode | off | 1 | 1/1 | **31** | **3.708** | 20 977 | 971 194 | 49 210 | 95% |

### 16.4 Comments

This is a long Construction task: Skein takes 38 LLM calls against 31, and the cost is almost
equal (3.65 ₽ against 3.71 ₽). Skein re-reads 75.6k tokens against 49.2k, but opencode has more
total input (971k against 769k) and slightly more output/reasoning (36.7k against 30.5k). K=1.

### 16.5 Traces

`bench/runs/matrix/2026-10-24-cobol/` — cells under `cells/<agent>-netoff-r1/`.

## 17. Template for the next task

```md
## N. <task-id>

### N.1 The task
What is given, what is broken or must be built, how acceptance works and what makes the
verifier special.

### N.2 How it is solved
Skein's route (`O→…→End`), the key action and state. How opencode solves it. What they share
and how they differ.

### N.3 Results
Summary table: agent, net, K, reward, turns/steps, ₽, reason, total in, fresh, cache hit.
Per-run tables below when K is greater than one.

### N.4 Comments
Observations, cost and time, caveats: K, not a same-day comparison, prompt versions.

### N.5 Traces
`bench/runs/…` paths.
```

## 18. What to measure next

1. **fix-ocaml-gc, `net on`.** There are no fresh measurements on the current model: on
   10-24 only `net off` was run. Repeat with `--net on` if needed.
2. **K=3 for `password`, `db-wal`, `crack`, `cobol`.** They are K=1 now; the article needs
   the spread, especially on the short `db-wal` and `crack`. `crack` is `net on` only.

Live runs cost money and time, so they are started only with the owner's permission.
