# fix-ocaml-gc — run 2026-10-06: solved (reward 1.0)

> Russian mirror — `docs/fix_ocaml_gc_run_report_2026-10-06_ru.md`.

Related: `docs/fix_ocaml_gc_run_report_2026-10-05.md` (the focus defect),
`docs/plans/engine_fixes_found.md` (the plan that fixed it),
`docs/plans/fix_ocaml_gc_investigation.md` (the run journal),
`docs/fix_ocaml_gc_ideal.md` (the reference shape), `docs/tools.md`,
`docs/ir_semantics.md`.

Run: `harbor run --config /tmp/opencode/accept.yaml -y` — Flash +
reasoning `high`, `maxTurns 60`, `override_cpus: 4` / `override_memory_mb: 6144`.
Two attempts, both on 2026-10-06:

| Job | trial | when | engine | reward |
|---|---|---|---|---|
| `~/.skein-bench/harbor/2026-10-06__10-57-47` | `fix-ocaml-gc__Lr6THZi` | morning | with `need` | **1.0** |
| `~/.skein-bench/harbor/2026-10-06__14-53-22` | `fix-ocaml-gc__a48xRKy` | afternoon | after `need` removed (P4) + P5/P6 | **1.0** |

Both ended at `max_turns`, but the verifier confirmed the fix in each:
`make -C testsuite one DIR=tests/basic` → **`40 tests passed`**.

---

## 1. Outcome

| Metric | 10-57-47 | 14-53-22 |
|---|---|---|
| reward | **1.0** (`40 tests passed`) | **1.0** (`40 tests passed`) |
| agent turns | 60, `stopReason=max_turns` | 60, `stopReason=max_turns` |
| wall (agent / verifier) | ~26 min / ~9 min | ~34 min / ~5 min |
| input / output tokens | 1 141 150 / 342 242 | 1 232 482 / 411 240 |
| cache read | 639 232 (56.0%) | 660 608 (53.6%) |
| context first / peak / last | 777 / 37 587 / 23 564 | 777 / 41 277 / 29 467 |
| graph | createGoal 7, complete 6, **edits 1**, checks 2, goals 8, plans 8, alternatives 1, actions 41 | createGoal 7, complete 8, **edits 1**, checks 2, goals 10, plans 10, alternatives 10, actions 36 |
| edit turn | 29 | 53 |

The **whole-task** wall was ~36 min (10:57:49Z→08:33:39… local 07:57→08:33) and
~39 min (11:53:23Z→12:32:16Z) — the `override_cpus: 4` cut the verifier's
`make -j4` from the earlier ~2 h to under ~10 min (P3.1).

## 2. What changed since 2026-10-05

The 2026-10-05 run made one wrong edit in 60 turns and lost the budget in the
`unknown_revision` loop. The fixes (details: `docs/plans/engine_fixes_found.md`):

- **P0** — reasoning is on (`reasoningEffort="high"` default, `maxTokens=8192`):
  the decisive factor (F1). With reasoning off the model never touched line 650.
- **S1–S3** — focus is trimmed under a closed ancestor; a closing move acts only
  on the node in focus; a re-check after `inconclusive` is allowed.
- **P1** — crash diagnostics: `signal`/`core`/`backtrace` surface in the
  projection (`src/tools/crash.ts`).
- **P2** — the projection keeps what was lost: `complete` notes, `edit`
  `-find +replace` diffs, and the produced results of **every branch level**.
- **P3.1/P3.3** — the container gets 4 CPUs / 6 GB, and `run {background}` +
  `{job}` lets the agent build and verify without blocking a turn.
- **P4** — `need` removed: doxa no longer shapes the context; the working set is
  engine-owned (branch levels) plus `query {id}` (TTL).
- **P5/P6** — a refusal names the focus move (`focusHint`), and the prompt keeps
  the focus.

## 3. Trajectory

Both runs name the defect in `pool_sweep` (the cursor advance uses
`Whsize_hd(hd)` instead of `wh`) and make the reference one-line edit:

```
find:    ... } release_to_global_pool = 0; }  p += Whsize_hd(hd);  } while (p + wh <= end);
replace: ... } release_to_global_pool = 0; }  p += wh;              } while (p + wh <= end);
```

- **10-57-47** (with `need`): edit at turn 29; then the budget went into
  re-reading / polling; 6 of 8 refusals were `need` with a bodyless id.
- **14-53-22** (after P4/P5/P6): the model closes `locate` at turn 45, makes the
  edit at turn 53, then starts a **background** bootstrap build (`job-2`,
  P3.3) and polls it (turns 56–57) before running the fix goal's check
  (turns 58–59). Removing `need` did not regress the live path.

In both, the edit is in place when `max_turns` hits; the harness verifier then
rebuilds clean and passes. The remaining budget is spent on the long build, not
on wrong moves — the trajectory shape now matches `docs/fix_ocaml_gc_ideal.md`.

## 4. Verification

- Offline: `npm run typecheck`; `SKEIN_LIVE=false npx vitest run` —
  **141 passed / 22 skipped**.
- Live scenarios (reasoning on): `two-outputs` and `retrieve-at-scale` pass;
  `retrieve-at-scale` reaches the large body through `query obs:41`.
- Acceptance: the two runs above; read
  `~/.skein-bench/harbor/<ts>/<trial>/verifier/{reward.txt,test-stdout.txt}`.

## 5. Next

1. Trim wasted turns before the fix (localization is 45 turns in 14-53-22) so
   the run stops *before* `max_turns` and can self-verify within budget.
2. The verifier still costs ~5–9 min; keep `override_cpus: 4`.
3. `P3.2` (fast proxy reward) remains deferred — Harbor-internals infra, not
   engine work.
