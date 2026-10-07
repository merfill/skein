# Skein — engine defects found on fix-ocaml-gc, and the plan to fix them

> Russian mirror — `docs/plans/engine_fixes_found_ru.md`.

> **Historical.** Predates the current IR: the `complete` operator is removed and
> `done_when` is `objective` | `arbiter`. See `docs/ir.md`, `docs/ir_semantics.md`.

Related: `docs/plans/fix_ocaml_gc_investigation.md` (the run journal),
`docs/fix_ocaml_gc_run_report_2026-10-05.md` (the focus defect),
`docs/fix_ocaml_gc_run_report_2026-10-06.md` (the accepted fix),
`docs/ir_semantics.md`, `docs/tools.md`, `docs/projection.md`,
`docs/testing.md` (commands and the live gate).

Status: plan agreed 2026-10-06. Items **S1–S5**, **P0**, **P1**, **P2**, **P3.1**, **P3.3**,
**P4** (remove `need`) and **P5/P6** are implemented; P1's
backtrace is best-effort where the platform pipes cores. **P3.2** (fast proxy reward)
is deferred: it needs Harbor-internals infrastructure, not engine work.

Acceptance (**2026-10-06, twice**): two `fix-ocaml-gc` runs on Flash + reasoning `high`,
`maxTurns 60`, `override_cpus: 4` — both **reward 1.0** (`40 tests passed`). The first
(`2026-10-06__10-57-47`, ~36 min, with `need`) and the second
(`2026-10-06__14-53-22`, ~39 min, after `need` removal + P5/P6) each named the defect
(`pool_sweep` advances `p` by `Whsize_hd(hd)` instead of `wh`) and made the reference
one-line edit; both stopped at `max_turns` (turns spent polling the long build /
re-reading), but the verifier confirmed the fix each time. The second run shows the
post-`need` engine does not regress the live path. Details:
`docs/fix_ocaml_gc_run_report_2026-10-06.md`. Artifacts:
`~/.skein-bench/harbor/2026-10-06__10-57-47/`, `~/.skein-bench/harbor/2026-10-06__14-53-22/`.

Task constraints (agreed): the model is not changed for everyday work; the whole
bench set is not run; acceptance is a single `fix-ocaml-gc` run.

---

## 1. What prompted this

