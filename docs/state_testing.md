# Skein — testing the state prompts (step by step, live)

> Working document. How to check and debug the state prompt on a **live task**
> (`fix-ocaml-gc`), going **one engine turn at a time**, running the commands in the task's
> container and recording each turn's tape. This is the main debugging tool: it holds the
> process, the code that implements it, and how the tape is built.
>
> Related documents: `docs/states_ru.md` (state goals and criteria),
> `docs/prompt_state_machine_concept.md` (the state graph), `docs/testing.md`,
> `docs/ir_semantics.md` §7 (the tape), `AGENTS.md`.

## 0. Goal

Make the agent, in every state:
- do the **state's work** (not a neighbour's),
- **close** the state (`stop`) on its own criterion — without drift and without a "judge" oracle,
- not **drag on** (not re-derive what it already has).

We measure by turns: which state it closed in, or where it went; the volume of `reasoning`; the
content of `why`. Model — `routerai/~deepseek/deepseek-v4-flash-latest`, `SKEIN_TEMPERATURE=0.1`
(**noisy**: do not draw a conclusion from a single sample, look at `K≥3`).

## 1. Two tools

1. **Live, step by step** — `bench/step.ts` (in the repo). One run = one engine turn: it replays
   the accumulated action sequence in the task's container, builds the tape and makes **one**
   model call. This is the everyday tool: walk the states, look at each turn's result, then edit
   the prompt.
2. **Offline replay of a recorded turn** — `bench/turn.ts` (in the repo). It takes an
   already-**recorded** turn's tape, edits a message (say, the criterion line) and calls the model
   again — **without a container**. Cheap; for comparing wordings on the same input.

Rule: **do not run the container for every text edit** — only for a new live run.

## 2. How everything executes

### 2.1 The task container

Implementation — `tests/sandbox/docker.ts`, function `dockerWorkspace(root, options)`.

- **The task image already holds the environment** (repo, toolchain), so nothing is installed on
  the host.
- The image's `WORKDIR` tree is dumped once into a **temporary root on the host** (tar pipe, so
  the owner becomes the host user, not the image's root).
- Then a **long-lived container** is started:
  `docker run -d --entrypoint sleep -v <root>:/app --network none -w /app <image> infinity`.
  The `--network none` flag (default) keeps the agent **offline**.
- Commands go through `docker exec` **into that same container**, so every step sees one tree.
- The file tools (`read`/`grep`/`list`/`edit`/`write`) work on the **same** tree through
  `fsWorkspace` (bind-mount), so edits are "visible" to both the host and the container.
- Cleanup — `cleanupContainers()` (wipes the mount from inside the container, then `docker rm`).

### 2.2 Running commands

Implementation — `src/tools/index.ts`, function `executeAction(action, state, workspace, turn)`.
It turns one doxa operator into **journal events**:

- `move` / `stop` / `decline` — IR nodes, no container needed.
- `apply` per tool:
  - `bash` → `runShell` → `workspace.run(command)` → the container runs
    `docker exec -w <workdir> <name> bash -lc "set -o pipefail; umask 000; <command>"`.
    The result is an observation node with `exitCode`, `output` (stdout tail), `error` (stderr
    tail); if the body is large, the full stream sits behind `outputRef`/`errorRef` (fetched with
    `recall`).
  - `read` / `grep` / `list` → `workspace.read/grep/listFiles` (the same tree) → an observation
    (the window is bounded to ~8K; on overflow — the head + `outputRef`).
  - `edit` / `write` / `apply_patch` → a tree edit → `mutate`.
- Observations and actions enter the IR; `placeMove` hangs the action on the current state's plan.

So **the doxa's commands run in the container**, and their stdout/stderr come back onto the tape
as the tool call's result.

### 2.3 The turn driver

`bench/step.ts` — "one turn per run":

```
TAPE_DIR=<dir> npx tsx bench/step.ts <task-id> <seq.json>
```

- reads `seq.json` — an array of `{ turn, action }` (the accumulated actions of previous turns);
- `materializeTask(task)` gives `{ root, request }`; starts up a `dockerWorkspace`;
- seeds the journal with the request node and **replays `seq`** through `executeAction` (the
  commands run in the container);
