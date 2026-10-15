# Skein — state protocol plan (states as the skeleton of the walk)

> English mirror of `docs/plans/archive/state_protocol_plan_ru.md`.
> Status: **in progress — Phase 0 (freeze the concept).** The concept (§2–§4) and all open
> decisions (§13, incl. §4a) are **settled with the owner** (2026-10-13); the implementation
> ("how", §6–§7) is fixed accordingly. Phase 0 lands the decisions in the semantics and the
> operator registry before any code. This document is written to be self-contained: work can
> start from it after a context reset.

## 0. How to read this plan

The plan separates **concept** (settled: what the agent's walk *is*) from **how** (now fixed:
IR, traversal, prompt, migration). Read §1–§4a as binding, §6–§12 as the fixed design, §13 as
the resolved decisions, §14 as the cost. Nothing here is open any more; a future change goes
through the normal semantics-first path.

## 1. Why — the evidence

Two live `fix-ocaml-gc` runs on the current (incremental) design, 2026-10-13:

| Branch | reward | stop | turns | cost | goals | states | transitions |
|---|---|---|---|---|---|---|---|
| net on | 1 | `request_addressed` | 55 | 31.0₽ | 1 | `[reconnaissance]` | 0 |
| net off | 1 | `request_addressed` | 42 | 12.6₽ | 1 | `[reconnaissance]` | 0 |

Both solved and closed cleanly, but **the state machine never ran**: after the opening
`create_goal` the doxa created **no** further goal and never changed state. Yet the trajectory
*had* the phases — a de-facto reconnaissance → localization → reference → patch → verification —
they were just never declared. The reasoning-token profile (net off) marks them:

- **t1–7 Reconnaissance** — reasoning ~0–45 (executing `ls`/`grep`/reads).
- **t8 Localization** — spike to 2843; the model *names the buggy line* (`p += Whsize_hd(hd)`
  is "dimensionally inconsistent"). The criterion is met at t8.
- **t14–19 build/repro "in pattern"** — reasoning 16–286 (pure execution).
- **t20–33 reference / re-derivation loop** — reasoning **40,306 tokens (58% of the run)** over
  14 turns with no edit; in the tail of t29: "I keep going back and forth." This is the
  Reference trap of `docs/prompt_state_machine_concept.md` §6.
- **t34 Patch commit** — the **largest** spike (8192, the output cap) and the first `edit`.
- **t39–41 Verification** — reasoning collapses (492 → 9 → 82).

So the walk happened, undeclared, and the miss cost ~40k reasoning tokens. Three structural
causes:

1. **State change is welded to sub-goal creation.** `create_goal { what, state, action }`
   requires a seed `action` and *descends* into a new goal — it reads as "split the task and
   lose focus", not "change phase". The model, already working in the current goal, avoids it.
2. **The transition is optional and invisible in the prompt.** `B7` lists `create_goal` as one
   of four equal options; the Localization relief says "move to Patch in the same move", which
   the model satisfies by a bare `edit`. The routes live only in the base block `B4`, far from
   the moment of decision.
3. **The request-level goal is vague and the world is flat.** "Close the whole task" is an
   abstract target; the model just works and stops. Sub-goals (the one mechanism for changing
   state) were never created in practice.

And two engine blind spots:

4. **The stall detector is blind to the loop.** `knowledgeKey` counts any new observation as
   progress, so the t20–33 re-derivation (new fetch attempts, new reads) kept `stall = 0` and
   the nudge never fired.
5. **The island instruction went stale.** Because the goal stayed `reconnaissance`, the model
   was told "Reconnaissance" while patching (t34–41) — so it learned to ignore the `State:`
   line.

## 2. The concept / model (settled)

A **hybrid of a finite automaton and a tree walk**:

- **States are the skeleton.** The islands are the automaton's states; a transition is a
  *move* to another state.
- **The tree is the stack of the walk.** The focus descends into a state's work and returns
  when it closes.
