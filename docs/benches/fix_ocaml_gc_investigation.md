# fix-ocaml-gc — investigation journal (context, tools, plan)

> Russian mirror — `docs/benches/fix_ocaml_gc_investigation_ru.md`.

> **Historical.** Predates the current IR: the `complete` operator is removed and
> `done_when` is `objective` | `arbiter`. See `docs/ir.md`, `docs/ir_semantics.md`.

Related: `docs/context_design.md` (the projection and plan design),
`docs/projection.md`, `docs/tools.md`, `docs/ir_semantics.md`,
`docs/benches/fix_ocaml_gc_ideal.md` (the reference form).

Status: a working journal. It records what has been investigated, what is fixed, what
remains, so work can resume from any point. **The current state is §9 (session
2026-10-06): the acceptance passes.** The changes are committed.

Task constraints (agreed): we do not change the model; we do not run the whole set; we
aim for a short route (the reference is ~14 turns), not 60.

---

## 1. What we test

A single probe case — `fix-ocaml-gc` (terminal-bench): after run-length compressing the
free space in the major heap, the OCaml compiler crashes during bootstrap. The reference
fix is one line in `runtime/shared_heap.c` (~line 650). The criterion:
`make -C testsuite one DIR=tests/basic` → "40 tests passed". The run command:

```sh
bash bench/harbor/run.sh    # or harbor run --config /tmp/opencode/skein-fix.yaml -y
```

Jobs live in `~/.skein-bench/harbor/<ts>`; the per-turn log is
`<trial>/agent/langgraph-run.log` (lines `SKEIN_CONTEXT`, `SKEIN_PROPOSAL`,
`SKEIN_TURN`, `SKEIN_EVENTS`, `SKEIN_METRICS`).

---

## 2. Run history

| Job | What changed | peak ctx | turns | edits | checks | reward | stop |
|---|---|---|---|---|---|---|---|
| `2026-10-03__11-00-06` | before everything (witness in context) | 804,503 | 60 | 2 | 2 | 0 | maxTurns |
| `2026-10-03__13-45-56` | negative history (`negative`) | 8,264 | 60 | 0 | 0 | 0 | maxTurns |
| `2026-10-03__15-34-19` | negative clearly visible | 7,974 | 60 | 0 | 0 | 0 | maxTurns |
| `2026-10-03__16-19-58` | read window, grep by content | 8,628 | 60 | 0 | 0 | 0 | maxTurns |
| `2026-10-03__18-04-31` | prompt: strategy, §5.1 (no git) | 19,727 | 60 | 0 | 0 | 0 | maxTurns |
| `2026-10-03__19-31-32` | plan branching (B) + `calls` | 19,600 | **22** | 0 | 0 | 0 | **no_progress** |
| `2026-10-03__19-50-18` | grep may be repeated | 28,772 | 60 | 0 | 0 | 0 | maxTurns |
| `2026-10-03__20-24-32` | working set `need/shown` | 36,716 | 60 | 0 | 0 | 0 | maxTurns |
| `2026-10-03__21-14-05` | prompt: mandatory decomposition | ~37k | 60 | **1** | 0 | 0 | maxTurns |

Conclusion: the context became manageable (804k → tens of k); structure and the first
edit appeared. There is no success (reward = 1).

---

## 3. Defects found and fixes

### 3.1 Context explosion
`frontier.lastResult` inlined a `check` node whole, including `witness` — a version of
**every file** in the workspace (~7000 entries ≈ 767k chars). Peaks `37k→802k`.
**Fixed:** the projection was rewritten — `path`/`constraints`/`lastResult`/`calls`,
raw payloads are not inlined. `SKEIN_CTX_TOTAL`/`SKEIN_CTX_EXCERPT` are gone.

### 3.2 A refusal never reached the model (loop)
`record_rejection` was written, but the new projection had no `refusals`; the context
after a refusal was byte-for-byte the same → the model repeated (7× the same `read`).
**Fixed:** `calls` (formerly `negative`) — dedup by signature + `count`, status
`ok/fail/refused`. An invariant was introduced: a refusal/failure must change the
projection.

