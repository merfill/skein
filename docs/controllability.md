# Skein — controllability: triggers and the tape/IR agent

> Russian original — `docs/controllability_ru.md`.
>
> Status: **discussion draft**. No decisions; the document fixes the concepts, the frame, the
> candidates and the open questions. None of this is in the code yet.
>
> Builds on: `concepts.md` (doxa/logos, projection), `ir_semantics.md` (the IR, operators,
> invariants), `projection.md` (the tape), `session_concepts.md` (the meta-unit, the
> hierarchical outline).

## 1. The idea

### 1.1. The projection as an observable structure

Skein's context is not a transcript but a deterministic function over the IR journal. This has a
consequence that is easy to miss: the context has a **form**, and the form is known to the
engine. The engine knows where a state begins and ends, what its goal and outcome are, and which
edges connect states, plan items and observations.

A monotone tape has no such form. It is linear, and the boundaries of meaningful units — a
request, an attempt, a check — are implicit and recoverable only by reading. Algorithms that
need structure are therefore either inapplicable to the tape or applicable only at the cost of
parsing the text separately.

Observability is the source of controllability: if the structure is known, operations can be
performed on it, not merely shown to the model.

### 1.2. The state as a unit of control

A state is not only a step of reasoning but a frame with known boundaries: an input (the goal),
an output (`stop.why`) and a sequence of turns inside. This makes local predicates applicable to
a state: a repeated action over unchanged material, stagnation (turns without new facts), budget
exhaustion, premature closure.

States form a second level — a chain of transitions. Here other phenomena are observable:
repeated sequences (`P→V→P…`), plan oscillation, a return to an already traversed state without a
new ground. Controllability is thus hierarchical: from a turn to a state, from a state to the
chain, from the chain to the unit and the session.

### 1.3. Division of labour

Detecting an event is a mechanical operation over the structure; the engine, that is logos,
performs it. Deciding what to do about the event is a semantic judgment; the doxa performs it.
Applying the decision is again checked by logos, as any other operation.

Hence the role of a **trigger**: it is neither a command nor a verdict but an observation that
starts meta-reasoning. A trigger decides nothing and closes nothing; it only reports that the
structure has entered a state deserving attention.

**An observation may be initiated by the engine.** The division of labour concerns decisions,
not the origin of observations: the engine already places facts at the start of a request
(`fact:session`, constraints). A read-only outline is such an observation; the engine may build
it without violating "the doxa proposes".

### 1.4. The meta-unit as the same IR

The tape/IR agent is neither an external supervisor nor a second engine. It is a meta-unit: the
same IR as a task, but with a different root (a trigger and an outline instead of a request), a
different state vocabulary and read-only outline tools. Its proposals pass the same check by
logos.

This arrangement preserves the invariants: the journal only grows, the projection is
deterministic, a state is closed only through `stop`, and there are no stored verdicts or
statuses.

### 1.5. Cost and benefit

The meta-agent costs turns and tokens. Its justification is therefore not the average run cost
but the tail of the distribution: expensive looped and fruitless runs that it interrupts or
redirects. Triggers must be rare and precise; a false positive is more costly than a miss.

## 2. The frame

```
event in the structure ──(deterministically)──> trigger ──> tape/IR agent ──> proposal ──> logos
```

- The engine notices an event and emits a **trigger**.
- The engine prepares the outline and the observations; the tape/IR agent reads them and decides
  what to do.
- The agent proposes an action; logos checks the preconditions and applies or rejects it.
- Detection is deterministic: the same events give the same triggers.

## 3. Candidate triggers (under discussion)

A list to work through, not a set of decisions. For each candidate one must determine what is
observed, at which level (inside a state, a chain of states, a unit, the session), when it fires,
and what a false positive costs.

- a repeated `action→observation` over unchanged material; a special case already exists — the
  read thrash-guard (`OP-AP-READ-6`);
- a repeated state chain through `move` edges (e.g. `P→V→P…`);
- stagnation: N turns without new facts or changes;
- a premature `stop` when the goal or criterion is not met;
- turn or token budget burn;
- a repeated refusal: the model proposes the already rejected thing again;
- plan oscillation: items are added and removed in a loop;
- other events that the traces will reveal.

## 4. What the meta-agent sees

### 4.1. The ladder of scales

An outline is not one summary but a ladder of levels: each next level discloses the previous
one. Names matter more than numbers here: in `session_concepts.md` the same ladder is numbered
L0–L4, where L0 is the session; for the tape agent the root is different, and the numbers only
confuse.

