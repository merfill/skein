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

## 1. The tools

1. **The real engine, one turn at a time** — `bench/live-step.ts` (see `docs/live_step.md`). One
   process keeps the task container and the workspace alive; each step is a `runAgent`
   continuation (`seed`/`startTurn`, `maxTurns: startTurn + 1`). Transitions, refusals, the
   failed-Patch revert and reasoning-on-the-tape are the engine's. **Use this for behaviour.**
2. **Offline replay of a recorded turn** — `bench/turn.ts` (in the repo). It takes an
   already-**recorded** turn's tape, edits a message (say, the criterion line) and calls the model
   again — **without a container**. Cheap; for comparing wordings on the same input.
3. **Replay of a recorded tape through `runAgent`** — `seed`/`startTurn` + the container. Needed
   when checking **engine transitions** (`stop`/`move`, reverting a failed Patch): a manual
   `propose` loop bypasses `executeNode`. Checklist — §2.5.

Rule: **do not run the container for every text edit** — only for a new live run.

## 2. How everything executes

### 2.1 The task container

Implementation — `tests/sandbox/docker.ts`, function `dockerWorkspace(root, options)`.

- **The task image already holds the environment** (repo, toolchain), so nothing is installed on
  the host.
- For Docker tasks the container starts **directly from the image**:
  `docker run -d --entrypoint sleep --network <bridge|none> -w /app <image> infinity`. `/app`
  is not extracted to a host temp root and not bind-mounted (`rootless`); there is no host
  copy. Rootless Docker cannot attach a network to a container started with `--network none`,
  so the container always starts on the bridge: with `--net off` it is detached from the agent
  after setup and reattached before `test.sh`.
- Commands, the file tools (`read`/`grep`/`list`/`edit`/`write`), `bash`, background jobs and
  the checkpoint run through `docker exec` in that container, so `/app` and `/tmp` mean the same
  thing to the tools and to the shell; `grep`/`listFiles` return workspace-relative paths like
  `fsWorkspace`.
- The checkpoint store is `/tmp/.skein` **inside the container** (`DockerBackend`);
  `/app/.skein/checkpoints` is a symlink to it.
- Every ported task, including `regex-log`, takes this path. Acceptance is the task's own
  `tests/test.sh`: after the agent it is copied to `/tests` and run in the same container; it
  installs Python itself (`uv`), so the image may have none. `bwrap` (`container.ts`) remains
  only for `bench/minimal` and the image-less fallback: there the workspace is a host root, the
  file tools are host `fsWorkspace`, and `/tmp` is per-invocation. The opencode baseline uses
  the legacy bind-mounted Docker path and the same `test.sh` acceptance.
- Cleanup — `cleanupContainers()` (`docker rm`; no `/app` host mount to wipe).

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

`bench/live-step.ts` — the real engine, one turn per run (details — `docs/live_step.md`):

```sh
npx tsx bench/live-step.ts <task-id> --net off --dir <dir>
```

- for Docker, `openTaskWorkspace(task)` takes the rootless path: the container starts from the
  image, `/app` is not copied to the host, the checkpoint lives in `/tmp/.skein`; it runs the
  `setup`; this is the same setup as the full run;
- each turn is a `runAgent` continuation (`seed`/`startTurn`, `maxTurns: startTurn + 1`), so the
  transitions, refusals, failed-Patch revert and reasoning on the tape are the engine's, not the
  harness's;
- after a turn it prints the state, calls, observations, usage, cost and tree diff, writes the
  tape, and waits for `<dir>/continue` (or continues with `--auto`; `--turn N` stops after N).

### 2.4 Where the tape is written

Directory — `--dir` (default `bench/runs/sandbox-tasks/<ts>-<task>-live-step`):

- `contexts/tNNN.txt` — the turn's **readable tape** (exactly what went to the model);
- `reasoning.ndjson` — the provider's hidden reasoning per turn (diagnostics, not the tape);
- `turns.ndjson` — per turn: `{ turn, situation, island, actions, usage, cost, stopReason }`;
- `journal.ndjson` — the full event journal after each turn.

Whole live runs live in `bench/runs/sandbox-tasks/<ts>-<name>/`.

### 2.5 Replaying a recorded tape (the current debugging method)

