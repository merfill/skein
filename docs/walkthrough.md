# Skein — walkthrough: states and the dynamic tape

> **Current as of 2026-10-29.** A state is the unit of work. The context is a deterministic
> projection of the IR; the engine rebuilds it on every turn. The journal only grows, while the
> tape changes: a closed state disappears from it but stays in the journal and remains
> addressable by `id`.
>
> Source of truth — `docs/ir_semantics.md`; the projection — `docs/projection.md`; the
> states — `docs/states_ru.md`; as-built — `docs/ir.md`. Russian mirror — `docs/walkthrough_ru.md`.

## Preamble

**How an ordinary agent works.** Almost every LLM agent is built the same way: the model has a
message tape (system, user, assistant, tool), and that tape is its memory. The agent appends a
new turn, the next model call reads the whole tape, and so on. Everything the agent "knows" lives
in that transcript: files it read, command output, past reasoning, errors. When the tape grows too
long, it is truncated or summarized — and some knowledge is then lost or distorted. The model sees
the whole history but cannot choose what it needs right now: the old and already wrong stays next
to the new.

**How Skein works.** Skein keeps knowledge differently. The source of truth is a journal (the IR):
an immutable list of events saying what happened (the request, states, calls, results, edits). The
message tape is not memory but a projection of the journal: it is rebuilt on every turn and shows
the model only what belongs to the current state. The same events therefore always give the same
tape, and a focus change changes the view without rewriting history. Whatever leaves the tape stays
in the journal and is fetched by `id`.

**What a state is.** The agent's work is split into states. A state is not a step or a command
but a state of knowledge: for example, "find the target in the material" or "check the change
against the acceptance". Every state has a goal (what should be known), a criterion (the
observable sign that the goal is reached) and a way to act (which tools are available and how to
behave). The model enters a state with a `move`, works in it and closes it with a `stop` when the
criterion holds. The set of states is fixed: Orientation, Localization, Research, Patch, Recovery,
Construction, Verification, End. The current state determines what the tape shows: its goal, its
material information, its instruction and its plan. Once a state is closed, the tape keeps only
`Start`/`Finish` from it, and the focus moves to the next state.

**Principles.** Three things follow, and the rest of this document builds on them:

1. The model proposes moves; the engine decides and records the result (doxa/logos).
2. A state is the unit of work: it has a goal, a criterion and a way to act.
3. The tape is dynamic: it shows the current state, not the whole path; a closed state leaves only
   a trace in it.

## 1. Journal, IR, state and tape

Skein rests on four concepts:

| Concept | What it is |
|---|---|
| **journal** | a list of events; it only grows; the only source of truth |
| **IR** | the graph of states and transitions, built from the journal |
| **state** | a `move` with a goal, a criterion and a plan |
| **tape** | what the model sees: the request, the current state in full, and the traces of closed states |

In the IR a state is a `move`: the island name, the goal and the criterion. States are not nested:
they are a sequence of steps in the request, one after another. Inside a state there is a plan:
items and alternatives on the items. An alternative is a concrete tool call; the reasoning is
recorded next to the call, and the execution result appears on the tape. A separate `stop` closes
the state.

The tape is built from the state graph on every turn. The same events give the same tape. The IR
(nodes, edges, operators) is described in `docs/ir_semantics.md`, `docs/ir.md` and
`docs/ir_operations.md`.

### 1.1 How the tape is built

The tape starts with two messages:

1. `system` — the base prompt: general rules and the description of states and transitions.
2. `user` — the user's request.

If the request has constraints, they arrive as separate `system` messages between the prompt and
the request.

Then come the states. An open state looks like this:

```
system   Start state <label>
system   <workspace map or environment facts>
system   <instruction: how to act in this state>
user     Goal: <state goal>
         Your earlier guess (may be wrong): <guess>   ← when the model set it
assistant [id] <tool call> + reasoning
tool      [id] <result>
assistant [id] <next call> + reasoning
tool      [id] <result>
system   <turn hint: hint → Done when → stop requirement>
```

