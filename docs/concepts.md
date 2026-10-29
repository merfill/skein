# Skein — a coding agent with a deterministic IR context

> **Note (state protocol).** The tree/traversal/projection details here predate the
> **state protocol** redesign (`docs/plans/archive/state_protocol_plan.md`): the walk is now a state
> machine over islands — `move` declares the state (its goal is the island's own) and an optional
> note (`what`), the first `apply` seeds its plan, `stop` finishes it and forces the transition, and the terminal
> state ends the request. The current shape is `docs/ir_semantics.md`; the as-built is
> `docs/ir.md`. The conceptual frame (doxa/logos, the journal, the projection) still holds.
> Any `done_when`/criterion language below is historical (there is **no** criterion gate — a
> state closes only by the doxa's `stop`).

## The core idea

An ordinary agent treats the context as a message tape: the LLM reads the tape and
writes to it; the IR, if any, sits on the side.

Skein inverts this: **the context is a projection of the IR**. The tape exists only
for communication with the LLM. Memory lives in the IR. The LLM does not "remember" —
it sees a slice of state, and what it sees is determined by a **projection function**,
not by history. A consequence: the context does not accumulate. Every turn is a fresh
projection of the current state.

## The tree, not the tape (ReAct, unwound)

A ReAct loop is a flat, growing transcript: the LLM reads it and appends the next tool
call, and the only signal that the task is over is the model itself emitting a final
answer. Skein **unwinds that loop along a tree**:

```
request ─(move)▶ state (its own goal) ─(plan)▶ plan (items; last is current) ─▶ action ─▶ observation
```

A request is walked as a sequence of states. Flat states hang off the request (a `move` each);
a `move` declares the state — a state IS its own goal — and may carry an unverified note (`what`).
A non-actionable request
is **declined** instead (`unactionable`). A state closes only by the doxa's `stop` (no criterion);
`stop`ping a state forces the next `move` (or the terminal state and `stop`).

**The arm is ReAct in place.** Within one level — an arm — a state is entered whose
plan gains one item per command; each command is executed, its result recorded
(`observation`/`mutate`) and shown to the doxa; the doxa then either adds the next node or
stops. This is the ReAct loop unchanged: the next move is chosen from the results (a turn
may carry several independent commands). What ReAct cannot do is *keep* it — here every
step is an event in the append-only journal. An arm stops being flat only when a step
**branches**: the doxa proposes an alternative to that step (another command) — and each
branch is still an arm, i.e. ReAct again, one level down. In this sense the tree is "ReAct
unwound": not a different policy, but ReAct plus explicit memory, branching, and a
termination criterion.

- Only the state's first step is materialized as a plan item; later steps are chosen a turn at
  a time. The plan's `item` edges append in order, and
  the **last** is the current step. A turn appends one item per command (a batch may append
  several).
- With no alternatives, the tree is a flat, typed, addressable list — exactly the
  ReAct limit, no worse.
- The tree buys what a tape cannot: an explicit **termination criterion** (the
  `done_when` command), **verifiable closure** (the criterion's exit code), **branching**
  when a hypothesis fails, and a context that is a bounded slice (a spine plus its arms)
  rather than a growing tape.
- "Are we done?" is decided by the engine against the criterion, not by an LLM turn.

The plan is live, not a contract: it is revised by **adding nodes**
(alternatives, new items), never by rewriting one. The IR only grows.

## First principle: knowledge has a source

Every event in the journal is knowledge obtained from experience: a reading, a search,
a criterion run, a user statement, or the engine's own deterministic action. Nothing
appears out of nowhere, and every fact traces back to the experience that produced it —
its **source**. A verdict guessed from a file change, a goal declared done by the LLM, a
belief with no origin — all violate the principle.

Three consequences used throughout:

- a file change is known only because a deterministic action produced it (`mutate`),
  never guessed;
- a "pass" is only the exit code of the goal's own criterion run; a change of the code
  can make that run stale, but can never invent a verdict;
- a refused proposal is recorded (`record_rejection`) with its reason, not merely
  shown for a turn.

## Doxa and logos

The frame comes from the doxa/logos distinction (Ankyra, `doxa_and_logos.tex`):

- **Doxa** is the LLM. It only *proposes*: one or more operators per turn (a batch)
  (`move`, `apply`, `stop`, `decline`; `recall`/`search` are read-only
  addressing). Its thought is narrative and stays out of the IR. A proposed state enters
  `open`; it is never at once closed.
- **Logos** is the deterministic side: the gate (`classify`), the execution and
  recording of commands, and state derivation (`fold`, `project`), including the
  **traversal** that decides where the focus moves.
- **Arbiter** is the authority outside doxa and logos at the **boundaries**: the
  toolchain and the user (the first request, the final acceptance of the request). There is no
  per-state acceptance.

Doxa never closes a state by a verdict: a state is closed only by the doxa's `stop` (there is no
criterion gate).

## The IR in one page

A single graph, two namespaces (`docs/ir.md` is the as-built reference):

- **work** — `request`, `move`, `plan`, `item`, `action`, `observation`,
  `stop`, `unactionable`, `constraint`.
- **artifact** — `file` (canonical id `file:src/foo.ts`).

**Edges.** `move` (request → move), `plan` (move → plan), `items`, `alts`,
  `result`, `stop` (move → stop), `unactionable`, `mutates`.

**State** (never stored; computed by `fold`): an action is `executed` once it produced a
result, a state (`move`) is `finished` once it has a `stop` relation (the terminal state
included). There is no
`achieved`/`refuted`/`abandoned` and no criterion.

**Events** (closed vocabulary): `add_node`, `add_edge`, `descend`, `return`, `mutate`,
`record_rejection`. There is no `set_status` and no `record_check`: a state change is a
new node-event (`move`/`observation`/`stop`).

**Operators.** `move { state, what }` declares the state to work in (the first one, or the next
after a `stop`); `what` is an optional unverified note (a state IS its own goal; the plan hangs
directly off the `move` and the first `apply` seeds it). `apply { action }`
runs/reads/edits the world. `decline { why? }` answers a non-actionable request
(`unactionable`). `stop { why? }` is the sole closure: it closes the state's `move` (or, at the
terminal state, the request); there is no criterion and no check; the request has no `stop`.
`recall`/`search` are read-only addressing.

## The cycle

```
project → propose → classify → execute → progress
```

1. `project` builds the context (a slice of the tree).
2. `propose` asks doxa for one or more operators (a batch).
3. `classify` gates it (the logos decides admissibility).
4. `execute` applies it deterministically, appending events.
5. `progress` stops when the terminal state is stopped (the run ends), on no progress, or
   on the budget.

One move per turn (one or more independent calls), so every turn leaves a verifiable trace.

## Traversal: the spine and the arms

The position of work is a **stack of frames** — the **spine** — from the request to
the focus, one frame per level. Each frame carries an **arm**: the ordered siblings at
that level (the state under the request, the plan items under the state's `move`), with the
current position inside it (the last item). Moving is a `descend` (push) or a `return`
(pop); the engine computes where the focus must be, deterministically.

Neither the stack nor the cursor is stored: the stack is the fold of `descend`/
`return` over the journal, the cursor is derived from the plan. So `same events → same
context`. History (executed items, observations, criterion runs) is not kept on the spine
— it lives in the tree and is recalled **by address** (`recall { id }`). The full model is
`docs/plans/archive/traversal_stack_spec.md`.

## Projection

Projection is the heart of Skein: not "what was said" but "what acts now". It is a
deterministic function of the state, not an LLM summary. `Context` carries:

- `path` — the spine (`request → current move`); each node carries its own `plan` (so a
  plan revision is visible where it happened);
- `constraints`, the message tape, `applicable`.
The old `lastResult`/`shown`/`calls`/`checkReady`/`nextAction`/`budget` blocks are gone — the
context is the tape (`docs/projection.md`).

Everything else — file contents, raw output, older bodies — is reached through
`recall`/`search`. Addressability is always guaranteed: every node is either shown or one
recall away.

## Staleness by version

Code knowledge is non-monotonic, but the journal stays monotonic. The bridge is
**staleness by version**:

- a `read` fact records the file hash (`version`) at assertion time;
- a mutation emits `mutate`, which deterministically makes facts about the old version
  stale;
- a criterion run's observation carries a `ref → version` witness; a later `mutate`
  makes facts about the old version stale, so a pass cannot silently remain valid.

The witness is a snapshot of the whole workspace — sound but coarse; precision is
deferred.

## Acceptance

Acceptance is external; there is no separate actor inside the loop:

- the **toolchain** (tests, type checker, repro scripts) produces the criterion's exit
  code when the goal's acceptance command runs;
- the **user** or the harness issues the first request and accepts the final result from
  outside.

There is no `record_check` and no per-state acceptance. A state is closed only by the
doxa's `stop` — there is no criterion gate. The LLM never produces the closure.

The request root is not closed in the IR: acceptance is external and implicit. Inside,
only `requestSettled` is computed.

## How it differs from existing approaches

- **MemGPT / Letta** — the LLM manages textual memory blocks. Skein: rules manage
  typed state; the LLM proposes changes.
- **Deepagents** — eviction and summarization compress the tape but keep it.
  Skein: the context is a projection, not a summary; nothing is lost, only addressed.
- **LangGraph state** — a typed dict for orchestration, not for context management.
  Skein: projection into context is the main function.
- **RAG** — retrieval by similarity. Skein: deterministic relevance by structure,
  status and provenance, with addressed recall.

The novelty: **context as projection** over an append-only tree, with a deterministic
traversal and verification only by running a goal's criterion.

## Status

Tier 0 (a bug fix by a failing test) and the Tier 1 work graph are implemented; the
current IR is `docs/ir.md`, the semantics `docs/ir_semantics.md`, the traversal stack
`docs/plans/archive/traversal_stack_spec.md`, and the step-reduction work
`docs/plans/archive/step_reduction_plan.md`.
