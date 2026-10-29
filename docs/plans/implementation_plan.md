# Skein — overall implementation plan

Concept — `docs/concepts.md`. Conceptual frame — doxa/logos in
`ankyra/docs/doxa_and_logos.tex` and `ankyra/docs/concepts_ru.md`. Detailed spec
of the current stage — `docs/plans/archive/tier0_plan.md`. This document is the overall plan,
decisions, roadmap, and status.

## 1. Essence

Skein is a coding agent whose context is a **projection of the IR**, not a message
tape. The LLM is doxa: it only proposes (a goal enters `open`). The deterministic
engine (logos) decides. The user or the harness issues the first request and accepts
the final result from outside; there is no separate arbiter role in the loop. The
event journal and the projection function are the protocol.

## 2. Fixed decisions

| Decision | Choice |
|---|---|
| Language | TypeScript (Node 22, ESM), package manager npm |
| State model | hybrid graph `work` + `artifact`, append-only journal + deterministic projection |
| Code non-monotonicity | staleness by version (file hash), no manual retraction |
| First slice | bugfix by a failing test; the criterion is the test command |
| Orchestration | LangGraph.js (`@langchain/langgraph`) |
| LLM | as in Ankyra: OpenAI-compatible endpoint; model layer — the Vercel AI SDK (`@ai-sdk/openai-compatible`); reasoning on (default effort `low`; hard tasks `high` per run); secrets only in `.env` |
| Criterion | a goal's `done_when` is a literal command; its `exitCode` (0 = pass) is the only pass/fail fact |
| Closure | a frame closes only by the doxa's `stop` (for now accepted only once the criterion passed); a request ends when its goal is stopped |
| Architecture criterion | **controllability**: a state and its boundaries are observable, so deterministic algorithms apply to the structure; the turn cost is an accepted price, not a reason to change the projection |

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

**Tier 4 — controllability and sessions (strategic direction; order — 4b first, then 4a).**

The value of the projection is not the turn count but **observability**: the engine knows a
state and its boundaries, so algorithms that a monotone tape cannot cheaply support apply to
the structure. Both directions share one mechanism — the **meta-unit**: the same IR, its own
state vocabulary, read-only outline tools, and operations that logos checks and applies. The
mechanism is built once and instantiated twice: the session agent and the tape/IR agent.

- **4b — session and session agent (first).** Develops `docs/session_concepts.md`: a container
  of units (the session journal, `focus`, `pending`), two independent statuses (unit
  open/closed vs `active`/`suspended`/`abandoned`/`completed`), a meta-unit with the
  `respond`/`resume`/`revise`/`redirect`/`cancel`/`query` operations, and a deterministic
  hierarchical outline L0–L4. The difference from a monotone tape: a request is a first-class
  addressable unit, and the session agent enumerates/locates past requests **structurally**
  (outline, `recall` by id), without similarity/RAG. The session agent does not edit task
  trees — it only proposes operations; logos checks the preconditions. Invariants: nothing is
  deleted or compressed into a summary-truth; no verdicts or stored statuses. Minimal slice —
  `docs/session_concepts.md` §10.
- **4a — triggers and the tape/IR agent (second).** The engine deterministically notices an
  event in the structure (a repeated `action→observation` over unchanged material, a repeated
  state chain through `move` edges, stagnation, a premature `stop`, budget burn, etc.) and
  emits a **trigger**; the tape/IR agent with read-only outline tools decides what to do and
  proposes an action; logos checks and applies. A trigger is an observation, not a verdict.
  The list of triggers, the agent's tools and the reactions are open; they get a dedicated
  document, `docs/controllability.md` (RU: `docs/controllability_ru.md`). This lifts the deferred cycle/premature-stop
  detection without turning it into a hard gate.

**Why this order.** 4b gives something to touch by hand (dialogue continuity, addressable past
requests) and builds the meta-unit; 4a reuses the same mechanism and adds triggers/tools. The
semantics of triggers is discussed separately, in its own document.

## 4. Current status

> **Brought to the IR semantics.** The code follows `docs/ir_semantics.md`: the old
> model (`claim`/`decision`/`subgoal`, status fields, `mode`) is replaced by the
> operator model (`create_goal`/`apply`/`stop`, plus read-only `recall`/`search`) and derived
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
  (`docs/plans/archive/observation_plan.md`, `docs/plans/archive/watcher_plan.md`).
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
  goal along path edges; the unreachable stays retrievable through `recall`
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
  (`src/llm/structured.ts`) binds them (no forced `tool_choice`, like opencode), maps the call to
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

- **IR revision folded (shape, operations, context; done).** The `item` node replaced the
  `alternatives` container; relations renamed (`goal`/`unactionable`/`plan`/`stop`/`items`/
  `alts`/`result`/`mutates`); `stop` is a relation on the goal (not a plan item);
  `create_goal` runs its first command at once; `apply` places a command by the outcome of the
  current item, and a command's non-execution is an observation with a reason (not a
  node-less refusal); the context is a **message tape** rebuilt from the tree. Spec —
  `docs/ir_semantics.md`; rollout — `docs/plans/archive/ir_revision_implementation_plan.md`. The
  earlier shape statements in this section are history.