- `project` + `buildMessages` builds the tape, `propose` makes **one** model call;
- writes the result (see §2.4).

The loop: run → take `next-actions.json` → append the actions to `seq.json` under the next `turn`
→ run again. That is how you "walk the turns", stopping after each.

> Cost note: every run replays the **whole** `seq` in a fresh container. If `seq` contains
> `./configure`/`make`, the build runs on every turn — turns become slow and expensive (we saw
> this on Verification).

### 2.4 Where the tape is written

Directory — `TAPE_DIR` (default `bench/runs/sandbox-tasks/<task>-step`):

- `contexts/tNNN.txt` — the turn's **readable tape** (exactly what went to the model);
- `turns.ndjson` — per turn: `{ turn, situation, island, actions, reasoning }`;
- `next-actions.json` — the model's proposal (the next turn's actions).

Whole live runs live in `bench/runs/sandbox-tasks/<ts>-<name>/`. Examples: the full path
`run-loc-restart` (Localization → Patch → Verification), the recorded example
`rec-orientation-182830` (Orientation t0–t4 with reasoning).

## 3. How the tape is built (what is erased, what is added)

The tape is built by `project` (`src/ir/project.ts`) and `buildMessages`
(`src/loop/propose.ts`) from the IR **anew every turn** (deterministically: same events → one
`Context`). Nothing "accumulates" by itself: the source is the event journal, the tape is its
projection.

The general skeleton of one turn:

```
system   — the base prompt (States + Transitions + the file-names line)   [always]
system…  — constraints, if any                                            [as needed]
user     — the USER REQUEST                                               [always, once]
… states (children of the request) in order of appearance …
system   — the current situation's instruction (plan/working/transition/terminal) [always]
```

The **request** is shown **once, as the second message** (right after the base prompt) — and on
**every** turn, so the task is visible inside the state too.

**State entry** (shown for every state):

```
ai       — Start state <Label>
system   — <island instruction: how to act in this state>
user     — what: <island.what>
```

**Returning to Localization after a failure** (the current open state only): right after
`ai: Start state Localization` comes another `system` — the **last** failed attempt, assembled by
logos from the journal:

```
system — Previous failed attempt:
           Patch: runtime/shared_heap.c
             <the actual find from edit>
             ->
             <the actual replace>
           Verification: `<command>` exited <N>
             <output tail: segfault/error>
           Do not repeat this change; look elsewhere.
```

The source is not the doxa's `why` but `payload.call` of the change and the last failed `bash` in
`verification` (`exitCode != 0`). The last attempt only; older ones are already on the tape. A
Patch that changed no file renders `Patch: no file changed.`

**Open state** — after that come the plan's steps: each doxa turn is a pair
`ai(tool_calls=[…])` + one `tool(result)` per call.

**Closed state** — the plan is **elided**: only these remain

```
ai — Start state <Label>
system — <instruction>
user — what: <goal>
ai — Finish state <Label> — <why from stop>
```

**Situation instruction** (at the tail, `system`):

| situation | what is appended |
|---|---|
| `request` | `REQUEST_INSTRUCTION` — pick the starting state (`move`) or `decline` |
| `plan` | "Call a tool — the action that advances the goal above." |
| `working` | `turnInstruction` — the state's criterion + "when it holds, `stop`; a suspicion is enough…" |
| `transition` | `transitionInstruction` — read the `Finish` line, pick the next state |
| `terminal` | "This is Finish. Call `stop` now…" |

**What is erased (not shown):**
- `notes` from `move` — not rendered;
- `what` from `move` — not rendered (the goal comes from the island definition);
- **a closed state's plan** — all `ai`/`tool` pairs are replaced by a single `Finish` line.

**What is added:**
- the request — at the top, once;
- state entry — `ai(Start)` + `system(instruction)` + `user(what)`;
- the situation's tail instruction;
- tool calls — as `tool_calls` in `ai`; one doxa turn's steps go **in one batch**
  (`ai` with an array of `tool_calls` + N `tool`), not one pair per call.

## 4. Method rules

