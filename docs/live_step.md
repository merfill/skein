# Skein — the real engine, one turn at a time

> Working document. How `bench/live-step.ts` drives the **real** engine on a task, one turn per
> step, while the task's container executes the tools. Companion to
> `docs/state_testing.md` (the tape, the container, the step harness) and `docs/testing.md`.

## 1. Why

This is the **only** step-by-step driver. The old replay harness (`bench/step.ts`, removed)
replayed a recorded action sequence and called `propose` directly, bypassing `executeNode`: the
journal carried no `payload.reasoning`, and transitions/refusals/staleness were the harness's.
`bench/live-step.ts` keeps the real loop: `runAgent` and the projection run on the host, while
the file tools, `bash`, background jobs and the checkpoint live in the task container (rootless
Docker; no host copy of `/app`), and the process stays alive between turns.

## 2. Invocation

```sh
npx tsx bench/live-step.ts fix-ocaml-gc --net off
npx tsx bench/live-step.ts fix-ocaml-gc --net off --auto --turn 20
```

Options:

| flag | meaning |
|---|---|
| `--net on\|off` | host-side `fetch` network (off routes through the API allowlist proxy); `run`/jobs execute in the container; the task container is always `--network none` |
| `--dir <path>` | trace directory (default `bench/runs/sandbox-tasks/<ts>-<id>-live-step`) |
| `--signal <path>` | continue file (default `<dir>/continue`) |
| `--auto` | do not wait between turns |
| `--turn N` | stop after absolute turn `N` |

Without `--auto` the process prints the turn and waits; `touch <dir>/continue` advances,
`touch <dir>/quit` stops.

## 3. How a turn is executed

1. For Docker, `openTaskWorkspace(task, { network })` (`tests/sandbox/harness.ts`) takes the
   rootless path: the container starts from the image, `/app` is not copied to the host, and the
   checkpoint lives in `/tmp/.skein`; it runs the task's setup and captures the initial
   checkpoint. This is the same helper the full run (`runTask`) uses.
2. The first call is a normal `runAgent` with `maxTurns: 1`; it seeds the request and the
   session probe.
3. Every later call passes the previous `events` as `seed` and `startTurn = result.turns`, with
   `maxTurns: startTurn + 1`. `executeNode` still runs the real turn: it classifies the
   proposal, executes the tools in the container, journals the reasoning and applies
   transitions/reverts. `max_turns` at the end of the call is only the pause boundary and is
   not treated as the run's verdict.
4. The loop ends on the engine's own closure (`done` with a reason other than `max_turns`) or
   on `--turn`/`quit`.

Because the process is long-lived, the `Workspace`, the container and the tree are the same
across turns — nothing is replayed.

## 4. What each turn shows

- state: `situation/island`, model token breakdown (`in/out/reasoning`), cache, cost, context
  chars;
- the doxa's calls (`call <tool> <args>`);
- the observations of the just-executed turn (`exit`, output tail);
- the workspace diff since the initial post-setup tree, computed from the checkpoint store
  (`diff -rq trees/0 trees/N`);
- the tape path.

Files under `--dir`:

| file | content |
|---|---|
| `contexts/tNNN.txt` | exactly the messages sent to the model |
| `contexts.ndjson` | projection inputs per turn (situation, island, history) |
| `reasoning.ndjson` | the provider's hidden reasoning per turn |
| `turns.ndjson` | calls, usage, cost, stop reason |
| `journal.ndjson` | the full event journal after each turn |

## 5. Limits

- The driver loads the prompt modules once. Editing prompt text takes effect only after a
  restart; for a fresh world start the task again (the trace keeps the old journal).
- The artificial one-turn `maxTurns` boundary means `stopReason=max_turns` on an ordinary turn;
  the driver ignores it and continues from the returned journal.
- Same evidence rules as any live run: `temp=0.1` is noisy, so `K≥3` and one factor at a time.
