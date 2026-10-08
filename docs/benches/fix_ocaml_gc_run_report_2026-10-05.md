# fix-ocaml-gc — run 2026-10-05: the day's changes and the focus defect

> Russian mirror — `docs/benches/fix_ocaml_gc_run_report_2026-10-05_ru.md`.

Related: `docs/benches/fix_ocaml_gc_run_report.md` (the previous run),
`docs/benches/fix_ocaml_gc_run_report_2026-10-04.md` (the `locate` stall analysis),
`docs/ir_semantics.md` (§2.6 traversal, §2.8 call summary, §8 projection),
`docs/projection.md`, `docs/tools.md`.

Run: `bash bench/harbor/run.sh -d terminal-bench -i fix-ocaml-gc -k 1`.
Job: `~/.skein-bench/harbor/2026-10-05__21-34-49`, trial `fix-ocaml-gc__UciLYSJ`.
The run was **cancelled by hand during the verifier phase** → no `reward`.

---

## 1. Outcome

| Metric | Value |
|---|---|
| agent turns | 60 (≈9 min, 21:35→21:43), `stopReason=max_turns` |
| input / output tokens | 714,272 / 8,240; cache read 367,360 |
| context | first 777, peak 32,541, last 6,612 |
| graph | createGoal 14, complete 6, **edits 1**, checks 5, goals 11, plans 11, alternatives 1, actions 32 |
| verifier | cancelled during `make clean && ./configure && make -j4` (full OCaml build in-container, task timeout ×2) |
| reward | not obtained (cancelled) |

The run did **not hang**: the agent finished in 9 minutes; the slow phase was the verifier
(the OCaml build). The cancellation killed the verifier before a verdict. But even if it
had finished, it would be **0**: the single edit is wrong (§3).

## 2. Engine/prompt changes made that day

The earlier analysis (`docs/benches/fix_ocaml_gc_run_report_2026-10-04.md`) showed the model loses
the meaning of the error and loops. Changed:

1. **stderr separate from stdout.** `workspace.run` (`src/tools/workspace.ts`) now uses
   `spawnSync`; `CommandResult = {code, stdout, stderr}`. The streams are never merged.
2. **Separate storage and display.** `src/tools/index.ts`: `run`/`check` store `output`
   and `error` as distinct fields; a large body behind `outputRef`/`errorRef`;
   `resolveBody` returns the full body for `query` and the inline excerpt for `shown`.
   `ResultView.error`; `lastResult`/`query`/`shown` show the streams separately
   (`src/ir/project.ts`).
3. **`calls.note` from stderr** by a strict rule (last crash line → error line → last
   non-empty); it no longer matches `-fno-exceptions`.
4. **The prompt forbids merging the streams** (`2>&1`, `&>`), `src/loop/propose.ts`.
5. **Refusal visible at the root.** The `calls` scope is the subtree of the chosen
   interpretation **∪ the current path** (`src/ir/project.ts`), so a `repeat_hypothesis`
   at the request is visible (invariant 21).
6. **Coherent repeat messages** (`src/loop/classify.ts`): if the body is already in
   `shown` — "use the body there"; otherwise "query {id}". This breaks the
   `read → query → read` loop.
7. **Materialize on a failed `edit`** (`src/tools/index.ts`): the failure observation
   carries the file's current content, and it is pinned into `shown` (`ExecOutcome.pin`,
   `src/loop/graph.ts`).
8. **Reaction to a wrong root** (prompt): a "path/target not found" failure is a wrong
   working directory; recreate the interpretation/goal with a `cd <dir> &&` prefix.

## 3. Trajectory

- **T1–T4:** the model reads `HACKING.adoc`, does not find it at the root, `list`, reads
  `ocaml/HACKING.adoc`. The cwd reaction **worked**: later checks are
  `cd ocaml && ./configure && make` and `cd ocaml && make -C testsuite one DIR=tests/basic`.
- **T5–T6:** `cd ocaml && ./configure && make` → segfault in `camlinternalFormatBasics.cmi`;
  reproduce closed.
