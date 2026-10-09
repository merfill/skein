# Skein — a coding agent with a deterministic IR context

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
request ─(has_goal)▶ goal (a hypothesis) ─(has_plan)▶ plan (a string sketch; last item is current) ─▶ action ─▶ observation
```

A request is interpreted **once** as a goal (`has_goal`); the interpretation is fixed for
now. A non-actionable request is **declined** instead (`no_goal` → `unactionable`).

**The arm is ReAct in place.** Within one level — an arm — a goal is proposed whose
plan materializes exactly one item (a command); that item is executed on its own turn;
its result is recorded (`observation`/`mutate`) and shown to the doxa; the doxa
then either adds the next node or stops. This is the ReAct loop unchanged: one step per
turn, the next chosen from the result. What ReAct cannot do is *keep* it — here every
step is an event in the append-only journal. An arm stops being flat only when a step
**branches**: the doxa proposes an alternative to that step (another command) or
decomposes it into a composite sub-goal — and each branch is still an arm, i.e. ReAct
again, one level down. In this sense the tree is "ReAct unwound": not a different
policy, but ReAct plus explicit memory, branching, and a termination criterion.

- Only the goal's first step is materialized as a plan item; the plan itself is a string
  sketch, and steps are chosen one at a time. The plan's `item` edges append in order, and
  the **last** is the current step. The tree grows one node per turn.
- With no alternatives, the tree is a flat, typed, addressable list — exactly the
  ReAct limit, no worse.
- The tree buys what a tape cannot: an explicit **termination criterion** (the
  `done_when` command), **verifiable closure** (the criterion's exit code), **branching**
  when a hypothesis fails, and a context that is a bounded slice (a spine plus its arms)
  rather than a growing tape.
- "Are we done?" is decided by the engine against the criterion, not by an LLM turn.

The plan is a live sketch, not a contract: it is revised by **adding nodes**
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

- **Doxa** is the LLM. It only *proposes*: exactly one operator per turn
  (`create_goal`, `apply`, `stop`, `decline`; `query` is read-only addressing). Its
  thought is narrative and stays out of the IR. A proposed goal enters `open`; it is
  never at once closed.
- **Logos** is the deterministic side: the gate (`classify`), the execution and
  recording of commands, and state derivation (`fold`, `project`), including the
  **traversal** that decides where the focus moves. A criterion run's exit code is read
  here — not issued as a node.
- **Arbiter** is the authority outside doxa and logos at the **boundaries**: the
  toolchain (the criterion command) and the user (the first request, the final
  acceptance of the request). There is no per-goal acceptance.

Doxa never closes a goal by a verdict: a goal is closed only by the doxa's `stop`,
gated by the criterion fact (a passing `exitCode`).

## The IR in one page

A single graph, two namespaces (`docs/ir.md` is the as-built reference):

- **work** — `request`, `goal`, `plan`, `alternatives`, `action`, `observation`,
  `stop`, `unactionable`, `constraint`.
- **artifact** — `file` (canonical id `file:src/foo.ts`).

**done_when** is a single **command string**: the criterion the engine runs, read by its
exit code (0 = pass, non-zero = fail, absent = no verdict). The exit code is the only
verdict — not a node.

**Edges.** `has_goal`, `has_plan`, `item`, `has_alternatives`, `produces`, `has_stopped`,
`no_goal`, `mutates`.

**State** (never stored; computed by `fold`): a node is `open`/`executed`/`stopped` — an
action is `executed` once it produced a result, a goal is `stopped` once it has a
`has_stopped` edge; there is no `achieved`/`refuted`/`abandoned`. The criterion facts
(pass/fail/no verdict from a run's `exitCode`) and the settled request are derived reads,
not statuses.

**Events** (closed vocabulary): `add_node`, `add_edge`, `descend`, `return`, `mutate`,
`record_rejection`. There is no `set_status` and no `record_check`: a state change is a
new node-event (`observation`/`stop`).

**Operators.** `create_goal { what, why?, done_when, plan, step, revises? }` interprets
the request once, or decomposes the current step into a sub-goal (an alternative); `plan`
is a string sketch and `step` the first action. `apply { action }` runs/reads/edits the
world. A `run` with an explicit `target` is the goal's **criterion run** (an observation
with `target`+`exitCode`); a bare `run` is an ordinary observation. `decline { why? }`
answers a non-actionable request (`unactionable`). `stop { why? }` is the sole closure,
accepted (for now) only on a goal whose criterion passed: it appends the `stop` as the
goal's last plan item. There is no `stop` on the request. `query` is read-only
addressing.

## The cycle

```
project → propose → classify → execute → progress
```

1. `project` builds the context (a slice of the tree).
2. `propose` asks doxa for exactly one operator.
3. `classify` gates it (the logos decides admissibility).
4. `execute` applies it deterministically, appending events.
5. `progress` stops when the request's goal is stopped (the run ends), on no progress, or
   on the budget.

One proposal per turn, so every turn leaves a verifiable trace.

## Traversal: the spine and the arms

The position of work is a **stack of frames** — the **spine** — from the request to
the focus, one frame per level. Each frame carries an **arm**: the ordered siblings at
that level (the goal under the request, the plan items under a goal), with the current
position inside it (the last item). Moving is a `descend` (push) or a `return`
(pop); the engine computes where the focus must be, deterministically.

Neither the stack nor the cursor is stored: the stack is the fold of `descend`/
`return` over the journal, the cursor is derived from the plan. So `same events → same
context`. History (executed items, observations, criterion runs) is not kept on the spine
— it lives in the tree and is recalled **by address** (`query { id }`). The full model is
`docs/plans/traversal_stack_spec.md`.

## Projection

Projection is the heart of Skein: not "what was said" but "what acts now". It is a
deterministic function of the state, not an LLM summary. `Context` carries:

- `path` — the spine (`request → … → focus`); each node carries its own `plan` and
  `alternatives` (so a plan revision is visible where it happened);
- `constraints`, `lastResult` (the full result of the latest call), `shown` (the
  working set), `calls` (a deduplicated index of previous calls), `applicable`,
  `checkReady`, `nextAction`, `budget`.

Everything else — file contents, raw output, older bodies — is reached through
`query`. Addressability is always guaranteed: every node is either shown or one query
away.

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

## The arbiter

The Arbiter is a **boundary authority**, not a per-goal actor:

- the **toolchain** (tests, type checker, repro scripts) produces the criterion's exit
  code when the goal's `done_when` runs;
- the **user** owns the first request and the final acceptance of the request.

There is no `record_check` and no per-goal acceptance. A goal is closed only by the
doxa's `stop`, gated by the criterion fact (a passing `exitCode`). The LLM never produces
either.

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
`docs/plans/traversal_stack_spec.md`, and the step-reduction work
`docs/plans/step_reduction_plan.md`.