- **`move` and `create_goal` are two distinct moves.** `move { state }` decides *what to do*
  (the phase / kind of work). `create_goal { what, action }` then concretizes *how*: the
  concrete outcome and the first concrete step.
- **A goal is the work of one state, not of the whole request.** That is why it becomes
  concrete: the model closes a *state*, not an abstract task.
- **The goal is created for the declared state.** `create_goal` does not repeat `state`: after a
  `move`, the goal's `what` and `action` are the concrete work *of that state*, and the
  `create_goal` description says so explicitly. The engine records the goal as belonging to the
  state that governs it.
- **The plan is a flat list of concrete steps.** An alternative is another action: a failed
  step → try an alternative; a succeeded step that needs more → the next step. There are **no
  sub-goals inside a plan** (they never appeared in practice, and concrete steps suit the model
  better than abstract nested goals).
- **Closing a state is a decision point.** `stop` closes the state's goal; the engine returns
  to the point of transition and the model must decide: the terminal state (everything is
  done) or a new state.
- **There is a terminal state.** A finishing island everyone eventually moves to — the sign of
  the end. Reaching it and stopping completes the request.
- **The doxa decides everything semantic**: when a state's work is done (its criterion), which
  state is next (the transition), and what concrete step to take. The engine gates nothing by a
  criterion; it only reports tool results and shows what is possible now.

## 3. The walk / protocol (settled)

```
request ──move──▶ state ──create_goal──▶ goal ──apply/stop──▶ (steps)
                                           │
                              stop ◀───────┘  → back to the state
                                           │
                       decide: ──move──▶ next state  |  ──move──▶ terminal ──stop──▶ done
```

What the model may do at each point (the strict contract, §4):

| Focus | Admissible moves | Meaning |
|---|---|---|
| request (no goal) | `move { state }` or `decline` | choose the first state of the work |
| a `move` (state set, no goal) | `create_goal { what, action }` | concrete outcome + first step for this state |
| a state's goal (open) | `apply { … }` (a step), `stop` | do the work; `stop` closes the state |
| after `stop` (at the state) | `move { state }` | the forced transition decision (or the terminal) |
| the terminal state | `stop` | the request is complete |

Notes:
- The first move on a request is `move`, then `create_goal` as usual (the request has no goal
  of its own).
- A failed step is an alternative action of the same item; a succeeded step that needs more is
  the next item (the current `placeMove` rule, actions only).
- `recall`/`search` are read-only addresses, available throughout (not moves).

## 4. The action/observation contract (settled intent)

The prompt must state **strictly and per focus** what the model may decide *right after a tool
result*, instead of a general loop. Concretely: the projection renders the admissible moves for
the current focus (the `applicable` set, §6), not a one-size "SEARCH, then IMPLEMENT, then
VERIFY". After an observation the model chooses exactly one of:

- the next concrete step of the current state (`apply`);
- `stop`, which closes the current state and forces the transition decision;
- a read-only `recall`/`search` of a stored result.

`move` and `create_goal` appear only where the protocol admits them (at the request / at a
`move` / after a `stop`).

## 4a. The context of a finished state (compaction)

When a state's work is done and the model moves on, the **finished state's turns leave the
tape**: its `create_goal`, its `apply` calls and their observations are elided, and only a
**description** remains — what the state was and that it finished. This is the natural
generalization of today's rule "a closed goal contributes only its closure message" — a whole
state, not just a goal. It is what keeps a long walk bounded (the net-on run reached 135k chars
of context).

- **A projection rule, not a journal rewrite.** The journal stays append-only and keeps every
  event (for replay/analysis); `project` elides the subtree of a finished state and emits one
  description line. Determinism is preserved (`project` stays a pure function of the events).
- **`move` returns the description.** When the model `move`s to the next state, the engine emits
  the traversal `return` out of the finished state, and the `move` result carries the
  description of the state it left: `State <label>: finished — <summary>`. The model sees a
  compact "what happened" instead of the raw turns.
- **The summary's content (settled).** An engine-derived base (the state, the `stop` reason,
  the files mutated) **plus** an optional one-line `note` the model passes on `move`; the
  `note`, when present, is appended to / overrides the base. Recommended at §13.
