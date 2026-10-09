# Skein — overall implementation plan

Concept — `docs/concepts.md`. Conceptual frame — doxa/logos in
`ankyra/docs/doxa_and_logos.tex` and `ankyra/docs/concepts_ru.md`. Detailed spec
of the current stage — `docs/plans/archive/tier0_plan.md`. This document is the overall plan,
decisions, roadmap, and status.

## 1. Essence

Skein is a coding agent whose context is a **projection of the IR**, not a message
tape. The LLM is doxa: it only proposes (a goal enters `open`). The deterministic
engine (logos) decides; the arbiter is a boundary authority (the first request, the
final acceptance of the request), not a per-goal actor. The event journal and the
projection function are the protocol.

## 2. Fixed decisions

| Decision | Choice |
|---|---|
| Language | TypeScript (Node 22, ESM), package manager npm |
| State model | hybrid graph `work` + `artifact`, append-only journal + deterministic projection |
| Code non-monotonicity | staleness by version (file hash), no manual retraction |
| First slice | bugfix by a failing test; the criterion is the test command |
| Orchestration | LangGraph.js (`@langchain/langgraph`) |
| LLM | as in Ankyra: OpenAI-compatible endpoint, reasoning on (default effort `low`; hard tasks `high` per run); secrets only in `.env` |
| Criterion | a goal's `done_when` is a literal command; its `exitCode` (0 = pass) is the only pass/fail fact |
| Closure | a frame closes only by the doxa's `stop` (for now accepted only once the criterion passed); a request ends when its goal is stopped |

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

**Tier 2 — non-monotonic knowledge (reframed by the IR semantics; mostly delivered).**
- Non-monotonicity is **derived**, not stored: `refuted`/`abandoned` predicates and
  `alternatives`+`chosen` are computed by `fold`, and a step's revision history is
  shown in the projection (`docs/ir.md` §4, §7). This replaced the old
  statuses/`Revision`-record frame.
- The earlier roadmap (modes, `W` gate, `cited`, `frontier.revisions`) was superseded
  by the semantics migration — `docs/plans/archive/logos_roadmap_plan.md` is kept as history.
- Still deferred: staleness precision (R3b) — narrow the witness to a dependency
  closure; today it is the whole workspace (`SKIP_DIRS`).

**Tier 3 — doxastic operators.**
- `analogy`, `intuition` — asking the LLM for the non-derivable, as explicit
  operators. Not started.

**Immediate next steps.**
1. Tighten classification: a constraint must forbid a `run` (shell) workaround,
   not only `edit`. **Done** — effect guard: `edit` is checked in `classify`; a
   `run` that changes a forbidden file is reverted and recorded as a violation
   (`docs/plans/archive/constraint_guard_plan.md`).
2. Long-horizon tasks where the projection should give an advantage
   (multi-file edits, 50+ turns).
3. Compare Skein vs opencode vs a monotonic agent on the same tasks. **Started** — the
   first matched run (3 long terminal-bench tasks, k = 3, reasoning `high` both) is in
   `docs/benches/bench_report.md` §4.4, and the first pass of the **local sandbox** (§4.8)
   runs all thirteen tasks without Harbor (`docs/testing.md` §3.6).
4. **Comparative testing (next).** Re-run the sandbox on the same tasks at reasoning `high`
   (to match Harbor), k = 3, and compare per task: turns, LLM calls, tool calls and their
   breakdown, tokens (`in`/`out`/cache/reasoning) and cost — against opencode. A matched
   opencode sandbox backend is the prerequisite (opencode runs only through Harbor today).
   The premature `stop` on `fix-ocaml-gc`/`custom-memory-heap-crash` was fixed by the
   stop-closure refactor (§4); re-check their accuracy numbers after the next run.

## 4. Current status

> **Brought to the IR semantics.** The code follows `docs/ir_semantics.md`: the old
> model (`claim`/`decision`/`subgoal`, status fields, `mode`) is replaced by the
> operator model (`create_goal`/`apply`/`stop`, plus read-only `query`) and derived
> state. Plan and status — `docs/plans/archive/ir_semantics_migration_plan.md`; the
> as-built — `docs/ir.md`. The Tier 0/Tier 1 line below is history.

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
- **Breadth run (2026-10-08)** — the ten other terminal-bench tasks, online, `low`, k=2
  (`bench/harbor/skein-unrun.template.yaml`): every attempt that reached the agent solved
  its task (13/13); `fix-code-vulnerability`/`git-leak-recovery` were lost to Docker image
  pulls. Blocker fixed first: `invokeTools` now raises the completion cap on a truncated
  response (`finish_reason: "length"`) instead of ending the run with `llm_error`
  (`docs/benches/bench_report.md` §4.7).