Calls and results accumulate: they are what the model has already done in this state. The turn
hint is not stored: on the next turn it is gone, and a new one is appended.

An example of an open Localization after two calls:

```
system   Start state Localization
system   Orientation result: root /app, entries ...
system   Find the target in the material ...
user     Goal: find the target in the material
assistant [a1] grep "def parse" + reasoning
tool      [o1] src/parse.py:63 ...
assistant [a2] read src/parse.py 40-90 + reasoning
tool      [o2] ... window 40-90 ...
system   Start from the workspace map ... Done when: "the target is named ..."
         When it holds, `stop` — and nothing else.
```

When a state is closed, two `system` messages remain — its trace:

```
system   Start state Localization
system   Finish state Localization — line 63 drops the last token ...
```

The instruction, map, goal, calls and results of a closed state leave the tape. The data stays in
the IR and is fetched with `recall`/`search` while some state is open.

### 1.2 The transition

After `stop` only `move` is available; there are no other tools. A temporary `system` instruction
is appended:

```
system   Your result is the line `Finish state Localization — …` above — read it.
         Next states from Localization:
         - Patch — ...
         - Research — ...
         Choose Patch when ...
         Choose Research only when ...
         Call `move` alone. ...
```

After the `move` this instruction is erased. The next state opens with its own `Start state`, its
own instruction, its own material information and its own goal; the previous state's plan is not
carried.
The corrective `L↔R` edges are described only here, in the transition rule; they do not affect
behavior inside a state.

## 2. A state is the unit of work

A state is not a step or a command but a state of knowledge. It has a **goal**, a **criterion**
and **a way to act**. The model declares a state with a `move`:

```
move { state, what?, done? }
```

- `state` — an island from the closed vocabulary. A state is its goal.
- `what` — the doxa's optional guess about the concrete subject; it is not the goal.
- `done` — an optional criterion override for the island.

The tape shows the state's goal as `Goal: <island.what>`. When the model sets `what`, the guess
appears next to it: `Your earlier guess (may be wrong): …`.

A state is closed **only** by an explicit `stop`; the engine does not check the criterion.
`stop` records the line `Finish state <label> — <why>`: the state's trace and its handoff to the
next state.

### 2.1 Islands are states

An island is a kind of work; `state` in a `move` names the island, and the `move` itself is a
concrete state in the journal. In this text, "state" is a concrete step; "island" is a kind of
work.

| Island | Goal (`island.what`) | Criterion (briefly) | Material information | `next` |
|---|---|---|---|---|
| **Orientation** | name the root, top-level entries, repo status and acceptance | root and entries known; repo noted; acceptance named | `Workspace` | L, R, C |
| **Localization** | find the target in the material | target and coordinates; siblings ruled out; a suspected cause (unverified) | `Orientation result` | P, R¹ |
| **Research** | explain the situation and establish the method | situation explained; method named | `Orientation result` + `Probe` | Recovery, C, L¹ |
| **Patch** | make the named change to the artifact | change applied; result form checked | `Workspace` | V |
| **Recovery** | recover the required result from the source | output exists, derived from the source, the source check passes | `Probe` | End, R |
| **Construction** | build the new artifact from the spec or the source behaviour | artifact exists; acceptance check passes | `Probe` | End, R |
| **Verification** | check the changed artifact against the goal's acceptance | the acceptance holds (command or constraints) | `Probe` | End, P, L |
| **End** | complete the request | — | — | — |

¹ Corrective edges. `Localization → Research` is chosen when the work turns out to be a
situation, not a code defect; `Research → Localization` when the situation turns out to be a code
defect. This corrects a wrong start classification; these edges are not a routine exit.

Besides the goal and the criterion, an island defines `instruction` (how to act; shown once at
entry), `hint` (how to behave on every turn) and `applies` (which apply-tools are available).
Neither the instruction nor the hint replaces the goal: the goal is `island.what`.

