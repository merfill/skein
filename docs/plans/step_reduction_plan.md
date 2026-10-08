# Skein — plan for reducing LLM turns and the context format

> English mirror of `docs/plans/step_reduction_plan_ru.md`.
> Basis — the `ref-localize` run analysis (`docs/benches/bench_report.md` §4.5) and the
> doxa/logos principle discussion. Touches `docs/ir.md`, `docs/system_prompt.md`.

## 1. Cost methodology

Doxa turns and logos operations must not be conflated:

- **LLM turn** (a doxa call) is the only cost: tokens, cache, latency.
- **IR operation** (close a goal, add `verifies`, advance the plan cursor, return focus,
  mark `addressed`) is deterministic and **free**.

Counting IR operations as "steps" is a methodological error. In the current code
`create_goal`/`complete`/`query`/`run target` are implemented as doxa turns, so they
*currently* cost; logically they are logos work the engine must do itself.

**Metrics:** LLM turns; input/output tokens; cache%; `reasoning_tokens` per turn
(a signal of extra deliberation); wall-time. Reward is the control invariant.

`ref-localize` data (§4.5): Skein's useful work ≈ 5.75 actions vs opencode's 5.7; the
whole gap (≈6.25 "steps") is overhead turns duplicating logos work. Each turn carries
~7.2k tokens of constant (system 19,227 chars + tools 9,161 chars).

## 2. Principle