### 3.3 Tools lied (silent truncation)
- `read` cut content to 400 chars, and the same window could not be re-read.
- `grep` could not see `.c/.h` (a hard `TEXT_EXT` list).
**Fixed** (`docs/tools.md`): `read` — a window ≤400 lines with an explicit "lines X–Y
of Z, continue from …", re-reading allowed; `grep` — by content (not by extension),
`before/after` default 5/5, ≤200 matches, repeating allowed; `run` — full output
(≤8000, beyond that head+tail + `outputRef`).

### 3.4 The plan trap (`cursor=0`)
Plan items were commands the model never ran verbatim → the item stayed "open" forever
and the model kept "reproducing".
**Fixed:** (B) the engine itself branches the current unfulfilled item when the action
differs; the option is kept append-only; the plan is a checklist; an item is resolved
if `achieved/refuted/abandoned/executed` or it has a chosen resolved alternative.

### 3.5 Working-set loss (#9)
The projection held one latest result; the model oscillated `read ↔ make` ("build logs
are lost"). **Fixed:** a hypothesis carries `need: [id…]` (≤5); result bodies are
stored — small ones in the node, large ones referenced in
`.skein/observations/<id>.txt`; next turn they are shown in full under `shown`. `calls`
gained an `id`. (Invariant 11 refined: no secrets; small results allowed.)

### 3.6 A bad plan (commands instead of stages)
The plan was "2 commands", with no `fix`/`verify` and no hypothesis node.
**Fixed by the prompt:** mandatory decomposition into **stage sub-goals** with a
concrete `done_when` (`reproduce → locate → fix → verify` for a bugfix); an `action`
item only for an immediate command; a hypothesis is a node with `why`, settled by a
`check`. Verified on 6 synthetic requests — all produce a plan of sub-goals.

---

## 4. Current behavior (run `21-14-05`)

The plan is correctly formed (stages), `reproduce` is closed at T14 (`complete`),
`locate` at T57, `edit` at T59 (the last turn), with no check.

| Stage | Outcome |
|---|---|
| reproduce | `complete`, T14 |
| locate | `complete`, T57 (**43 turns!**) |
| fix | `edit` T59, unverified |
| verify | not reached |

`goals:5, completes:2, edits:1, checks:0`, reward 0, `stopReason=null`.

### Why locate took 43 turns (proven)
`grep` searches the whole workspace; results are sorted by path, so service files come
first. From `lastResult` T17–T27: `grep run_length|…|compress` yields **410/546
matches**, the first 200 shown — all from `ocaml/.depend`, `ocaml/.mailmap`,
`ocaml/Changes`; `runtime/*.c` never enters the view. The model's thoughts: "drowning
in noise (.depend, Changes)". `SKIP_DIRS` skips directories but **not files** like
`.depend`.

---

## 5. Open tasks (by priority)

1. **grep: scope and service files (currently the main locate blocker).**
   - `grep { pattern, path?, before?, after? }` — restrict to a directory/glob
     (`grep {pattern:"sweep", path:"runtime"}`).
   - do not read hidden/generated files (`.depend`, `.mailmap`, `Changes`) — the
     ripgrep hidden-skip analogue.
2. **Stage discipline (tempo).** The model does not close a stage as soon as its
   `done_when` is met: `locate` accumulated evidence for 43 turns. Prompt: "close the
   stage as soon as you can name the code; a stage is a few turns".
3. **Stop on the absence of positive progress.** A new `read`/`grep` is new knowledge,
   so `no_progress` does not fire; a "no mutation/closure for K turns" counter is
   needed.
4. **`need`: one-turn vs persistent.** `shown` now "blinks" (the model forgets to
   re-request); consider a working set until the model changes it.
5. **`calls` growth** (dozens of entries on long runs).
6. **Bringing the context budget back** if it becomes a problem again (not applied).

---

## 6. Key files (where is what)

- Projection and working set: `src/ir/project.ts`, `src/loop/graph.ts`.
- Tools: `src/tools/index.ts`, `src/tools/workspace.ts` (`grep`, `list`).
- Plan/branching/predicates: `src/ir/traversal.ts`, `src/ir/graph.ts`,
  `src/loop/classify.ts`.
- Prompt: `src/loop/propose.ts` (decomposition, strategy, `need`, limits).
- Schemas: `src/llm/schemas.ts` (`MAX_NEED`, `plan`, `revises`).
- Tests: `tests/ir.test.ts`, `tests/loop.test.ts`.
- Design/specs: `docs/context_design.md`, `docs/projection.md`, `docs/tools.md`,
  `docs/ir_semantics.md`.

---

## 7. How to continue (recipe)

1. Fix one item from §5 (start with grep scope + service files).
2. `npm run typecheck`, `SKEIN_LIVE=false npx vitest run`.
3. `harbor run --config /tmp/opencode/skein-fix.yaml -y` (case `fix-ocaml-gc`).
4. Inspect `~/.skein-bench/harbor/<ts>/<trial>/agent/langgraph-run.log`: the plan, the
   stage timeline (`complete`/`edit`/`check`), `SKEIN_METRICS` (ctx, turns, reward).
5. Compare with `docs/benches/fix_ocaml_gc_ideal.md` and the table here; add a row to §2.

---

## 8. Session 2026-10-04: structured output, context, diagnosis

This section is more current than §4–§5; read it first.

### 8.1 Chronology (fix-ocaml-gc, one attempt each)

| Job | What changed | turns | edits | checks | stop | reward |
|---|---|---|---|---|---|---|
| `2026-10-04__16-20-49` | before the session (tool calling) | 60 | 4 | 3 | max_turns | 0 |
| `2026-10-04__19-05-54` | — | 37 | 0 | 0 | **llm_error** | 0 |
| `2026-10-04__19-33-21` | `withConfig` + `rebuild` | 30 | 0 | 0 | **llm_error** | 0 |
| `2026-10-04__19-45-22` | + repair round | 60 | 2 | 4 | max_turns | 0 |
| `2026-10-04__21-15-09` | JSON-only + `thought` cap + objective fix | 60 | 5 | 6 | max_turns | 0 |
| `2026-10-04__21-56-14` | + pipefail + failure history | 60 | 6 | 6 | max_turns | 0 |
| `2026-10-04__22-30-48` | + level retention + "failure to cause" | **24** | 0 | 1 | **no_progress** | 0 |
| `2026-10-04__22-38-56` | + plan-guard fix | 60 | 2 | 2 | max_turns | 0 |

### 8.2 What is fixed

1. **Structured output — JSON-only** (`src/llm/structured.ts`). Under the long prompt the
   provider returned tool calls with flat/broken args (`operator` at the top level instead
   of `action`, "Bad control character"), and LangChain v1 has no `Runnable.bind` (per-call
   kwargs go through `withConfig`). Now: **the raw JSON schema in the prompt + manual
   parse**; a cut-off is detected by `finish_reason == "length"` (structural check as a
   fallback); `max_tokens` is raised via `rebuild` (a constructor field); one repair round
   on a schema violation. Startup `llm_error`s are gone.
2. **`thought` is bounded** to one short sentence (`src/loop/propose.ts`): the model dumped
   its reasoning into `thought` (up to **30 127** output tokens/turn → cut-offs). Now
   ~100–300; no cut-offs.
3. **`pipefail`** in `workspace.run` (`src/tools/workspace.ts`): `make | tail` now returns
   `make`'s code — a failure shows as `fail`, not `pass`.
4. **Failure history** (`src/ir/project.ts`): failed attempts are **not pruned** after an
   `edit`, and a `calls` note surfaces the error line even when `verdict=pass`.
5. **Level-retention context** (`src/loop/graph.ts`, `projectNode`): the results of the
   **current** focus goal's actions stay in `shown` with no TTL until the focus leaves the
   level; `need`/`query` are for cross-level recall (TTL). Removes the `read ↔ make`
   oscillation (one window was re-read 5–6 times).
6. **Plan guard** (`src/loop/classify.ts`): "all plan items fulfilled → do not grow" fires
   only when the plan **carries a checkable step** (an action or an objective sub-goal).
   Otherwise, after epistemic stages (reproduce/locate) are closed, the model could not add
   the fix stage and fell into a `create_goal` loop (regression `22-30-48`).
7. **Prompt "from a failure to its cause"** (`src/loop/propose.ts`): extract the exact fact
   from the error → name the invariant → **read the definition of every symbol/macro** →
   check **all** maintainers of the invariant, including the quiet ones (the advance), not
   only the obvious (the merge) → the failing check is the oracle.
8. **Trace replay** (`bench/replay.ts`, `npm run replay`): runs recorded contexts
   (`contexts.ndjson` or `SKEIN_CONTEXT` from a Harbor log) through the live model without
   Harbor; prints `operator`/tool, `thought`, tokens, `finish_reason`.
9. Docs synced: `testing_{ru,}.md` §8.1, `context_design_{ru,}.md` §8,
   `ir_semantics_{ru,}.md` (`run target` semantics), `tools_{ru,}.md` (`run`).

### 8.3 Diagnosis: why the task is not solved

- **Information was not missing.** A per-turn audit: at **every** edit the context held the
  defective line (`p += Whsize_hd(hd);`) and the crash output (`Segmentation fault`), and
  the code was re-read.
- **The root is a specific symbol.** The model reasoned about `Whsize_hd` **without ever
  reading its definition** (0 contexts out of 60). Without it, the common advance
  `p += Whsize_hd(hd)` looks correct, and attention goes to the merge/rle logic.
- **After item 8.2.7** the `Whsize_hd` definition is now read (**0 → 19** contexts), the
  model adds an objective fix stage and makes edits. Its hypotheses are close ("with
  wosize=0 `Whsize_hd` gives 1, not `wh`"), but it patches the `p += wh*Wosize_hd(hd)`
  branch and the merge, not the common `p += Whsize_hd(hd)` → `p += wh`. One inference is
  not made.
- A `create_goal` thrash remains (20 per run) — a separate issue.

### 8.4 Open tasks

1. **The common advance after a run-skipping branch.** Nudge: "if the branch already
   advanced the pointer past a run, the common step is exactly one size-class slot
   (`wh`)". Word it generally, not hard-coded to the case.
2. **`create_goal` thrash.** Dedup/limit growth; repeated interpretations in a row until
   `no_progress`.
3. **grep scope + service files** (from §5, still relevant).
4. Stage-closing discipline (from §5).

---

## 9. Session 2026-10-06: the task is solved (reward 1.0)

The `fix-ocaml-gc` acceptance now passes. The plan behind the fixes —
`docs/benches/engine_fixes_found.md`; metrics and trajectory —
`docs/benches/fix_ocaml_gc_run_report_2026-10-06.md`. This section is the current state.

### 9.1 Chronology (fix-ocaml-gc, one attempt each)

| Job | What changed | turns | edits | checks | stop | reward |
|---|---|---|---|---|---|---|
| `2026-10-06__10-57-47` | S1–S5, P0–P3.3 (`need` still present) | 60 | 1 | 2 | max_turns | **1** |
| `2026-10-06__14-53-22` | + P4 (no `need`), P5/P6 | 60 | 1 | 2 | max_turns | **1** |

Both: `override_cpus: 4`, reasoning `high`; verifier `40 tests passed`.

### 9.2 Why it finally solved

- **P0 — reasoning on** is the decisive factor (F1): with `reasoningEffort="high"` the
  model touches the right line; with reasoning off it never did (15/15 off-target).
- **S1–S3** (focus under a closed ancestor; closing move on the focus; re-check after
  `inconclusive`) remove the 12-turn `unknown_revision` loop.
- **P1/P2** (crash diagnostics; `complete` notes, edit diffs, per-level retention) put the
  defective line, the crash and the stage evidence into the projection.
- **P3.1/P3.3** (4 CPU/6 GB; `run {background}` + `{job}`) let the agent build and verify
  without blocking a turn.
- **P4/P5/P6** remove the one place doxa shaped the context (`need`) and make a refusal
  name the focus move. The second run shows removing `need` does not regress the live path.

### 9.3 Trajectory

Both name the defect in `pool_sweep` and apply the reference edit
`p += Whsize_hd(hd);` → `p += wh;`. First run: edit at turn 29 (before `need` removal).
Second run: `locate` closed at turn 45, edit at turn 53, then a **background** bootstrap
build (`job-2`, P3.3) polled at turns 56–57 before the fix goal's check (turns 58–59).
Both hit `max_turns` with the edit already in place; the verifier then rebuilds clean and
passes.

### 9.4 Open tasks

1. **Shorten localization** (45 turns in `14-53-22`) so the run stops before `max_turns`
   and can self-verify within budget — the last wasted turns are the long build.
2. **`create_goal` thrash** is still visible (`14-53-22`: 10 goals / 10 plans /
   10 alternatives); from §8.4.
3. **`P3.2`** (fast proxy reward) remains deferred — Harbor-internals infra.
4. Should `reasoningEffort=high` stay the everyday default (cost/latency) or be raised
   only for hard tasks? (open in `engine_fixes_found.md` §10).