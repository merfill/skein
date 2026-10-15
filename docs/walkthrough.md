# Skein — walkthrough: the tree and the context, step by step

> **Note (state tape).** The tree and the tables below reflect the current model: a state
> (`move`) IS its goal. `move { state, what, done }` declares the island of work, the state's goal
> (`what`) and its stop condition (`done`); the state's plan hangs directly off the `move` and is
> seeded by its first ordinary `apply`; `stop` closes the state and forces the transition; the
> terminal (`finish`) move's `stop` ends the request. The context is a message tape, and a state
> renders as a `Start state <label>` / goal / `Finish state <label> — <why>` triple (the request
> is a temporary `user` turn shown at a state decision). The current shape is `docs/ir_semantics.md`,
> the operator reference is `docs/ir_operations.md`, the design plans are
> `docs/plans/archive/goal_into_move_plan.md` and `docs/plans/archive/state_protocol_plan.md`; the
> as-built is `docs/ir.md`.

> Russian mirror — `docs/walkthrough_ru.md`.

## Preamble

**What Skein is.** Skein is a coding agent that keeps its knowledge not in a dialogue
with the model but in a **journal of facts**, and builds a **projection** of the current
state for the model on every turn — a precisely defined slice, not an accumulating
transcript. The model's context is a fresh projection each turn, rebuilt from the tree.

**Doxa and logos.** The conceptual frame is the split between *doxa* and *logos*:

- **doxa** is the language model. It invents well but is not responsible for the truth of
  what it invents, so it only *proposes* one or more moves per turn (a batch);
- **logos** is the deterministic engine together with the tools and the environment. It
  runs commands, records their results in the journal, recomputes the derived facts and
  builds the projection. Logos does not invent content — it decides whether a proposed
  move is admissible and what follows from it.