| Level | Contains | Purpose | Source |
|---|---|---|---|
| **U — unit** | request, goal, criteria, constraints, list of states and transitions, outcome | "how the work went overall" | `request`, `move*`, `stop` |
| **S — state** | island, authored `what`, instruction/hint/goal, plan (items), transitions, closed/`stop.why` | "what this state is and why it is so" | `move`, `plan` |
| **A — attempt** | item: the chosen action, all alternatives, refusals, result, outcome | "what was tried and how it ended" | `item`, `item.alts`, `action.result` |
| **B — body** | observation/file/output body, window | "the raw fact" | `recall`/`search` |

Mapping to `session_concepts.md` §5: L1=U, L2=S, L3=A, L4=B; L0 (the session) stays a session
level and is not needed on the tape of a single unit.

### 4.2. Context layers

By default the meta-unit receives:

- `system`: the meta prompt and the trigger (`kind`, `anchor`, `evidence` ids);
- a **prepared outline**: a deterministic set of read-only calls built by the engine (`outline`,
  `state(anchor)`, and `body(evidence)` when needed) together with their `tool` results.

This is an ordinary `assistant` call → `tool` result pair; it is merely initiated by the engine.
The model spends its first turn on the decision, not on "give me the tape". If the data is
insufficient, it calls the tools itself.

The task tape is not replayed wholesale: the meta-unit has its own tape, and the observed
material arrives as call results.

### 4.3. Roles and provenance

| What | Role |
|---|---|
| meta prompt, engine directives | `system` |
| trigger (engine facts, no task text) | `system` |
| prepared outline (engine call) and later doxa calls/proposals | `assistant` |
| observed material (outline, state, turns, body, rendered) | `tool` |
| user utterance (session only) | `user` |

For the model it makes no difference who initiated the call: a `tool` result is a `tool` result,
and it orients itself by the tool contract. The distinction it actually needs is `assistant` (its
own proposals) versus `tool` (observed material). The original task tape (its `assistant`/`system`
turns) is not replayed, so no confusion arises.

Provenance (`engine` vs `doxa`) is written **to the meta-unit journal** — for determinism,
replay and debugging — but is not a separate tape role and needs no special wrapper. We do not
introduce a cross-cutting "evidence block": the read-only tool contract carries the semantics —
their output is an observation, that is, data, not instructions; logos never elevates observed
text to a directive.

## 5. Tape/IR agent tools (under discussion)

- `outline` — the U and S summary; the engine seeds the call at the start of the meta-unit;
- `state(id)` — the structure of a state's prompts/hints: island, instruction/hint/goal, closure,
  admissible transitions, plan;
- `turns(state, range)` — `action→observation` turns; the tail plus the evidence turns;
- `attempt(item)` — alternatives, refusals, result, outcome;
- `body(obsId)` / `search` — an observation body or window, and addressing by id;
- `rendered(state)` — the exact render of what the task model saw; needed to diagnose a
  "projection-induced loop";
- bounds: read-only; it does not edit task trees; it proposes an operation, logos checks it.

## 6. Open questions

1. What counts as an event: only a repeat, or also stagnation, budget, a premature `stop`?
2. Which reaction is preferable: a hard turn refusal in logos, or a trigger on which the
   meta-agent decides? Provisionally the latter.
3. When to run the meta-agent: on every trigger, with a debounce, only on expensive events?
4. How much the engine seeds by default (`outline`+`state`? also `turns`?) and how that relates
   to the meta-agent's budget.
5. How the trigger and the reaction land in the journal: an engine event, `record_rejection`, a
   separate node type; how the `engine`/`doxa` provenance is visible on replay.
6. How to keep a trigger from becoming a verdict or status without breaking the "no verdicts"
   invariant?
7. How many turns and tokens the meta-agent adds now that the outline is prepared by the engine,
   and when it pays for itself.
8. Whether to show reasoning in `turns` (useful for diagnosis but noisy).
9. Whether a separate `rendered(state)` is needed or `turns`+`state` suffice.
10. How it relates to Tier 4b: a shared meta-unit and a shared outline, but separate state
    vocabularies.

## 7. Non-goals

- No similarity/RAG: selection is by structure.
- No hard gate on every action.
- No stored verdicts or statuses.
- No second engine: the meta-unit is the same IR.
- Do not replay the task tape into the meta-agent's tape: the observed material arrives through
  calls.