- One sample at `temp=0.1` is **not a conclusion**; look at `K≥3`.
- Compare variants on the **same turn** (one input).
- Judge by the **action** (`stop`/where it went) and by `reasoning`, not by "it seems".
- Edits — general, no hacks for `fix-ocaml-gc`.
- Live/container runs — only with the owner's explicit go-ahead (time and money).

## 5. Achievements and current problems (for tomorrow)

### Done (today)

- **The tape's shape was reworked** (see §3): the request at the top, once; state entry —
  `ai(Start)` + `system(instruction)` + `user(what)`; `notes`/`move.what` not shown.
- **A per-island `instruction` was added** (`src/ir/islands.ts`) — "how to act in the state",
  rendered as a `system` message on entry.
  - Orientation: "explore the repository with the search tools, read the project's docs (README,
    HACKING)… do not hunt the defect, reproduce the failure, or compare with upstream".
  - Localization: "read the suspect code and **compare it with its siblings** — other walks of the
    same structure (the same pools/heap); a different advance or encoding is the signal. Name the
    file(s) and lines. Do not prove the defect, apply a fix, or compare with upstream".
- **The sibling comparison works**: in the run the model matches `pool_sweep` against
  `calc_pool_stats`/`pool_finalise`/`compact_update_pools`/`verify_pool` and finds the divergence
  `p += Whsize_hd(hd)` vs `p += wh` (`runtime/shared_heap.c:650`). There is no drift into
  `major_gc.c` on a fresh Localization run.
- **The `stop` description was strengthened** (`src/llm/tools.ts`): it now references the
  criterion line in the context and carries "a strong suspicion is enough — do not verify to be
  sure".
- **A full run through the path's end**: Localization (t6–t17) → transition → Patch
  (`edit`: `p += Whsize_hd(hd)` → `p += wh`, t18–t24) → transition → Verification (t25+, started
  `./configure`/`make`). The answer was right everywhere.
- **The opencode prompt was reviewed** (for comparison): the system prompt is generic, **with no
  scenario** (neither `major` nor `heap` nor `sweep`); the request is the only source of the task.
  opencode wins not by layout but by behavior: it reads the code widely and **compares the
  "sibling" loops**, and carries through to the tests; it needs no oracle (network off).
- **Reasoning on the tape (2026-10-17, default).** The doxa now sees its own previous reasoning on
  the tape: the provider adapter (`src/llm/provider.ts`) round-trips `reasoning_content`, the
  engine journals a turn's reasoning on its action nodes (`payload.reasoning`), the projection
  shows it on the turn's assistant message; on by default, `SKEIN_REASONING_TAPE=false` is an A/B
  switch. A controlled A/B on the full loop (`sandbox-run`, `--net off`, K=3–4): **the moment
  Localization closes does not change** (ON t14,15,14,11 / OFF t14,11,14), but reasoning is ~2.5×
  lower and cost ~40% lower (the added context lands in `cacheRead`, fresh input equal at ~49k).
  Details — `docs/benches/best_bench.md`, section "2026-10-17".
- **Returning to Localization carries the failed attempt (2026-10-17).** `renderState`
  (`src/ir/project.ts`), for the **current open** Localization, inserts a `system` right after
  `ai: Start state Localization`: the actual change of the last `patch` (from `payload.call`) and
  the last failed run of `verification` (`exitCode != 0`) with a short output tail, plus "Do not
  repeat this change; look elsewhere". Before, the link was lost: a closed state's plan is elided
  and only the doxa's `why` remained.
  **Checked without a full run** (§2.3): the recorded looping run (`2026-10-17T08-04-06-897Z`) up
  to its re-entry into Localization, the same failed edit applied to a fresh tree, three passes of
  Localization to `stop`. The control (no block) re-confirmed line 644 and looped; with the block
  **2/3 closed on the right line** (`p += Whsize_hd(hd)` → `p += wh`, lines ~644–653/653), **1/3**
  did not close within 12 turns but also did **not** re-confirm the old hypothesis (it kept
  reading). The block is visible on the tape (`Previous failed attempt:`).

### Problems (for tomorrow)

> Hypothesis p.1–2 is **closed**: "late closure because the model cannot see its own conclusion" is
> **not the cause** (the reasoning-on-the-tape A/B, see "Done"; the old n=30 baseline turned out to
> be a harness artifact — `bench/step.ts` vs the full loop, see §6). So the re-derivation after the
> finding (Patch in run1: t17–t21 re-read before the edit) is a disposition, not a lack of
> reasoning on the tape. Hence the new items below.

