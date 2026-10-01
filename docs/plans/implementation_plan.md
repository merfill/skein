# Skein — overall implementation plan

Concept — `docs/concepts.md`. Conceptual frame — doxa/logos in
`ankyra/docs/doxa_and_logos.tex` and `ankyra/docs/concepts_ru.md`. Detailed spec
of the current stage — `docs/plans/tier0_plan.md`. This document is the overall plan,
decisions, roadmap, and status.

## 1. Essence

Skein is a coding agent whose context is a **projection of the IR**, not a message
tape. The LLM is doxa: it only proposes (`status=open`). The deterministic engine
and the arbiter are logos: they decide. The event journal and the projection
function are the protocol.

## 2. Fixed decisions

| Decision | Choice |
|---|---|
| Language | TypeScript (Node 22, ESM), package manager npm |
| State model | hybrid graph `work` + `artifact`, append-only journal + deterministic projection |
| Code non-monotonicity | staleness by version (file hash), no manual retraction |
| First slice | bugfix by a failing test; arbiter is the test runner |
| Orchestration | LangGraph.js (`@langchain/langgraph`) |
| LLM | as in Ankyra: OpenAI-compatible endpoint, **reasoning disabled** (`thinking.type=disabled`, `reasoning.effort=none`); secrets only in `.env` |
| Arbiter | objective (test runner) plus subjective (user/acceptance) |

## 3. Roadmap

**Tier 0 — bugfix by a failing test (done).**
Closed loop `goal → locate → claim → action → check → done`; IR and projection;
staleness; objective arbiter. Details — `docs/plans/tier0_plan.md`.

**Tier 1 — working on a task (done).**
- `Decision` as first-class: choice, rejected alternatives, rationale.
- `Check`/arbiter as an explicit node with an objective verdict.
- Subgoals and their decomposition.
- Path-based relevance: reachability from the goal through decision/action edges
  (C2).
  Details and order of work — `docs/plans/tier1_plan.md`.

**Tier 2 — non-monotonic knowledge.**
- Statuses `superseded`/`refuted`, specificity, `Revision` as a record.
- Staleness precision (R3b): scope the witness to a dependency closure, via each
  ecosystem's tooling; deferred from Tier 1 (`docs/plans/tier1_plan.md` §7).

**Tier 3 — doxastic operators.**
- `analogy`, `intuition` — asking the LLM for the non-derivable, as explicit
  operators.

**Immediate next steps.**
1. Tighten classification: a constraint must forbid a `run` (shell) workaround,
   not only `edit`. **Done** — effect guard: `edit` is checked in `classify`; a
   `run` that changes a forbidden file is reverted and recorded as a violation
   (`docs/plans/constraint_guard_plan.md`).
2. Long-horizon tasks where the projection should give an advantage
   (multi-file edits, 50+ turns).
3. Compare Skein vs opencode vs a monotonic agent on the same tasks.

## 4. Current status

Tier 0 is implemented (steps 1–5 of `docs/plans/tier0_plan.md` §11): `src/ir`,
`src/config`, `src/llm`, `src/tools`, `src/loop`, three fixtures, offline and live
gates. Full status and deliberate simplifications — `docs/plans/tier0_plan.md` §13.

Beyond Tier 0, the current line adds:

- **First principle** — every event is knowledge obtained from experience and
  traces to a source (`docs/concepts.md`).
- **Check soundness** — a check carries a witness; a later change stales it and
  the claim moves to `frontier.invalidated`
  (`docs/plans/check_soundness_plan.md`).
- **Observation of change** — `run` records a `mutate` per changed file; the
  engine reconciles active `ref`s before each projection, with a signature cache;
  `fs.watch` is left for a future streaming mode
  (`docs/plans/observation_plan.md`, `docs/plans/watcher_plan.md`).
- **Rejection recording** — a refused proposal is recorded as a
  `record_rejection` event and shown under `frontier.refusals`, so it survives
  tail eviction and replay (`docs/plans/rejection_plan.md`).
- **Context budget** — `index` is a bounded summary (counts + newest window) under
  the addressability contract; the turn budget is shown in `header.budget`
  (`docs/plans/index_budget_plan.md`).
- **Subjective arbiter** — `userAcceptance` records a user check
  (`actor: "user"`), so non-code work can reach a settled state
  (`docs/plans/user_approval_plan.md`).
- **Staleness scope** — transitivity is covered by a workspace-wide witness; the
  witness now lives once, on the observation
  (`docs/plans/staleness_scope_plan.md`).
- **Work graph (T1.1)** — `decompose`/`decide` produce subgoals, decisions, and
  connecting edges (`decomposes`/`justifies`/`chosen_over`/`supports`) with
  `provenance.llm`; attachment to a parent is mandatory (the `classify` gate);
  `superseded`/`achieved` statuses are derived; the projection shows subgoals and
  links (`docs/plans/tier1_plan.md`).
- **Path-based relevance (T1.2)** — `frontier` is the reachable closure from the
  goal along path edges; the unreachable stays retrievable through `query`
  (`docs/plans/tier1_plan.md` §5).
- **Explicit check node (T1.3)** — `record_check` materializes a `check` node
  (command, verdict, witness, `actor`) and a `verifies` `check → claim` edge;
  `query {verdictOf}` reads the node (`docs/plans/tier1_plan.md` §6).

Verification: `npm run typecheck`; `npm test` (67 tests) — offline tests, live gate
only when `SKEIN_LIVE=true`.

**Deferred (backlog):**

- **Stable projection prefix (prompt cache).** The `skein-plugin` bench (`bench/`)
  showed the provider caches only the system prefix (exactly 1664 tokens per call)
  while the projection is never cached: its stable prefix ends at
  `goal`/`constraints`, immediately followed by the volatile `frontier`.
  Optimization (volatile to the tail, settled facts and the file index append-only
  at the front, bounded growth) is deferred as premature; it needs a separate study.

## 5. Boundaries

Deliberately out of scope for the current stages: AST/symbol table, embeddings,
CSP/arithmetic, UI, multilinguality, multiple LLM providers.

## 6. Open questions

- Proposal validation: strict zod contract vs a lenient JSON fallback (as in
  Ankyra `llm/structured.py`).
- `payload` shape for `finish`/`run`: free text vs a typed predicate.
- Cache: only the header (goal + constraints) is stable; the frontier changes
  every turn.
