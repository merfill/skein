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
request → goal (a hypothesis) → plan (a string sketch + first step) → action → observation / check
```

**The arm is ReAct in place.** Within one level — an arm — a goal is proposed whose
plan materializes exactly one item (a command); that item is executed on its own turn;
its result is recorded (`observation`/`mutate`/`check`) and shown to the doxa; the doxa
then either adds the next node or stops. This is the ReAct loop unchanged: one step per
turn, the next chosen from the result. What ReAct cannot do is *keep* it — here every
step is an event in the append-only journal. An arm stops being flat only when a step
**branches**: the doxa proposes an alternative to that step (another command) or
decomposes it into a composite sub-goal — and each branch is still an arm, i.e. ReAct
again, one level down. In this sense the tree is "ReAct unwound": not a different
policy, but ReAct plus explicit memory, branching, and a termination criterion.

- Only the goal's first step is materialized as a plan item; the plan itself is a string
  sketch, and steps are chosen one at a time. The tree grows one node per turn.
- With no alternatives, the tree is a flat, typed, addressable list — exactly the
  ReAct limit, no worse.
- The tree buys what a tape cannot: an explicit **termination criterion** (an
  objective `done_when`), **verifiable closure** (a verdict comes only from a check),
  **branching** when a hypothesis is refuted, and a context that is a bounded slice
  (a spine plus its arms) rather than a growing tape.
- "Are we done?" is decided by the engine against the criterion, not by an LLM turn.

The plan is a live sketch, not a contract: it is revised by **adding nodes**
(alternatives, new items), never by rewriting one. The IR only grows.

## First principle: knowledge has a source

Every event in the journal is knowledge obtained from experience: a reading, a search,
a check, a user statement, or the engine's own deterministic action. Nothing appears
out of nowhere, and every fact traces back to the experience that produced it — its
**source**. A verdict guessed from a file change, a goal declared achieved by the LLM,
a belief with no origin — all violate the principle.

Three consequences used throughout:

- a file change is known only because a deterministic action produced it (`mutate`),
  never guessed;
- `achieved` comes only from a check; a change of the code can invalidate that check,
  but can never invent a verdict;
- a refused proposal is recorded (`record_rejection`) with its reason, not merely
  shown for a turn.

## Doxa and logos

The frame comes from the doxa/logos distinction (Ankyra, `doxa_and_logos.tex`):

- **Doxa** is the LLM. It only *proposes*: exactly one operator per turn
  (`create_goal`, `apply`, `stop`; `query` is read-only addressing). Its thought is
  narrative and stays out of the IR. A proposed goal enters `open`; it is never at
  once achieved.
- **Logos** is the deterministic side: the gate (`classify`), verdicts
  (`record_check`), and state derivation (`fold`, `project`), including the
  **traversal** that decides where the focus moves.
- **Arbiter** is the authority outside doxa and logos: the toolchain (objective) and
  the user (acceptance). It owns the first request, the final stop, and acceptance of
  an arbiter goal.

Doxa never closes a goal. An objective goal is settled only by its own check; an
arbiter goal only by external acceptance.

## The IR in one page

A single graph, two namespaces (`docs/ir.md` is the as-built reference):

- **work** — `request`, `goal`, `plan`, `alternatives`, `action`, `observation`,
  `check`, `stop`, `constraint`.
- **artifact** — `file` (canonical id `file:src/foo.ts`).

**done_when** has two kinds: `objective` (a literal command whose exit code settles
the goal) and `arbiter` (external acceptance by the user/arbiter).

**Edges.** `has_plan`, `item`, `has_alternatives`, `chosen`, `under` (an assumption a
check rests on), `produces`, `verifies`, `mutates`.

**Predicates** (never stored; computed by `fold`): an action is `executed`/`abandoned`;
a goal is `open`/`achieved`/`achieved_under`/`refuted`/`abandoned`; a request is
`open`/`addressed`.

**Events** (closed vocabulary): `add_node`, `add_edge`, `descend`, `return`, `mutate`,
`record_rejection`, `record_check`. There is no `set_status`: a state change is a new
node-event, not an edit.

**Operators.** `create_goal { what, why?, done_when, plan, step, revises? }` interprets
the request, or decomposes the current step into a sub-goal (an alternative); `plan` is a
string sketch and `step` the first action. `apply { action }` runs/reads/edits the world.
A `run` with an explicit `target` (an objective goal) is a **check**; a bare `run` is an
observation. `stop { why? }` is the terminal move — accepted only when the request is
`addressed`.

## The cycle

```
project → propose → classify → execute → progress
```

1. `project` builds the context (a slice of the tree).
2. `propose` asks doxa for exactly one operator.
3. `classify` gates it (the logos decides admissibility).
4. `execute` applies it deterministically, appending events.
5. `progress` stops when the request is `addressed`, on no progress, or on the budget.

One proposal per turn, so every turn leaves a verifiable trace.

## Traversal: the spine and the arms

The position of work is a **stack of frames** — the **spine** — from the request to
the focus, one frame per level. Each frame carries an **arm**: the ordered siblings at
that level (the interpretations under the request, the plan items under a goal), with
the cursor/chosen position inside it. Moving is a `descend` (push) or a `return`
(pop); the engine computes where the focus must be, deterministically.

Neither the stack nor the cursor is stored: the stack is the fold of `descend`/
`return` over the journal, the cursor is derived from the plan. So `same events → same
context`. History (executed items, observations, checks) is not kept on the spine — it
lives in the tree and is recalled **by address** (`query { id }`). The full model is
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
- a check's witness is a `ref → version` snapshot; a later `mutate` stales the
  `verifies` edge, so the goal never silently stays `achieved`.

The witness is a snapshot of the whole workspace — sound but coarse; precision is
deferred.

## The arbiter

Two authorities, both entering through `record_check`:

- **objective** — the toolchain: tests, type checker, repro scripts. It gives the
  verdict that settles an objective goal;
- **arbiter** — the user, through acceptance. It settles a goal that has no command
  criterion (`userAcceptance`, a check with `actor: "user"`). The LLM cannot produce
  either verdict.

The request root is not closed in the IR: acceptance is external and implicit. Inside,
only `addressed` is computed.

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
traversal and verification only by an explicit check.

## Status

Tier 0 (a bug fix by a failing test) and the Tier 1 work graph are implemented; the
current IR is `docs/ir.md`, the semantics `docs/ir_semantics.md`, the traversal stack
`docs/plans/traversal_stack_spec.md`, and the step-reduction work
`docs/plans/step_reduction_plan.md`.