When the question is about **engine transitions** (`stop`/`move`, reverting a failed Patch),
replay the **tape through `runAgent`**; otherwise the hook in `executeNode` is bypassed. `AgentInput.seed` (an existing journal) and `startTurn` (its
turn number) resume the loop; `maxTurns` stays absolute.

Checklist:

1. **Pick the run and the cut point.**
   - second entrance into Localization — fold through the `descend` after its `move`
     (`plan / localization`);
   - failed Verification (transition) — through the `stop` edge of the closed Verification;
   - working Verification after a failure — through the `result` edge of the failed `bash`.
2. **Make the tree match the seed.** Start `dockerWorkspace` for `fix-ocaml-gc`; apply/reverse the
   recorded `edit` (or `write`/`apply_patch`) to match the events. Then append a synthetic
   `mutate` with the actual file version (`workspace.version`). Without it the IR and the tree
   diverge and the next `edit` gets `stale_base`.
3. **Call `runAgent({ propose, workspace, maxTurns }, { request, seed, startTurn })`.** Do not
   write a manual `propose` loop: transitions and the revert live in `executeNode`.
4. **Put a sentinel in `propose`.** Stop when `context.island` reaches the target (e.g.
   `localization` after the revert, or `verification` before a build) so one run does not enter an
   expensive build.
5. **Write `contexts/tNNN.txt`, `turns.ndjson`, `journal.ndjson`.** Read `reasoning`, the actions,
   `stop why`, `revert`; the context is exactly what went to the model.
6. **K≥3, one factor at a time.** `SKEIN_STREAMING`, `SKEIN_TEMPERATURE` and prompt edits are
   separate arms; otherwise the conclusion is about the wrong factor.

Expected after the current fix:

- Verification fails → `stop` → `move` to Patch or Localization (the model chooses; Patch when the
  coordinates still hold) → the engine writes `revert` for the last
  Patch, restores the pre-patch file and updates the IR versions;
- the open Localization block says `This change has been reverted…` and
  `A different change is required…`;
- Patch applies **another** diff, not a variant of the reverted one;
- a second Verification failure again gives `stop` → Localization → revert, with no debugging or
  editing inside Verification.

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
**every** turn, so the task is visible inside the state too. There is **no** separate
environment-brief message after the request.

The **probe** is one session `fact` (`id: fact:session`, payload `{ environment, material }`),
recorded at request start (`src/loop/probe.ts`). `material` is the workspace map (`root`, repo,
entries/paths, files), with no configs, build commands or extensions. The projection shows it as
`Workspace` in Orientation; in Localization/Research the same map is `Orientation result`
(Research also gets `Probe` with interpreters/tools); Patch gets it as `Workspace`; other states
get `Probe` (environment) under its own heading. Closed states carry no block and the request turn has none. The probe's
raw output never reaches the tape; a replay reads the recorded fact instead of probing again.
`environment` also carries `network: on|off` — the agent's mode, recorded by the harness (not
guessed by a shell); it tells a state whether a missing runtime can be installed.

**State entry** (shown for every state; the block only for the current one):

```
ai       — Start state <Label>
system   — <island instruction: how to act in this state>
user     — what: <island.what>
system — <Workspace in Orientation/Patch / Orientation result in L,R / Probe elsewhere>
user   — what: <the island's goal>
```

**Returning to Localization or Patch after a failure** (the current open state only): right after
`ai: Start state Localization`/`Start state Patch` comes another `system` — the **last** failed
attempt, assembled by logos from the journal:

```
system — Previous failed attempt:
           Patch: runtime/shared_heap.c
             <the actual find from edit>
             ->
             <the actual replace>
           Verification: <literal retelling of the failure: command, exit, actual error>
           This change has been reverted in the workspace; the tree is back to its pre-patch state.
           Do not repeat this change. A different change is required; it may be in the same file or even the same loop.
```

The source is the change's `payload.call` and the doxa's `stop.why` on the failed `verification`
— a literal retelling of the failure (command, exit, actual error), not a code diagnosis and not
the mechanical last failing command/tail. The last attempt only; older ones are already on the
tape. A Patch that changed no file renders `Patch: no file changed.`

