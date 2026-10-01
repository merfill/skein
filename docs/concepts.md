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

## First principle: knowledge has a source

Every event in the journal is a piece of knowledge obtained from experience:
a reading, a search, a check, a user statement, or the engine's own
deterministic action. No knowledge appears out of nowhere, and every fact can
be traced back to the experience that produced it — its **source**.

This is the foundation of the system, and of the IR in particular, not a
convention. The IR is built so that every event traces to a source; anything
that would create knowledge without one is a design error. A verdict guessed
from a file change, a claim declared verified by the LLM, a belief with no
origin — all violate the principle and must be rejected.

Three consequences used throughout:

- a file change is known only because a deterministic action produced it
  (`mutate`), never guessed;
- `verified` comes only from an arbiter's check; a change of the code can
  invalidate that check, but can never invent a verdict;
- a refused proposal is recorded (`record_rejection`) with its reason, not merely
  shown for a turn.

## Doxa and logos

The conceptual frame comes from the doxa/logos distinction (Ankyra,
`doxa_and_logos.tex`):

- **Doxa** is the LLM. It only *proposes*: one structured `{ thought, action }`
  per turn. The thought is narrative and stays out of the IR (it goes to the
  `recent` stream). A proposed belief becomes a node only when the engine admits
  it (`track`), and then with `status = "open"` — never immediately `verified`.
- **Logos** is the deterministic side: the gate (`classify`), arbiter verdicts
  (`record_check`), and state derivation (`fold`, `project`).
- **Protocol** is the environment: the append-only event journal, `fold`,
  `project`, and status transitions.

The IR stores the admitted, distilled state. Raw doxa — thoughts and rejected
wording — is not stored in it. A node carries no provenance of its own; its source
is the typed event that introduced it (for a claim, the proposal the engine
admitted). The provenance kind `llm` is carried by edges born from admitted doxa
proposals (`decompose` / `decide` / `track`).

## IR primitives

Details of the operations and the state model — `docs/ir.md`. In short: a single
graph with two namespaces:

- `work` — the work over the code: `goal`, `subgoal`, `claim`, `decision`,
  `action`, `observation`, `check`, `constraint`.
- `artifact` — the code world: `file`, `symbol`, `test`. Canonical ids:
  `file:src/foo.ts`, `sym:src/foo.ts#bar`, `test:...`.

**Edges.** work→work: `decomposes`, `supports`, `refutes`, `depends_on`,
`chosen_over`, `justifies`. work→artifact: `touches`, `locates`, `verifies`,
`violates`. artifact→artifact: `calls`, `defines`, `imports`, `tests`.

**Statuses.** `open` / `verified` / `refuted` / `superseded` for claims and
observations; `active` / `applied` / `reverted` for decisions and actions;
`achieved` / `abandoned` for subgoals; `must` for constraints; `believed` / `stale` /
`confirmed` for artifacts.

**Provenance** lives on edges — *how the relation is known*: `llm`, `user`,
`read`, `grep`, `check` — and on checks, through `actor` (`arbiter` or `user`).
Nodes do not carry it. The kind `grep` is declared but reserved.

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

- `header` — the goal, the constraints, and the turn budget;
- `frontier` — the closure from the goal: subgoals and open claims in full (claims
  carry their parent, `supports`); settled claims one line each (`verified` /
  `invalidated`); achieved
  subgoals one line each; rejected nodes (`refuted` / `superseded`) one line each;
  active decisions with their rejected alternatives (`over`); refused proposals one
  line each, collapsed by signature; the last action;
- `artifacts` — an index of files (id plus one line), never contents;
- `index` — an overview of the space: counts by kind (`counts`) plus a window of
  the newest nodes (`recent`) as `{ id, kind, label }`;
- `recent` — the last turns verbatim, for flow: the doxa's thought and the tool's
  result.

One arbitrary parameter, `tail` (six by default), sets the visibility budget: it
bounds the window `index.recent`, the `recent` stream, and the one-line
`frontier.verified` and `frontier.refusals`. The overview `index.counts` is never
clipped; the full listing is always retrievable through `query`.

Relevance is **path-based**: `frontier` shows the reachable closure from the open
goal along `decomposes` / `justifies` / `chosen_over` / `supports` edges. A node
outside the closure is not shown, but is still retrievable through `query` —
addressability is not lost. `header`, `artifacts`, `index`, and `recent` are not
filtered.

Addressability is always guaranteed: every node is either shown or retrievable
through `query`, so the agent can name what it does not see. `index` is a summary,
not a full listing; the full listing is a query away.

## Non-monotonicity: staleness by version

Code knowledge is non-monotonic, but the journal must stay monotonic. The bridge
is **staleness by version**:

- a `read` fact records the file hash (`version`) at assertion time; a `grep`
  observation is ephemeral and carries no version;
- a mutation emits `mutate`, which deterministically marks facts about the old
  version `stale`;
- a check's source observation records a **witness** — the `ref → version`
  snapshot it was obtained against; a later `mutate` stales the `verifies` edge, so
  the claim moves to `invalidated`, never silently staying `verified`.

The witness is a snapshot of the whole workspace, so any change invalidates a
check — sound but coarse. Precision (an import graph, to avoid invalidating on
unrelated changes) is deferred.

So the knowledge log only grows, while the mutable code is a derived view of
replayed actions. Cancellation needs no manual retraction.

## The Arbiter

Skein distinguishes two authorities:

