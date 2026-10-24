# Skein — walkthrough: the tree and the context, step by step

> **Current as of 2026-10-24.** A state (`move`) IS its goal: `move { state, what?, done?,
> notes? }` declares the island of work; `what` is the doxa's articulation (optional), `done`
> overrides the criterion (optional), and `notes` are recorded but never rendered. The state
> block renders **`island.what`**, not `move.what`; the per-turn tail carries the doxa's
> articulation (if any), the criterion and the closure. `Start state` / `Finish state` markers
> are **`system`**, the transition instruction is a `user` turn, and the request leads the tape
> on every turn. `recall`/`search` are offered only while a state is open; a failed Verification
> defaults to **Patch** (Localization only when the object/coordinates are in doubt), and the
> engine reverts the last Patch.
>
> The source of truth is `docs/ir_semantics.md`; the operator reference is
> `docs/ir_operations.md`; the projection is `docs/projection.md`; the as-built is `docs/ir.md`.
> Russian mirror — `docs/walkthrough_ru.md`.

## Preamble

**What Skein is.** Skein is a coding agent that keeps knowledge not in the chat with the model
but in a **journal of facts**, and on every turn builds a **projection** — a strictly defined
slice of the current state. The model's context is a fresh projection each turn, assembled from
the tree anew.