### 2.2 Routes

- **Repair:** `O → L → P → V → End`.
- **Recovery:** `O → R → Recovery → End`.
- **Construction:** `O → C → End` (full spec) or `O → R → C → End` (the source must be understood).
- **Corrective:** `V → P/L` on failure; `L ↔ R` on a wrong start classification; `R/C → R` on a
  method failure.

The request has no `stop` of its own. It is interpreted once (`move` or `decline`), and the run
ends when the terminal `End` state is closed.

## 3. Tape details

### 3.1 Material information

The material information depends on the island: `Workspace` (Orientation, Patch), `Orientation result`
(Localization, Research; Research also gets `Probe`), `Probe` (Recovery, Construction,
Verification). These are already recorded facts; there is no need to re-probe them.

### 3.2 Reasoning

The doxa's past reasoning is visible on its assistant turns (`payload.reasoning`). The raw
`thought` is not stored: its meaning stays in `why`. Toggle — `SKEIN_REASONING_TAPE=false`.

### 3.3 What is not shown, and how to fetch it

- `move.what` is a guess on the `Goal:` turn, not the goal;
- the plans, material information and instructions of closed states are not shown;
- the request's presumptions are not carried into the state as facts.

Addressability: every node is either shown or one `recall`/`search` by `id` away, while a state
is open. Erasure changes the view; it does not destroy knowledge.

## 4. End-to-end example

### 4.1 The task

`/app` holds a small Python project: `src/parse.py`, `Makefile`, `tests/`. Someone broke string
parsing in `src/parse.py`, so `make test` fails. The user asks:

> "I broke the build; make `make test` pass."

One constraint applies, `k1` — do not touch the tests. The acceptance is `make test`.

### 4.2 The start: the opening block

The first turn has not chosen a state yet. The tape holds the base prompt and the request. The
prompt, schematically (full text — `src/loop/prompt/blocks.ts`):

```
system   # Role ... ## States ... ## Transitions ...
user     "I broke the build; make `make test` pass."
system   Choose the state to start in ... (request instruction)
```

Only `move` and `decline` are available. For this task the first step is Orientation: the project
and the acceptance must be known.

### 4.3 Orientation

The doxa calls `move {state:"orientation"}`. The Orientation entry appears on the tape:

```
system   Start state Orientation
system   Workspace map: root /app; entries src/, Makefile, tests/ ...
system   Read the workspace map ... (state instruction)
user     Goal: name the workspace root, its top-level entries, the repository status, and the acceptance the request declares
system   ... Done when: "..." ... When it holds, `stop` — and nothing else.
```

The map and the request already give the goal and the acceptance, so the move is
`stop {why:"root /app; entries src/, Makefile, tests/; acceptance: make test"}`.

Orientation leaves a trace:

```
system   Start state Orientation
system   Finish state Orientation — root /app; entries ...; acceptance: make test
```

### 4.4 The transition to Localization

The tape now holds the request, the Orientation trace and a temporary transition instruction:

```
system   Your result is the line `Finish state Orientation — …` above — read it.
         Next states: Localization, Research, Construction.
         Move to Localization when the request is to find an error in existing code or files.
         ...
```

Only `move` is available. The request is to find an error in existing code, so Localization is
chosen. (A situation would go to Research; a fully specified artifact to Construction.) The doxa
calls:

```
move {state:"localization", what:"the parse loop that breaks on the last token"}
```

### 4.5 Localization

After the `move` the transition instruction is erased; the tape holds the request, the Orientation
trace and the open Localization:

```
system   Start state Localization
system   Orientation result: root /app; entries ...; acceptance: make test
system   Find the target ... (state instruction)
user     Goal: find the target in the material
         Your earlier guess (may be wrong): the parse loop that breaks on the last token
assistant [a1] grep "def parse" + reasoning
tool      [o1] src/parse.py:63 ...
assistant [a2] read src/parse.py 40-90 + reasoning
tool      [o2] ... (window 40-90) ...
system   ... Done when: "the target is named ..." ... `stop` — and nothing else.
```

