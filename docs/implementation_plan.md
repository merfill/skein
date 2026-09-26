# Skein — overall implementation plan

Concept — `docs/concepts.md`. Conceptual frame — doxa/logos in
`ankyra/docs/doxa_and_logos.tex` and `ankyra/docs/concepts_ru.md`. Detailed spec
of the current stage — `docs/tier0_plan.md`. This document is the overall plan,
decisions, roadmap, and status.

## 1. Essence

Skein is a coding agent whose context is a **projection of the IR**, not a message
tape. The LLM is doxa: it only proposes (`status=open`). The deterministic engine
and the witness are logos: they decide. The event journal and the projection
function are the protocol.

## 2. Fixed decisions

| Decision | Choice |
|---|---|
| Language | TypeScript (Node 22, ESM), package manager npm |
| State model | hybrid graph `work` + `artifact`, append-only journal + deterministic projection |
| Code non-monotonicity | staleness by version (file hash), no manual retraction |
| First slice | bugfix by a failing test; witness is the test runner |
| Orchestration | LangGraph.js (`@langchain/langgraph`) |
| LLM | as in Ankyra: OpenAI-compatible endpoint, **reasoning disabled** (`thinking.type=disabled`, `reasoning.effort=none`); secrets only in `.env` |
| Witness | objective (test runner) plus subjective (user/acceptance) |

## 3. Roadmap

**Tier 0 — bugfix by a failing test (done).**
Closed loop `goal → locate → claim → action → check → done`; IR and projection;
staleness; objective witness. Details — `docs/tier0_plan.md`.

**Tier 1 — working on a task.**
- `Decision` as first-class: choice, rejected alternatives, rationale.
- `Check`/witness as an explicit node with an objective verdict.
- Subgoals and their decomposition.

**Tier 2 — non-monotonic knowledge.**
- Statuses `superseded`/`refuted`, specificity, `Revision` as a record.

**Tier 3 — doxastic operators.**
- `analogy`, `intuition` — asking the LLM for the non-derivable, as explicit
  operators.

**Immediate next steps.**
1. Tighten classification: a constraint must forbid a `run` (shell) workaround,
   not only `edit`.
2. Long-horizon tasks where the projection should give an advantage
   (multi-file edits, 50+ turns).
3. Compare Skein vs opencode vs a monotonic agent on the same tasks.

## 4. Current status

Tier 0 is implemented (steps 1–5 of `docs/tier0_plan.md` §11): `src/ir`,
`src/config`, `src/llm`, `src/tools`, `src/loop`, three fixtures, offline and live
gates. Full status and deliberate simplifications — `docs/tier0_plan.md` §13.

Verification: `npm run typecheck`; `npm test` — offline tests, live gate only when
`SKEIN_LIVE=true`.

## 5. Boundaries

Deliberately out of scope for the current stages: AST/symbol table, embeddings,
CSP/arithmetic, UI, multilinguality, multiple LLM providers.

## 6. Open questions

- Constraint workaround through `run` (see immediate next steps).
- Proposal validation: strict zod contract vs a lenient JSON fallback (as in
  Ankyra `llm/structured.py`).
- `payload` shape for `finish`/`run`: free text vs a typed predicate.
- Cache: only the header (goal + constraints) is stable; the frontier changes
  every turn.
