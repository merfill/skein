# Skein — overall implementation plan

Concept — `docs/concepts.md`. Conceptual frame — doxa/logos in
`ankyra/docs/doxa_and_logos.tex` and `ankyra/docs/concepts_ru.md`. Detailed spec
of the current stage — `docs/plans/archive/tier0_plan.md`. This document is the overall plan,
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
| LLM | as in Ankyra: OpenAI-compatible endpoint, reasoning on (default effort `low`; hard tasks `high` per run); secrets only in `.env` |
| Arbiter | objective (test runner) plus `arbiter` (user/acceptance) |

## 3. Roadmap

**Tier 0 — bugfix by a failing test (done).**
Closed loop `goal → locate → claim → action → check → done`; IR and projection;
staleness; objective arbiter. Details — `docs/plans/archive/tier0_plan.md`.

**Tier 1 — working on a task (done).**
- `Decision` as first-class: choice, rejected alternatives, rationale.
- `Check`/arbiter as an explicit node with an objective verdict.
- Subgoals and their decomposition.
- Path-based relevance: reachability from the goal through decision/action edges
  (C2).
  Details and order of work — `docs/plans/archive/tier1_plan.md`.

**Tier 2 — non-monotonic knowledge.**
- Statuses `superseded`/`refuted`, specificity, `Revision` as a record.
- Staleness precision (R3b): scope the witness to a dependency closure, via each
  ecosystem's tooling; deferred from Tier 1 (`docs/plans/archive/tier1_plan.md` §7).

**Tier 3 — doxastic operators.**
- `analogy`, `intuition` — asking the LLM for the non-derivable, as explicit
  operators.

**Immediate next steps.**
1. Tighten classification: a constraint must forbid a `run` (shell) workaround,
   not only `edit`. **Done** — effect guard: `edit` is checked in `classify`; a
   `run` that changes a forbidden file is reverted and recorded as a violation
   (`docs/plans/archive/constraint_guard_plan.md`).
2. Long-horizon tasks where the projection should give an advantage
   (multi-file edits, 50+ turns).
3. Compare Skein vs opencode vs a monotonic agent on the same tasks. **Started** —
   the first matched run (3 long terminal-bench tasks, k = 3, reasoning `high` both)
   is in `docs/benches/bench_report.md` §4.4: parity on `fix-ocaml-gc`, no aggregate accuracy
   gain, and the per-call context saving is offset by more calls and a worse cache.

## 4. Current status

Tier 0 is implemented (steps 1–5 of `docs/plans/archive/tier0_plan.md` §11): `src/ir`,
`src/config`, `src/llm`, `src/tools`, `src/loop`, three fixtures, offline and live
gates. Full status and deliberate simplifications — `docs/plans/archive/tier0_plan.md` §13.

Beyond Tier 0, the current line adds:

- **First principle** — every event is knowledge obtained from experience and
  traces to a source (`docs/concepts.md`).
- **Check soundness** — a check carries a witness; a later change stales it and
  the claim moves to `frontier.invalidated`
  (`docs/plans/archive/check_soundness_plan.md`).
- **Observation of change** — `run` records a `mutate` per changed file; the
  engine reconciles active `ref`s before each projection, with a signature cache;
  `fs.watch` is left for a future streaming mode
  (`docs/plans/observation_plan.md`, `docs/plans/archive/watcher_plan.md`).
- **Rejection recording** — a refused proposal is recorded as a
  `record_rejection` event and shown under `frontier.refusals`, so it survives
  tail eviction and replay (`docs/plans/archive/rejection_plan.md`).
- **Context budget** — `index` is a bounded summary (counts + newest window) under
  the addressability contract; the turn budget is shown in `header.budget`
  (`docs/plans/archive/index_budget_plan.md`).
- **Arbiter (user acceptance)** — `userAcceptance` records a user check
  (`actor: "user"`), so non-code work can reach a settled state
  (`docs/plans/archive/user_approval_plan.md`).
- **Staleness scope** — transitivity is covered by a workspace-wide witness; the
  witness now lives once, on the observation
  (`docs/plans/archive/staleness_scope_plan.md`).
- **Work graph (T1.1)** — `decompose`/`decide` produce subgoals, decisions, and
  connecting edges (`decomposes`/`justifies`/`chosen_over`/`supports`) with
  `provenance.llm`; attachment to a parent is mandatory (the `classify` gate);
  `superseded`/`achieved` statuses are derived; the projection shows subgoals and
  links (`docs/plans/archive/tier1_plan.md`).
- **Path-based relevance (T1.2)** — `frontier` is the reachable closure from the
  goal along path edges; the unreachable stays retrievable through `query`
  (`docs/plans/archive/tier1_plan.md` §5).