The engine performs the revert on the failure transition `Verification → Patch/Localization`: it emits a
`revert` event (files + new versions) and restores the pre-patch tree. The block is rendered for
the **currently open** Localization or Patch. If the revert is impossible (e.g. `write`/`apply_patch`
without a preimage in Phase 1), the block says `The failed change is still in the workspace.` — do
not pretend it was reverted.

**Open state** — after that come the plan's steps: each doxa turn is a pair
`ai(tool_calls=[…])` + one `tool(result)` per call.

**Closed state** — the plan is **elided**: only these remain

```
ai — Start state <Label>
system — <instruction>
user — what: <goal>
ai — Finish state <Label> — <why from stop>
```

**The turn's tail** (`system`, except `transition` — a `user` turn):

| situation | what is appended |
|---|---|
| `request` | `REQUEST_INSTRUCTION` — pick the starting state (`move`) or `decline` |
| `plan` | `planInstruction` — "Call a tool…" + the tail: hint → `what:` → done criterion → closure |
| `working` | `turnInstruction` — the same tail (per turn, never stored) |
| `transition` | `transitionInstruction` — read the `Finish state` line, pick the next state |
| `terminal` | `NODE_INSTRUCTIONS.terminal` — "This is End. …" |

**What is erased (not shown):**
- `notes` from `move` — not rendered;
- `what` from `move` — not rendered (the goal comes from the island definition);
- **a closed state's plan** — all `ai`/`tool` pairs are replaced by a single `Finish state` line.

**What is added:**
- the request — at the top, once;
- state entry — `ai(Start)` + `system(instruction)` + `user(what)`;
- the turn's tail — the open state's per-turn tail (`plan`/`working`) or the situation
  instruction (never stored; rebuilt on the next turn);
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

- **Rootless D (2026-10-23).** Docker tasks run without a host copy of `/app`: file tools,
  `grep/list`, `bash`, jobs and the checkpoint live in the container; the checkpoint store is
  `/tmp/.skein` (`DockerBackend`); `checkIn:"host"` then used a verifier container
  (`SKEIN_VERIFIER_IMAGE`), later replaced by the task's own `test.sh` in the agent's
  container. The 5-minute `signatureMap` (per-file `docker exec` → batched `signatures`) was
  found and fixed. Crack after the fix: 24 turns, reward=1, request_addressed.
- **Acceptance via `test.sh` (2026-10-24).** The Docker path runs the task's own
  `tests/test.sh` after the agent in its container (like Harbor) and reads
  `/logs/verifier/reward.txt`. `--net off` detaches the network from the agent only; the
  verifier always keeps it.
- **D is closed (2026-10-23, session 10).** `regex-log` now runs its own image + verifier
  container (bwrap left the task path); `stageSolution` is rootless; `live-step` computes the
  tree diff inside the container; `fetchTo` copies bytes via `docker cp`; rootless
  `grep/list/listFiles` honor `SKIP_DIRS`/dot entries/include-exclude like `fsWorkspace`.
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
- **Reasoning on the tape (2026-10-17, default).** The doxa sees its own previous reasoning on
  the tape: the AI SDK (`@ai-sdk/openai-compatible`) round-trips reasoning
  (`reasoning`/`reasoning_content`), the engine journals a turn's reasoning on its action nodes
  (`payload.reasoning`), the projection shows it on the turn's assistant message; on by default,
  `SKEIN_REASONING_TAPE=false` is an A/B switch. A controlled A/B on the full loop (`sandbox-run`, `--net off`, K=3–4): **the moment
  Localization closes does not change** (ON t14,15,14,11 / OFF t14,11,14), but reasoning is ~2.5×
  lower and cost ~40% lower (the added context lands in `cacheRead`, fresh input equal at ~49k).
  Details — `docs/benches/best_bench.md`, section "2026-10-17".