- **Retrievability (settled).** The loss is accepted, as with a closed goal's internals today.
  Once a state's turns are elided their ids are gone from the tape, so a `recall` of an elided
  result is impossible; if a later state needs a fact, the summary (or a kept pointer) carries
  it.

## 5. Impact map (what this touches)

- **IR / types** — a new `move` node kind and its edge; `GoalPayload.state` removed; item
  alternatives can no longer be goals.
- **Schemas / tools** — a new `move` operator and native tool; `create_goal` loses `state`.
- **Traversal** — `focusEvents`, `itemFulfilled`, `firstUnfulfilledItem`, `applicable`,
  `currentGoalId` (a state node joins the walk).
- **classify** — the structural gates for `move`; `create_goal` only at a `move`.
- **execute** — `buildGoal` without state; a `move` case; `placeMove` (actions only).
- **projection** — `islandOf` from the state node; the tape renders `move`/`create_goal` pairs;
  the per-focus admissible set.
- **prompt** — the strict action/observation contract; the walk; the terminal island.
- **islands** — the terminal island as a plain sentence; a possible `next` reframing.
- **tests** — everywhere (`tests/ops`, `tests/loop.test.ts`, projection/tape, prompt,
  `tests/coverage.test.ts` IDs, live steps).
- **docs** — `ir_semantics{,_ru}`, `ir_operations{,_ru}`, `ir{,_ru}`, `system_prompt{,_ru}`,
  `walkthrough{,_ru}`, `concepts{,_ru}`, `projection{,_ru}`, `prompt_state_machine_concept{,_ru}`.

## 6. IR design (settled)

The shape (all decisions resolved, §13):

1. **A `move` node.** Add `"move"` to `WORK_KINDS` (`src/ir/types.ts`); payload `{ state:
   IslandId }`. It is a real tree node so: the tape shows the state change as an assistant
   move; `islandOf` reads it; the engine can count "turns since the last move".
2. **The state's goal hangs off the move.** `create_goal` at a `move` focus creates the `goal`
   under that move node (reuse the `goal` edge) and descends into it. The plan/items/actions
   are unchanged below the goal.
3. **The states are the request's children (flat).** Each new `move` after a `stop` is a new
   child of the request (a sibling of the previous state). Alternatives considered: a *chain*
   (each move under the previous) — rejected because the corrective cycles
   (verification→localization, env_triage) would deepen the tree without bound.
4. **`stop` returns to the state node.** On `stop`, the goal closes and the focus returns to
   its governing `move`; the state is finished; the model then emits the next `move` (or the
   terminal).
5. **`itemFulfilled` loses the goal case.** An item is fulfilled when its current alternative
   is a *succeeded action* only (no `goal` alternative).
6. **`islandOf` = the state of the focus's governing `move`** (the last one on the path, since
   the journal stays append-only; the state is derived, never rewritten).
7. **The terminal island.** Keep `handoff` as the terminal (no rename), rendered as **one
   sentence** (no `what`/`criterion`/`relief`/`next`), e.g. "End — move here to finish the
   work; stop here and the request is complete." The terminal needs **no goal of its own**: it
   accepts `stop` directly.
8. **`GoalPayload`** — drop `state`; keep `what`. `state` moves to the `move` node.
9. **`applicable`** — `request`: `{ move, decline }`; `move`: `{ create_goal }`; `goal`:
   `{ apply, stop }`; after `stop`/finished state: `{ move }`; terminal: `{ stop }`.
10. **Refusals / non-execution** — `move` while a goal is open, `create_goal` at a request
    (without a prior `move`), `apply` at a `move` (before its goal): classify with a reason
    (structural moves are refused without a node, as today). These are protocol errors, not
    criterion gates.

Open IR decisions are collected in §13.

## 7. Prompt design (proposed)

