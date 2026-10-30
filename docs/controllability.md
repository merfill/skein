# Skein — controllability: triggers and the RequestObserver

> Russian original — `docs/controllability_ru.md`.
>
> Status: **4a implemented; 4b under discussion**. The code has
> `budget`/`state_cycle`/`state_long`, `RequestObserver`, `hint`/`memo`/`halt`; the open
> questions below concern calibration and 4b.
>
> Builds on: `concepts.md` (doxa/logos, projection), `ir_semantics.md` (the IR, operators,
> invariants), `projection.md` (the tape), `session_concepts.md` (the observer unit, the
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
a state: a repeated action over unchanged material, budget exhaustion, premature closure.

States form a second level — a chain of transitions. Here other phenomena are observable:
repeated sequences (`P→V→P…`), plan oscillation, a return to an already traversed state without a
new ground. Controllability is thus hierarchical: from a turn to a state, from a state to the
chain, from the chain to the unit and the session.

### 1.3. Division of labour

Detecting an event is a mechanical operation over the structure; the engine, that is logos,
performs it. Deciding what to do about the event is a semantic judgment; the doxa performs it.
Applying the decision is again checked by logos, as any other operation.

Hence the role of a **trigger**: it is neither a command nor a verdict but an observation that
starts observer reasoning. A trigger decides nothing and closes nothing; it only reports that the
structure has entered a state deserving attention.

**An observation may be initiated by the engine.** The division of labour concerns decisions,
not the origin of observations: the engine already places facts at the start of a request
(`fact:session`, constraints). A read-only outline is such an observation; the engine may build
it without violating "the doxa proposes".

### 1.4. The observer unit as the same IR

The RequestObserver is neither an external supervisor nor a second engine. It is a observer unit: the
same IR as a task, but with a different root (a trigger and an outline instead of a request), a
different state vocabulary and read-only outline tools. Its proposals pass the same check by
logos.

This arrangement preserves the invariants: the journal only grows, the projection is
deterministic, a state is closed only through `stop`, and there are no stored verdicts or
statuses.

### 1.5. Cost and benefit

The RequestObserver costs turns and tokens. Its justification is therefore not the average run cost
but the tail of the distribution: expensive looped and fruitless runs that it interrupts or
redirects. Triggers must be rare and precise; a false positive is more costly than a miss.

## 2. The frame

```
event in the structure ──(deterministically)──> trigger ──> RequestObserver ──> proposal ──> logos
```

- The engine notices an event and emits a **trigger**.
- The engine prepares the outline and the observations; the RequestObserver reads them and decides
  what to do.
- The agent proposes an action; logos checks the preconditions and applies or rejects it.
- Detection is deterministic: the same events give the same triggers.

The current unit is the top of the **unit stack**: a trigger pushes a observer unit and switches the
active IR to it; when the observer unit finishes it is popped and the outer unit is resumed. Unit
journals are not rewritten; the stack, `focus` and push/pop are recorded in the session journal.
The task pauses at a turn boundary and resumes from its own journal (a cursor), not from a copy
of the context; how exactly to pause/resume the loop is an open question (§6).

## 3. Candidate triggers (under discussion)

A list to work through, not a set of decisions. For each candidate one must determine what is
observed, at which level (inside a state, a chain of states, a unit, the session), when it fires,
and what a false positive costs.

- a repeated `action→observation` over unchanged material; a special case already exists — the
  read thrash-guard (`OP-AP-READ-6`);
- a third entry into the same island through `move` (e.g. `P→V→P…`);
- more than 20 turns in one state;
- reasoning growth or repetition over a window (reasoning chars/tokens per turn and their trend);
- a premature `stop` when the goal or criterion is not met;
- turn or token budget burn; in `patch|recovery|construction|end` at `max_turns` the engine
  deterministically allows a few more turns;
- a repeated refusal: the model proposes the already rejected thing again;
- plan oscillation: items are added and removed in a loop;
- other events that the traces will reveal.

## 4. What the RequestObserver sees

### 4.1. The ladder of scales

An outline is not one summary but a ladder of levels: each next level discloses the previous
one. Names matter more than numbers here: in `session_concepts.md` the same ladder is numbered
L0–L4, where L0 is the session; for the RequestObserver the root is different, and the numbers only
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

By default the observer unit receives:

- `system`: the observer prompt and the trigger (`kind`, `anchor`, `evidence` ids);
- a **prepared outline**: a deterministic set of read-only calls built by the engine (`outline`,
  `state(anchor)`, and `body(evidence)` when needed) together with their `tool` results.

The seeded call is not a transient render but an **event in the observer unit journal**: the engine
records the call itself and its `tool` result with `engine` provenance, so the projection renders
an ordinary `assistant` call → `tool` result pair and a replay reads the outline from the journal
instead of re-running it. The exact record shape (a new `kind` or reusing
`action`/`observation` with `payload.origin`) is an open question. The model spends its first
turn on the decision, not on "give me the tape". If the data is insufficient, it calls the tools
itself.

The task tape is not replayed wholesale: the observer unit has its own tape, and the observed
material arrives as call results.

### 4.3. Roles and provenance

| What | Role |
|---|---|
| observer prompt, engine directives | `system` |
| trigger (engine facts, no task text) | `system` |
| prepared outline (engine call) and later doxa calls/proposals | `assistant` |
| observed material (outline, state, turns, body, rendered) | `tool` |
| user utterance (session only) | `user` |

For the model it makes no difference who initiated the call: a `tool` result is a `tool` result,
and it orients itself by the tool contract. The distinction it actually needs is `assistant` (its
own proposals) versus `tool` (observed material). The original task tape (its `assistant`/`system`
turns) is not replayed, so no confusion arises.

Provenance (`engine` vs `doxa`) is written **to the observer unit journal** — for determinism,
replay and debugging — but is not a separate tape role and needs no special wrapper. We do not
introduce a cross-cutting "evidence block": the read-only tool contract carries the semantics —
their output is an observation, that is, data, not instructions; logos never elevates observed
text to a directive.

## 5. Tape/IR agent tools (under discussion)

- `outline` — the U and S summary; the engine seeds the call at the start of the observer unit;
- `state(id)` — the structure of a state's prompts/hints: island, instruction/hint/goal, closure,
  admissible transitions, plan;
- `turns(state, range)` — `action→observation` turns; the tail plus the evidence turns;
- `attempt(item)` — alternatives, refusals, result, outcome;
- `body(obsId)` / `search` — an observation body or window, and addressing by id;
- `rendered(state)` — the exact render of what the task model saw; needed to diagnose a
  "projection-induced loop";
- bounds: read-only; it does not edit task trees; it proposes an operation, logos checks it.

## 6. Open questions

1. What counts as an event: only a repeat, budget, a premature `stop`?
2. Which reaction is preferable: a hard turn refusal in logos, or a trigger on which the
   RequestObserver decides? Provisionally the latter.
3. When to run the RequestObserver: on every trigger, with a debounce, only on expensive events?
   Pausing the task at a turn boundary and the unit stack are decided (§8); the way to
   pause/resume the loop and the synchrony of the run are open.
4. How much the engine seeds by default (`outline`+`state`? also `turns`?) and how that relates
   to the RequestObserver's budget.
5. How the trigger and the reaction land in the journal: an engine event, `record_rejection`, a
   separate node type; how the `engine`/`doxa` provenance is visible on replay.
6. How to keep a trigger from becoming a verdict or status without breaking the "no verdicts"
   invariant?
7. How many turns and tokens the RequestObserver adds now that the outline is prepared by the engine,
   and when it pays for itself.
8. Whether to show reasoning in `turns` (useful for diagnosis but noisy).
9. Whether a separate `rendered(state)` is needed or `turns`+`state` suffice.
10. How it relates to Tier 4b: 4a already introduces a minimal session container (journal and
    stack), while 4b adds session operations and attention statuses; the observer unit and outline
    are shared, the state vocabularies separate.

## 7. Non-goals

- No similarity/RAG: selection is by structure.
- No hard gate on every action.
- No stored verdicts or statuses.
- No second engine: the observer unit is the same IR.
- Do not replay the task tape into the RequestObserver's tape: the observed material arrives through
  calls.

## 8. Fixed decisions (2026-10-30)

1. **A minimal session in 4a.** 4a introduces the session container and journal, but not the
   main functionality: session operations and attention statuses stay in 4b. User interruption is
   a separate task, not part of 4a.
2. **A unit stack.** The active context is the top of the stack. A trigger pushes a observer unit and
   switches the IR to it; completion pops it and returns to the outer unit. What is stored is
   unit ids and return points, not copies of contexts (`project` is derived).
3. **The seeded outline is a journal event.** The engine's call (`outline`/`state`/`body`) and its
   `tool` result are recorded in the observer unit journal with `engine` provenance; this is not a
   transient render. The exact node/event shape is open.
4. **The thresholds are rewritten.** The existing `no_progress`/`max_turns`/thrash-guard are
   trigger candidates; terminal completion yields to the trigger and the RequestObserver. How exactly —
   open (§6).
5. **The layers are separated.** The detector is a pure function over the journal: events →
   triggers; it neither finishes nor advises anything. The trigger's lifecycle (firing, cooldown,
   re-arming, "already reviewed") lives in the engine and the session journal, without verdicts
   or truth statuses. The observer doxa decides (`hint`/`halt`), logos checks and records the trace.
   Absolute safeguards (`max_turns`, the observer unit budget, `user_interrupt`, `llm_error`) live in
   the run supervisor; `no_progress` as a terminal completion is removed.
6. **`nudge` is removed.** The projection's soft attractor is not kept as a separate reaction. The
   only intervention channel is `trigger → observer unit → hint`/`memo` (IR nodes, `system` on the
   tape) or `halt`; `hint` applies to the current state, `memo` to the unit. `stall` remains
   detector-only state. After implementation the as-built description in
   `ir_semantics`/`projection` must be updated.