- **Explicit check node (T1.3)** — `record_check` materializes a `check` node
  (command, verdict, witness, `actor`) and a `verifies` `check → claim` edge;
  `query {verdictOf}` reads the node (`docs/plans/archive/tier1_plan.md` §6).
- **fix-ocaml-gc acceptance (2026-10-06)** — the long terminal-bench task is solved
  (**reward 1.0**, `40 tests passed`) on Flash + reasoning `high`. The engine fixes
  (focus under a closed ancestor, crash diagnostics, projection retention, background
  `run`, removal of `need`) — `docs/benches/engine_fixes_found.md`; the run report —
  `docs/benches/fix_ocaml_gc_run_report_2026-10-06.md`.
- **IR operations reference & coverage** — every tree operator is specified with a
  stable ID in `docs/ir_operations.md` (+`_ru`); offline tests grouped by operator
  (`tests/ops/`), property tests over 400 random legal trees, a coverage gate
  (`tests/coverage.test.ts`), and live step tests (`tests/live/ir_operations_step.test.ts`).
- **Native tool calls (structured output)** — the agent proposes through flat function
  tools generated from zod (`src/llm/tools.ts`); `invokeTools`
  (`src/llm/structured.ts`) binds them with `tool_choice: "required"`, maps the call to
  the IR `Action` and repairs one malformed/missing call. The JSON-schema-in-prompt path
  (`invokeStructured`) stays a generic fallback. This replaced the single nested
  discriminated union, which inflated reasoning and tripped the completion cap on hard
  turns (`docs/testing.md` §8.1; `docs/benches/bench_report.md` §4.4). Added the `write` tool
  (`docs/ir_operations.md` §2.2.6).
- **Model comparison (DeepSeek vs Qwen)** — `qwen3-30b-a3b-instruct-2507` fails the
  synthetic set (0/4) and costs more than the current DeepSeek; staying on
  `~deepseek/deepseek-v4-flash-latest`.
- **System prompt revision (done)** — behavior blocks plus `docs/system_prompt.md`, the
  `apply` drift removed, a VCS policy and an external reference, the `fetch`/`apply_patch`
  tools, the out-of-workspace path guard, and a controlled experiment (§4.5 in
  `docs/benches/bench_report.md`). Outcome — `docs/plans/archive/system_prompt_revision_plan.md`.

Verification: `npm run typecheck`; `SKEIN_LIVE=false npx vitest run` — offline tests,
live gate only when `SKEIN_LIVE=true`.

**Deferred (backlog):**

- **Possible tools.** `write` is done. Still candidates, by size of the gap: `edit` by
  range / `multiedit` (find/replace breaks on ambiguous or duplicated fragments);
  `web_fetch` (docs, error analysis — currently reachable through `run`/`curl`, so low
  priority); LSP `symbol` (definition/references/rename). Non-goals stay: VCS, a `todo`
  tool (the plan lives in the IR), browser/screenshots, subagents, MCP (`docs/tools.md` §8).
- **Exercise `write` live.** No live scenario creates a file: the two "creation-looking"
  fixtures (`command-from-package`, `make-command`) already ship `package.json`/`Makefile`,
  so the model reads the command instead of writing. Add a fixture whose README requires
  creating a file (e.g. a missing `package.json`), then run it
  (`SKEIN_SCENARIOS=<name> SKEIN_LIVE=true npx vitest run tests/live/scenarios.test.ts`).
  `write` is covered offline today (`tests/ops/apply.test.ts`, `OP-AP-WRITE-1..5`).
- **Stable projection prefix (prompt cache).** The `skein-plugin` bench (`bench/`)
  showed the provider caches only the system prefix (exactly 1664 tokens per call)
  while the projection is never cached: its stable prefix ends at
  `goal`/`constraints`, immediately followed by the volatile `frontier`.
  Optimization (volatile to the tail, settled facts and the file index append-only
  at the front, bounded growth) is deferred as premature; it needs a separate study.
- **Reducing LLM turns.** Logos closure (a passing objective check verifies ancestors
  with the same criterion) and a separate context-format A/B (JSON projection vs a
  transcript with assistant/tool roles) — `docs/plans/step_reduction_plan.md`.

## 5. Boundaries

Deliberately out of scope for the current stages: AST/symbol table, embeddings,
CSP/arithmetic, UI, multilinguality, multiple LLM providers.

## 6. Open questions

- Proposal validation: strict zod contract vs a lenient JSON fallback (as in
  Ankyra `llm/structured.py`).
- `payload` shape for `finish`/`run`: free text vs a typed predicate.
- Cache: only the header (goal + constraints) is stable; the frontier changes
  every turn.