The target and the cause are found; the move is
`stop {why:"line 63 drops the last token — off-by-one in the loop"}`.

The trace:

```
system   Start state Localization
system   Finish state Localization — line 63 drops the last token ...
```

### 4.6 Patch and Verification

Next come the change and the acceptance. The first Patch applies a change:

```
... Finish state Localization ...
system   Start state Patch
system   Workspace map ...
user     Goal: make the named change to the artifact
assistant [a3] edit {path:"src/parse.py", ...}
tool      [m] mutated src/parse.py
... (stop → Finish state Patch — ...)
system   Start state Verification
system   Probe ...
user     Goal: check the changed artifact against the goal's acceptance
assistant [a4] bash {command:"make test"}
tool      [o4] exit 1 — IndexError: list index out of range
... (stop → Finish state Verification — make test: exit 1 — IndexError: list index out of range)
```

What happened: the change moved the loop boundary, and now on the last iteration the code reads
`tokens[i + 1]` past the end of the list. The test fails with `IndexError`. The object itself — the
parse loop — was found correctly; the change is what is wrong. So by the transition rule
`V → Patch` (the failure is in the change or the result, the object is the same) we return to
Patch instead of finishing the request.

Before the return the engine writes `revert`: files go back to the state before the first change.
The failure stays on the tape only in Verification's `Finish` line; the failed Verification's plan
is not shown.

The second Patch applies a different diff — with a boundary check — and Verification passes:

```
system   Finish state Verification — make test: exit 1 — IndexError: list index out of range
system   Start state Patch
system   Workspace map ...
user     Goal: make the named change to the artifact
assistant [a5] edit {path:"src/parse.py", ...}   ← another diff
tool      [m] mutated src/parse.py
... (stop → Finish state Patch — ...)
system   Start state Verification
system   Probe ...
user     Goal: check the changed artifact against the goal's acceptance
assistant [a6] bash {command:"make test"}
tool      [o6] exit 0
... (stop → Finish state Verification — ...)
```

### 4.7 End

When the acceptance passes, only the request remains:

```
system   Start state End
system   This is End. Call `stop` when the request is complete.
```

The doxa calls `stop {why:"request complete"}`. The run is complete (`request_addressed`). The IR keeps every state, including the failed
Verification; the tape keeps only their traces.

### 4.8 What remains in the IR

States are separate steps of the request. Each is linked to the request by a `move` edge, and a
plan hangs on the state itself. The tape removed them from view, but the IR kept everything:

```
R  request
├─ I0 orientation   stopped   (on the tape only Start/Finish)
├─ I1 localization  stopped   plan: a1 grep, a2 read
├─ I2 patch         stopped   plan: a3 edit (v1→v2)
├─ I3 verification  stopped   plan: a4 bash (exit 1)     ← failed
│  ┆ revert v2→v1 (on the I3→I4 transition)
├─ I4 patch         stopped   plan: a5 edit (v1→v3)
├─ I5 verification  stopped   plan: a6 bash (exit 0)
└─ H  end           stopped
```

This is why `recall`/`search` matter: a closed state is not visible on the tape, but its results
are available by `id`.

### 4.9 What to notice

- **A state is the unit of work.** The goal is `island.what`; `move.what` is a guess; `move.done`
  overrides the criterion.
- **Erasure after `stop`.** On the tape a closed state keeps only `Start`/`Finish`; the plan and
  the material information leave, but stay in the IR.
- **`Finish` is the trace and the handoff.** The next state does not inherit the plan. It gets its
  own material information and reads the `Finish` line as the result.
- **The tail holds the goal.** `hint`, `Done when` and the closure requirement are rebuilt every
  turn. This is not memory; it is a reminder at the end of the tape.
- **Reasoning on the tape.** The doxa sees its past reasoning on assistant turns; the raw
  `thought` is not stored, its meaning stays in `why`.
