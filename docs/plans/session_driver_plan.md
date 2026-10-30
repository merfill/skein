# Tier 4b — the terminal session: a REPL and its driver

> Russian original — `docs/plans/session_driver_plan_ru.md`.
>
> Status: **implemented; verified offline and with the live synthetic session** (driver `runSessionTurn`, REPL `runRepl`, CLI
> `src/cli.ts`, a scripted-agent scenario). No live runs were made. Out of scope: session
> persistence across restarts, Ctrl-C interruption, streaming output, resume strategies,
> `revise`, pins, the reading island and live runs.

## 1. The scenario

A terminal is open in a project directory. A program named `skein` runs inside it, connects to
the model, and shows a prompt. The user types a line and presses Enter. The agent reads the
project, works, and stops. Then the prompt returns, and the dialogue can continue.

Today this scenario does not exist. `runAgent` (`src/loop/graph.ts:346`) processes a single
request and returns. It is called by the tests, the benches and the Harbor adapter, not by a
terminal program. The session container exists, but nothing drives several utterances through
it.

This plan makes the scenario real with the smallest useful terminal program. The driver is a
library function that the program calls once per user line.

## 2. Current state

- There is no command-line entry point and no `bin` in `package.json`.
- `runAgent` builds a request, walks it through the states and returns `AgentResult`.
- `SessionState` and `SessionAgent` exist; the exposed operations are `respond` and `start`.
- The loop has no notion of a dialogue: after `runAgent` returns, the process is expected to end.

## 3. Target behaviour

The program is started from the project directory:

```sh
npx tsx src/cli.ts          # or: npm run cli
```

It prints the workspace root and a prompt (`skein> `). The sequence below is the acceptance
scenario.

```text
skein> fix the failing build

  session: start("fix the failing build")
  task r1: start
  [r1 t1] move orientation "name the workspace and the acceptance"
  [r1 t2] apply bash: ls
  ...
  task r1: stopped (request_addressed) after 12 turns

skein> now add a test for the parser

  session: start("add a parser test to the fixed build")
  task r1: completed (trace)
  task r2: start
  ...
  task r2: stopped (request_addressed) after 7 turns

skein> what did you change?

  session: respond
  changed runtime/shared_heap.c and added a regression test

skein> continue from where we left off

  session: start("continue … with the findings")
  task r3: start
  ...
  task r3: stopped (max_turns)

skein> exit
```

Rules of the interaction:

- every non-empty line is one utterance and one call to the driver;
- `exit` or `quit` ends the program; Ctrl-D ends it as well;
- the program never runs a task in the background: while a task runs, the prompt waits;
- if the session agent refuses an operation, the program prints the reason and returns to the
  prompt;
- a state is closed only by the task's own `stop`; `start` does not close the previous task, it
  only removes it from focus;