**Doxa and logos.** The idea comes from the *doxa*/*logos* opposition:

- **doxa** is the language model. It proposes well but does not own the truth of what it
  proposes, so it only *proposes* one or several moves per turn (a batch);
- **logos** is the deterministic engine with the tools and the environment. It runs commands,
  records results in the journal, recomputes derived facts and builds the projection. Logos
  invents no content — it decides whether a move is allowed and what follows from it.

Hence the rule: **the doxa proposes — logos decides.** The model never declares work done:
a state is closed by its `stop`, and a failure is an instrument fact, not a status.

**Arbiter.** Above doxa and logos sits the **arbiter** — an external instance (the user or the
harness). It issues the first request and accepts the result from outside; it takes no part in
closing individual states.

**What closes work.** The only closable frame is a **state**. It closes **only by an explicit
`stop`**; there is no criterion gate. The request has no `stop` of its own: it is interpreted
exactly once (`move` or `decline`), and the run ends when its terminal `end` state is stopped
(or the request is declined).

**Why this document.** The formal documents describe the model piece by piece. Here the point is
section 4: one task is traced end to end, with the journal, the tree, the derived facts and the
projection. Section 5 adds special cases (decline, the Verification correction cycle, timeout,
versions/addressing).

**How to read.** This is an illustration, not a second formalism. If text and code disagree,
the code and `docs/ir_semantics.md` win.

---

## 1. Concepts

### 1.1 Roles

| Term | Meaning |
|---|---|
| **doxa** | the language model; proposes one or more moves per turn (a batch) |
| **logos** | the deterministic engine: runs commands, keeps the journal, recomputes facts, builds the projection |
| **arbiter** | the external instance: issues the first request and accepts the final result from outside |

### 1.2 Data layers

| Term | Meaning |
|---|---|
| **journal** | an immutable event list — the only source of truth; append-only |
| **state** | the fold of the journal (`fold`): nodes, edges, container order, the walk stack, file versions |
| **projection**, also **context** | the strictly defined slice of the state the doxa sees this turn |
| **node** | a tree object: `request`, `move`, `plan`, `item`, `action`, `observation`, `stop`, `constraint`, `file`, `unactionable` |
| **edge** | a link between nodes: `move`, `plan`, `items`, `alts`, `result`, `mutates`, `stop`, `unactionable` |
| **world events** | `mutate` (a file changed), `revert` (the last Patch was rolled back) |

### 1.3 Work

| Term | Meaning |
|---|---|
| **request** | the user's unstructured motivation; the tree root; interpreted **exactly once** as a state (`move`) or declined (`unactionable`); it has no plan and no `stop`; the run ends when its terminal state is stopped |
| **state** (`move`) | an island of work: `state` (the island name) + optional `what` (the doxa's articulation), `done` (criterion override), `notes` (recorded, not rendered); a state IS its goal |
| **plan** | a container of items; a plan item is always an **action**; the list gives the order and the **last** item is current |
| **action** | one tool call (`read`/`grep`/`list`/`edit`/`write`/`bash`/`webfetch`/`apply_patch`); a turn may carry several — the engine runs them in order |
| **observation** | the recorded result: a read window, run output, exit code |
| **alternatives** | a container of variants: a revision of a plan item (a retry becomes the item's newest variant) |
| **`stop`** | the terminal move: closes the current state (or, in the terminal state, ends the request) |
| **`decline`** | the move that marks the request unactionable and ends the run |
| **`revert`** | an engine event: on a failed Verification transition it rolls the last Patch back and updates file versions |

### 1.4 A run and its output

| Term | Meaning |
|---|---|
| **action** | one tool call; the **first** call of a state seeds the plan and runs immediately |
| **`exitCode`** | the return code: `0` — success, non-zero — failure, absent — no verdict (timeout); ordinary output, not a gate |

A run is an ordinary `observation`; the exit code closes nothing — the doxa decides the state
is ready and calls `stop`.

### 1.5 Facts derived from the journal

| Fact | Meaning |
|---|---|
| **`actionExecuted`** | the action has a `result` or `mutates` edge |
| **`hasStopped`** | the state's `move` has a `stop` edge to a `stop` node (it is closed) |
| **file version** | raised by `mutate`; `revert` restores the pre-patch version |

The request has no "settled" fact of its own: its completion is read from the terminal state —
the run ends when the terminal `move` is stopped.

### 1.6 Node status

There is no stored node status; facts are derived:

- an action is `executed` once it produced a result;
- a state is closed once its `move` has a `stop` edge.

There are no "achieved"/"refuted" node statuses and no criterion gate.

### 1.7 Walk and applicable moves

- **stack** (or **path**) — the request plus the current state; the top is the **focus**;
- **cursor** — the index of the first unexecuted plan item;
- **sibling row** — ordered variants at one level; the **last** child is current;
- **applicable** — the moves allowed in the current focus; the tool surface is built from it:
  - request — `move` / `decline`;
  - open state — the state's `apply` vocabulary + `stop` + `recall` / `search`;
  - closed (awaiting transition) — only `move`;
  - terminal — `stop`;
- **`descend` / `return`** — moving the focus down the tree and back up.

### 1.8 Refusals, world and addressing

- **refusal** (`record_rejection`) — a record that a proposal was refused, with a reason;
- **`mutate`** — a file-change event; raises the **version**;
- **`revert`** — rolls the last Patch back on a failed `Verification → Patch/Localization`:
  files return to pre-patch, versions in the IR are updated;
- **`recall` / `search`** — addressed reading: a past result's body by `id` (window) or by
  pattern, without re-running the command; available only while a state is open.

---

## 2. Four levels in one picture

```
                    append-only        pure           pure
  doxa proposal ─▶ journal (Event[]) ──fold──▶ State ──project──▶ Context ──▶ doxa
       ▲                                                                  │
       └────────── one or more operators per turn, chosen from applicable moves ──┘
```

- **Journal** — `Event[]`, the only truth (`add_node`, `add_edge`, `descend`, `return`,
  `mutate`, `revert`, `record_rejection`).
- **State** — `fold(journal)`: nodes, edges, container order, the walk stack, file versions.
- **Context** — `project(state)`: the message tape, the situation, constraints, the frontier,
  the situation instruction.
- **Doxa** — reads `Context` and proposes operators (`move` / `apply` / `stop` / `decline`;
  `recall`/`search` are read-only addressing, while a state is open).

Nothing the doxa "thinks" is stored. The plan is its note; the trace of work is the tree.

## 3. Notation

| symbol | meaning |
|---|---|
| `R` | the root `request` |
| `I`, `I0`, `I1`, `H` | states (`move`): the island focus and the terminal `end` |
| `a1`, `a2` | plan items (`action`) |
| `obs` | `observation` (read window, run output with the exit code) |
| `→` | the focus moves; `+` a node or edge is created; `⟂` a refusal |
| `open` / `executed` / `stopped` | the three displayed states (`stateOf`) |

---

## 4. End-to-end example: one task from start to finish

The task:

> "I broke the build; make `make test` pass."

One constraint `k1` — do not touch the tests. Route:
`O → L → P → V (fail) → P → V (pass) → End`. The run lasts 21 turns (0–20). The first
Verification fails: the engine reverts the Patch and moves the work into a new Patch; the
second Verification passes. Each row shows the doxa's proposal, the journal event, the tree
growth, the derived facts and what the doxa sees next.

| Turn | Stack | Doxa proposal | Journal / tree change | Derived facts | Projection (what the doxa sees) |
|---|---|---|---|---|---|
| 0 | `[R]` | — *(the arbiter issues the request)* | `+ request R {text}` | `rootId=R` | `situation=request`; `applicable=[move, decline]` |
| 1 | `[R] → [R,I0]` | `move I0 {state:"orientation"}` | `+ move I0`; `+ move R→I0` | `I0=open`; `situation=plan` | `Start state Orientation`; Workspace map; instruction; `what: name the workspace root… acceptance…` |
| 2 | `[R,I0]` | `stop {why:"/app is the repo; acceptance is make test"}` | `+ stop s0`; `+ stop I0→s0` | `I0=stopped`; `situation=transition` | `Finish state Orientation — …`; `applicable=[move]` |
| 3 | `[R,I0] → [R,I1]` | `move I1 {state:"localization"}` | `+ move I1`; `+ move R→I1` | `I1=open`; `situation=plan` | `Start state Localization`; map + Environment; `what: find the target…` |
| 4 | `[R,I1]` | `apply grep {pattern:"def parse"}` *(first item)* | `+ plan Q1`; `+ items Q1→a1`; `+ action a1`; `+ obs o1` | `a1=executed`; `situation=working` | `lastResult` — matches; `applicable=[apply, stop, recall, search]` |
| 5 | `[R,I1]` | `apply read src/parse.py [40-90]` | `+ action a2`; `+ items Q1→a2`; `+ obs o2 {version:v1}` | `observed(file)=v1` | `lastResult` — the code window |
| 6 | `[R,I1]` | `stop {why:"line 63 drops the last token — off-by-one in the loop"}` | `+ stop s1`; `+ stop I1→s1` | `I1=stopped`; `situation=transition` | `Finish state Localization — …`; `applicable=[move]` |
| 7 | `[R,I1] → [R,I2]` | `move I2 {state:"patch"}` | `+ move I2`; `+ move R→I2` | `I2=open`; `situation=plan` | `Start state Patch`; map; `what: make the named change…`; tail with the criterion |
| 8 | `[R,I2]` | `apply edit src/parse.py {old,new}` *(first item)* | `+ plan Q2`; `+ items Q2→a3`; `+ action a3`; `+ mutates a3→file`; `mutate v1→v2` | `currentVersion(file)=v2` | `lastResult` — the change is applied |
| 9 | `[R,I2]` | `stop {why:"the change is in the workspace"}` | `+ stop s2`; `+ stop I2→s2` | `I2=stopped` | `Finish state Patch — …`; `applicable=[move]` |
| 10 | `[R,I2] → [R,I3]` | `move I3 {state:"verification"}` | `+ move I3`; `+ move R→I3` | `I3=open`; `situation=plan` | `Start state Verification`; Environment; `what: check the changed artifact…` |
| 11 | `[R,I3]` | `apply bash {command:"make test"}` *(first item)* | `+ plan Q3`; `+ items Q3→a4`; `+ action a4`; `+ obs o4 {exitCode:1}` | `a4=executed` | `lastResult` — `make test` failed (literal) |
| 12 | `[R,I3]` | `stop {why:"make test: exit 1 — <literal failure>"}` | `+ stop s3`; `+ stop I3→s3` | `I3=stopped`; `situation=transition` | `Finish state Verification — …`; `applicable=[move]` |
| 13 | `[R,I3] → [R,I4]` | `move I4 {state:"patch"}` | `+ revert {files, v2→v1}`; `+ move I4`; `+ move R→I4` | `currentVersion(file)=v1`; `I4=open` | `Start state Patch`; above on the tape — `Finish state Verification — <literal why>`; the failed Verification's plan is elided; `applicable=[apply, stop, recall, search]` |
| 14 | `[R,I4]` | `apply edit src/parse.py {old2,new2}` *(a different diff)* | `+ plan Q4`; `+ items Q4→a5`; `+ action a5`; `+ mutates`; `mutate v1→v3` | `currentVersion(file)=v3` | `lastResult` — the change is applied |
| 15 | `[R,I4]` | `stop {why:"a different change is in the workspace"}` | `+ stop s4`; `+ stop I4→s4` | `I4=stopped` | `Finish state Patch — …` |
| 16 | `[R,I4] → [R,I5]` | `move I5 {state:"verification"}` | `+ move I5`; `+ move R→I5` | `I5=open`; `situation=plan` | `Start state Verification`; Environment |
| 17 | `[R,I5]` | `apply bash {command:"make test"}` | `+ plan Q5`; `+ items Q5→a6`; `+ action a6`; `+ obs o6 {exitCode:0}` | `a6=executed` | `lastResult` — `make test` passed |
| 18 | `[R,I5]` | `stop {why:"the acceptance command passes"}` | `+ stop s5`; `+ stop I5→s5` | `I5=stopped`; `situation=transition` | `Finish state Verification — …`; `applicable=[move]` |
| 19 | `[R,I5] → [R,H]` | `move H {state:"end"}` | `+ move H`; `+ move R→H` | `H=open`; `situation=terminal` | `Start state End`; `applicable=[stop]` |
| 20 | `[R,H]` | `stop {why:"request complete"}` | `+ stop s6`; `+ stop H→s6`; the run ends | `H=stopped`; `hasStopped(H)=true` | the session ends with `request_addressed` |

On turn 13 the engine writes `revert` **before** entering the new Patch: the last Patch is
rolled back, the tree returns to pre-patch. The failure stays on the tape in the closed
`Patch`/`Verification` `Finish` lines (the literal `stop.why`); closed states' plans are
elided, and the current implementation renders no separate `Previous failed attempt` block.

### 4.1 The final tree

The request's states hang as **flat children** by the `move` edge, in walk order. Plans hang on
`move`; failed states stay closed in the tree ("what did not work"), and `revert` deletes no
events — it only restores files and versions.

```
R  request "I broke the build; make test must pass"         (root: no plan, no stop)
│  move
├─▶ I0  move orientation                                  stopped ✔
│      └─ stop ─▶ s0
├─▶ I1  move localization                                 stopped ✔
│      │  plan
│      │   ├─ items ─▶ a1 grep        executed → obs o1
│      │   └─ items ─▶ a2 read        executed → obs o2 (v1)
│      └─ stop ─▶ s1
├─▶ I2  move patch                                        stopped ✔
│      │  plan
│      │   └─ items ─▶ a3 edit        executed → mutates (v1→v2)
│      └─ stop ─▶ s2
├─▶ I3  move verification                                 stopped ✔ (failed)
│      │  plan
│      │   └─ items ─▶ a4 bash "make test"  executed → obs o4 (exit 1)
│      └─ stop ─▶ s3
│      ┆  revert: v2→v1 (on the I3→I4 transition)
├─▶ I4  move patch                                        stopped ✔
│      │  plan
│      │   └─ items ─▶ a5 edit        executed → mutates (v1→v3)
│      └─ stop ─▶ s4
├─▶ I5  move verification                                 stopped ✔
│      │  plan
│      │   └─ items ─▶ a6 bash "make test"  executed → obs o6 (exit 0)
│      └─ stop ─▶ s5
└─▶ H   move end                                          stopped ✔
       └─ stop ─▶ s6
```

On the tape a closed state is the compact record `Start state <label>` / instruction /
`what: <island.what>` / `Finish state <label> — <why>`: the plan and the brief are elided, the
instruction stays. The plan and the rest are available only in an open state (or via `recall`).

### 4.2 What to notice

- **A state IS its goal.** `move` declares the island; the state block renders `island.what`.
  `move.what` is the doxa's articulation and goes to the per-turn tail, not the block.
  `move.done` overrides the criterion in the tail; `notes` are recorded but not rendered.
- **The first plan item is an ordinary tool call.** There is no separate concretization
  operator: the first `apply` after `move` seeds the plan and runs immediately (turns 4, 8, 11,
  14, 17).
- **Batching is allowed.** A turn may propose several independent calls; the engine runs them
  in order and returns N results. `move` and `stop` are never batched.
- **`stop` closes the state.** After `stop` the only applicable move is `move` (turns 2, 6, 9,
  12, 15, 18). The terminal `stop` on `end` ends the request (turn 20).
- **There is no criterion gate.** `stop` is accepted on an open state; the doxa decides when
  the criterion holds (the tail repeats it after every result). A failure is a fact, not a
  closure.
- **A failed Verification defaults to Patch.** The engine reverts the last Patch (`revert`) and
  the new Patch starts from the pre-patch tree. The failure stays on the tape in the closed
  `Patch`/`Verification` `Finish` lines (the literal `why`); the current implementation renders
  no separate `Previous failed attempt` block. Localization is chosen only when the failure
  points at a different object/coordinates.
- **The model surface is the frontier.** Request — `move`/`decline`; open state — applies +
  `stop` + `recall`/`search`; closed — only `move`; terminal — `stop`.
- **Nothing decides by itself.** The engine does not run the plan or close states on an exit
  code; its only intervention is the deterministic `revert` on a failed Verification.

### 4.3 Plan, alternatives and `stop`

**Plan.** A state has exactly one plan: a `plan` edge from `move` to the `plan` node; items are
linked by `items` edges. The order is the **list** of the plan's children; the current item is
the **last** child. A plan item is always an action.

**Alternatives.** The `alternatives` container hangs on a plan item (the revision history of a
step that did not work). The current variant is the last child; the rest stay in the tree as
"what did not work".

```
state (move)
│  plan
└─▶ Q  plan   [ item list: s, … ]
       │
       └─ items ─▶ s  action "cat HACKING.adoc"          (did not work)
                  │  alts
                  └─▶ a'  action "make test"  (newest = current; runs)
```

**`stop`.** It acts on the state: a `stop` node + a `stop` edge from the `move`. `stop` is not
a plan item; there is no gate. On a working state it forces a transition (only `move`); on
`end` it ends the request. The request has no `stop`.

---

## 5. Special cases

### 5.1 Unactionable request (`decline`)

A request like "hello there" has no actionable task. The doxa invents no state; it declines.

| Turn | Stack | Doxa proposal | Journal / tree change | Derived facts | Projection |
|---|---|---|---|---|---|
| 0 | `[R]` | — *(the arbiter issues the request)* | `+ request R {text}` | `rootId=R` | `applicable=[move, decline]` |
| 1 | `[R]` | `decline {why:"there is no actionable task"}` | `+ unactionable U {why}`; `+ unactionable R→U`; the run ends | the request has no state; `unactionableOf(R)=U` | the session ends; the request keeps the mark |

`decline` is accepted only on a **fresh** request. A failed command is **not** a `stop`: the
doxa keeps working in the same state (adds items and checks again).

### 5.2 Failed Verification: Patch by default and revert

A failed acceptance does not close Verification "by itself" — the doxa's `stop` does (turn 12).
On the `Verification → Patch/Localization` transition the engine:

1. writes a `revert` event for the last Patch (files to pre-patch, versions updated);
2. makes the new `move` a flat child of the request;
3. leaves the failure on the tape in the closed `Patch` and `Verification` `Finish` lines (the
   literal `stop.why`). Closed states' plans are elided, and the current implementation renders
   **no** separate `Previous failed attempt` block.

**Localization** is chosen only when the failure points at a different object/coordinates;
otherwise Patch. If the revert is impossible (`write`/`apply_patch` without a preimage), the
engine leaves the change in the tree and prints no separate warning; the failure is still
visible in the `Finish` lines. This is a known gap — see the handoff.

### 5.3 Non-deciding run (timeout)

| Turn | Stack | Doxa proposal | Journal / tree change | Derived facts | Projection |
|---|---|---|---|---|---|
| 1 | `[R,I3]` | `apply bash {command:"make test", timeout:60000}` | `+ obs {**no exitCode**}` | no verdict: `I3` stays `open` | `lastResult={command, error:"…timed out…"}`; may retry |
| 2 | `[R,I3]` | `apply bash {command:"make test"}` (retry) | a new observation | — | a timeout brought no knowledge |

`exitCode` is the main "passed/failed" signal. Its absence means "no verdict": the state stays
open and a retry is allowed. A run never closes a state.

### 5.4 World, versions and addressing

| Turn | Stack | Doxa proposal | Journal / tree change | Derived facts | Projection |
|---|---|---|---|---|---|
| r | `[R,I]` | `apply read src/parse.py [10-80]` | `+ action`; `+ obs{ref, version:v1}`; `result` | `observed(file)=v1` | the window enters the tape as a `tool` result |
| e | `[R,I]` | `apply edit src/parse.py` | `+ action`; `+ mutates`; `mutate v1→v2` | `currentVersion=v2`; the `v1` read is stale | stale content is **not** shown as active |
| v | `[R,I]` | `stop` → `move` after a failed Verification | `+ revert`; versions back | `currentVersion=v1` | the failure in the `Finish` lines; no separate block |
| q | `[R,I]` | `recall {id:"obs:…"}` | no node; the body returns | — | the body enters as a transient `tool` result |

A file change emits `mutate`; freshness is **computed**, not stored as a flag. `revert`
restores files and versions without deleting events. `recall`/`search` are available only while
a state is open; a repeated command with the same inputs and an unchanged world is refused —
the knowledge is already there, take it by address.

---

## 6. What this walkthrough illustrates

1. **Context is a projection, not the model's own word tape.** Every turn builds a fresh tape
   from the tree.
2. **The doxa proposes — logos decides.** A move is chosen from the applicable set; rules and
   facts decide whether it happens.
3. **Closing is exactly one `stop`, and only by the doxa.** The request ends on the terminal
   `end`'s `stop` (or `decline`).
4. **A state IS its goal.** `move { state }` declares the island; the block renders
   `island.what`; `move.what` is the articulation and `move.done` is the criterion override.
5. **The model surface is the frontier.** Request — `move`/`decline`; open — applies + `stop` +
   `recall`/`search`; closed — only `move`; terminal — `stop`.
6. **Nodes hold no truth.** There are `open`/`executed`/`stopped` and derived facts; a failure
   is a fact, not a status.
7. **The trace is monotone.** Nothing is rewritten; a failed step stays visible, and `revert`
   is a deterministic engine event, not history deletion.
8. **Everything is addressable.** Result bodies live in the journal and are recalled by `id`;
   the context stays a bounded slice.