The `fix-ocaml-gc` runs (terminal-bench): after run-length compression of the free
space in the major heap, the OCaml compiler segfaults during bootstrap. The reference
fix is a **single token** — `sed -i '650s/Whsize_hd(hd)/wh/' runtime/shared_heap.c`,
i.e. the unconditional cursor advance `p += Whsize_hd(hd);` becomes `p += wh;`
(confirmed from the task's `solution/solve.sh`). The criterion is
`make -C testsuite one DIR=tests/basic` → "40 tests passed".

The 2026-10-05 run made **one** edit in 60 turns (wrong), then spent the budget in
the `unknown_revision` loop (focus defect), `Text file busy` retries and
re-localization. Investigation (chat probes, ideal conditions: buggy `pool_sweep` +
macros + crash diagnostic, minimal prompt, history of the model's own failed edits).

## 2. Findings (evidence)

- **F1 — the decisive factor is the reasoning toggle, not context or the engine.**
  With the production client, `createChatModel` always sends
  `thinking:{type:"disabled"}` and `SKEIN_REASONING_EFFORT` defaulted to `none`
  (`src/llm/client.ts:23`, `src/config/settings.ts:33`).
  - Flash, reasoning **off**: 15/15 attempts wrong (and 6 further attempts with a
    rich core dump wrong); it never touched line 650.
  - Flash, reasoning **high**: correct fix on attempt 1; with the terse error it also
    solved it (2/2). The core dump is helpful but was **not required**.
  - V4 Pro, reasoning **high**: correct fix on attempt 1.
- **F2 — ground truth**: `sed '650s/Whsize_hd(hd)/wh/'`; `p += Whsize_hd(hd)` is a
  *word count* (Wosize+1) while every pool block spans `wh` words, so the advance
  must be `wh`.
- **F3 — context/instruction ablation did not rescue the reasoning-off model**:
  adding macro definitions, the model's own closing note, a full gdb core dump
  (crash line, locals, `p-end=12`) and a forced loop trace all still failed. This
  isolated the cause to the model/config.
- **F4 — engine defects found along the way** (details in §5–§7): focus under a
  closed ancestor; a closing move could target an ancestor; a re-check after
  `inconclusive` was refused; `complete` notes and edit diffs are not surfaced; the
  segfault/core dump is not read; `run` has a 120 s cap; the verifier rebuilds OCaml
  for ~2 h.

## 3. Done in the working tree (S1–S5)

- **S1. `focusEvents` trims the branch under a closed ancestor** — `src/ir/traversal.ts`
  (invariant 17); test `tests/ir.test.ts`.
- **S2. A closing move acts on the node in focus** — `apply run {target}` and
  `complete {goal}` reject an ancestor/sibling (`not_current_goal`) —
  `src/loop/classify.ts`; tests `tests/loop.test.ts`.
- **S3. A re-check after an `inconclusive` verdict is allowed** —
  `src/loop/classify.ts`; test.
- **S4. Docs** — `docs/ir_semantics.md` (+`_ru`), `docs/ir.md` (+`_ru`),
  `docs/tools.md` (+`_ru`).
- **S5. Live step test** `focus-check` —
  `fixtures/live/fix-ocaml-gc-steps.json`, `tests/live/fix_ocaml_step.test.ts`.

## 4. P0 — reasoning on and a larger completion budget (implemented)

- `src/config/settings.ts`: `reasoningEffort` default `"low"` for everyday runs;
  a hard task raises it to `"high"` per run — `SKEIN_REASONING_EFFORT`, or the
  Harbor adapter's `configurable.reasoningEffort`. `maxTokens` 4096 → **8192**
  (ceiling 32768 unchanged).
- `src/llm/client.ts`: `reasoningBody(effort)` — `"none"` keeps the old off-body,
  otherwise `{ reasoning: { effort } }` (the exact form that produced the correct
  fix).
- `tests/loop.test.ts`: updated (default `low`, env override `high`,
  `reasoningBody` cases).

Agreed: reasoning is on by default at `low`; the bench/acceptance (`fix-ocaml-gc`)
runs at `high` (`bench/harbor/skein.template.yaml` → `configurable.reasoningEffort:
high`). `maxTokens=8192`. Risk: `high` costs more latency; a provider may
additionally want `thinking`; verify live.

## 5. P1 — crash diagnostics (core dump): never lose the crash information

**DONE (2026-10-06), P1b best-effort.** `CommandResult.signal` is set in
`workspace.run`; the wrapper raises `ulimit -c unlimited`; on a crash signal
(`!timedOut`) `crashReport` (`src/tools/crash.ts`) finds the newest `core*` in the
workspace and, if `gdb` is present, runs `gdb --batch -nx -c <core> -ex bt -ex "info
locals"`. The observation/check payloads carry `signal`/`core`/`backtrace`, the turn
header says "killed by SIGSEGV", and `src/ir/project.ts` surfaces them in
`lastResult` and the `calls` note. When no core was written, the engine reports the
kernel's `core_pattern` so the absence is explained. Covered for a foreground run and a
completed background job (`JobResult.startedAt`). Files: `workspace.ts`, `crash.ts`,
`tools/index.ts`, `events.ts`, `graph.ts`, `project.ts`; docs `docs/tools.md` §4.3.

Recon result: on the dev host `core_pattern` is a pipe to `systemd-coredump`
(`|/usr/lib/systemd/systemd-coredump …`), so no `core` file appears in the workspace;
`gdb` is installed. In a Docker task container the host `core_pattern` is inherited, so
the core file may never be written — then P1 yields the **signal only**, not a
backtrace. A `debug`/run-under-gdb variant is the robust alternative for a container
that pipes cores (open question §10).

Original loss points:

1. `src/tools/workspace.ts` — `spawnSync` knows `result.signal`, but `CommandResult`
   dropped it.
2. `src/tools/index.ts` — the `run` observation carried `{command, verdict, output,
   error}`; no signal, no dump.
3. No core was read at all: no `ulimit -c`, no `gdb` on the core (the task image
   installs `gdb`, so debugging is intended).
4. `src/ir/project.ts` — `lastResult`/`calls` showed neither signal nor backtrace.

## 6. P2 — information lost in the projection

**DONE (2026-10-06).** P2a: a completed subjective goal leaves `path` (focusEvents
trims the branch under a closed ancestor), so `callsView` now emits a `complete <goal>`
entry carrying its `note` (`src/ir/project.ts`); `PathNode` also carries `note` for a
closed root goal. P2b: `edit` stores `find`/`replace` in its action payload, a failed
edit now records its action (with a `produces` edge), and `calls` shows a short
`-find +replace` diff (plus the failure reason) instead of a blank "applied"
(`src/tools/index.ts`, `src/ir/project.ts`). P2c: `shown` carries the produced results
of **every level on the branch**, not just the leaf, newest first, so a stage's evidence
stays visible until the parent closes (`src/loop/graph.ts`); the cross-level TTL test was
retargeted to an off-branch result. Docs `docs/tools.md` §4.4. Tests: `tests/loop.test.ts`,
`tests/workingset.test.ts`.

## 6b. P4 — remove `need` (the model no longer shapes the context)

**DONE (2026-10-06).** Found while analyzing the 2026-10-06 acceptance run: `need` was the
one place where doxa declares what the logos should show, which contradicts "doxa proposes,
logos decides"; and a bad id (`complete`/`action` node, or a hallucinated one) refused the
**whole** proposal — 6 of 8 refusals in that run were `need` with a bodyless id, one of
them dropping a valid `read`. With level retention (P2c) and `query {id}` the capability is
covered, so `need` was removed: `proposalSchema` (`src/llm/schemas.ts`), the validation
(`src/loop/classify.ts`), the pinning (`src/loop/graph.ts`), the prompt
(`src/loop/propose.ts`), the live harness/scenarios, and the docs
(`docs/context_design.md` §8, `docs/tools.md` §4.4, `docs/projection.md`, `docs/ir.md`).
The working set is now engine-owned (branch levels) plus `query {id}` bodies (TTL).

## 6c. P5/P6 — the refusal names the focus move; the prompt keeps the focus

**DONE (2026-10-06).** Found by the live `two-outputs` run: after the fix, an objective
goal `w:goal:42` with its plan done sat at the focus (`checkReady: true`), but the model
looped `complete w:goal:2` / `complete w:goal:42` for 12 turns (`not_current_goal` ↔
`objective_goal_needs_check`) to `max_turns` — it did not act on the focus.

- **P5** (`src/loop/classify.ts`): a deterministic `focusHint(state)` reads the focus and
  returns the concrete expected move (check an objective goal whose plan is done; complete
  a subjective one; apply/descend into the next plan item; interpret a request). It is
  appended to the `not_current_goal` refusals, so a wrong-target move is told what to do
  instead — the engine states the frontier, the doxa still proposes.
- **P6** (`src/loop/propose.ts`): the `complete` description and the Rules now state that
  only the focus can be closed, and an objective focus whose plan is done is settled by its
  check, never by completing an ancestor.
- `tests/live/scenarios.ts`: `two-outputs` dropped the now-unmet soft `uses: ["query"]`
  (with level retention both reads stay in view; nothing forces a cross-level fetch).

## 7. P3 — slow verifier and the `run` cap (options 1 + 2 + 3.3)

Root cause: the task verifier `tests/test.sh` does `make clean && ./configure &&
make -j4`, while `task.toml` gives **cpus=1, memory=2G** (so `-j4` is `-j1`), and
`bench/harbor/skein.template.yaml` sets `timeout_multiplier: 2.0` → up to 2 h. The
agent's own `run` is capped at **120 s** (`src/tools/workspace.ts:232`), so the agent
**cannot self-verify** the build at all.

Harbor itself does not check the build: it runs the task verifier and reads
`/logs/verifier/reward.txt`. The `make clean` is the task's code, not Harbor's.

- **P3.1 (option 1) — more CPU/RAM for the container. DONE (2026-10-06).** Harbor's
  `JobConfig` supports job-level `environment.override_cpus` / `override_memory_mb`
  (also `override_storage_mb`/`-gpus`/`-tpu`, plus `cpu_enforcement_policy` /
  `memory_enforcement_policy` = `auto|limit|request|guarantee|ignore`; CLI flags
  `--override-cpus` / `--override-memory-mb`). It overwrites `task_env_config` for every
  task (`harbor/environments/base.py:296`), and the Docker provider applies it as
  `--cpus` / memory limit (`docker/docker.py:269`). Set in
  `bench/harbor/skein.template.yaml`: `override_cpus: 4`, `override_memory_mb: 6144`
  (fits 16 CPU / 30 G at `n_concurrent_trials: 3`). Verified with
  `harbor run --config bench/harbor/skein.yaml --print-config`. Expected: the verifier's
  `make -j4` now gets 4 cores (~2 h → ~30–40 min).
- **P3.2 (option 2) — fast proxy reward.** After the run, execute
  `make -C testsuite one DIR=tests/basic` on the agent's tree (no `make clean`), via
  a Harbor post-run hook/plugin or an external snapshot script. Minutes to ~15 min;
  not an official reward — for iteration only.
  **Recon (2026-10-06): no clean CLI mechanism.** Harbor has no `exec`-into-a-trial;
  `artifacts` can download a path but a moved OCaml tree does not rebuild (absolute
  paths). Plugins are Python entry points (installed into Harbor's env) with
  `JobPlugin.on_job_start/on_job_end`; the programmatic `Job` API exposes
  `on_verification_started` (a hook that could run the incremental check inside the
  container). That is environment-specific infrastructure, not engine work — deferred
  unless repeated iteration needs it.
- **P3.3 — `run` timeout / long commands. DONE (2026-10-06).** A `run` started with
  `background: true` returns at once with a job id and is polled with `{job}`; the
  foreground cap is `SKEIN_RUN_TIMEOUT_MS` (default 120 s). Files: `src/tools/workspace.ts`
  (`startJob`/`pollJob`, separate `.skein/jobs/<id>.{out,err}` logs, `runTimeoutMs`),
  `src/tools/index.ts` (run branch), `src/llm/schemas.ts`, `src/loop/classify.ts`
  (validations; a poll is never a repeat), `src/config/settings.ts`, `langgraph/graph.ts`
  (`configurable.runTimeoutMs`). Docs: `docs/tools.md` §4.7 (+`_ru`). The agent can now
  build and confirm its own fix without blocking a turn.

## 8. Order of work (agreed)

1. **P3.3** — otherwise the agent cannot verify a build. **DONE.**
2. **P1** (crash diagnostics) → **P2** (P1 feeds P2: the backtrace must reach the
   projection). **DONE.**
3. **P3.1** (Harbor recon → implementation) **DONE**; **P3.2** (hook/script) **deferred**
   as Harbor-internals infra, not engine work.
4. Live scenarios + one acceptance run on Flash+reasoning (or Pro+reasoning).
   **DONE** — `two-outputs`, `retrieve-at-scale` pass live; `fix-ocaml-gc` acceptance
   **reward 1.0 twice** (2026-10-06).

## 9. Verification

- Offline after each code change: `npm run typecheck`,
  `SKEIN_LIVE=false npx vitest run`.
- Live step tests: `SKEIN_LIVE=true npx vitest run tests/live/fix_ocaml_step.test.ts`.
- Focused live scenarios (reasoning on) for the affected loop branches.
- Acceptance: one `fix-ocaml-gc` run, with the verifier given enough CPU; read
  `~/.skein-bench/harbor/<ts>/<trial>/verifier/reward.txt`.

## 10. Open questions

- P1: the host `core_pattern` pipes to `systemd-coredump`, so a container likely writes
  no core file; add an explicit run-under-gdb / `debug` variant, or accept signal-only?
- P3.1: does Harbor expose per-task resource overrides?
- P3.2: Harbor plugin vs external snapshot script.
- ~~Whether `reasoningEffort=high` should stay the default for everyday runs or be
  raised only for hard tasks.~~ **Resolved (2026-10-06):** default `low`; the
  bench/acceptance sets `high` per run (`configurable.reasoningEffort`).