- **objective** — the toolchain: type checker, tests, repro scripts. It decides
  whether a hypothesis is refuted and whether a check passed;
- **subjective** — the user, through acceptance criteria. It decides whether the
  goal is achieved.

A subjective verdict is recorded as a check with `actor = "user"`
(`src/ir/approval.ts`); the LLM cannot produce it. Both authorities go through
`record_check`, so `verified` still has exactly one path — this is how non-code
work reaches a settled state. Every check is an addressable `check` node (command,
verdict, witness, `actor`), pointed at by a `verifies` edge to the claim.

Without an arbiter, Skein is an automaton; with one, it is a tool.

## How it differs from existing approaches

- **MemGPT / Letta** — the LLM manages textual memory blocks. Skein: rules manage
  typed state; the LLM proposes changes.
- **Deepagents** — eviction and summarization compress monotonicity but do not
  remove it. Skein: cancellation is first-class.
- **LangGraph state** — a typed dict for orchestration, not for context
  management. Skein: projection into context is the main function.
- **RAG** — retrieval by similarity. Skein: deterministic relevance by status and
  provenance, with path relevance reserved.

The novelty: **context as projection**, with a formal state model and a
deterministic projection.

## Resolved design questions

The original sketch left eight questions open. They are resolved as follows.

1. **What is "one action"?** One structured proposal `{ thought, action }`. The
   thought is narrative: it goes to `recent`, not the IR.
2. **How does the user enter the IR?** The user owns the goal; the goal is not
   LLM content. A goal change is a revision, not silent history. The user also
   enters through acceptance (a subjective check).
3. **Who decides relevance?** Deterministic. Currently by status and provenance
   (open claims, active decisions, their observations/actions); path-based
   relevance is reserved (Tier 1).
4. **What if the projection is wrong?** Addressability is always guaranteed: every
   node is either shown or retrievable through `query`, so the agent can see what
   exists and request it. The `index` is a bounded summary, not a full listing.
5. **What about long files?** File contents never enter the IR; artifacts are
   pointers, reads are ephemeral.
6. **What is a turn?** One projection → propose → classify → execute cycle.
7. **How to cache?** Only the header (goal, constraints, system prompt) is stable;
   the frontier changes each turn.
8. **Where is the Arbiter?** Objective toolchain plus user acceptance, both
   recorded through `record_check`.

## Outcomes of the design review

An external critique of `docs/ir.md` / `docs/concepts.md` was triaged point by
point in `docs/design_review.md`. The outcomes:

**Applied** (with the plan that implements each):

- **R1 index blow-up** — `index` is a bounded summary under the addressability
  contract (`docs/plans/index_budget_plan.md`);
- **R2 contents vs memory** — contents stay out of the IR; long command output is
  spilled and referenced (`docs/plans/context_inspection_plan.md`);
- **R3 stale checks / transitivity** — a check's observation carries a witness;
  the witness lives once; transitivity is covered by the whole-workspace snapshot
  (`docs/plans/check_soundness_plan.md`, `docs/plans/staleness_scope_plan.md`);
- **C1 non-code arbitration** — a subjective verdict is a check with
  `actor = "user"` (`docs/plans/user_approval_plan.md`);
- **P3 rejected actions** — refusals are recorded as events
  (`docs/plans/rejection_plan.md`), while the provenance split is rejected;
- **P4 budget** — the turn budget is shown in `header`
  (`docs/plans/index_budget_plan.md`);
- **C2 path-based relevance** — the reachability closure from the goal in `project`
  (`docs/plans/tier1_plan.md` §5).

**Deferred:**

- **R3b precision** (beyond Tier 1) — scope the witness via each ecosystem's
  tooling to avoid invalidating checks on unrelated changes; the current snapshot
  is sound but coarse (`docs/plans/tier1_plan.md` §7);
- **P1 deterministic compaction** — largely subsumed by R1 and the output spill;
  revisit only if an evaluation shows the need, and never as LLM summarization.

**Rejected:**

- **R4 engine-set `goal_achieved`** — closing the goal is external by design;
- **C3 agent `set_status`** — doxa only proposes; logos decides;
- **P2 `read_artifact`** — redundant with `read`/`query`;
- **P3 provenance split** (`llm_proposal` / `llm_hallucination`) — speculative; a
  separate kind is unnecessary, `llm` already means "doxa proposed it";
- **an LLM critic as arbiter** — it would put doxa in the role of logos;
- **narrowing the witness without read tracing** — unsound in general.

## Risks

- **Loss of thread.** The LLM does not see its previous thought. Mitigation:
  `recent`, and narrative kept out of the IR.
- **Projection overhead.** If projection were LLM-summarized, the savings would
  vanish. Mitigation: deterministic rules.
- **Complexity.** The IR must be maintained and the LLM taught to use it; the
  prompt is new. This is not a plugin — it is a new agent.
- **Cache.** The projection changes each turn; only the header caches.
- **User.** An unfamiliar user does not understand why the agent forgot something.
  A transparent interface is needed.

## Status

Tier 0 (bugfix by a failing test) is implemented, the design-review points listed
above are applied, and Tier 1 is progressing: T1.1 (a produced work graph —
subgoals, decisions, connecting edges), T1.2 (path-based closure in the
projection), and T1.3 (an explicit check node) are implemented. Plan and roadmap:
`docs/plans/implementation_plan.md`; Tier 0 detail: `docs/plans/tier0_plan.md`;
Tier 1 detail: `docs/plans/tier1_plan.md`; triage: `docs/design_review.md`.
