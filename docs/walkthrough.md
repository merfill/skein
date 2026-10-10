# Skein — walkthrough: the tree and the context, step by step

> **Note (IR revision folded).** The tree drawn below predates the IR revision: the
> `alternatives` container is now the plan item `item` (`items`/`alts`), a goal's closure is
> a relation on the goal (not a plan item), and the context is a message tape. The current
> shape is `docs/ir_semantics.md`; the as-built is `docs/ir.md`. A full pass over this
> walkthrough is a follow-up.

> Russian mirror — `docs/walkthrough_ru.md`.

> **Goal reduction (`docs/plans/goal_reduction_plan.md`).** This walkthrough uses the
> pre-reduction vocabulary (criterion `done_when`, `step`, `revises`, `target`, `state`).
> In the reduced model a goal is `what` with a plan seeded by the first
> `command`, and it is closed by `stop` (no criterion gate); a run's `exitCode` is ordinary
> output. Read "criterion", "check", `done_when`, `step`, `target`/`checkReady` and `state`
> below as superseded; `docs/ir_operations.md` is the current reference.

## Preamble

**What Skein is.** Skein is a coding agent that keeps its knowledge not in a dialogue
with the model but in a **journal of facts**, and builds a **projection** of the current
state for the model on every turn — a precisely defined slice, not an accumulating
transcript. The model's context is a fresh projection each turn, not a message tape.

**Doxa and logos.** The conceptual frame is the split between *doxa* and *logos*:

- **doxa** is the language model. It invents well but is not responsible for the truth of
  what it invents, so it only *proposes* exactly one move per turn;
- **logos** is the deterministic engine together with the tools and the environment. It
  runs commands, records their results in the journal, recomputes the derived facts and
  builds the projection. Logos does not invent content — it decides whether a proposed
  move is admissible and what follows from it.