> Doxa proposes **one operator per turn**; the engine applies a **deterministic closure
> of the tree to a fixpoint**. The number of IR operations in that closure is
> unbounded. Every closed goal carries check provenance (the "no verified without check
> provenance" invariant).

Boundary: an **objective** goal is settled by the check verdict (logos); an **arbiter**
goal only by external acceptance; running a command (a side effect) is initiated by
doxa. Doxa does not close goals (`complete` is removed, A2).

## 3. Part A — logos closure (retired)

> **Retired** in `docs/plans/archive/plan_stepwise_redesign.md` (step 2.5, decision §3(a)): under
> strictly step-by-step traversal plan items are actions only, so nested objective chains
> with a shared criterion do not arise and `closeAncestors` becomes dead. The code was
> removed together with step 2.

**3.1 Semantics.** A passing objective check verifies the focus goal **and all its plan
ancestors** whose `done_when.command` matches, when all other items of their plans are
already successful. Provenance is that same check (same witness). Subjective goals are
untouched by closure.

**3.2 Implementation.** `src/ir/graph.ts`:
- a private `itemSettled(state, itemId)` — `goal` predicate `achieved`/`achieved_under`,
  `action` `executed`, honoring alternatives;
- `closeAncestors(state)` — BFS upward from the check's goals over plan containers; on a
  matching command and successful sibling items, add a `verifies` edge `chk→G`
  (id `${checkId}:c:${G}`) with the check's provenance, idempotently;
- in `fold`: `derivePredicates(state); closeAncestors(state); derivePredicates(state);`.

Why in `fold`: it is a pure function of the journal (determinism
`same events → same Context`); it covers any `record_check`, including `userAcceptance`;
the `achievedWithoutCheck` invariant sees the synthesized edges; the traversal
(`focusEvents`) cascades the focus up by itself and `progressNode` stops the loop — no
new doxa events needed.

**3.3 Prompt.** B7 (`src/loop/prompt/blocks.ts`): an interpretation with the same
criterion is closed by the engine automatically; a separate check is only for a
different criterion.

**3.4 Tests.** `tests/ops/derivation.test.ts` (positive; a different command —
negative; an unfulfilled item — negative; nesting; `under` → `achieved_under`).
`tests/ops/apply.test.ts` — integration: `create_goal` with a plan →
`complete(stage1)` → `check(stage2)` → root `achieved`, request `addressed`, no second
check. Live — existing scenarios + `achievedWithoutCheck`.

**3.5 Verification.** `npm run typecheck`; `SKEIN_LIVE=false npx vitest run`;
`SKEIN_LIVE=true npx vitest run tests/live/scenarios.test.ts`;
`SKEIN_CASES=fixtures/synthetic npx tsx bench/run.ts ref-localize-{on,off}`.

**3.6 Effect.** −1 turn per bug fix (the duplicate final check); fewer command runs and
full workspace hashes. Reward unchanged.

**Status:** implemented (engine + offline tests). Confirmed by a `ref-localize-on` run
(2026-10-07): `checks=1` instead of 2, `steps=10`, reward 1; closure edge
`chk:55→w:goal:2`, root `achieved`, request `addressed`. The §4.5 A/B re-run is pending.

### A2 — structural closure, dropping `complete` (core)

**Semantics.** A goal's state is derived from its subtree, not asserted by doxa:
- a goal with a plan is **fulfilled** iff **all** plan items are fulfilled;
- **refuted** if the subtree contains a `refuted` item not replaced by an alternative;
- a goal with an **empty plan** is fulfilled (vacuously; such goals must not be created);
- an objective goal follows its check verdict (as today);
- the `complete` operator is **removed**: doxa does not close goals.

**Implementation.** The structural rule in `goalPredicate` (`src/ir/graph.ts`); removing
`complete` from `schemas.ts`, `tools.ts`, `classify.ts`, `applicable`, B7 and from the
`latestComplete`/`closes` semantics; updating tests and docs.

**Effect.** −2 turns (the `reproduce`/`locate` stages are no longer closed by hand).

**Risk.** Core semantics; re-check invariants, ops tests, live scenarios.

**Status:** implemented. `done_when` = `objective` | `arbiter`; `complete`/`closes` are
removed from the types, schema, tools, classifier, `applicable`, projection and
`goalPredicate`; B3/B6/B7/B13 rewritten (a plan is actions + one objective goal).
Offline tests updated (240 passed). Live `ref-localize-on`: reward 1, `steps=9`, no
`complete`. A3 was done earlier; A4 (hypothesis + actions in one call) and A5 (auto-check)
remain.

### A3 — working set: keep the evidence

**Problem.** The diff body (479 chars) is evicted **not by size** but by scope:
`levelIds = current.branch` (`src/loop/graph.ts:130`) — a closed stage leaves the branch
and its body is dropped; the `calls` index keeps only a note clipped to **120** chars.

**Implementation.** Working-set scope = bodies under open goals on the path **plus bodies
of recently closed stages** (`HELD_TURNS = 6`); the `MAX_HELD = 5` / `HELD_CHARS = 16,000`
caps are unchanged. `callNote` (`src/ir/project.ts`) 120 → **512** chars.

**Effect.** −1 turn (`query`) in on/off.

### A4 — hypothesis + first actions in one call

**Idea.** `create_goal` carries the hypothesis and plan; the engine executes the first
action items in the same turn (instead of paying one turn for `create_goal` and then one
for `run`).

**Implementation.** Extending `create_goal`/`executeAction`; depends on A2 (action items
and structural closure).

**Effect.** The leading action items of a new plan are run by the engine in the same turn
(until the first goal; cap `AUTO_RUN_ACTIONS = 4`), so `create_goal` + the exploratory
commands are one call.

**Status: reverted.** The auto-run violates step-by-step (I4) and **created the funnel**
on the long tasks (`docs/benches/bench_report.md` §4.4, run `2026-10-07__16-42-30`: all 9 trials
`llm_error`): the plan was exhausted in the same turn, and for an `arbiter` goal with an
exhausted plan `applicable` offered only `create_goal` → nested goals. Reverted in
`docs/plans/archive/plan_stepwise_redesign.md` step 1 (`AUTO_RUN_ACTIONS` and the loop removed).
The historical metrics below are kept for context.

Historically (with A4): live `ref-localize-on`: **steps 5** (was 9), prompt 45.6k (was
77.5k), reward 1; `ref-localize-off`: **steps 5** (was 11.7), prompt 52.6k (was 120.7k),
reward 1. Online tests that assumed step-by-step execution were updated.

**A4 bug (fixed).** The auto-run of the leading action `node --test` matched the goal's
`done_when.command`, and the `run` branch **implicitly** promoted it to a check — the goal
was refuted at the reproduce step (runs `09:31`, `09:48`: `record_check` fail before the
fix). Fix: the verdict is produced **only by an explicit check on the goal**
(`run {target}`); a command match no longer promotes a run to a check
(`docs/plans/traversal_stack_spec.md` §9). Offline: 240 passed. The fix is **kept** after
the A4 revert — the verdict is always produced by an explicit check on the goal.

### A5 — auto-running the objective criterion (rejected)

The engine runs `done_when.command` itself once an objective goal's plan is done.
**Implemented and tested, then reverted.** Reason: `checkReady` fires **prematurely** — a
goal with an action-only plan is "done" as soon as the actions ran (including A4's auto
run), and the engine checks the criterion at once. On `ref-localize-on` this produced a
flood of refutations and one run hit `maxTurns` (24 steps, 14 goals); the rest took 7–8
instead of 5. The world/decision is logos's (as in A4), but the "plan done" trigger is too
coarse; it needs a signal that the work on the goal is actually finished, which the engine
lacks. Rejected; the A5 code was removed.

**Open (rephrased):** what counts as "a goal is ready to check" so the interpretation is
not refuted mid-step. A candidate: only an objective goal whose plan completed by a
**child check passing** (not by executing actions) — i.e. verification climbs the tree
instead of firing on "a plan of actions".

## 4. Part B — context format (last item)

**4.1 Problem.** Each turn sends a fresh `[system, user(JSON projection)]` +
`tool_choice: required` — **with no assistant/tool roles**. The model never sees its
prior call/result tape; the state is reconstructed from JSON. Hypotheses: (a) the
off-distribution format raises `reasoning_tokens`/turn; (b) there is no "tool result
follows tool call" prior → redundant re-checks; (c) only the system+tools prefix is
cached, the projection is not.

**4.2 Options for a familiar-history packaging.**
- **A (current):** `[system, user(JSON)]`.
- **B (transcript):** `[system, user(task), assistant(tool_call)/tool(result) × K,
  user(frontier)]` — a bounded projection rendered as an ordinary dialogue.
- **C (hybrid):** a compact JSON projection plus a short transcript window.

Renderers are pure functions of events (determinism preserved), the window K is bounded
(the context does not grow like a tape).

**4.2a Telemetry + A+ (stable prefix) — measured; A+ rejected.** Reasoning tokens were
not measured: `UsageLike` (`bench/metrics.ts`) read only input/output/cache. It now
captures `output_token_details.reasoning` (fallback
`response_metadata.usage.completion_tokens_details.reasoning_tokens`);
`TurnMeter`/`TurnRecord` carry `reasoningTokens`, the `bench/run.ts` and
`langgraph/graph.ts` `SKEIN_TURN`/`SKEIN_METRICS` lines include it, and
`bench/agents_compare.ts` prints `reason`.

A key-reordering "A+" was tried (stable fields before `state`/`cursor`/`chosen`, volatile
layers trailing, `calls` oldest-first) on `ref-localize-on`, n=3 each. It did **not** widen
the cacheable prefix: the average common serialization prefix between turns was ~30–40%
both ways. The live runs were worse — A: steps 7/7/7, `reason` 210/372/505, cache
84/83/73%; A+: steps 9/8/7, `reason` 712/752/429, cache 64/71/70%. Cause: `path` is first
and carries the volatile `state`/plan, so within-node key order cannot extend the prefix
(moving `lastResult` away from the top also seems to cost a turn). A+ was reverted;
**telemetry kept**. A genuine prefix needs a stable/volatile split (an immutable brief
before the focus) — folded into options B/C below.

**4.2b B (transcript) — prototype.** The transcript is the current branch, not the global
journal: `system`, an immutable brief (request + constraints), the branch's steps as
`assistant(call)/tool(result)` pairs in chronological order, and the volatile board last.
Short result bodies are inline; a long body stays addressable by id (`query`) — the
existing working-set/storage rule is unchanged. History is scoped to the chosen
interpretation, so a failed alternative's steps are not expanded — only its marker
(`refuted`/`abandoned` with `why`) shows in `path`; on a rollback the prefix before the
divergence node is unchanged and only the suffix is re-rendered. `assistant` carries the
tool call only (no `thought`, B.3). Selected with `SKEIN_CONTEXT_FORMAT=transcript`
(default `json`); the bench and live harness now measure the real prompt payload
(`promptText`). Guarded by `tests/prompt.test.ts` ("context format: transcript").

**4.3 A/B experiment.** Cases: `ref-localize-on` + one live scenario. Compare A/B(/C) by
LLM turns, input/output, cache%, `reasoning_tokens`/turn, reward. Hypothesis: B lowers
reasoning/turn and raises cache% at equal reward.

**Metric caveat (for the full opencode comparison, deferred).** opencode reports reasoning
separately: its local JSON carries `tokens.reasoning` alongside `tokens.output`, and
`tokens.total = input + output + reasoning + cache.read`. The plugin's
`tools/measure.ts` sums only `tokens.output`, so the cached opencode `out` **excludes**
reasoning; Skein's LangChain `output_tokens` **includes** it. When comparing, sum
`tokens.reasoning` from the raw `opencode.txt` and compare reasoning↔reasoning (and never
`out`↔`out`). The full opencode runs on `ref-localize-on` and `multi-bug-calc` are
deferred.

**4.4 Decisions before implementing.** Window size K; generating tool messages and their
ids; relation to the "stable projection prefix" backlog item
(`docs/plans/implementation_plan.md` §4).

**Status:** telemetry implemented and used; A+ measured and rejected (reverted). B
(transcript) implemented behind `SKEIN_CONTEXT_FORMAT`; the live A/B (json vs transcript)
is pending. C remains.

## 5. Open questions

- **Resolved.** Doxa never closes a goal: an objective goal is settled by its check, an
  arbiter goal by external acceptance (A2); `complete` is removed.
- **Resolved.** A4 (hypothesis + first actions in one call) is **reverted**: it violates
  step-by-step and created the funnel (`docs/plans/archive/plan_stepwise_redesign.md` §1).
- **Open.** Auto-running `done_when.command` by the engine once the plan is done (A5):
  running a command is a side effect, so it must be decided whether that is allowed
  without a doxa turn.
- **Open.** The context format's effect on the stable prefix/cache (Part B).
- **Traversal spec:** `docs/plans/traversal_stack_spec{,_ru}.md` — spine and arms, plan
  revisions (append-only), projection, invariants; §9 — verification only by an explicit
  check.