- **Model layer on the Vercel AI SDK + streaming (2026-10-17, done).** `src/llm/client.ts` —
  `createOpenAICompatible`; `buildMessages` → AI SDK `ModelMessage[]`; `invokeTools`/
  `invokeStructured` → `generateText`/`streamText`; tools — AI SDK `tool()` from the same zod
  schemas; reasoning and usage come from the SDK result. The old LangChain adapter
  (`src/llm/provider.ts`), the SSE parser and `onResponseBody` are gone; `@langchain/openai` is
  removed. `SKEIN_STREAMING` (default on) chooses `streamText` vs `generateText`;
  `SKEIN_REASONING_TAPE` still controls whether reasoning is shown on the tape. Tests/benches
  updated; plan/status — `docs/plans/ai_sdk_migration_plan.md`.
- **Literal Verification why + failed-attempt block (2026-10-17, done).** Verification's
  `stop.why` is a literal retelling of the error: the command, exit status, actual text; no code
  diagnosis and no "why the fix did not work". `Previous failed attempt` in the open Localization
  and Patch is built from the model's `why` of the failed Verification and the actual diff of the
  last Patch; the mechanical `lastFailingRun`/`git`/exit no longer leaks into the block. It says
  `has been reverted` and `Do not repeat this change`; a masked exit-0 with `stop.why` is also
  visible. Tests — `tests/revert.test.ts`, `tests/tape_render.test.ts`.
- **Verification → Patch + revert (2026-10-17, done).** `ISLANDS.verification.next` includes
  Patch: when the Localization coordinates still hold and only the change failed, the model may go
  straight back to Patch. `isFailedVerificationMove` reverts the failed Patch on both targets
  (`Patch`/`Localization`), so Patch starts from the pre-patch tree and with the block. Live:
  run5 of the final batch chose `verification → patch`, made one revert and fixed the tail; in
  separate stage samples the model more often chose Localization. Tests — `tests/revert.test.ts`.
- **Per-state hints (2026-10-17, done).** `Island.hint` per state + a shared closure tail:
  Orientation — `pwd`/build/check; Localization — sibling walkers; Patch — "only the named change
  / do not repeat the failed attempt"; Verification — pass/fail/environment; End — `stop` when the
  request is complete.
  `turnInstruction` no longer mixes states; tests — `tests/prompt.test.ts`,
  `docs/system_prompt.md`.
- **Final live batch (2026-10-17, done).** `fix-ocaml-gc --net on`, 5 parallel: **5/5
  `reward=1`**, 29–50 steps, **7.315₽** total (1.031–2.521₽ per run); 999,544 in (79.7% cache),
  47,325 out (28,462 reasoning). Tokens and analysis — `docs/benches/best_bench.md`.
- **Orientation result vs probe (2026-10-20, done).** One `fact:session`
  (`environment` + `material`) is recorded at request start. `material` is the workspace map:
  `root`, repo status, top-level entries/paths, file count; configs, build commands, extensions
  and build state are gone. Orientation renders `Workspace`; Localization/Research get the same
  map as `Orientation result` (Research also gets `Probe` with interpreters/tools); other states
  get `Probe` (environment) under its own heading. Orientation's goal is narrowed to the inputs
  and the acceptance declared by the request; if the map and request already name them, the first
  step can be `stop`.
- **Orientation across 13 tasks (2026-10-20, minimal).** Real task images: **13/13 closed
  Orientation in 3 turns** (request → `stop` → transition; one `password` took 4), with no
  material exploration and no errors. `fix-ocaml-gc`: 3 turns, ~6.4k in, 0.065₽ versus 6 turns /
  25.9k / 0.166₽ before. K=3 routes: password/cobol → Research, custom-memory/fix-git →
  Localization, git-leak → Research (3/3). Tests — `364 passed`, typecheck clean.
- **Localization/Patch alignment (2026-10-20).** Localization — the 29-turn criterion:
  target + coordinates/extent + siblings ruled out, **no** failing code/cause. Patch — as in the
  29-turn run (`439095b`, declared form); Verification was already that version. Probe rules:
  `repo: none` → no git, no build docs/configs, start from the named subsystem; "the tape already
  holds what you observed".
- **Full fix-ocaml (2026-10-20, live).** With failing code: 60 turns/7.61₽, wrong line, Patch-1
  21 + Patch-2 16. After alignment: reward=1, `stop=request_addressed`, **34 turns, 4.24₽**:
  Orientation 3/0.29, Localization 7/0.83, **Research 5/1.00 (extra step)**, Patch 10/1.22,
  Verification 8/0.79, End 1/0.10. The remaining gap to 29/1.684₽ is the extra Research: for a
  code defect the transition should be L→P; Research is for situations/new artifacts. Tests —
  `364 passed`, typecheck clean.