- **Base block** — the walk (§2–§3) and the terminal island; the islands with `What / Done
  when / Constraints` (keep today's shape) plus a local marker "criterion met → `stop` the
  state". The two live-tested levers stay: `B1` without the tape internals; the batch rule.
- **Per-focus admissible set** — render `applicable` (§4) so the model sees exactly what it may
  decide now, especially after an observation.
- **`move` tool** — "Declare the state you will work in: `move { state }`. To change phase,
  `move` again after closing the current state."
- **`create_goal` tool** — loses `state`, and its description says the goal is the **work of the
  state you just moved to**: "After a `move`, concretize *that state's* work: `what` (the
  concrete outcome for this state) and `action` (the first concrete step of this state)."
- **No sub-goals** — examples must not show a nested goal; a too-big step is more steps, or a
  more specific state.
- **Attractor** — a soft nudge when a state has not changed for N turns (now trivially
  measurable: turns since the last `move`), complementing the content-based stall.

## 8. Invariants (updated)

- A goal is closed only by the doxa's `stop`; there is no criterion gate.
- **A goal exists only inside a state (created after a `move`); the request has no goal.**
- **The request ends when the terminal state is closed (stopped).**
- `project` is deterministic: same events → same `Context`.
- The journal is append-only; the current state is derived from the last `move`.
- A `stale` fact is never shown as active content.
- **A finished state's turns are elided from the tape; the journal keeps them** (§4a — a
  projection rule, not a rewrite).
- doxa (the LLM) only proposes; logos decides (refusals and tool failures are the only facts
  the engine adds).
- Minimal diff per phase; docs first for each semantic step.

## 9. Relation to the working tree and existing plans

The working tree currently holds the (uncommitted) incremental changes from
`docs/plans/archive/state_transitions_plan.md`: the `no_current_item` engine fix, the prompt redesign
(`B1`/`B4`/island `What/Done/Constraints`/transitions/`create_goal` description), the
`Context.nudge`, the `OP-CG-5` tests, and `tests/live/state_transitions_step.test.ts`.

- The `no_current_item` fix and the goal-vs-plan machinery it touched become **moot** (states
  leave `create_goal`; sub-goals go away).
- The prompt redesign (per-state `What/Done/Constraints`, conditioned transitions, the nudge)
  **carries over in spirit** and is re-expressed in §7.
- `docs/plans/archive/state_transitions_plan{,_ru}.md` is **superseded** by this plan; keep it as a
  historical record (or fold its P1–P5 evidence into §1).

**(resolved)** The incremental work was **committed as a stepping stone** (`6af64b7`), not
reverted; the redesign builds on it on `main` (§13.9).

## 10. Implementation phases

Order per the repo rule (semantics → code → test). Each phase is one change, offline-verified.

- **Phase 0 — freeze the concept.** Land this plan (EN/RU); update `ir_semantics{,_ru}` §2.5–2.7,
  §4 and `ir_operations{,_ru}` (new `OP-MV`, `OP-CG` rewritten) to the new model **before**
  code, per `docs/plans/README`/AGENTS.
- **Phase 1 — IR types & events.** `move` node kind + payload; `GoalPayload` loses `state`;
  edge for move→goal (or reuse `goal`); events unchanged (add_node/add_edge/descend/return).
- **Phase 2 — traversal.** `currentGoalId`/`focusEvents` walk request→state→goal; `stop`
  returns to the state; `itemFulfilled` without goals; `applicable` per §6.9.
- **Phase 3 — schemas & tools.** `move` operator (`actionSchema`) + native tool
  (`PROPOSAL_TOOLS`); `create_goal` loses `state`; `executeAction` gains `case "move"` and
  `buildGoal` without state; `placeMove` actions-only.
- **Phase 4 — classify.** Structural gates for `move`; `create_goal` only at a `move`.
- **Phase 5 — projection & prompt.** `islandOf` from the state node; the tape renders
  `move`/`create_goal`; the per-focus admissible set; the walk; the terminal island sentence;
  the attractor (turns since `move`).