1. **Localization closes late**: the answer is in hand from ~t10–t14, but `stop` comes at t17;
   reasoning balloons (1.5k–8.8k), the model re-derives what it already has.
2. **The criterion is not treated as met.** The model does **not ignore** the criterion — it
   quotes it (t14: "the state's criterion is just naming file(s) and coordinates"), yet keeps
   reading: "named a candidate → what if it is wrong → read more". This is the will to certainty,
   not a missing text.
3. **Edits near the `stop` point do not give reliable closure.** The strengthened `stop`
   description — ~1/3 of closures at t16; duplicating "a strong suspicion…" inside the criterion —
   worse (also ~1/3, but noisier). So it seems not to be the wording but the model's disposition on
   a late, bloated turn.
4. **Meta-doubt (t25):** the model is confused that the `ai: Start/Finish state` markers are the
   engine's lines, not its own ("did I actually apply a fix? … the tool calls so far were 'move'
   declarations, not actual edits"). A possible side effect of the state entry being an `ai`
   message.
5. **Verification is expensive**: each turn replays the whole `seq` in a fresh container, so
   `configure`/`make` in `seq` runs again on every turn.
6. **EN mirror and index** (`docs/README.md`) — done (this file).
7. **Verification trap: after a failed build the model stays in Verification and burns the budget
   (2026-10-17, the main one).** Live `--net on`, K=3: **1/3** reward=1 (40 turns, the correct
   tail fix `p += Whsize_hd(hd)` → `p += wh`); **2/3** `max_turns`=60, no transport `llm_error`.
   In both failures Localization again named the **free-run line** (`p += wh * Wosize_hd(hd)`),
   Patch changed it, the tail `p += Whsize_hd(hd)` was left → the same segfault. Then the model
   **does not close Verification and does not return to Localization**:
   - run `10-20-26`: `./configure`, then **19× `make -j16`** (t29,33,36,39,42,44,46,48–59)
     interleaved with source reads; the acceptance command was never run;
   - run `10-33-08`: configure, make, gdb, valgrind, `runtime/ocamlrund`, and it **edits the file
     via `bash`** (`python3`/`perl`) inside Verification (write tools are not offered there, but
     `bash` can write).
   The "Previous failed attempt" block did not help **because it is only shown on re-entry into
   Localization**, and there was no re-entry.
   Candidate: on the first failed run in Verification the turn hint should demand `stop` and a
   move to Localization (do not debug here), and/or forbid write-class via `bash` in Verification.

## 6. Experiment log (do not repeat)

- Edits to `done`/`what` (line / area / files / "strong suspicion" / "with coordinates or not")
  **do not control stopping**: the stop rate ≈ 0–1/3.
- Adding opencode's line "think … based on the filenames directory structure" to the base prompt —
  **no effect** (the model still went to the `VERSION`/upstream oracle).
- Copying "a strong suspicion…" from the hint into the criterion as well — **does not help** (~1/3).
- Textual "hacks" (bringing back B0/anti-diff) — rejected as a special-case fix.
- **Compare only within one harness.** The baseline `run-loc-restart` (Localization closed at
  n=30) against the full loop gave a false "win": `bench/step.ts` (replays the whole `seq` each
  turn) and `sandbox-run` (an incremental loop) are not comparable in turn count. An A/B changes
  **one** factor, in one harness.

## 7. Code and data

- **Turn driver:** `bench/step.ts` (one turn: replay `seq` in the container + one `propose`).
- **Offline turn replay:** `bench/turn.ts` (from a recorded tape, no container).
- **Container:** `tests/sandbox/docker.ts` (`dockerWorkspace`).
- **Action execution:** `src/tools/index.ts` (`executeAction`).
- **Tape:** `src/ir/project.ts` (`project`), `src/loop/propose.ts` (`buildMessages`),
  instructions — `src/loop/prompt/blocks.ts`, island texts — `src/ir/islands.ts`, tool
  descriptions — `src/llm/tools.ts`.