- **No criterion check.** `stop` is accepted by the doxa; an instrument failure is a fact, not a
  closure.
- **The surface is the frontier.** On the request, `move`/`decline`; in an open state, the
  apply-tools, `stop`, `recall`/`search`; in a closed state, only `move`; in the terminal state,
  `stop`.
- **A failed Verification goes to Patch by default.** `revert` rolls the last Patch back;
  Localization is chosen only when the failure points at a different object.

## 5. Special cases

### 5.1 Unactionable request (`decline`)

| Turn | State | Move | Tape | Journal |
|---|---|---|---|---|
| 0 | request | — | base + request + request instruction | `+ request R` |
| 1 | request | `decline {why:"there is no actionable task"}` | the session ends | `+ unactionable U`; `R→U` |

`decline` is accepted only on a fresh request. A failed command is not a `stop`: the doxa keeps
working in the same state, adds items and checks again.

### 5.2 Failed Verification: `revert` and return

A failed acceptance does not close Verification by itself — the doxa's `stop` does. On the
`Verification → Patch/Localization` transition the engine:

1. records `revert` for the last Patch (files return to the state before the change, versions are
   updated);
2. adds the new state to the request as another step;
3. leaves the failure in the closed `Patch`/`Verification` `Finish` lines (the literal `stop.why`).

The failed state's plan is removed from the tape; there is no separate `Previous failed attempt`
block. If the revert is impossible (`write`/`apply_patch` without a preimage), the change stays
in the files — a known gap.

### 5.3 Timeout

| Turn | State | Move | Tape | Fact |
|---|---|---|---|---|
| 1 | V working | `bash {command:"make test", timeout:60000}` | `tool` with `{command, error:"… timed out…"}` | no `exitCode`; no verdict |
| 2 | V working | the same command again | a new `tool` | the timeout brought no knowledge |

`exitCode` is the "passed/failed" signal, not a gate. Without it, the state stays open and the
command may be repeated. A run never closes a state.

### 5.4 World, versions and addressing

| Turn | Move | Tape | Fact |
|---|---|---|---|
| r | `read src/parse.py [10-80]` | `tool` with the window | `observed(file)=v1` |
| e | `edit src/parse.py` | `tool mutated <path>` | `currentVersion=v2`; the `v1` read is stale |
| v | `stop` → `move` after a failure | the failure in the `Finish` lines | `revert` restored the versions |
| q | `recall {id:"obs:…"}` | the body arrives as a transient `tool` | no node is created |

Freshness is computed from the version, not stored as a flag. A stale read is not shown as
active. `recall`/`search` are available only while a state is open.

## 6. Why this design, and what it costs

- **States are isolated.** The model works with the current state's goal and material, not the
  whole past path; a closed state does not distract it.
- **The tail holds the goal.** `hint`, `Done when` and the closure requirement remind it of the
  criterion at the end of the tape and leave no debris in the journal.
- **The focus is non-monotone.** The tape is a view, not a transcript. A focus change removes the
  irrelevant, but knowledge stays available by `id`.
- **Transitions cost money.** A prefix cache miss (prefill), an extra turn per transition, and
  re-orientation reasoning. The last part is variable and reflects the quality of the state's
  spec. See `docs/projection.md` §8. Price the result (rubles per task, turns per task), not the
  transition. Provider noise (different subcontractors, turns without reasoning) is a statistical
  fluctuation, not a design property.

What the example shows:

1. Context is a projection, not a transcript. The tape is rebuilt every turn.
2. A state is the unit of work: goal, criterion, behavior and tool set.
3. Only the doxa's `stop` closes a state; there is no criterion check.
4. After closing, the tape keeps only `Start`/`Finish`, while the data stays in the IR.
5. The `Finish` line is the state's trace and its handoff to the next state.
6. The tail holds the goal rather than storing it.
7. The doxa's reasoning returns to the tape, but the raw `thought` is not stored.
8. Everything is addressable: the closed state is not visible but is fetched by `id`.