Hence the main principle: **doxa proposes, logos decides.** The model never declares the
work done by itself; the facts (above all a command's exit code) and the engine's rules
do.

**Arbiter.** Above doxa and logos stands the **arbiter**, an external authority. In the
current model it is the user (a human or the harness that scores the result). The arbiter
sets the very first request and accepts the final result from outside. It takes no part in
accepting individual goals: a goal is closed by the doxa's `stop`.

**What closes the work.** The only frame that can be closed is a **goal**. A goal is
closed **only by an explicit `stop`** — there is no criterion gate. The
request has no `stop` of its own: it is interpreted **exactly once** as a goal
(`has_goal`) or declined (`no_goal` → `unactionable`), and the run **ends when its goal is
stopped** (or when the request is declined).

**Why this document.** The formal documents describe the model in parts. Here **§4 is the
point**: one task is followed all the way through, from the request to closure, turn by
turn, showing what happens in the journal, in the tree, in the derived facts and in the
projection. §5 adds the special cases the main run does not meet (a non-actionable
request, a decomposed step, a timeout and a background job, file versions).

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
| **doxa** | the language model; it proposes exactly one move per turn |
| **logos** | the deterministic engine: it runs commands, keeps the journal, recomputes the facts, builds the projection |
| **arbiter** | the external authority: it sets the first request and accepts the final result from outside |

### 1.2 Data layers

| Term | Meaning |
|---|---|
| **journal** | the immutable list of events — the only source of truth; it is only appended to |
| **state** | the fold of the journal (`fold`): nodes, edges, container order, traversal stack, file versions |
| **projection**, a.k.a. **context** | the precisely defined slice of state that doxa sees on the current turn |
| **node** | an object of the tree: `request`, `goal`, `plan`, `action`, `observation`, `stop`, `constraint`, `file`, `unactionable` |
| **edge** | a link between nodes: `has_goal`, `no_goal`, `has_plan`, `item`, `has_alternatives`, `produces`, `has_stopped`, `mutates` |

### 1.3 Work

| Term | Meaning |
|---|---|
| **request** | the user's unstructured motivation; the root of the tree; it is interpreted **exactly once** as a goal (`has_goal`) or declined (`no_goal` → `unactionable`); it has no plan and no `stop`; the run ends when its goal is stopped |
| **goal** | an interpretation of the request or a subgoal: `what`; its plan is seeded with the first `command` |
| **plan** | a container of items; a plan item is always an **action**; the order is the list, and the **last** item is the current one |
| **action** | one command; executed one per turn |
| **observation** | a recorded result: a read window, a run's output, an exit code |
| **alternatives** | a container of options: a branched/decomposed item (a sub-goal becomes the item's newest alternative) |
| **`stop`** | the terminal move: it closes the focused goal |
| **`decline`** | the move that records a non-actionable request (`no_goal` → `unactionable`) and ends the run |

### 1.4 A run and its output

| Term | Meaning |
|---|---|
| **command** | the first plan item; one plain foreground shell command |
| **`exitCode`** | the exit code: `0` = pass, non-zero = fail, absent = no verdict (a timeout) — ordinary output, not a gate |

A run is an ordinary `observation`; nothing is closed by an exit code — the doxa decides
when a goal is done and calls `stop`.

### 1.5 Facts derived from the journal

| Fact | Meaning |
|---|---|
| **`actionExecuted`** | the action has a `produces` or `mutates` edge |
| **`hasStopped`** | the goal has a `has_stopped` edge to a `stop` node (it is closed) |

The request has no derived "settled" fact of its own: its completion is read straight from
its goal — the run ends when the goal is stopped.

### 1.6 Node status

A node has no stored status; the facts are derived:

- an action is `executed` once it produced a result;
- a goal is closed once it has a `has_stopped` edge.

There are no "achieved"/"refuted" statuses on nodes and no criterion.

### 1.7 Traversal and admissible moves

- **stack**, a.k.a. **branch** (`path`) — the path from the request to the current goal; the top of the stack is the **focus**;
- **cursor** — the index of the first unfulfilled plan item;
- **sibling row** — the ordered options of one level (plan items or alternatives); the **last** child is the current one;
- **admissible moves** (`applicable`) — the moves the rules permit at the current focus; doxa chooses one of them;
- **`descend` / `return`** — moving down the tree and returning a level up.

### 1.8 Refusals, the world, addressability

- **refusal** (`record_rejection`) — a record that a proposal was rejected, with a reason;
- **`mutate`** — an event that a file changed; it bumps the file's **version**;
- **witness** (`witness`) — a snapshot of file versions at the moment of a criterion run; staleness is computed from it;
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
        └──── one operator per turn, chosen from the admissible moves ──┘
```

- **Journal** — `Event[]`, the only truth (`add_node`, `add_edge`, `descend`, `return`,
  `mutate`, `record_rejection`).
- **State** — `fold(journal)`: nodes, edges, container order, the traversal stack, file
  versions. Nodes never change.
- **Context** — `project(state)`: the traversal branch (`path`) with its containers, the
  global constraints, the latest full result, the working set, the call summary, the
  admissible moves, the budget.
- **Doxa** — reads the `Context` and proposes exactly one operator (`create_goal` /
  `apply` / `stop` / `decline`; `recall`/`search` are read-only addressing).

Nothing doxa "thinks" is stored. The plan is a note to self; the trace is the tree.

## 3. Notation

| symbol | meaning |
|---|---|
| `R` | the root `request` |
| `I`, `G` | goals: the interpretation of `R`, a decomposed subgoal |
| `a1`, `a2` | plan items (`action`) |
| `obs` | an `observation` (a read window, a run's output together with its exit code) |
| `Aₛ`, `A_G` | `alternatives` containers (under a branched item `s`, under a goal `G`) |
| `→` | the focus moves; `+` a node/edge is created; `⟂` a refusal (`record_rejection`) |
| `closed` / `open` | a goal has / lacks a `has_stopped` edge |

---

## 4. The through-line example: one task from start to finish

This is the main section. The task:

> "I broke the build; verify with `make test`."

One constraint `k1` — do not touch the tests. The run lasts 11 turns (0–10). The first
attempt does not help; doxa **stays in the same goal** — it adds another step and re-checks
— and `stop`s the goal once the criterion passes. The run then ends because the goal is
stopped. Each row shows what doxa does, which event logos appends, how the tree grows,
which facts appear, and what doxa will see on the next turn.

| Turn | Stack | Doxa proposal | Journal / tree change | Derived facts | Projection (what doxa sees) |
|---|---|---|---|---|---|
| 0 | `[R]` | — *(the arbiter sets the request)* | `+ request R {text}` | `rootId=R` | `path=[R:open]`; `applicable=[create_goal, decline]` |
| 1 | `[R] → [R,I]` | `create_goal I` `{what:"fix the build so make test passes", done_when:"make test", plan:"reproduce, localize, fix, re-check", step:{command:"make test"}}` | `+ goal I`; `+ has_goal R→I`; `+ plan Q`; `+ has_plan I→Q`; `+ action a1 "make test"`; `+ item Q→a1`; `descend → I` | `I=open`; the request's interpretation is `I` | `path=[R, I]`; `I.done_when="make test"`; `I.plan.items=[a1:open]`; `applicable=[apply, create_goal]`; `nextAction=a1` |
| 2 | `[R,I]` | `apply run "make test"` (**no `target`** — reproduce) | run; `+ obs o1 {command:"make test", exitCode:1}`; `produces a1→o1` | `a1=executed`; the current item is now the last | `lastResult={command:"make test", exitCode:1}`; `calls=[run make test: fail]`; `applicable=[apply, create_goal]` |
| 3 | `[R,I]` | `apply grep "run-length"` (localize) | `+ action a2`; `+ item Q→a2`; `+ obs o2`; `produces a2→o2` | the current item moves to `a2` | `lastResult` — matches in `runtime/shared_heap.c`; `calls` grows |
| 4 | `[R,I]` | `apply read runtime/shared_heap.c [40-120]` | `+ action a3`; `+ item Q→a3`; `+ obs o3 {ref, version:v1}`; `produces a3→o3` | `observed(file)=v1` | `lastResult` — a code window; `shown=[o3]` |
| 5 | `[R,I]` | `apply edit runtime/shared_heap.c` (attempt #1) | `+ action a4 {find,replace}`; `+ mutates a4→file`; `+ item Q→a4`; `mutate v1→v2` | `currentVersion(file)=v2`; the read `o3` is stale | `lastResult={kind:"action", ref:"…"}`; `calls` |
| 6 | `[R,I]` | `apply run {target:"I"}` (first check) | run `I.done_when`; `+ action a5`; `+ item Q→a5`; `+ obs o5 {command:"make test", target:"I", exitCode:1, witness}`; `produces a5→o5` | `criterionFailed(I)=true`; `I` stays `open` | `lastResult={command:"make test", exitCode:1}`; `applicable=[apply, create_goal]` — keep working in the same goal |
| 7 | `[R,I]` | `apply read runtime/shared_heap.c [200-260]` (look closer) | `+ action a6`; `+ item Q→a6`; `+ obs o6 {ref, version:v2}`; `produces a6→o6` | `observed(file)=v2` | `lastResult` — a code window |
| 8 | `[R,I]` | `apply edit runtime/shared_heap.c` (attempt #2) | `+ action a7 {find,replace}`; `+ mutates a7→file`; `+ item Q→a7`; `mutate v2→v3` | `currentVersion(file)=v3`; the read `o6` is stale | `lastResult={kind:"action", ref:"…"}` |
| 9 | `[R,I]` | `apply run {target:"I"}` (second check) | run `I.done_when`; `+ action a8`; `+ item Q→a8`; `+ obs o8 {command:"make test", target:"I", exitCode:0, witness}`; `produces a8→o8` | `criterionPass(I)=true` | `lastResult={command:"make test", exitCode:0}`; `applicable=[apply, stop]`; `checkReady=true` |
| 10 | `[R,I]` | `stop {why:"the suite is green"}` (close `I`) | `+ stop s1`; `+ item Q→s1` (the plan's **last** item); `+ has_stopped I→s1`; the run ends | `I=stopped`; `hasStopped(I)=true` | the session ends with reason `request_addressed` |

### 4.1 The final tree

After turn 10 the tree looks like this. The request is linked to its single interpretation
by a `has_goal` edge. The goal has a `has_plan` edge to a `plan` node, and the plan's items
are a **list** of actions (the order is the list, not the shape of the tree); the plan's
**last** item is the `stop` node, and a `has_stopped` edge from the goal points at the same
node. There is no request-level alternatives container and no `chosen` edge anywhere: a
container's order is its list, and the last child is the current one.

```
R  request "I broke the build; verify with make test"      (root: no plan, no criterion, no stop)
│  has_goal
└─▶ I  goal "fix the build so make test passes"            (stopped ✔)
       │  has_plan
       ├─▶ Q  plan   [ list of items: a1, a2, a3, a4, a5, a6, a7, a8, s1 ]
       │      ├─ item ─▶ a1  action "make test"        executed → obs o1   (exit 1)
       │      ├─ item ─▶ a2  action "grep …"           executed → obs o2
       │      ├─ item ─▶ a3  action "read …"           executed → obs o3   (ref@v1)
       │      ├─ item ─▶ a4  action "edit …"           executed → mutates file v1→v2
       │      ├─ item ─▶ a5  action "run {target:I}"   executed → obs o5   (target:I, exit 1)
       │      ├─ item ─▶ a6  action "read …"           executed → obs o6   (ref@v2)
       │      ├─ item ─▶ a7  action "edit …"           executed → mutates file v2→v3
       │      ├─ item ─▶ a8  action "run {target:I}"   executed → obs o8   (target:I, exit 0)
       │      └─ item ─▶ s1  stop {why:"the suite is green"}   (the plan's LAST item)
       └─ has_stopped ─▶ s1  stop
```

The order of a plan's items is given by the **list** (insertion order), not by the shape of
the tree: `item` edges show container membership, the list shows the sequence, and the
**last** child is the current one. At any moment the projection shows **not** this whole
tree, but only the current branch, its containers, the latest result, the call summary and
the admissible moves. Everything else is one `recall`/`search` away.

### 4.2 What to notice in the main run

- **Turns 2, 6 and 9** all run `make test`, but turn 2 goes **without `target`** and turns 6
  and 9 **with `target:"I"`**. That is the distinction: an ordinary run is an observation
  (reproducing the failure), a run with `target` is a criterion. Without `target`,
  reproducing would not settle the goal before the fix.
- **Turn 6 does not close `I`.** Exit code `1` is a fact (`criterionFailed(I)`), not a
  sentence. The goal stays `open` and doxa **keeps working in the same goal**: it adds
  another step (turn 7) and another fix (turn 8), then re-checks (turn 9).
- **The interpretation is created once.** The request is interpreted exactly once
  (`has_goal`); after a failed criterion doxa does not re-interpret the request and does not
  rewrite the goal — it appends plan items. Re-interpretation is a deferred feature.
- **Turn 9 does not close `I`.** A criterion passing is only an exit code. Closure happens
  on turn 10 (`stop`). It is a uniform rule: work first, then `stop`.
- **The request has no `stop` of its own.** The run ends on turn 10 because the request's
  goal `I` is stopped (`request_addressed`). Acceptance of the request stays external — the
  arbiter does it.
- **Nothing happens "by itself".** The engine does not run the plan, does not close goals
  on an exit code, and does not pick steps — each turn exactly one move is made by doxa.

### 4.3 How the tree is arranged: plan, alternatives and `stop`

**Plan.** A goal has exactly one plan: a `has_plan` edge runs from the goal to a `plan`
node, and the plan's items are linked to the plan by `item` edges. The order of the items
is given not by the edges but by the **list** of children of the `plan` node: the edges
show membership, the list shows the sequence. There is **no `chosen` edge**: the current
item of a container is simply its **last** child. A plan item is always an action
(`action`); a subgoal can never be a plan item.

**Alternatives.** An `alternatives` container is the way to "redo without rewriting". It
hangs off a **goal** (approach options) or a **plan item** (the revision history of a step
that did not work). There is no `chosen` edge: the **current option is the last child**;
the rest are simply not current and stay in the tree as "what did not work".

When doxa runs a command **different** from the current unfulfilled item, the engine does
not rewrite the item; it hangs an `alternatives` container on it and adds the new action as
the **newest (last) option**:

```
goal
│  has_plan
└─▶ Q  plan   [ list of items: s, … ]
       │
       └─ item ─▶ s  action "cat HACKING.adoc"          (did not work)
                  │  has_alternatives
                  └─▶ As  alternatives   [ list of options: a', … ]
                             item ─▶ a'  action "make test"  (newest = current; runs)
```

Important: the engine **never "enters" an action** — it enters either a subgoal (the step's
newest alternative) or stays in place and advances the current item.

**`stop`.** The `stop` move operates **only on a goal**. The engine appends a `stop` node
as the goal's **last plan item** AND draws a `has_stopped` edge from the goal to that same
node — that is how the goal is marked closed. There is no criterion gate: `stop` is
accepted on an open goal. There is no `stop` on the request: the request ends (the run
ends) when its goal is stopped.

---

## 5. Special cases

The main run never met four situations. We look at them separately, each as a short
fragment.

### 5.1 A non-actionable request (`decline`)

A request like "hello, uncle Vasya" contains no actionable task. Doxa does not invent a goal;
it declines.

| Turn | Stack | Doxa proposal | Journal / tree change | Derived facts | Projection (what doxa sees) |
|---|---|---|---|---|---|
| 0 | `[R]` | — *(the arbiter sets the request)* | `+ request R {text}` | `rootId=R` | `applicable=[create_goal, decline]` |
| 1 | `[R]` | `decline {why:"there is no actionable task in the request"}` | `+ unactionable U {why}`; `+ no_goal R→U`; the run ends | the request has no goal; `unactionableOf(R)=U` | the session ends; the request carries the `unactionable` note |

`decline` is accepted only at a **fresh** request (one with no goal and no `unactionable`
yet). It closes nothing: it records that the request's intent is not actionable and the run
stops there.

Note the counterpart rule: **a failing command is not a closure.** After a failure doxa
keeps working in the same goal (it appends commands and re-runs, as in §4); `stop` is a
deliberate decision, and it does not re-interpret the request.

### 5.2 Decomposing a step into a subgoal

A step of the plan needs its own criterion. Doxa decomposes the **current step**, not the
whole goal.

| Turn | Stack | Doxa proposal | Journal / tree change | Derived facts | Projection (what doxa sees) |
|---|---|---|---|---|---|
| k | `[R,I]` | `create_goal G {what:"make the sub-suite pass", done_when:"ctest -R heap", plan:"…", step:{command:"ctest -R heap"}}` | `+ G`; `+ Aₛ` under the current step `s`; `+ item Aₛ→G`; `descend → G` | step `s` gets a new (newest) alternative `G`; `I`'s current item is still `s` | `path=[R, I, G]`; `I.plan.items=[s{alternatives:[G]}, …]` |
| k+1 | `[R,I,G]` | `apply run {target:"G"}` | `+ obs{target:"G", exitCode:0}` | `criterionPass(G)=true` | `applicable=[apply, stop]` |
| k+2 | `[R,I,G]` | `stop` (close `G`) | `+ stop` (G's last plan item); `+ has_stopped G→stop` | `G=stopped`; step `s` is fulfilled through its newest alternative | return to `I`; the current item advances past `s` |
| k+3 | `[R,I]` | continue `I`'s remaining plan … | … | | |

**A subgoal is never a plan item**: it enters only as the **newest alternative** of the
step it decomposes. The engine never "moves into an action" — it moves into the subgoal.
Step `s` is considered fulfilled when its newest (current) alternative is `stopped`, so
decomposing a step does not block the plan. `stop` on `G` closes only `G`; the engine
`return`s to `I` and continues.

### 5.3 An unfinished run and a background command

**E1. A criterion run that times out.**

| Turn | Stack | Doxa proposal | Journal / tree change | Derived facts | Projection (what doxa sees) |
|---|---|---|---|---|---|
| 1 | `[R,I]` | `apply run {target:"I"}` | run `make test`; the process is killed by the timeout; `+ obs{target:"I", **no exitCode**}` | no verdict: `I` stays `open` | `lastResult={command:"make test", error:"…timed out…"}`; the model may retry |
| 2 | `[R,I]` | `apply run {target:"I"}` (retry) | a new observation | — | this is **not** a repeat: a timeout brought no knowledge |

**E2. A long command in the background.**

| Turn | Stack | Doxa proposal | Journal / tree change | Derived facts | Projection (what doxa sees) |
|---|---|---|---|---|---|
| j | `[R,I]` | `apply run {command:"make bootstrap", background:true}` | `+ action`; `+ obs{job:"job-1", state:"running"}` | — | `lastResult={job:"job-1", state:"running"}` |
| j+1 | `[R,I]` | `apply run {job:"job-1"}` | `+ action "poll job-1"`; `+ obs{state, exitCode?}` | when the state is `done`, an `exitCode` appears | each poll reads new state, so it is never a repeat; a poll is never a criterion |

`exitCode` is the whole "pass or not" signal. Its **absence** (a timeout, a signal without
a controlled exit) means "no verdict": the goal stays `open`, and the model may repeat the
same criterion — an unfinished run is neither a repeat nor progress. A criterion is never
backgrounded (a `background_target` refusal): a check must reach a verdict within the
turn. A background command is an ordinary observation.

### 5.4 The world, versions and addressability

| Turn | Stack | Doxa proposal | Journal / tree change | Derived facts | Projection (what doxa sees) |
|---|---|---|---|---|---|
| r | `[R,I]` | `apply read runtime/shared_heap.c [10-80]` | `+ action`; `+ obs{ref, version:v1}`; `produces` | `observed(file)=v1` | `lastResult={ref:"…", output:"…"}` |
| e | `[R,I]` | `apply edit runtime/shared_heap.c` | `+ action`; `+ mutates`; `mutate v1→v2` | `currentVersion(file)=v2`; the `v1` read is now stale | the stale read is **removed** from `shown` |
| q | `[R,I]` | `recall {id:"obs:…"}` | no node; the body is returned | — | the body enters `shown` for a few turns |

A file changing emits `mutate` (a version bump); actualness is **computed**, not stored as
a flag. The `v1` read fact is not deleted — it simply stops belonging to the current
context, and stale content is never shown as active. Everything is addressable: a past
result's body is fetched by `id` with `recall`, without repeating the call. That is why a
repeated command with the same inputs and an unchanged world is refused — the knowledge
already exists, take it by address.

---

## 6. What this walkthrough illustrates

1. **The context is a projection, not a tape.** Every turn doxa sees the branch and its
   containers, not the transcript.
2. **Doxa proposes, logos decides.** Doxa chooses a move from the admissible ones; the
   rules and the derived facts decide whether it lands.
3. **There is exactly one closure: `stop`, and (for now) only a positive one.** A criterion
   passing is only an exit code; a goal ends when doxa proposes `stop` and the rule accepts
   it (a passing criterion). The request has no `stop` of its own — it ends when its goal is
   stopped, or when it is declined as non-actionable.
4. **A check is a criterion run**: an ordinary observation with `target` and `exitCode`.
   There is no `check` node, no verdict, no `under`.
5. **No truth on nodes.** Only `open` / `executed` / `stopped` plus the criterion facts; a
   failure is a fact, not a status.
6. **The trace is monotone.** A revision or an added step only adds nodes; nothing is
   rewritten — the failed step stays visible as "what did not work", and the request's
   interpretation is created once via `has_goal`.
7. **Everything is addressable.** Result bodies live in the journal and are recalled by
   `id`; the context stays a bounded slice.