- **Phase 6 — tests.** See §11.
- **Phase 7 — docs mirrors.** All `_ru` mirrors + coverage matrix.
- **Phase 8 — live.** See §12.

## 11. Tests

- `tests/ops/` — new `move` operator tests (`OP-MV-*`): `move` at the request; `create_goal`
  after `move`; `stop` returns to the state; `move` after `stop`; `move` to the terminal;
  refusals (`move` with an open goal, `create_goal` without a `move`). Update `OP-CG-*`
  (no `state`, only after `move`), `OP-ST-*` (close a state), `TR-*` (the walk), `DER-*`
  (state from `move`).
- `tests/loop.test.ts`, `tests/ops/{applicable,traversal,ir_properties}.test.ts` — the walk.
- Projection/tape (`tests/tape*.test.ts`, `messages.test.ts`, `tests/ops/create_goal.test.ts`)
  — the `move`/`create_goal` rendering.
- `tests/prompt.test.ts` — the strict per-focus contract; no sub-goals; the terminal sentence.
- `tests/islands.test.ts` — the terminal island as a plain sentence.
- `tests/coverage.test.ts` — `OP-MV-*` registered; the matrix updated.
- `tests/live/` — see §12.

## 12. Live verification

- **Synthetic gate** (extend `tests/live/state_transitions_step.test.ts`, offline-built
  projection → one LLM call): after an observation in a state whose criterion holds, the model
  proposes `stop`; at a request it proposes `move`; at a `move` it proposes `create_goal`; at a
  closed state it proposes the next `move`; at the terminal it proposes `stop`. Gate: only if
  green, spend the expensive bench.
- **`fix-ocaml-gc`, on/off** — success signal: `states=[…]` with **more than one distinct
  state**, `reward 1`, a clean close. Compare the pre-edit re-derivation window (t20–33 = 40k
  reasoning tokens) and the first-edit turn versus the baseline of §1.

## 13. Decisions (resolved 2026-10-13)

Concept-level (bind Phase 0/1):

1. **Tree shape** — **flat**: every state is a child of the request (a sibling of the previous
   state). Rejected: a chain (corrective cycles would deepen the tree without bound).
2. **Terminal** — keep **`handoff`**, no rename; it needs **no goal**, it accepts `stop`
   directly.
3. **`move` node vs event** — a real **tree node** (visible on the tape, `islandOf`-readable,
   lets the engine count "turns since the last `move`").
4. **How the engine asks for the transition** — after `stop` the projection focuses the finished
   state, renders `applicable = { move }`, and emits an explicit directive, e.g.
   `State <label> finished (<summary>) — move to the next state or to the terminal`.

Concept-level (§4a):

- **Summary of a finished state** — **engine-derived base + an optional model `note`** on
  `move`.
- **Retrievability of elided ids** — **accept the loss** (as today); the summary carries what a
  later state needs.

How-level (bind Phase 2–5):

5. Refusal set and reasons for protocol errors — as §6.10 (`move` with an open goal;
   `create_goal` without a `move`; `apply` at a `move`).
6. `recall`/`search` remain **universally available** (read-only, not moves).
7. The attractor's threshold — turns since the last `move` exceed N (default to be tuned in
   Phase 5 against the synthetic gate).
8. Decomposition — **gone** (flat steps); a too-big step is more steps or a more specific
   state.
9. **Working tree** (§9) — the incremental work was **committed as a stepping stone**
   (`6af64b7`), not reverted; the redesign builds on it on `main`.

## 14. Risks and cost

- **Big IR change** — touches the core tree, traversal, projection, schemas and every ops test;
  the working tree's incremental changes are partly reverted.
- **Behavioural** — the win (a declared, counted walk; forced transition decisions) is measured
  only live; one run per branch is a direction, not statistics.
- **Cost** — the synthetic gate is cheap; the `fix-ocaml-gc` on/off pair is ~₽ (the last net-on
  run cost 31₽).
- **Ceremony risk** — `move` + `create_goal` is two moves; the prompt must keep `create_goal`
  concrete (an outcome + a first step), not a ritual.