Hence the main principle: **doxa proposes, logos decides.** The model never declares the
work done by itself; the tool results (above all a command's exit code) and the engine's
rules do.

**Arbiter.** Above doxa and logos stands the **arbiter**, an external authority. In the
current model it is the user (a human or the harness that scores the result). The arbiter
sets the very first request and accepts the final result from outside. It takes no part in
accepting individual states: a state is closed by the doxa's `stop`.

**What closes the work.** The only frame that can be closed is a **state**. A state is
closed **only by an explicit `stop`** — there is no criterion gate. The request has no
`stop` of its own: it is interpreted **exactly once** as a state (`move`) or declined
(`unactionable`), and the run **ends when its terminal state is stopped** (or when the
request is declined).

**Why this document.** The formal documents describe the model in parts. Here **§4 is the
point**: one task is followed all the way through, from the request to closure, turn by
turn, showing what happens in the journal, in the tree, in the derived facts and in the
projection. §5 adds the special cases the main run does not meet (a non-actionable
request, the corrective cycle, a non-decisive run, file versions).

**How to read.** This is an illustration, not a second formalism. The source of truth is
`docs/ir_semantics.md`; the as-built is `docs/ir.md`; the operator reference is
`docs/ir_operations.md`; the projection spec is `docs/projection.md`. Where prose and code
disagree, the code and `docs/ir_semantics.md` win.

---

## 1. Concepts

Below is a glossary of the terms used in the text and the tables. Words in backticks are
code identifiers; they are not translated.

### 1.1 Roles

| Term | Meaning |
|---|---|
| **doxa** | the language model; it proposes one or more moves per turn (a batch) |
| **logos** | the deterministic engine: it runs commands, keeps the journal, recomputes the facts, builds the projection |
| **arbiter** | the external authority: it sets the first request and accepts the final result from outside |

### 1.2 Data layers

| Term | Meaning |
|---|---|
| **journal** | the immutable list of events — the only source of truth; it is only appended to |
| **state** | the fold of the journal (`fold`): nodes, edges, container order, traversal stack, file versions |
| **projection**, a.k.a. **context** | the precisely defined slice of state that doxa sees on the current turn |
| **node** | an object of the tree: `request`, `move`, `plan`, `item`, `action`, `observation`, `stop`, `constraint`, `file`, `unactionable` |
| **edge** | a link between nodes: `move`, `plan`, `items`, `alts`, `result`, `mutates`, `stop`, `unactionable` |

### 1.3 Work

| Term | Meaning |
|---|---|
| **request** | the user's unstructured motivation; the root of the tree; it is interpreted **exactly once** as a state (`move`) or declined (`unactionable`); it has no plan and no `stop`; the run ends when its terminal state is stopped |
| **state** (`move`) | an island of work the doxa declares to work in: `state` (the island's name) + `what` (the state's own goal text); the state IS its goal |
| **plan** | a container of items; a plan item is always an **action**; the order is the list, and the **last** item is the current one |
| **action** | one tool call (`read`/`grep`/`list`/`edit`/`write`/`bash`/`webfetch`/`apply_patch`); executed one per turn |
| **observation** | a recorded result: a read window, a run's output, an exit code |
| **alternatives** | a container of options: a revised plan item (a new attempt becomes the item's newest alternative) |
| **`stop`** | the terminal move: it closes the focused state (or, at the terminal state, ends the request) |
| **`decline`** | the move that records a non-actionable request (`unactionable`) and ends the run |

### 1.4 A run and its output

| Term | Meaning |
|---|---|
| **action** | one tool call; the state's **first** action seeds the plan and is executed at once; often one plain foreground shell command |
| **`exitCode`** | the exit code: `0` = pass, non-zero = fail, absent = no verdict (a timeout) — ordinary output, not a gate |

A run is an ordinary `observation`; nothing is closed by an exit code — the doxa decides
when a state is done and calls `stop`.

### 1.5 Facts derived from the journal

| Fact | Meaning |
|---|---|
| **`actionExecuted`** | the action has a `result` or `mutates` edge |
| **`hasStopped`** | the state's `move` has a `stop` edge to a `stop` node (it is closed) |

The request has no derived "settled" fact of its own: its completion is read straight from
its terminal state — the run ends when the terminal move is stopped.

### 1.6 Node status

A node has no stored status; the facts are derived:

- an action is `executed` once it produced a result;
- a state is closed once its `move` has a `stop` edge.

There are no "achieved"/"refuted" statuses on nodes and no criterion gate.

### 1.7 Traversal and admissible moves

- **stack**, a.k.a. **branch** (`path`) — the request plus the current state; the top of the stack is the **focus**;
- **cursor** — the index of the first unfulfilled plan item;
- **sibling row** — the ordered options of one level (plan items or alternatives); the **last** child is the current one;
- **admissible moves** (`applicable`) — the moves the rules permit at the current focus; doxa chooses one of them; the offered tool surface is bound from it;
- **`descend` / `return`** — moving the focus down the tree and returning a level up.

### 1.8 Refusals, the world, addressability

- **refusal** (`record_rejection`) — a record that a proposal was rejected, with a reason;
- **`mutate`** — an event that a file changed; it bumps the file's **version**;
- **`recall` / `search`** — addressed reading: a past result's body is fetched by `id` (window) or searched by pattern, without repeating the call.

---

## 2. The four levels, in one picture

The whole cycle fits into four steps: the journal accumulates, the state is derived from
it, the projection is built from the state, and doxa proposes the next move from the
projection.

```
                    append-only        pure              pure
  doxa proposal ─▶ journal (Event[]) ──fold──▶ State ──project──▶ Context ──▶ doxa
        ▲                                                              │
        └──── one or more operators per turn, chosen from the admissible moves ──┘
```

- **Journal** — `Event[]`, the only truth (`add_node`, `add_edge`, `descend`, `return`,
  `mutate`, `record_rejection`).
- **State** — `fold(journal)`: nodes, edges, container order, the traversal stack, file
  versions. Nodes never change.
- **Context** — `project(state)`: the message tape, the situation, the global constraints,
  the frontier (admissible moves), the observation instruction.
- **Doxa** — reads the `Context` and proposes one or more operators (a batch) (`move` /
  `apply` / `stop` / `decline`; `recall`/`search` are read-only addressing).

Nothing doxa "thinks" is stored. The plan is a note to self; the trace is the tree.

## 3. Notation

| symbol | meaning |
|---|---|
| `R` | the root `request` |
| `I`, `I0`, `I1`, `H` | states (`move`): the focus of an island, and the terminal `finish` |
| `a1`, `a2` | plan items (an `action`) |
| `obs` | an `observation` (a read window, a run's output together with its exit code) |
| `→` | the focus moves; `+` a node/edge is created; `⟂` a refusal (`record_rejection`) |
| `closed` / `open` | a state's `move` has / lacks a `stop` edge |

---

## 4. The through-line example: one task from start to finish

This is the main section. The task:

> "I broke the build; verify with `make test`."

One constraint `k1` — do not touch the tests. The run lasts 16 turns (0–15). The first
attempt does not help; doxa **stays in the same state** — it adds another step and
re-checks — and `stop`s the state once its `Done when` holds. It then `move`s through the
remaining states and ends at `finish`. Each row shows what doxa does, which event
logos appends, how the tree grows, which facts appear, and what doxa will see on the next
turn.

| Turn | Stack | Doxa proposal | Journal / tree change | Derived facts | Projection (what doxa sees) |
|---|---|---|---|---|---|
| 0 | `[R]` | — *(the arbiter sets the request)* | `+ request R {text}` | `rootId=R` | `situation=request`; `applicable=[move, decline]` |
| 1 | `[R] → [R,I0]` | `move I0 {state:"reproduction", what:"reproduce the failure: make test fails"}` | `+ move I0 {state, what}`; `+ move R→I0` | `I0=open`; `situation=plan` | `path=[R, I0]`; `I0.what="reproduce the failure…"`; plan empty; `applicable=[apply, stop]` |
| 2 | `[R,I0]` | `apply bash {command:"make test"}` (the state's FIRST plan item) | `+ plan Q0`; `+ items Q0→a1`; `+ action a1 "make test"`; `+ obs o1 {command:"make test", exitCode:1}`; `produces a1→o1` | `a1=executed`; `situation=working` | `lastResult={command:"make test", exitCode:1}`; `applicable=[apply, stop]` |
| 3 | `[R,I0]` | `stop {why:"the failure is reproduced"}` | `+ stop s1`; `+ stop I0→s1` | `I0=stopped`; `situation=transition` | `applicable=[move]` — the state is finished; only `move` is offered |
| 4 | `[R,I0] → [R,I1]` | `move I1 {state:"localization", what:"name the file, the line and the exact change"}` | `+ move I1`; `+ move R→I1` | `I1=open`; `situation=plan` | `path=[R, I1]`; plan empty; `applicable=[apply, stop]` |
| 5 | `[R,I1]` | `apply grep {pattern:"run-length"}` (first plan item — localize) | `+ plan Q1`; `+ items Q1→a2`; `+ action a2 "grep …"`; `+ obs o2` | `a2=executed` | `lastResult` — matches in `runtime/shared_heap.c` |
| 6 | `[R,I1]` | `apply read runtime/shared_heap.c [40-120]` | `+ action a3`; `+ items Q1→a3`; `+ obs o3 {ref, version:v1}` | `observed(file)=v1` | `lastResult` — a code window |
| 7 | `[R,I1]` | `stop {why:"the exact change is named"}` | `+ stop s2`; `+ stop I1→s2` | `I1=stopped`; `situation=transition` | `applicable=[move]` |
| 8 | `[R,I1] → [R,I2]` | `move I2 {state:"patch", what:"apply the fix"}` | `+ move I2`; `+ move R→I2` | `I2=open`; `situation=plan` | `path=[R, I2]`; `applicable=[apply, stop]` |
| 9 | `[R,I2]` | `apply edit runtime/shared_heap.c {oldString, newString}` (first plan item) | `+ plan Q2`; `+ items Q2→a4`; `+ action a4 {find,replace}`; `+ mutates a4→file`; `mutate v1→v2` | `currentVersion(file)=v2` | `lastResult={kind:"action", ref:"…"}` |
| 10 | `[R,I2]` | `stop {why:"the change is in the workspace"}` | `+ stop s3`; `+ stop I2→s3` | `I2=stopped`; `situation=transition` | `applicable=[move]` |
| 11 | `[R,I2] → [R,I3]` | `move I3 {state:"verification", what:"the acceptance command make test passes"}` | `+ move I3`; `+ move R→I3` | `I3=open`; `situation=plan` | `path=[R, I3]`; `applicable=[apply, stop]` |
| 12 | `[R,I3]` | `apply bash {command:"make test"}` (first plan item — the acceptance command) | `+ plan Q3`; `+ items Q3→a5`; `+ action a5 "make test"`; `+ obs o5 {command:"make test", exitCode:0}` | `a5=executed` | `lastResult={command:"make test", exitCode:0}` |
| 13 | `[R,I3]` | `stop {why:"the acceptance command passes"}` | `+ stop s4`; `+ stop I3→s4` | `I3=stopped`; `situation=transition` | `applicable=[move]` |
| 14 | `[R,I3] → [R,H]` | `move H {state:"finish"}` (no `what` — the terminal state) | `+ move H {state}`; `+ move R→H` | `H=open`; `situation=terminal` | `applicable=[stop]` |
| 15 | `[R,H]` | `stop {why:"done"}` | `+ stop s5`; `+ stop H→s5`; the request ends | `H=stopped`; `hasStopped(H)=true` | the session ends with reason `request_addressed` |

### 4.1 The final tree

After turn 15 the tree looks like this. The request's states hang off it as **flat
children** by a `move` edge, in walk order. Each state's plan hangs directly off its
`move` by a `plan` edge, and the plan's items are linked by `items` edges (the order is the
list, not the shape of the tree); the state is closed by a `stop` edge from its `move` to a
`stop` node. There is no request-level alternatives container and no `chosen` edge
anywhere: a container's order is its list, and the last child is the current one.

```
R  request "I broke the build; verify with make test"      (root: no plan, no stop)
│  move
├─▶ I0  move {state:"reproduction", what:"reproduce the failure: make test fails"}   stopped ✔
│      │  plan
│      └─▶ Q0  plan   [ a1 ]
│      │      └─ items ─▶ a1  action "make test"     executed → obs o1 (exit 1)
│      └─ stop ─▶ s1  stop {why:"the failure is reproduced"}
├─▶ I1  move {state:"localization", what:"name the file, the line and the exact change"}   stopped ✔
│      │  plan
│      └─▶ Q1  plan   [ a2, a3 ]
│      │      ├─ items ─▶ a2  action "grep …"        executed → obs o2
│      │      └─ items ─▶ a3  action "read …"        executed → obs o3 (ref@v1)
│      └─ stop ─▶ s2  stop
├─▶ I2  move {state:"patch", what:"apply the fix"}   stopped ✔
│      │  plan
│      └─▶ Q2  plan   [ a4 ]
│      │      └─ items ─▶ a4  action "edit …"        executed → mutates file v1→v2
│      └─ stop ─▶ s3  stop
├─▶ I3  move {state:"verification", what:"the acceptance command make test passes"}   stopped ✔
│      │  plan
│      └─▶ Q3  plan   [ a5 ]
│      │      └─ items ─▶ a5  action "make test"     executed → obs o5 (exit 0)
│      └─ stop ─▶ s4  stop
└─▶ H   move {state:"finish"}                       stopped ✔ (terminal; its stop ends the request)
       └─ stop ─▶ s5  stop
```

The order of a plan's items is given by the **list** (insertion order), not by the shape of
the tree: `items` edges show container membership, the list shows the sequence, and the
**last** child is the current one. At any moment the projection shows **not** this whole
tree, but only the message tape for the current state, the constraints and the admissible
moves. Everything else is one `recall`/`search` away.

### 4.2 What to notice in the main run

- **A state IS its goal.** `move { state, what }` carries both the island of work and the
  state's goal text; there is no separate goal node. The plan hangs off the `move`.
- **The first plan item is an ordinary tool call.** There is no dedicated concretization
  operator: the first `apply` after a `move` seeds the plan and is executed at once
  (turn 2, 5, 9, 12).
- **`stop` closes the state.** After a `stop` the state is finished; the only admissible
  move is the transition `move` (turns 3, 7, 10, 13). This is why the surface cannot keep
  offering work after a state is done.
- **There is no criterion gate.** `stop` is accepted on an open state; the doxa decides
  when the state's `Done when` holds (the observation instruction restates it after every
  tool result). A failed run is a fact, not a closure — doxa adds another step.
- **The request ends at the terminal state.** A `stop` on a working state does not end the
  request; only the terminal `finish` move's `stop` does (turn 15).
- **The model surface IS the frontier.** At the request it is `move`/`decline`; at an open
  state the apply vocabulary plus `stop`; at a finished state `move` only; at the terminal
  state `stop`; `recall`/`search` throughout.
- **Nothing happens "by itself".** The engine does not run the plan, does not close states
  on an exit code, and does not pick steps — each turn one or more moves are made by doxa.

### 4.3 How the tree is arranged: plan, alternatives and `stop`

**Plan.** A state has exactly one plan: a `plan` edge runs from the `move` to a `plan`
node, and the plan's items are linked to the plan by `items` edges. The order of the items
is given not by the edges but by the **list** of children of the `plan` node: the edges
show membership, the list shows the sequence. There is **no `chosen` edge**: the current
item of a container is simply its **last** child. A plan item is always an action
(`action`); a state can never be a plan item.

**Alternatives.** An `alternatives` container is the way to "redo without rewriting". It
hangs off a **plan item** (the revision history of a step that did not work). There is no
`chosen` edge: the **current option is the last child**; the rest are simply not current
and stay in the tree as "what did not work".

When doxa runs a command **different** from the current unfulfilled item, the engine does
not rewrite the item; it hangs an `alts` edge on it and adds the new action as the
**newest (last) option**:

```
state (move)
│  plan
└─▶ Q  plan   [ list of items: s, … ]
       │
       └─ items ─▶ s  action "cat HACKING.adoc"          (did not work)
                  │  alts
                  └─▶ a'  action "make test"  (newest = current; runs)
```

**`stop`.** The `stop` move operates **on a state**. The engine appends a `stop` node and
draws a `stop` edge from the state's `move` to that node — that is how the state is marked
closed; the stop is not a plan item. There is no criterion gate: `stop` is accepted on an
open state. A `stop` on a working state forces the transition (the next admissible move is
`move`); a `stop` on the terminal `finish` move ends the request. There is no `stop` on
the request.

---

## 5. Special cases

The main run never met four situations. We look at them separately, each as a short
fragment.

### 5.1 A non-actionable request (`decline`)

A request like "hello, uncle Vasya" contains no actionable task. Doxa does not invent a
state; it declines.

| Turn | Stack | Doxa proposal | Journal / tree change | Derived facts | Projection (what doxa sees) |
|---|---|---|---|---|---|
| 0 | `[R]` | — *(the arbiter sets the request)* | `+ request R {text}` | `rootId=R` | `applicable=[move, decline]` |
| 1 | `[R]` | `decline {why:"there is no actionable task in the request"}` | `+ unactionable U {why}`; `+ unactionable R→U`; the run ends | the request has no state; `unactionableOf(R)=U` | the session ends; the request carries the `unactionable` note |

`decline` is accepted only at a **fresh** request (one with no state and no `unactionable`
yet). It closes nothing: it records that the request's intent is not actionable and the run
stops there.

Note the counterpart rule: **a failing command is not a closure.** After a failure doxa
keeps working in the same state (it adds steps and re-runs, as in §4); `stop` is a
deliberate decision, and it does not re-interpret the request.

### 5.2 The corrective cycle: a failed verification returns to localization

The `verification` island's transition carries a corrective edge: when the acceptance
command fails, the next state is `localization`, with the new evidence. Doxa does not
rewrite the state — it `stop`s the verification state and `move`s to a new localization
state.

| Turn | Stack | Doxa proposal | Journal / tree change | Derived facts | Projection (what doxa sees) |
|---|---|---|---|---|---|
| k | `[R,I3]` | `apply bash {command:"make test"}` | `+ action`; `+ obs {command:"make test", exitCode:1}` | `I3` stays `open` | the failure; the acceptance command still fails |
| k+1 | `[R,I3]` | `stop {why:"it still fails; back to localization"}` | `+ stop`; `+ stop I3→stop` | `I3=stopped`; `situation=transition` | `applicable=[move]` |
| k+2 | `[R,I3] → [R,I4]` | `move I4 {state:"localization", what:"name the change given the new failure"}` | `+ move I4`; `+ move R→I4` | `I4=open`; `situation=plan` | `path=[R, I4]` |

**States are flat children of the request**: a new state enters as a fresh `move` child of
the request, never nested inside another state. The failed `verification` state stays in
the tree as "what did not work"; the walk continues from the new localization state.

### 5.3 A non-decisive run (a timeout)

| Turn | Stack | Doxa proposal | Journal / tree change | Derived facts | Projection (what doxa sees) |
|---|---|---|---|---|---|
| 1 | `[R,I3]` | `apply bash {command:"make test", timeout:60000}` | run `make test`; the process is killed by the timeout; `+ obs{**no exitCode**}` | no verdict: `I3` stays `open` | `lastResult={command:"make test", error:"…timed out…"}`; the model may retry |
| 2 | `[R,I3]` | `apply bash {command:"make test"}` (retry) | a new observation | — | this is **not** a repeat: a timeout brought no knowledge |

`exitCode` is the whole "pass or not" signal. Its **absence** (a timeout, a signal without
a controlled exit) means "no verdict": the state stays `open`, and the model may repeat the
same command — an unfinished run is neither a repeat nor progress. A run is never a
closure oracle: a state is closed only by `stop`.

### 5.4 The world, versions and addressability

| Turn | Stack | Doxa proposal | Journal / tree change | Derived facts | Projection (what doxa sees) |
|---|---|---|---|---|---|
| r | `[R,I]` | `apply read runtime/shared_heap.c [10-80]` | `+ action`; `+ obs{ref, version:v1}`; `result` | `observed(file)=v1` | the window enters the tape as a `tool` result |
| e | `[R,I]` | `apply edit runtime/shared_heap.c` | `+ action`; `+ mutates`; `mutate v1→v2` | `currentVersion(file)=v2`; the `v1` read is now stale | the stale read is **not** shown as active content |
| q | `[R,I]` | `recall {id:"obs:…"}` | `+ action` (recall); `+ obs` (the body window); `result` | — | the recall renders as an `action` + `observation` on the state's tape |

A file changing emits `mutate` (a version bump); actualness is **computed**, not stored as
a flag. The `v1` read fact is not deleted — it simply stops belonging to the active
content, and stale content is never shown as active. Everything is addressable: a past
result's body is fetched by `id` with `recall`, without repeating the call. That is why a
repeated command with the same inputs and an unchanged world is refused — the knowledge
already exists, take it by address.

---

## 6. What this walkthrough illustrates

1. **The context is a projection, not a tape of the model's own words.** Every turn doxa
   sees a message tape rebuilt from the tree, not an accumulating transcript.
2. **Doxa proposes, logos decides.** Doxa chooses a move from the admissible ones; the
   rules and the derived facts decide whether it lands.
3. **There is exactly one closure: `stop`, and only the doxa's.** A state ends at its
   `stop`; the request ends when its terminal state is stopped, or when it is declined as
   non-actionable. There is no criterion gate.
4. **A state IS its goal.** `move { state, what }` declares the state and its goal; the
   plan hangs off the `move` and is seeded by the first `apply`.
5. **The model surface is the frontier.** At each situation the offered tools are exactly
   the admissible moves (`Context.applicable`), so a refused move is never offered.
6. **No truth on nodes.** Only `open` / `executed` / `stopped` plus the derived facts; a
   failure is a fact, not a status.
7. **The trace is monotone.** A revision or an added state only adds nodes; nothing is
   rewritten — the failed step stays visible as "what did not work", and the request's
   first state is created once via a `move`.
8. **Everything is addressable.** Result bodies live in the journal and are recalled by
   `id`; the context stays a bounded slice.
