# The agent's prompt as a state machine — concept

> A draft for review. It describes new principles for building a coding agent's prompt
> (and, more broadly, any REACT agent's): not a list of actions, but a **space of states**
> the model enters and leaves along causal links.
>
> Related documents: `docs/system_prompt.md` (the prompt's current shape),
> `src/loop/prompt/blocks.ts` (assembly), `docs/ir_semantics.md` §6–7 (situations),
> `src/ir/project.ts` (the projection), `docs/benches/best_bench.md` (live runs),
> `docs/plans/goal_reduction_plan.md` (invariant: only `stop` closes a goal).

## 0. The problem and the thesis

**Observation (practice).** Without a strategy in the prompt the model floundered and did not
know what to do next. As soon as the chain `localization → patch → verification` was added to
the prompt, the work took off. This is not a lucky coincidence: an agent needs not "what to do
in general" but **how to hold a convergent trajectory** — what states of work there are, how to
tell you have entered one, and where you can go from it.

**Thesis.** The agent's prompt is a **graph of states and transitions between them**, not a
procedure and not a checklist. A state is a *state of knowledge* defined by an
**exit criterion**; a transition is a **causal precondition** for changing state; a constraint
is a reusable refinement. The model itself decides whether it has entered a state, and so the
graph does not turn into rails.

**Why not a checklist.** A checklist prescribes an order and imposes ceremony even where it is
not needed (a one-line change). A state graph does not: the exit criterion can be met on the
spot or after reconnaissance. The order is not dictated; it is *derived* from the transitions.

**Why this matters now.** Live `fix-ocaml-gc` runs show drift: in run
`2026-10-11T13-50` (net off) **89%** of the reasoning is spent before the first edit, and the
root-cause analysis fully derived at t12 is reinvented for ~26 more turns
(`docs/benches/best_bench.md`). The drift is not about a lack of tools but about the model
having no state map of "where I am and where to go next".

## 1. Elements of the state graph

### 1.1 The state machine

The whole space of the task and the working tree is a **state machine**: a set of states and
transitions, traversed non-linearly — with backtracks and loops. The machine has **one
target state** — the state where the request is done and verified; everything else is a path
to it. The target state defines:

- **the result** — what must change;
- **the sign of attainment** — how to tell it worked (an acceptance command/test/criterion,
  if one is named or derived).

In Skein's terms the target state is the request and its acceptance sign; in the engine's
terms it is a closed goal (closed only by `stop`, `docs/plans/goal_reduction_plan.md`).

### 1.2 State

A short description of a **kind of development work** (a state of work) with a **clear exit
criterion**. The model "is in a state" when the criterion is met. A state is knowledge, not
steps: "you have localized when you can name the file, the line, the exact expression and the
invariant it breaks".

The key property of a state is that **the model itself can check the criterion**. If the
criterion cannot be established from the tape or from the working tree, it is not a criterion
but a slogan.

### 1.3 Constraints

Small rules/techniques/refinements are **constraints**: not states and not transitions, but
how to move through them. The elements of constraints:

- **not causally linked** — they do not define a transition;
- **shared across several states** — one constraint acts where relevant;
- formulated as **condition→action** or a **prohibition** checkable from the tape;
- differing in **force**: a *hard* constraint is enforced by the engine (insurmountable),
  a *soft* one only guides the move (doxa's discipline).

"Property of the environment" here means the constraint really acts in the agent's world, not
that the engine gates states (invariant §2.6 holds).

### 1.4 Transition

A causal link between states: a **precondition** or a **transition**. Transitions answer "under
what condition may I move on", not "what to do in order". There are few transitions, and almost
all of them lead to the target state.

## 2. Principles for building the state graph

1. **The target state first.** The prompt opens with what it is all for: the result and the
   sign of attaining it. Every state must lie on the path to the goal.
2. **State = criterion, not steps.** Formulate a state of knowledge that shows the kind of
   work is finished.
3. **Transition = precondition, not order.** "You move to B when X holds and you need Y", not
   "first A, then B".
4. **Constraint = one behavior, without causes.** A constraint refines a state, it does not
   define a transition; one constraint may apply in several states.
5. **Few transitions, acyclic toward the goal.** The graph must flow to the goal almost
   everywhere. Only corrective cycles are allowed: verification failure → localization;
   environment triage → back to the same state.
6. **Criteria are doxa's heuristic, not the engine's gate.** States help the model *choose a
   move*; closure stays with `stop`. A state criterion must not become a new engine gate — that
   would break the invariant of `docs/plans/goal_reduction_plan.md`.
7. **States are not examples to imitate.** The lesson from the B12 A/B (tool index): what the
   prompt lists, the model imitates, even to its detriment. So a state is a condition, not a
   model action; a constraint is a prohibition/permission, not a demonstration.
8. **A state is expressed as a predicate, not as "do".** "If you can name … you have localized"
   beats "locate the bug by reading".
9. **Reuse matters more than completeness.** Better 6–8 states covering the real kinds of work
   than a long catalogue "for every case".

## 3. Templates

### 3.1 The state template

```
STATE <name>
  What:        <the kind of work, in one phrase>
  Entry:       <from which states and under what condition you get here>
  Criterion:   <the state of knowledge that shows you are done here>
  Exit:        <which states the transitions lead to and under what condition>
  Constraints: <the constraints relevant here>
```

### 3.2 The constraint template

```
CONSTRAINT <name>: <one rule, positive or prohibitive>
  Applies in: <states>
```

## 4. Example: the states of a coding agent

Below is a working catalogue. It is an **example**, not the one true map: the set of states is
chosen for the agent's domain.

### 4.1 The target state (coding agent)

The user's working request: what must change and **how to tell it worked**. If the request
names an acceptance command (`make -C testsuite one DIR=tests/basic`, `pytest`, `npm test`),
that command is the sign of attainment. If it does not, the sign is derived in
Interpretation/Reconnaissance.

### 4.2 States

#### Interpretation

- **What:** turn raw motivation into one bounded goal.
- **Entry:** the target state (always the initial state).
- **Criterion:** the outcome and the *first concrete action* are named; the acceptance sign is
  found; the root of the work (workspace or subdirectory) is understood.
- **Exit:** → Reconnaissance. If there is no task at all (chit-chat, thanks) — Decline.
- **Constraints:** "one goal per request"; "the command comes verbatim from the request/project";
  "the workspace root, `cd <dir> &&` for a subdirectory".

#### Reconnaissance (orientation)

- **What:** the project map — what exists, how it builds/runs, where the relevant code and data
  are.
- **Entry:** Interpretation.
- **Criterion:** the entry point, the build and test commands, and the relevant paths are known.
- **Exit:** → Localization (defect); → Reproduction (defect); → Design/Planning (feature,
  multi-step task).
- **Constraints:** batch independent reads/greps; "wide first, then narrow".

#### Reproduction *(for defects)*

- **What:** obtain an observable failure tied to the goal.
- **Entry:** Reconnaissance (the task is a defect and there is a command that reproduces the
  failure).
- **Criterion:** there is a command whose failure is observed **and relates to the goal, not to
  the environment**.
- **Exit:** → Localization. If the failure is environmental — → Environment triage.
- **Constraints:** "tell 'not found' from 'not built'"; "foreground for build/test".

#### Localization / Diagnosis

- **What:** find the exact cause.
- **Entry:** Reproduction (defect); Reconnaissance (an obvious defect); Verification (failure —
  a new round).
- **Criterion:** **the file + line + exact expression and the invariant it breaks are named**
  (or the exact missing symbol/contract). If you cannot name the expression, you have not yet
  localized.
- **Exit:** → Patch; → Reference acquisition (external truth needed); → Planning (many edits).
- **Constraints:** "do not recall code — read it"; "anti-reinvention"; "correct: compare with a
  neighboring pattern in the same file".

#### Reference acquisition *(optional, bounded state)*

- **What:** obtain external truth (upstream, a diff, documentation).
- **Entry:** Localization (confirmation/reference needed).
- **Criterion:** the reference is on disk and usable **or** the attempts are exhausted — and
  then returning to your own derivation is mandatory (not a loop).
- **Exit:** → Localization (refined) / → Patch (reference obtained). On exhaustion — back with
  no change of state.
- **Constraints:** "reference-acquisition budget"; "an unavailable reference is a fact, not a
  reason to retry".

#### Planning / Design

- **What:** choose the approach and the sequence; for design, choose the interface/structure.
- **Entry:** Reconnaissance (multi-step task); Localization (many edits).
- **Criterion:** a concrete set of changes or a sequence of items whose **first item is
  executable now**; for design — the chosen structure and why.
- **Exit:** → Patch; → Decomposition (an item is too large).
- **Constraints:** "the first item is a literal command"; "one alternative per turn".

#### Patch / Implementation

- **What:** make the change.
- **Entry:** Localization (the exact edit is named); Design/Planning (the approach is chosen).
- **Criterion:** the exact change in the workspace, pointable to.
- **Exit:** → Verification.
- **Constraints:** "`oldString` is unique"; "`edit`, not `write`, for a targeted change";
  "anti-reinvention" (re-read the edit's purpose, do not retell the analysis).

#### Verification

- **What:** confirm the edit with the acceptance command/tests.
- **Entry:** Patch.
- **Criterion:** the acceptance command passes (the case that was failing now passes).
- **Exit:** → Hand-off. **On failure → Localization** (a new round with new evidence, not a
  blind re-edit).
- **Constraints:** "do not re-verify what passed"; "foreground"; "do not repeat a failed
  command — change the approach".

#### Environment triage / failure *(floating state)*

- **What:** tell an environmental failure (no configuration/dependencies) from a goal failure.
- **Entry:** any state where a command failed.
- **Criterion:** it is named which failure this is; for an environmental one, the preparation
  is done (`configure`, installing dependencies, `setup`).
- **Exit:** → back to the same state you came from.
- **Constraints:** "`No rule to make target` ≠ wrong directory"; "building the project is setup,
  not a defect".

#### Hand-off / Closure

- **What:** close the work.
- **Entry:** Verification (success).
- **Criterion:** `stop` with a reason — the only way to close the goal.
- **Exit:** → the target state.
- **Constraints:** "do not close before verification".

#### Service states

- **Decline:** the request is not workable → record it and finish, without inventing a goal.
- **Decomposition:** a plan item is too large → break it into a sub-goal.

### 4.3 Transitions (a sketch of the graph)

```
Goal → Interpretation → Reconnaissance
Reconnaissance → Reproduction → Localization       (defect)
Reconnaissance → Design/Planning                   (feature/multi-step)
Localization → Reference acquisition → Localization (external truth needed, bounded)
Localization/Design/Planning → Patch → Verification
Verification(failure) → Localization               (corrective cycle)
Verification(success) → Hand-off → Goal
* → Environment triage → *                         (floating)
```

Properties of the graph:

- **few transitions** — the route is derived, not listed;
- **almost everything flows to the goal** — two allowed cycles (failure→localization,
  environment);
- **branches by kind of task** — a defect goes through reproduction, a feature through design.

### 4.4 Constraints (a catalogue of elements with rationale)

| Constraint | Formulation | Applies in | Rationale |
|---|---|---|---|
| Anti-reinvention | If the goal/diff lines are already on the tape — name the exact replacement and edit in the same move; do not retell what you read. | Localization, Patch | #6: 89% reasoning before the edit; the analysis is reinvented for ~26 turns |
| Do not recall code | Exact syntax/names/macros — read them from disk. | Localization, Patch | Recalling code is unreliable; it is in B13 |
| Batch independent reads | Several independent reads/greps per turn. | Reconnaissance, Localization | fewer turns, the same context |
| One line of intent | No narration, only the intent and the calls. | all | less visible output |
| Do not repeat a failed command | Failure → a different approach. | Verification, Environment triage, Reference acquisition | the engine already refuses an exact repeat |
| Do not re-verify what passed | Success attained → do not verify again. | Verification | #5: a clean `stop` is cheaper |
| Reference-acquisition budget | A few failures → your own derivation. | Reference acquisition | #6: ~9 network attempts, all 403 |
| "Not found" ≠ "not built" | Tell a missing path from an unbuilt tree. | Environment triage | Phase 6: a correct edit, a wrong conclusion about the directory |
| `oldString` is unique | Otherwise `edit` will not apply. | Patch | the tool contract |
| Foreground | Run builds/tests in the foreground. | Verification, Environment triage | Phase 8: background ate 16/60 turns |

## 5. Assembly, situation, projection

The state graph is distributed across three layers that already exist in Skein:

1. **The prompt base (`BASE_PROMPT`) — the goal, the state graph and the preamble.** The prompt
   opens with a preamble: a coding agent implemented as a state machine; then the states with
   their criteria, the transitions, and the always-relevant constraints. Stable and cacheable.
   This is a replacement/extension of the current B1/B13.
2. **The situation instruction (`NODE_INSTRUCTIONS`) — highlighting the state.** The mapping
   "situation → admissible states": in `request` Interpretation/Decline dominate; in `goal`,
   Reconnaissance/Localization/…/Hand-off. Today it is `request`/`goal`; it extends without
   breaking.
3. **The projection (`src/ir/project.ts`) — the model's position.** Which state is passed,
   which is current, what remains to the goal (a plan item, the finishing command, whether the
   edit is made). Here too are the "attractors" the model is pulled toward.

**The source of names.** The state descriptions live in the prompt, while the names are one
list in the engine's code: from it the `state` enum of the `create_goal` schema is expanded, so
the IR controls the admissible values (an unknown name is a structural error, not a semantic
gate).

**Landed (2026-10).** The layers are in code: `B4` carries the mechanism (move on with
`create_goal` when the criterion holds), the `Start` candidates and the conditioned transitions
grouped by source; the per-state instruction renders `What / Done when / Constraints`; and the
`state`/transitions are single-sourced from `src/ir/islands.ts` (`blocks.ts` and the `create_goal`
`state` enum derive from it).

**Attractors.** This is what is missing today: a static instruction does not change from turn
to turn, while the tape grows. The graph must *highlight the position*: "localization closed →
the next attractor is Patch", "the edit is made, the acceptance command has not passed yet →
Verification". This is layer (3), not prompt text. A first lever landed: a soft `nudge` in the
projection when a goal stalls (`Context.nudge`, `src/ir/project.ts`); the position highlight
proper is still open.

**Invariant.** The state criteria are doxa's heuristic. The engine still does not gate on a
criterion; closure is only `stop`.

## 6. Convergence: how the state graph damps the drift (run analysis)

| Stretch | #5 net on (`13-21`) | #6 net off (`13-50`) | State by the graph |
|---|---|---|---|
| t1–9 | reconnaissance `bash`/grep | the same | Reconnaissance |
| t10–14 | the RLE bug surfaced while reading | the bug surfaced (t12) | Localization (the criterion is met already here) |
| t15–19 | one `webfetch` upstream, compare | `webfetch` 403 | Reference acquisition |
| t20–38 | 3 `edit` (t20/21/23) | **26 turns of reinvention**, the edit only at t39 | Patch (delayed) |
| build/tests | `make`, testsuite | `configure`/`make`, testsuite | Verification |
| closure | `stop` t32 | `stop` t44 | Hand-off → Goal |

Conclusion: **both trajectories localized early** (t10 / t12), but #6 had no "Localization →
Patch" transition: without an external reference the model got stuck in the Reference
acquisition state and reinvented the analysis. A graph with an explicit localization criterion,
a transition to Patch, and the constraints "anti-reinvention" + "reference budget" addresses
exactly this.

## 7. Verifiability

- **L1 (offline, CI; `tests/prompt.test.ts`):** the graph is assembled from blocks; every state
  has a criterion; the transitions are consistent and acyclic (except the allowed cycles); the
  constraints do not duplicate each other; the states do not repeat the tool descriptions.
- **L2 (fixtures):** a trajectory on a fixture does not leave the graph and reaches the goal.
- **L3 (A/B on live runs):** convergence metrics:
  - **reasoning before the first edit** (#6 = 89%, #5 = 40%);
  - **steps to the goal**;
  - **presence of a corrective cycle** instead of getting stuck;
  - cost.

The proof rule is as with B12: one change per A/B, both branches (`--net on` and `--net off`),
one run per branch = a direction, not statistics.

## 8. Risks and open questions

- **Imitation (lesson B12).** The graph can slide into mimicry. It is cured by formulating states
  and preconditions rather than examples; it is checked by A/B.
- **Trivial tasks.** Do not force passing through all states: the criteria let you enter later
  (e.g. straight to Patch if the localization is obvious).
- **A structural gap.** The graph helps *choose a move* but does not keep the model's own
  inference between turns: today `thought`/reasoning is not on the tape
  (`src/ir/project.ts:216,222` draws an assistant with empty text; `src/loop/graph.ts:210`
  writes `thought` only to the progress detector). The "anti-reinvention" constraint treats
  this only partly; keeping the inference and re-anchoring the goal is a separate lever.
- **Prompt budget.** The size of the graph and what to move into the projection.
- **Where the graph lives.** A fork: the base (stable, cached) vs the situation instruction
  (by state) vs the dynamic projection (position). Tentatively: the graph in the base, the
  position in the projection.
- **Relation to the current blocks.** What becomes a state, what a constraint, what moves into
  the tool descriptions (invariant §1.4 of `docs/system_prompt.md`: the prompt does not repeat
  the tool descriptions).