- **Returning to Localization/Patch carries the failed attempt (2026-10-17).** `renderState`
  (`src/ir/project.ts`), for the **current open** Localization and Patch, inserts a `system` right
  after `ai: Start state …`: the actual change of the last `patch` (from `payload.call`) and the
  model's `stop.why` of the failed `verification` (literal: command/exit/actual text), plus the
  reverted/different-change wording. Before, the link was lost: a closed state's plan is elided
  and only the doxa's `why` remained.
  **Checked without a full run** (§2.3): the recorded looping run (`2026-10-17T08-04-06-897Z`) up
  to its re-entry into Localization, the same failed edit applied to a fresh tree, three passes of
  Localization to `stop`. The control (no block) re-confirmed line 644 and looped; with the block
  **2/3 closed on the right line** (`p += Whsize_hd(hd)` → `p += wh`, lines ~644–653/653), **1/3**
  did not close within 12 turns but also did **not** re-confirm the old hypothesis (it kept
  reading). The block is visible on the tape (`Previous failed attempt:`).
- **Reverting the failed Patch and leaving Verification (2026-10-17).**
  - On the failure transition `Verification → Patch/Localization` the engine reverts the last Patch: a
    `revert` event (`src/ir/events.ts`), `State.reverted` and version updates in `fold`
    (`src/ir/graph.ts`), implementation in `src/ir/attempts.ts`
    (`isFailedVerificationMove`, `revertLastPatch`, `revertFailedPatch`). The hook is in
    `executeNode` (`src/loop/graph.ts`).
  - The `Previous failed attempt` block now says the change was reverted, shows the model's
    literal `why` from the failed Verification, and requires a **different** change, not
    "look elsewhere"; it is rendered in the open Localization and Patch.
  - The Verification hint now says: on a failed acceptance, `stop` with a literal `why` and
    choose `patch` when the Localization coordinates still hold, otherwise `localization`;
    environment failures are not a `stop` — fix and retry; no debugging/editing in Verification.
  - `AgentInput.seed`/`startTurn` (`src/loop/graph.ts`) resume `runAgent` from a recorded journal
    (see §2.5).
  - Tests: `tests/revert.test.ts` (revert, versions, block, conflict, passing Verification,
    integration through `runAgent`).
  - **K=3 on `08-04-06`:** cycles **0/3**; the correct edit — 1/3 with streaming on (temp 0.1),
    2/3 with streaming off (temp 0.1), 2/3 with streaming off + temp 0. The wrong variant — the
    free branch with `Whsize_hd` left for live blocks — persists. A second Verification failure
    (real build) gives `stop` → Localization → `revert` without a cycle.
  - Phase 1 reverts `edit` only; `write`/`apply_patch` return a conflict (Phase 2).
  - **Final `fix-ocaml-gc --net on` batch (2026-10-17):** 5/5 `reward=1`, 29–50 steps, 7.315₽;
    run5 used `Verification → Patch` directly (one revert), the others were direct. Tokens —
    `docs/benches/best_bench.md`.

- **Localization → Patch only (2026-10-20).** The late `Localization → Research` edge was
  removed (`83243ae`): Localization again has a single transition — Patch. A dry rebuild of the
  transition from the 34-turn run shows no Research; live K=3 on the same turn — 3/3 `move patch`
  (reasoning 0–166). Full `fix-ocaml-gc` K=1: reward=1, `request_addressed`, 34 turns, 5.23₽ —
  no Research, but Patch took 15 turns: re-deriving the cause (~10k reasoning over t13–t20) and
  2 turns on `.skein/checkpoints`; cache hit 81%.
- **Patch gets the material map (2026-10-20).** Patch no longer gets the Probe with
  compilers/interpreters; instead it gets `Workspace` (`root`, `repo`, `entries`, `files`), as
  Orientation does. On the recorded tape at t9 (Patch plan) a dry projection shows `repo: none`
  and `entries: ocaml/ (4623 files)`; live K=3 on the same context — 3/3 go straight to
  `runtime/shared_heap.c` (280-699), with no git and no `ls`/broad grep. Before: t9 `git status`
  + `git diff` (7.3k chars of usage, 0.157₽) and t10 `ls` + `grep free_space/run/rle` (0.156₽);
  after: 0.019–0.091₽ on Patch's first turn.