- **T7–T13:** localization in `ocaml/runtime/shared_heap.c`; at T13 the diagnosis is
  correct: "merge branch advances p by `wh*Wosize_hd(hd)` then again by `Whsize_hd(hd)`,
  double-counting".
- **T14–T17:** a fix goal is created; **T17 — the only edit — is wrong**:
  ```
  find:    ... } else { release_to_global_pool = 0; }  p += Whsize_hd(hd);
  replace: ... } else { release_to_global_pool = 0;  p += Whsize_hd(hd); }
  ```
  i.e. `p += Whsize_hd(hd);` was moved into the `else` (live) branch, whereas line 650
  should have `Whsize_hd(hd)` replaced by `wh` (`p += wh;`). The diagnosis was right, the
  edit wrong.
- **T18–T19:** checks of the fix goal and the root: a timeout (`inconclusive`) and a fail.
- **T20–T31: the `unknown_revision` loop ×12** (§4).
- **T33–T44:** fighting `Text file busy` copying `boot/ocamlrun` (a stale process).
- **T45–T59:** reproduce→locate again, `Text file busy` again; budget exhausted.

Result: the task is not solved; the blocker is the **wrong edit**, not the loops.

## 4. The defect found: focus under a refuted ancestor

At T20–T31 the focus was stuck for 12 turns:

```
path        = r1:open > w:goal:2:REFUTED > w:goal:370:open > w:goal:375:open
applicable  = [create_goal, apply]        // return is NOT offered
checkReady  = true
```

The model wants to recreate the root interpretation (`create_goal` with
`revises:[w:goal:2]`), but the engine evaluates the current point as `w:goal:375` (not
refuted) → refusal `unknown_revision`, 12 times in a row. The refusal **is visible** in
`calls` (R6 works), but there is no admissible move: `revises` is legal only at a refuted
point, and `return` is not offered.

**Cause.** `focusEvents` (`src/ir/traversal.ts`) ascends only when the **top** is closed.
But when a refuted ancestor (`w:goal:2`) has an open descendant (`w:goal:375`) as the top,
the stack is not trimmed, so the descendants of the refuted interpretation stay the focus.
Invariant 17 says "a closed goal does not remain the focus"; it should extend to **its
descendants**.

**Proposed fix (not applied).** In `focusEvents`: if the current node is open but one of
its ancestors (the branch without the request root) is closed, `return`. The branch then
trims to `r1`, `applicable=[create_goal]`, and the model can propose a corrected
interpretation. A general fix, with an offline `focusEvents` test.

## 5. Tests (state on 2026-10-05)

- Offline: `npm run typecheck` clean; `SKEIN_LIVE=false npx vitest run` — **127 passed**
  (added `tests/tools.test.ts`, `tests/prompt.test.ts`, cases in `tests/ir.test.ts`,
  `tests/loop.test.ts`).
- Live:
  - `tests/live/scenarios.test.ts` — 16/16;
  - `tests/gate.test.ts` — 4/4;
  - `tests/live/fix_ocaml_step.test.ts` — 3/3 (`build-failure`, `wrong-cwd`,
    `refuted-and-refusal`) on saved fix-ocaml-gc contexts;
  - `wrong-cwd` confirms the reaction: the model emits
    `create_goal { done_when: "cd ocaml && make -C testsuite one DIR=tests/basic" }`.

## 6. Next

1. **Fix `focusEvents`** (trim the branch under a closed ancestor) + an offline test —
   removes 12 wasted turns; does not change the reward.
2. **Edit vs diagnosis.** The main blocker is the quality of the edit: the model names the
   right invariant but picks the wrong line. This is about reasoning over code, not the
   engine; a topic for a separate analysis (e.g. requiring the exact spot to be read and
   the arithmetic checked before `edit`).
3. **The verifier is slow** (a full OCaml build). To obtain a `reward`, a run must be
   taken to completion (up to ~1–2 h) or the acceptance must be agreed in advance.