- **Stop closure (2026-10-09, done)** — a frame (goal or request) closes **only** by the
  doxa's `stop`; a criterion run is an ordinary `observation` carrying `target`+`exitCode`;
  the `check`/`verdict`/`under`/`arbiter` machinery is removed. The `stop` gate: on a goal,
  accepted iff its criterion passed or its plan is exhausted (a give-up); on the request,
  iff its chosen interpretation is settled or stopped. This removes the premature-stop
  defect on `fix-ocaml-gc`. Spec and example — `docs/ir_semantics.md` §4.3,
  `docs/walkthrough.md`; plan — `docs/plans/archive/stop_closure_plan.md`.
- **Request→goal refactor (2026-10-09, done)** — a `request` is interpreted exactly once
  as a `goal` via `has_goal` (the interpretation is fixed) or declined (`no_goal` →
  `unactionable`); the `chosen` edge is gone. `stop` operates only on a goal: it appends a
  `stop` node as the goal's **last plan item** plus a `has_stopped` edge, and (for now) is
  accepted only once the criterion passed (positive stops only; a give-up is deferred). A
  request has no `stop`; it ends when its goal is stopped; `decline` is available only at a
  fresh request. Plan — `docs/plans/archive/request_goal_plan.md`.
- **Long-task fixes and the first clean close (2026-10-09).** Prompt: the repair routine
  builds first (B7) and B10 separates a wrong working directory from an unbuilt/unconfigured
  tree; the named-suspect trigger (B7/B16) and "a reference diff is a lead, not a checklist"
  (B9) cut the read loop. Engine: `invokeTools` bounds a completion truncation to one brevity
  retry (no cap doubling); a read thrash-guard refuses a third read of an unchanged file
  (`OP-AP-READ-6`). A build-heavy task declares its own `maxTurns` (`fix-ocaml-gc`: 60,
  `tests/sandbox/task.ts`). Live re-run — `reward=1`, `stop=request_addressed` (the first
  positive close in the sandbox; it used all 60 turns). The transcript A/B was run and
  rejected. Details — `docs/benches/bench_report.md` §4.8; prompt — `docs/system_prompt.md`.

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
- **Reducing LLM turns.** The context-format A/B (JSON projection vs a role-tagged
  transcript) was run and the transcript was **provisionally rejected**: on `fix-ocaml-gc` it
  roughly doubled reasoning/cost (60.9k-token turns, ended `llm_error`), though it lifted the
  cache hit on short fixtures (90% vs ~55%) — and even on `fix-ocaml-gc` its cache was higher
  (63% vs 42–58%). The loss was a completion **truncation storm**, not the cache; that storm
  is now bounded (`invokeTools` retries once at the ceiling, no cap doubling), so the format
  should be re-run (details — `docs/benches/bench_report.md` §4.8). Meanwhile a named-suspect
  prompt trigger pushes the edit, and a read thrash-guard refuses a third read of an unchanged
  file. Still open: logos closure (a passing objective check verifies ancestors with the same
  criterion) — `docs/plans/step_reduction_plan.md`.
- **Long builds vs the turn budget (next study).** A build-heavy criterion (`fix-ocaml-gc`
  rebuilds the whole OCaml compiler) costs turns even when the fix is right: after the edit
  the agent starts a background `run {background: true}` and each `poll` is a separate doxa
  turn (a live run polled 8× while the build still ran, then ran the criterion early →
  `exitCode 2`). Declaring `maxTurns: 60` on the task (`tests/sandbox/task.ts`) made the run
  close positively (`reward=1`, `stop=request_addressed`) — but it used all 60 turns (edit
  t25, green criterion t58), so that is a ceiling, not headroom. Study: (a) a command
  `timeout` / a wired `runTimeoutMs` for a long **foreground** build (the setting exists but
  is never passed to the workspace — `docs/tools.md` §4.7 is inaccurate), and/or (b) cheaper
  polling (do not spend a doxa turn on a still-running job); measure turns and cost. Evidence
  — `docs/benches/bench_report.md` §4.8, `docs/testing.md` §3.6.
- **~~Terminate arbiter goals / stop the refused-`stop` loop.~~ Resolved (2026-10-09)** by
  the stop-closure refactor: there are no `arbiter` goals; every goal carries a command
  criterion, and a request ends by its own `stop` gated by the criterion fact (or a
  stopped interpretation), so an autonomous run no longer retries `stop` until `maxTurns`.
  Still open from that item: cut the `invokeTools` repair resends and allow batching — the
  other call-count drivers (`bench_report.md` §4.4.2).

## 5. Boundaries

Deliberately out of scope for the current stages: AST/symbol table, embeddings,
CSP/arithmetic, UI, multilinguality, multiple LLM providers.

## 6. Open questions

- Proposal validation: strict zod contract vs a lenient JSON fallback (as in
  Ankyra `llm/structured.py`).
- Stopping: whether the engine may run `done_when.command` itself once a plan is
  done, without a doxa turn (A5 in `docs/plans/step_reduction_plan.md` §5).
- Cache: only the stable prefix (request + constraints) is cacheable; the
  projection's focus changes every turn (`docs/plans/step_reduction_plan.md` §4).