- **Suspected cause in Localization (2026-10-20, K=3).** Localization's criterion now includes a
  suspected cause (`unverified`). Full `fix-ocaml-gc`: reward 3/3, turns 30/24/43, input
  307,859/153,747/334,964, cost 2.315/1.526/3.130₽ (was 34/404,613/5.226₽). The cause was
  correct in 2/3 — Patch 4–6 turns, 1.5–2.3₽; in run3 the cause was vague ("free-run skip mixing
  block and word units") → wrong patch → segfault → second Patch: 43 turns, 3.13₽. The bottleneck
  is now the precision of the suspected cause, not Patch.

### Problems (for tomorrow)

> Hypothesis p.1–2 is **closed**: "late closure because the model cannot see its own conclusion" is
> **not the cause** (the reasoning-on-the-tape A/B, see "Done"; the old n=30 baseline turned out to
> be a harness artifact — the old replay harness (`bench/step.ts`, removed) vs the full loop, see
> §6). So the re-derivation after the
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
   The "Previous failed attempt" block did not help **because it was only shown on re-entry into
   Localization**, and there was no re-entry; it is now also rendered in the open Patch.
   **Done:** on a failed acceptance the Verification hint demands a literal `why` and a choice of
   `Patch`/`Localization` (Patch when the coordinates still hold); a second failure (real build)
   was checked — the model stops and the engine reverts the Patch. Remaining: (a) exit-code masking (`make ...; echo $?`) — the principled fix is an
   engine-owned acceptance observation (the engine runs the command; the model passes no shell
   string), not prompt text; (b) after the revert the model sometimes chooses the free-branch
   variant instead of the tail `p += wh` — a Patch-targeting issue, not a loop.

## 6. Experiment log (do not repeat)

- Edits to `done`/`what` (line / area / files / "strong suspicion" / "with coordinates or not")
  **do not control stopping**: the stop rate ≈ 0–1/3.
- Adding opencode's line "think … based on the filenames directory structure" to the base prompt —
  **no effect** (the model still went to the `VERSION`/upstream oracle).
- Copying "a strong suspicion…" from the hint into the criterion as well — **does not help** (~1/3).
- Textual "hacks" (bringing back B0/anti-diff) — rejected as a special-case fix.
- **Compare only within one harness.** The baseline `run-loc-restart` (Localization closed at
  n=30) against the full loop gave a false "win": the old replay harness (`bench/step.ts`,
  removed; it replayed the whole `seq` each turn) and `sandbox-run` (an incremental loop) are not
  comparable in turn count. An A/B changes
  **one** factor, in one harness.

## 7. Code and data

- **Turn driver:** `bench/live-step.ts` (the real engine, one turn per run; see §2.3).
- **Offline turn replay:** `bench/turn.ts` (from a recorded tape, no container).
- **Container:** `tests/sandbox/docker.ts` (`dockerWorkspace`, `rootless`; `signatures`).
- **Checkpoint:** `tests/sandbox/checkpoint.ts` (`CheckpointBackend`/`HostBackend`) and
  `tests/sandbox/checkpoint-docker.ts` (`DockerBackend`; store `/tmp/.skein`).
- **Acceptance:** `tests/sandbox/harness.ts` (`stageTestSh`, `runTask`: `test.sh` →
  `reward.txt`); agent/verifier network — `tests/sandbox/network.ts`.
- **Action execution:** `src/tools/index.ts` (`executeAction`).
- **Reverting a failed Patch:** `src/ir/attempts.ts` (`isFailedVerificationMove`,
  `lastPatchBefore`, `revertLastPatch`, `revertFailedPatch`); the `revert` event —
  `src/ir/events.ts`; `State.reverted` and versions — `src/ir/graph.ts`; the hook —
  `src/loop/graph.ts` (`executeNode`).
- **Tape replay:** `AgentInput.seed`/`startTurn` — `src/loop/graph.ts`; checklist — §2.5.
- **Session probe:** `src/loop/probe.ts` (`probeSession`: environment + material),
  `src/loop/material.ts` (the workspace map: root/repo/entries/paths), `src/ir/environment.ts`
  (`EnvironmentFact`, subsets), `src/ir/material.ts` (`MaterialFact`, `workspaceBrief`),
  `src/ir/session.ts` (`SESSION_PROBE_ID = "fact:session"`, `probeBrief` for the environment);
  the `add_node kind:"fact"` event — `src/loop/graph.ts` (`runAgent`, `deps.probe`); rendering —
  `src/ir/project.ts` (`stateBrief`: Workspace/Orientation result/Probe).
- **Tape:** `src/ir/project.ts` (`project`), `src/loop/propose.ts` (`buildMessages`),
  instructions — `src/loop/prompt/blocks.ts`, island texts — `src/ir/islands.ts`, tool
  descriptions — `src/llm/tools.ts`.
- **Records:** `bench/runs/sandbox-tasks/` (a full-path example — `run-loc-restart`, a recorded
  example — `rec-orientation-182830`).
- **Reasoning via the AI SDK:** `src/llm/client.ts` (`createOpenAICompatible`, `transformBody`);
  a turn's reasoning field — `payload.reasoning` (`src/tools/index.ts`, `executeAction`),
  rendering — `src/ir/project.ts` (`renderPlan`), `src/loop/propose.ts` (the reasoning part),
  read back from the response — `src/llm/structured.ts` (`invokeTools`). `SKEIN_REASONING_TAPE`
  (default on); `provider.ts` is removed.
- **Transport — streaming:** `streamText`/`generateText` — `src/llm/structured.ts` (`callModel`,
  `invokeWithRetry`); `SKEIN_STREAMING` (default on, `src/config/settings.ts`).
  `SKEIN_REASONING_TAPE=false` keeps reasoning off the tape. There is no SSE parser/`transformSse`.
- **Meta-provider (RouterAI) and subcontractors.** We do **not** force `tool_choice` (opencode
  does not either): `required` routes the request to thinking upstreams that either reject it
  (`Thinking mode does not support this tool_choice`) or are rate-limited
  (`deepseek/deepseek-v4.1-flash-1017 is temporarily rate-limited upstream`). This is **not the
  proxy and not the engine**: our client ignores `HTTP(S)_PROXY` (checked with a deliberately
  broken proxy), and the same body without `tool_choice` passes. Another routing effect: adjacent
  turns may land on different subcontractors — one without reasoning, the next in thinking — and
  the latter demands `reasoning_content` that never existed (an empty value is rejected too); the
  fallback retries once with thinking off (`isReasoningContentRequired`). An empty
  `reasoning_content` on a tool turn is always sent back (`transformBody`).

## 8. Next steps

- **Closed:** "reasoning not on the tape → late closure" (shipped as the default, A/B — `docs/benches/best_bench.md`, 2026-10-17).
- **Done:** the streaming transport; the failed-attempt record on returning to Localization; the
  meta-provider fixes (no `tool_choice`, empty `reasoning_content`, thinking-off fallback, the
  transition instruction as `user`); the revert of the failed Patch on
  `Verification → Patch/Localization`; the failure-stop in Verification; `seed`/`startTurn` for replay —
  see §5, §7.
- **Live status (2026-10-17).** `fix-ocaml-gc --net on`, K=3 before the fix: transport 3/3 with no
  `llm_error`, reward 1/3 (the failures hit `max_turns`=60 because of the Verification trap).
  After the revert/stop fix: **cycles 0/3**; the correct edit 1/3 (streaming on, temp 0.1), 2/3
  (streaming off, temp 0.1) and 2/3 (streaming off, temp 0). A second Verification failure (real
  build) gives `stop` → Localization → `revert`.
- **Still to investigate** (on `fix-ocaml-gc`, K≥3, in **one** harness — §6):
  1. **Patch correctness, not the loop.** After the revert the model sometimes chooses the
     free-branch variant (`p += wh*(Wosize+1)` with `Whsize_hd` left for live blocks) instead of
     the tail `p += wh`. This is not a loop: Verification now closes and reverts. Needs Patch
     targeting: the `Previous failed attempt` block is now also rendered in the open Patch;
     remaining: require a change, not a rearrangement of the same lines.
  2. **Exit-code masking.** The model masks the status (`make ...; echo $?`, `|| true`), so
     `lastFailingRun` may miss the failure. The principled fix is an engine-owned acceptance
     observation: the engine runs the command; the model passes no shell string. Prompt lines and
     guards are rejected as hacks.
  3. **Phase 2 of the revert.** `write`/`apply_patch` currently return `revert_conflict`; need a
     preimage (`write`) and a reverse patch (`apply_patch`), all-or-nothing.
  4. **Harness.** Promote the temporary replay loop (`seed` + container + reverse diff) into
     `bench/`; checklist — §2.5.
  5. **Shell hygiene: cwd.** `bash` starts in the workspace root (`/app`), while the repo is in
     `/app/ocaml`; a general fix: show the cwd in the `bash` observation or distinguish the
     workspace/repo root.
  6. **Meta-doubt** (§5 p.4): does the `ai` marker `Start/Finish state` get in the way.
  7. The Patch/Verification state texts — `docs/states_ru.md` §2.4, §2.7.
- **Orientation result vs probe (2026-10-20).** One `fact:session` (`environment` + `material`)
  is recorded at request start. `material` is the workspace map: `root`, repo status, top-level
  entries (full paths for small materials), file count; no configs, build commands, extensions or
  build state. Orientation renders it as `Workspace`; Localization and Research get the same map
  as `Orientation result` (Research also gets `Probe` with interpreters/tools); other states get
  `Probe` (environment) under its own heading. Orientation's goal is narrowed to the inputs and
  the acceptance declared by the request; if the map and request already name them, the first
  step can be `stop`.
- **Orientation across 13 tasks (2026-10-20, minimal).** Live run on the real images: **13/13
  closed Orientation in 3 turns** (request → `stop` → transition; one `password` took 4), with no
  material exploration, `max_turns`, `llm_error` or refusals. `fix-ocaml-gc`: 3 turns, ~6.4k input
  tokens, 0.065₽ versus 6 turns / 25.9k / 0.166₽ in the previous scheme. K=3 routes:
  password/cobol → Research, custom-memory/fix-git → Localization, git-leak → Research (3/3).
  Remaining: environment for other states, `.skein` visible to the shell, probe staleness after
  installs/edits.
- **Localization/Patch alignment (2026-10-20).** Localization restored to the 29-turn criterion:
  target + coordinates/extent + siblings ruled out, **no** failing code/cause. Patch — as in the
  29-turn run (`439095b`, declared form); Verification was already that version. Probe rules:
  `repo: none` → no git, no build docs/configs, start from the named subsystem; "the tape already
  holds what you observed".
- **Localization live K=3 (2026-10-20).** `fix-code-vulnerability`: 3/3, Localization 4 turns,
  16–22k in, 0.22–0.36₽; target `_hkey`/`_hval` and CRLF/NUL named correctly. `fix-ocaml-gc`:
  3/3, Localization 8–11 turns, 63–139k in, 1.6–2.25₽; a reasoning storm on the final turn
  (2.3–2.8k), and turns spent on `git status/diff` with `repo: none`, HACKING and broad search.
  Probe-aware rules added: with `repo: none` do not run git, do not read build docs/configs,
  start from the subsystem named by the request. Repeat K=3 `fix-ocaml`: turns 9/7/9 (was
  8/11/10), cost 2.01/1.18/1.19₽ (was 1.62/1.87/2.25) — clearly better, still above the old 6
  turns; the reasoning storm remains in run1 (3.3k), so "one or two sibling sites" (#4) is not
  added yet. `fix-code` — 4/4/5 turns, 0.24–0.39₽, no regression.
- **Full fix-ocaml-gc (2026-10-20, live).** reward=1 but `stop=max_turns`, **60 turns, 7.61₽**:
  Orientation 3/0.29, Localization 8/1.21, Patch-1 21/2.74, Verification-1 8/0.68, Patch-2 16/2.28,
  Verification-2 4/0.40. Cause — Localization named the **wrong exact line**
  (`p += wh * Wosize_hd` without +1); Patch applied it, the build failed, the second Patch found
  `p += wh`. The old 29-turn run named only `pool_sweep`/encoding, and Patch derived the exact
  change. Conclusion: Localization must not require the failing code; restore target+siblings,
  with Patch/Verification as in the 29-turn run.
- **Full fix-ocaml-gc after alignment (2026-10-20, live).** reward=1,
  `stop=request_addressed`, **34 turns, 4.24₽**: Orientation 3/0.29, Localization 7/0.83,
  **Research 5/1.00 (extra step)**, Patch 10/1.22, Verification 8/0.79, End 1/0.10. The exact
  change `p += wh` is correct. Before alignment (failing code) it was 60 turns/7.61₽ and the
  wrong line. The remaining gap to 29 turns/1.684₽ is the extra Research: for a code defect the
  transition should go to Patch; Research stays for situations/new artifacts.
