# Skein — a coding agent with a deterministic IR context

## Core idea

An ordinary agent treats the context as a message tape: the LLM reads the tape and
writes to it; the IR, if any, sits on the side.

Skein inverts this: **the context is a projection of the IR**. The tape exists only
for communication with the LLM. Memory lives in the IR. The LLM does not
"remember" — it sees a slice of state, and what it sees is determined by a
**projection function**, not by history.

A consequence: the context does not accumulate. Every turn is a fresh projection;
the LLM does not see previous projections, it sees the current state.

## Doxa and logos

The conceptual frame comes from the doxa/logos distinction (Ankyra,
`doxa_and_logos.tex`):

- **Doxa** is the LLM. It only *proposes*. Every proposal enters the IR as
  `provenance.kind = "llm"` and `status = "open"` — never immediately `verified`.
- **Logos** is the deterministic side: arbiter verdicts (`check`) and closure of
  the artifact graph.
- **Protocol** is the environment: the append-only event journal, `fold`,
  `project`, and status transitions.

The IR is protocol plus internal state; doxa itself is not stored in the IR.

## IR primitives

Details of the operations and the state model — `docs/ir.md`. In short: a single
graph with two namespaces:

- `work` — the work over the code: `goal`, `subgoal`, `claim`, `decision`,
  `action`, `observation`, `constraint`.
- `artifact` — the code world: `file`, `symbol`, `test`. Canonical ids:
  `file:src/foo.ts`, `sym:src/foo.ts#bar`, `test:...`.

**Edges.** work→work: `decomposes`, `supports`, `refutes`, `depends_on`,
`chosen_over`, `justifies`. work→artifact: `touches`, `locates`, `verifies`,
`violates`. artifact→artifact: `calls`, `defines`, `imports`, `tests`.

**Statuses.** `open` / `verified` / `refuted` / `superseded` for claims and
observations; `active` / `applied` / `reverted` for decisions and actions;
`achieved` / `abandoned` for goals; `must` for constraints; `believed` / `stale` /
`confirmed` for artifacts.

Every node and edge carries **provenance** (how it is known: `llm`, `user`,
`read`, `grep`, `check`). This is what makes relevance computable later.

This is the evolved form of the original sketch: `hypothesis` became `claim`,
`source` became the artifact index, and cancellation is a status change, not a
removal.

## The cycle

```
goal → locate → claim → action → check → done
```

1. The user sets the goal (a `goal` node, with acceptance criteria).
2. The projection builds the context.
3. The LLM proposes exactly one action.
4. The engine classifies it: `derivable | cited | hypothesis | rejected`.
5. The engine executes it deterministically and appends events.
6. Repeat.

One proposal per turn, so every turn leaves a verifiable trace.

## Projection

Projection is the heart of Skein: not "what was said" but "what acts now". The
rules are deterministic, not LLM-driven:

- `goal` — always;
- active claims — in full;
- verified claims — one line, id and label;
- rejected claims — one line, id and reason;
- observations — the latest per active claim;
- artifacts — index only (id plus one line), never contents;
- the tail — the last few turns, verbatim, for flow.

"What is active" is **relevance by provenance**, not by similarity: a node is
active iff it lies on a path from an open goal through active decisions and
actions to open claims. The IR index is always included, so the agent knows what
exists even when it does not see contents.

## Non-monotonicity: staleness by version

Code knowledge is non-monotonic, but the journal must stay monotonic. The bridge
is **staleness by version**:

- every artifact fact (`read` / `grep`) records the file hash (`version`) at
  assertion time;
- a mutation (`edit`) emits `mutate`, which deterministically marks facts about
  the old version `stale`.

So the knowledge log only grows, while the mutable code is a derived view of
replayed actions. Cancellation needs no manual retraction.

## The Arbiter

Skein distinguishes two authorities:

- **objective** — the toolchain: type checker, tests, repro scripts. It decides
  whether a hypothesis is refuted and whether a check passed.
- **subjective** — the user, through acceptance criteria. It decides whether the
  goal is achieved.

Without an arbiter, Skein is an automaton; with one, it is a tool.

## How it differs from existing approaches

- **MemGPT / Letta** — the LLM manages textual memory blocks. Skein: rules manage
  typed state; the LLM proposes changes.
- **Deepagents** — eviction and summarization compress monotonicity but do not
  remove it. Skein: cancellation is first-class.
- **LangGraph state** — a typed dict for orchestration, not for context
  management. Skein: projection into context is the main function.
- **RAG** — retrieval by similarity. Skein: structural relevance to active claims.

The novelty: **context as projection**, with a formal state model and a
deterministic projection.

## Resolved design questions

The original sketch left eight questions open. They are resolved as follows.

1. **What is "one action"?** One structured proposal `{ thought, action }`. The
   thought is narrative: it goes to the tail, not the IR.
2. **How does the user enter the IR?** The user owns the goal; the goal is not
   LLM content. A goal change is a revision, not silent history.
3. **Who decides relevance?** Deterministic, by provenance: active means premises
   of the open goal.
4. **What if the projection is wrong?** The projection always includes the IR
   index, so the agent can see what exists and request it.
5. **What about long files?** File contents never enter the IR; artifacts are
   pointers, reads are ephemeral.
6. **What is a turn?** One projection → propose → classify → execute cycle.
7. **How to cache?** Only the header (goal, constraints, system prompt) is stable;
   the frontier changes each turn.
8. **Where is the Arbiter?** Objective toolchain plus user acceptance.

## Risks

- **Loss of thread.** The LLM does not see its previous thought. Mitigation: the
  tail, and narrative kept out of the IR.
- **Projection overhead.** If projection were LLM-summarized, the savings would
  vanish. Mitigation: deterministic rules.
- **Complexity.** The IR must be maintained and the LLM taught to use it; the
  prompt is new. This is not a plugin — it is a new agent.
- **Cache.** The projection changes each turn; only the header caches.
- **User.** An unfamiliar user does not understand why the agent forgot something.
  A transparent interface is needed.

## Status

Tier 0 (bugfix by a failing test) is implemented. Plan and roadmap:
`docs/plans/implementation_plan.md`; stage detail: `docs/plans/tier0_plan.md`.