- **Records:** `bench/runs/sandbox-tasks/` (a full-path example — `run-loc-restart`, a recorded
  example — `rec-orientation-182830`).
- **Provider reasoning adapter:** `src/llm/provider.ts` (`openaiCompatible`: `toWire`/`fromWire`/`fromChunk`),
  wired in `src/llm/client.ts` (`modelFetch`, `SKEIN_REASONING_TAPE`); a turn's reasoning field —
  `payload.reasoning` (`src/tools/index.ts`, `executeAction`), rendering — `src/ir/project.ts`
  (`renderPlan`), `src/loop/propose.ts` (`toMessage`), read back from the response —
  `src/llm/structured.ts` (`invokeTools`). The switch and A/B — `docs/benches/best_bench.md`
  (2026-10-17).
- **Transport — streaming:** `model.stream()` + chunk concatenation — `src/llm/structured.ts`
  (`callModel`, `invokeWithRetry`); SSE parsing and delta accumulation
  (`reasoning`/`content`/`tool_calls`/`usage`) — `src/llm/client.ts` (`transformSse`); toggle
  `SKEIN_STREAMING` (default on, `src/config/settings.ts`). `SKEIN_REASONING_TAPE=false` — the
  same tap without the rename.
- **Meta-provider (RouterAI) and subcontractors.** We do **not** force `tool_choice` (opencode
  does not either): `required` routes the request to thinking upstreams that either reject it
  (`Thinking mode does not support this tool_choice`) or are rate-limited
  (`deepseek/deepseek-v4.1-flash-1017 is temporarily rate-limited upstream`). This is **not the
  proxy and not the engine**: our client ignores `HTTP(S)_PROXY` (checked with a deliberately
  broken proxy), and the same body without `tool_choice` passes. Another routing effect: adjacent
  turns may land on different subcontractors — one without reasoning, the next in thinking — and
  the latter demands `reasoning_content` that never existed (an empty value is rejected too); the
  fallback retries once with thinking off (`isReasoningContentRequired`). An empty
  `reasoning_content` on a tool turn is always sent back (`toWire`).

## 8. Next steps

- **Closed:** "reasoning not on the tape → late closure" (shipped as the default, A/B — `docs/benches/best_bench.md`, 2026-10-17).
- **Done:** the streaming transport; the failed-attempt record on returning to Localization; the
  meta-provider fixes (no `tool_choice`, empty `reasoning_content`, thinking-off fallback, the
  transition instruction as `user`) — see §5, §7.
- **Live status (2026-10-17).** `fix-ocaml-gc --net on`, K=3: transport 3/3 with no `llm_error`,
  reward 1/3 (40 turns; the failures hit `max_turns`=60 because of the Verification trap, §5 p.7).
  `--net off`: every attempt hit the upstream rate limit that `tool_choice: "required"` routed to;
  after dropping `tool_choice` (fix A), **re-run 3×`--net off` in a new session** — the old
  net-off numbers (08:xx) no longer describe the current code.
- **Still to investigate** (on `fix-ocaml-gc`, K≥3, in **one** harness — §6):
  1. **Verification trap (the main one).** On a failed acceptance/build the model stays in
     Verification, reruns `make`, debugs and even edits via `bash` — until `max_turns` (§5 p.7).
     Candidate: on the first failed run the turn hint should demand `stop` and a move to
     Localization (do not debug/edit here); plus forbid write-class via `bash` in Verification.
  2. **Re-derivation after the finding.** run1 (`2026-10-17T04-57-57`): Localization found line 650
     at t14, but Patch still re-read for 5 turns (t17–t21) before a one-line edit. A candidate —
     aim Patch at directly applying the coordinates already named.
  3. **Shell hygiene: cwd.** `bash` starts in the workspace root (`/app`), while the repo is in
     `/app/ocaml`; in run1 there were three cwd errors (t6/t17/t25) + three recovery turns. A
     general fix: show the cwd in the `bash` observation, or make the prompt clearly distinguish the
     workspace root from the repo root. ~3 turns/run.
  4. **Meta-doubt** (§5 p.4): does the `ai` marker `Start/Finish state` get in the way.
  5. The Patch/Verification state texts (`docs/states_ru.md` §2.3–2.5 are empty).