- **Localization → Patch (2026-10-20).** *(Superseded 2026-10-29 — see the corrective L↔R entry
  below.)* The late `L → R` edge is removed (`83243ae`):
  Localization again has a single transition — Patch. A dry rebuild of the transition from the
  34-turn run shows no Research; live K=3 — 3/3 `move patch`. Full `fix-ocaml-gc` K=1: reward=1,
  `request_addressed`, 34 turns, 5.23₽ — no Research; the remainder is Patch at 15 turns
  (re-deriving the cause, ~10k reasoning) and 2 turns on `.skein/checkpoints`; cache hit 81%.
- **Corrective L↔R edges (2026-10-29).** `Localization → Research` is back as a corrective edge
  (a wrong start classification, not a routine exit), with the symmetric `Research → Localization`;
  the in-state prompts are untouched (`next` and the transition rule only). Synthetic
  `tests/routing.test.ts`; live 3 tasks × K=3 (`fix-code`, `db-wal`, `log-summary`,
  `--turns 34/32/21`): 9/9 `reward=1`, the edges were never taken and the normal routes did not
  move. Trace: `bench/runs/prompt-tests/2026-10-29T08-12-37-edges-k3-full/`.

Verification: `npm run typecheck`; `SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'`
— offline tests; the live gate only when `SKEIN_LIVE=true` and with the owner's explicit
go-ahead.

**Deferred (backlog):**

- **Generation display/interrupt (streaming UX).** Streaming is in place as transport (above),
  but tokens are not surfaced: showing and interrupting the output needs the loop to consume
  consume the AI SDK `textStream`/`fullStream` at the loop level rather than only assembling the
  result. Deferred.
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
  criterion) — `docs/plans/archive/step_reduction_plan.md`.
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
CSP/arithmetic, UI, multilinguality, multiple LLM providers. The meta-unit (Tier 4) is the
same IR, not a subagent; similarity/RAG stays out of scope.

## 6. Open questions

- **Tier 4 (sessions and controllability).** Order — 4b → 4a. Session open questions —
  `docs/session_concepts.md` §8; triggers, the tape/IR agent's tools and the reactions —
  `docs/controllability.md`.
- Proposal validation: strict zod contract vs a lenient JSON fallback (as in
  Ankyra `llm/structured.py`).
- Stopping: whether the engine may run `done_when.command` itself once a plan is
  done, without a doxa turn (A5 in `docs/plans/archive/step_reduction_plan.md` §5).
- Cache: only the stable prefix (request + constraints) is cacheable; the
  projection's focus changes every turn (`docs/plans/archive/step_reduction_plan.md` §4).
- **A path outside the workspace in `write`/`read`/`edit` (2026-10-19).** Today `/tmp/...`
  is reinterpreted as `/app/tmp/...` (workspace-relative), and the model loses turns debugging
  the path: 3 of 4 db-wal Recovery runs. Principled fix: **reject** a path outside the
  workspace instead of normalizing it, and say in the tool contract that the path is
  workspace-relative.
- **The Research → Recovery handoff must carry the method (2026-10-19).** In db-wal `why` said
  "determine the byte-level transform" rather than "XOR 0x42, little-endian checksums"; Recovery
  re-derived it and got stuck on endianness (t18–t21, 4–12k chars). General rule: `stop.why`
  carries what the next state needs — the method/coordinates/check, not just the situation.
- **Localization loses the cross-state handoff (regression, 2026-10-15).** The real sandbox
  `fix-ocaml-gc --net on` (Phase-20 tape) failed — reward 0, `max_turns` 60: orientation closed
  on "layout known" and localization started with a causal goal ("find why the bootstrap
  crashes") with no pointer to `runtime/shared_heap.c`, then went into `major_gc.c` / bootstrap
  debugging. The successful 2026-10-14 run (Phase 18, 29 turns, reward 1) chained via a **broad
  orientation goal** ("…locate the sweeping/free-space changes in the major GC…") and the move's
  **`note`** (the leaving state's summary → "…changes in `runtime/shared_heap.c`/`.h`"). Phase 20
  narrowed orientation to "layout" and dropped `note` from the move contract / B9, so the handoff
  is gone. Not yet fixed; options: (A) restore the `note` chain, (B) widen orientation to "where
  the change belongs", (C) make localization's first step "locate the touched files". Evidence:
  `docs/benches/best_bench_ru.md` (Фаза 20, Docker net on / virtual spec).
  **Update 2026-10-17:** the final `fix-ocaml-gc --net on` batch is 5/5
  (`docs/benches/best_bench.md`); per-state hints, the literal `why` and the
  `Previous failed attempt` block in Patch made the handoff work in this series. The question is
  kept as history and for a K>5 check.
