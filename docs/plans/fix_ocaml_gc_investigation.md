# fix-ocaml-gc — investigation journal (context, tools, plan)

> Russian mirror — `docs/plans/fix_ocaml_gc_investigation_ru.md`.

Related: `docs/context_design.md` (the projection and plan design),
`docs/projection.md`, `docs/tools.md`, `docs/ir_semantics.md`,
`docs/fix_ocaml_gc_ideal.md` (the reference form).

Status: a working journal. It records what has been investigated, what is fixed, what
remains, so work can resume from any point. The code is not committed (all changes are
in the working tree).

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
5. Compare with `docs/fix_ocaml_gc_ideal.md` and the table here; add a row to §2.