- if confirmation is enabled, the session agent first answers with the task formulation ("I
  understood the task as…"), and the next turn with agreement starts it.

Continuing work on a previous task is currently expressed as a new `start` with a reformulated
request. Strategies for resuming the same unit are a separate future slice.

## 4. Architecture

### 4.1. Entry point

`src/cli.ts` is a thin composition root. It:

1. parses the arguments: the project directory (default: the current directory), `--max-turns`,
   and, optionally, `--model`;
2. loads the settings (`loadSettings`) and creates the model (`createChatModel`);
3. creates the workspace (`fsWorkspace`), the task proposer (`modelProposer`) and the session
   agent (`createSessionAgentDeps`);
4. assembles `SessionTurnDeps` (below) and creates the session (`createSession`);
5. starts the readline loop, calls `runSessionTurn` for each line, prints the result;
6. exits on `exit`/`quit` or end of input.

A `cli` script is added to `package.json`:

```json
"cli": "tsx src/cli.ts"
```

No `bin` packaging is added in this slice.

### 4.2. The REPL loop

`src/session/repl.ts` contains the loop, separated from the process and the readline library so
that it can be tested offline:

```ts
runRepl(input: AsyncIterable<string>, deps: SessionTurnDeps, output: (line: string) => void,
        session?: SessionState): Promise<SessionState>
```

The loop:

1. reads the next line; skips empty lines;
2. stops on `exit`/`quit` or the end of input;
3. calls `runSessionTurn(deps, session, line)`;
4. prints the operation, a refusal reason if any, the reply, and the task summary;
5. waits for the next line.

`src/cli.ts` supplies a readline-based `AsyncIterable<string>` and a `process.stdout` writer.
The loop itself has no terminal dependency and is covered by an offline test.

### 4.3. The driver

`src/session/driver.ts` is the single-turn function; it is not a loop and does not read input.

```ts
runSessionTurn(deps, session, utterance) → {
  session,      // the same session, extended with events and possibly a new task unit
  operation?,   // the operation proposed by the SessionAgent: respond or start
  applied?,     // the logos result: { ok: true } or { ok: false, reason }
  reply?,       // the answer text; only for respond
  task?,        // { unitId, result: AgentResult } when a task ran
}
```

The inputs are:

| Parameter | Type | Formed by | Lifetime |
|---|---|---|---|
| `deps` | `SessionTurnDeps` | the composition root (`src/cli.ts` or a test) | once per process |
| `session` | `SessionState` | `createSession()` / the REPL loop | the whole dialogue |
| `utterance` | `string` | readline / the test input | one line |

`SessionTurnDeps` has two independent bundles:

```ts
interface SessionTurnDeps {
  sessionAgent: SessionAgentDeps; // the interpreting agent and its outline tools
  task: AgentDeps;                // the task agent, the workspace and its limits
}
```

- `sessionAgent.agent` — `modelSessionAgent(model)` in production, a scripted function in tests;
- `sessionAgent.tools` — `defaultSessionTools`;
- `task.propose` — `modelProposer(model)`, optionally wrapped to print each proposed action;
- `task.workspace`, `task.maxTurns`, `task.probe` (`probeSession`), `task.observer`
  (`createObserverDeps` when enabled).

There is no `options` parameter: the utterance ordinal lives in `session.utteranceSeq`.

The order inside one call:

1. `seq = session.utteranceSeq`;
2. `runSessionAgent` interprets the line; the session unit is opened, pushed and popped; logos
   applies the operation;
3. `session.utteranceSeq = seq + 1`;
4. the applied operation is dispatched:
   - `respond` — return the text, no task run;
   - `start` — take `pending`, open a new task unit and run it;
5. return.

If the operation is absent or refused, no task tree changes and no task runs.

### 4.4. The `start` operation

`start` is the only structural operation in the current vocabulary. It:

- pops the current focus (the old unit remains a trace; its state is not closed);
- puts the new task text into `pending`;
- is recorded in the session journal as an `operation`;
- in the driver becomes a new task unit: `runAgent` receives `open: true` and creates the
  request with that text.

There are no separate `resume` and `cancel` operations. Resuming is a future strategy; cancel as
an operation is not introduced, and Esc is an execution interrupt that changes no IR.

A logos refusal (for example, exceeding the text limit) is recorded as a session `refusal` event
and shown in L0 (`refused: …`) with its reasoning; the interpretation is complete.

#### 4.4.1. Reformulation and confirmation

The task is isolated: it sees only its own unit and receives neither the session L0 nor other
units' journals. Before a `start`, the session agent formulates the new task text from the
utterance and the L0 traces, descending into L1–L4 when needed. The driver passes only that text
to the task; context is transferred through the formulation, not through access to memory. In L0
the formulation is the task unit's `request`; the session unit's trace keeps the original
utterance and the operation with a reference to the created unit.

Confirmation is optional and is an interface policy, not an IR gate. When enabled, the session
agent first answers with the formulation and waits for "yes"; the next turn with agreement
proposes `start` with the same text. The driver only executes the operation it receives.

This matches `session_concepts` §4.4 and §6.2.

### 4.5. Engine changes

- **`runAgent.open`.** `AgentInput` gains `open?: boolean`: open and push the request unit even
  when a session is supplied. The default (`input.session === undefined`) preserves the current
  behaviour. The driver passes `open: true` for `start`.
- **Utterance ordinal.** `SessionState` gains `utteranceSeq: number` (0 at creation). It counts
  processed lines only and orders session events. Task units keep their local `turn`; the two
  counters are independent.
- **Task budget.** Every new task starts at `startTurn = 0` and receives the ordinary
  `max_turns`; the utterance ordinal does not affect the budget.
- **Journal sync.** `progress` checks request closure before syncing the focus unit journal, so
  the final `stop` can be missed. After every task run the driver appends the missing tail of
  `result.events` to `unit.journal` and sets `unit.turn = result.turns`.

### 4.6. Output

The terminal shows:

- the session operation and, on refusal, the logos reason;
- each task action as the proposer returns it (the CLI wraps `task.propose`);
- a summary at the end of the task: unit id, stop reason, turns;
- the `respond` text.

A task is never run concurrently with the prompt: the REPL waits for `runSessionTurn` to return.

### 4.7. Persistence

In this slice the session lives in memory for the lifetime of the process only. Saving it to
`.skein/session.json` and loading it on start is a separate step.

## 5. Work order

1. **Plan.** This document and the RU mirror; update the index entry.
2. **Operation vocabulary.** Keep `respond` and `start`; remove `resume`/`cancel`/`redirect`
   from the tools and the union; adjust the tests.
3. **Utterance ordinal.** `SessionState.utteranceSeq`; `createSession`; tests.
4. **`runAgent.open`.** Default behaviour unchanged; a test for opening into a supplied session.
5. **Driver.** `src/session/driver.ts`; tests with scripted agents.
6. **REPL.** `src/session/repl.ts` and a test with scripted input; then the thin `src/cli.ts`
   and the `cli` script.
7. **Docs.** Update `session_concepts`, the plans and the handoff; run the offline suite.

## 6. Test invariants

- **REPL scenario.** Scripted input: the first `start` runs `r1`; the second `start` removes
  `r1` from focus and runs `r2`; `respond` answers without a run; exit ends the loop.
- **Output.** The printed text names the operation, the task unit and the stop reason; no task
  runs for `respond`.
- **Fresh start.** `start` with no focus opens `r1` and the unit journal ends with the closure
  event.
- **New `start`.** The active unit loses focus and remains a trace; a new unit opens; `pending`
  is consumed; the old unit's state is not closed.
- **Isolation.** The task request is only the reformulated text; the task journal contains no
  events of other units.
- **Refusal.** An inadmissible operation yields no run and no task event.
- **Journal sync.** A request closed at the terminal state keeps its `stop` in the unit journal.
- **Counters.** Each line advances `utteranceSeq` by one; `result.turns` is independent.
- **Determinism.** The same session, lines and scripted agents give the same output.

Scenario check: offline — `tests/session_scenario.test.ts` (scripted agents); live runner —
`tests/sandbox/session-live.ts` (only with `SKEIN_LIVE=true` and go-ahead).

Commands: `npm run typecheck`;
`SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'`.

## 7. Acceptance criteria

- The REPL can be started with `npx tsx src/cli.ts` in a directory and accepts lines.
- The §3 scenario reproduces with scripted agents in an offline test.
- Typecheck and the offline suite are green.
- No state is closed except by the task's `stop`; `start` does not close the previous task.
- `runAgent` without `open` behaves exactly as before.
- No live/bench run is made.

## 8. Open questions

- **Session persistence.** In-memory now; `.skein/session.json` later.
- **Ctrl-C.** Interruption is not an IR operation; it needs a signal handler and a decision
  about a running task. Deferred.
- **First request.** The first line goes through the `SessionAgent`. Opening the first task
  directly from the CLI remains a possible simplification.
- **Reformulation and confirmation.** How detailed the task formulation should be, and how to
  represent agreement: a `respond` + a following `start`, or a separate operation.
- **Resume strategies.** "Continue" is currently `start`; a separate slice.
- **Progress output.** A wrapped proposer prints actions; live streaming of tokens and tool
  results is deferred.

## 9. Rollback

- The operation vocabulary, the utterance ordinal, `runAgent.open`, the driver and the REPL land
  in separate commits.
- Removing the REPL and the driver leaves the first 4b slice and `runAgent` intact.
