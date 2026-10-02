# Skein — IR: formal semantics

> Russian mirror — `docs/ir_semantics_ru.md`.

Related documents:

- `docs/logos_ir.md` — the foundation: doxa and logos, goals, gap analysis.
- `docs/ir.md` — **as-built**: how the IR is arranged in the current code.
- `docs/fix_ocaml_gc_ideal.md` — the model instance: a reference trajectory.
- `docs/plans/implementation_plan.md` — stages and status.

This is the **source of truth about the IR semantics**. The code follows it, not the
other way around. A change to the code's behavior goes:

1. change the semantics here (a new/changed operator or rule);
2. change the code;
3. a test encoding the invariant this change preserves.

Without step 1, step 2 is not done.

**Status.** The document describes the currently agreed model. The current code is
arranged differently (it has `claim`/`decision`/modes); the divergences are the
subject of bringing the code to the semantics, not a fault of the document. The exact
state of the code is `docs/ir.md`.

---

## 0. The principle: semantics is an operation on the IR tree

Everything that happens in the system is described **as an operation on the IR tree**.
Not "what the agent does in general", but:

- which **nodes** and **edges** are created;
- where the **current node** moves (the focus of work);
- which **derived state predicates** change (but are not stored);
- what the **next projection** shows (i.e. the model on the next step);
- which **invariants** are preserved.

This applies to the doxa's actions, the logos' reactions, and the arbiter's verdicts
alike. New behavior is a new operation, described by this template, not a direct edit
of the state bypassing the journal.

The tree is not a given but the trace of operations. It branches where the agent
chooses an approach (alternative goals) and grows deeper where a goal is unfolded
into items.

---

## 1. Roles

| Role | Who | Does | Does not |
|---|---|---|---|
| **Doxa** | LLM | proposes exactly one operator per turn | issue verdicts, infer |
| **Logos** | the deterministic engine, **including the environment and tools** | executes commands; places nodes and edges from the results; recomputes the derived view; builds the projection | infer truth; choose among equals |
| **Arbiter** | external (in Skein — a human; objective — the toolchain) | the first goal, verdict, stopping, root closure; the choice when no criterion exists | produce content |

There is no protocol/environment as a separate role: execution and recording are part
of the logos. The logos' internal operators are `o_rev` (recompute on change), `o_def`
(cancel/refute), `o_ctx` (projection). There is no preference operator (`o_spec`): we
have no defaults or specificity, so there is nothing to prefer.

Key consequences:

- **doxa only proposes.** Any of its proposals enters as a proposal (a goal is unclosed,
  an action is without a result), but never at once as an established fact;
- **choosing is from the applicable.** The logos deterministically supplies the
  *applicable* moves at the current traversal point (§2.6); the doxa picks one of them
  and fills it with content. Equally consistent hypotheses (no criterion) are decided
  by the **Arbiter**;
- **a verdict is the arbiter's alone.** "Pass/fail" is given by the toolchain (test,
  typechecker) or the user; the doxa and logos do not do it.

---

## 2. The IR tree

### 2.1 Nodes

| kind | space | meaning |
|---|---|---|
| `goal` | work | a goal: what to achieve (the plan is optional) |
| `action` | work | a command (a plan item) |
| `plan` | work | a plan container: ordered items (≥1) |
| `alternatives` | work | a container of approach options (≥1) |
| `observation` | work | the result of a command (an observation output) |
| `check` | work | the arbiter's verdict (payload: `pass`/`fail`/`inconclusive`) |
| `complete` | work | a goal closure by the doxa (an assumption) |
| `constraint` | work | a prohibition (payload `forbid`: path regexes) |
| `file` | artifact | a pointer to a file |

There are no separate `claim`, `decision`, `subgoal` kinds:

- **a rationale** is the goal's `why` field (human-readable text); **an assumption** is
  a goal that a closure references via the `under` edge (§6), not a separate kind;
- **a fact from an observation** — a command result (`observation`), not a doxa node;
- **subgoal** — a goal; there is no separate kind;
- **decision** — not a doxa node: the logos or the Arbiter chooses.

### 2.2 Goal

A goal carries fields:

- `what` — what to achieve;
- `why` — a human-readable rationale ("why"); may be empty; the formal assumptions are
  the `under` references at the closing node (§6);
- `done_when` — the completion condition: **objective** (a command with a verdict) or
  **subjective** (a formulation).

The plan is a **separate node** `plan`, linked to the goal by the `has_plan` edge. A
goal may lack it: the absence of a plan means "the plan is not specified yet". A
`plan` node, if present, always carries **at least one item**.

A **plan item** is a `goal` (subgoal) or an `action` (command); the items of a `plan`
node are ordered by their position in the child list. A subgoal-item may have no plan
of its own — then it is unspecified too.

**Alternatives** — the goal's second container: an `alternatives` node, linked to the
goal, holds approach options (`goal` items). It appears **lazily** — not when the goal
is created, but when the current approach has failed and a new candidate is proposed.
The chosen (current) option is the one the traversal descended into (the `chosen` edge,
§2.6); the rest are `abandoned` (derived). The options are proposed by the doxa, not by
the Arbiter.

### 2.3 Edges

| kind | from → to | meaning |
|---|---|---|
| `has_plan` | `goal` → `plan` | the goal's plan (optional) |
| `item` | `plan` / `alternatives` → `goal` / `action` | an item/option (order = position) |
| `has_alternatives` | `goal` → `alternatives` | a container of approach options |
| `chosen` | `alternatives` → `goal` | the chosen (current) approach option |
| `under` | `check` / `complete` → `goal` | an assumption a closure rests on |
| `produces` | `action` → `observation` / `check` | a command result |
| `verifies` | `check` → `goal` | the check's verdict about the goal |
| `closes` | `complete` → `goal` | a goal closure by the doxa |
| `mutates` | `action` → `file` | the command changed the file (with a version) |

Edges do **not** carry item/option order: it is set by the position in the container's
(`plan` / `alternatives`) child list. Edges give structure, the list gives traversal
order. A plan item may be a subgoal without a plan of its own (unspecified).

### 2.4 The current node

At every moment there is a **current node** — the focus of work; all doxa operators are
relative to it. The focus is set by the **traversal stack** (§2.6): the path from the
root to the current goal. The mechanics of descent/return are there too.

### 2.5 State is derived

Nodes have **no stored statuses**: nodes do not change. State is predicates computed in
the projection from incident event nodes:

- an action is `executed` ⇔ it has a produced child (`produces`/`mutates`); otherwise
  the item is merely planned;
- a goal is `achieved` ⇔ it is closed by a `check` with verdict `pass` and **without**
  `under` edges;
- a goal is `achieved_under` ⇔ it is closed by a `check` (`pass`, with `under`) or by a
  `complete` node;
- a goal is `refuted` ⇔ it is closed by a `check` with verdict `fail`;
- a goal with a `check` `inconclusive` stays `open` (it needs the Arbiter);
- a goal is `abandoned` ⇔ it is an option in `alternatives` that was not pursued (a
  sibling has the `chosen` edge);
- otherwise the goal is `open`.

These are `project` rules, not fields. Only the journal is monotone (§3).

### 2.6 The stack and traversal

Traversal is the deterministic part of the logos. It does **not choose** what to do; it
computes the *applicable* moves at the current point; the choice among them is the
doxa's (§7).

The **stack** `S = [G₀ … G_k]` is the path from the root to the current goal; `G₀` is
the root. The **cursor** `cursor(G)` is a **derived** number: the index of the first
**unperformed** plan item of `G`, left to right. An item is performed if it is an
`action` with a produced child (`observation`/`check`/`mutate`) or a `goal` in the
state `achieved`/`achieved_under`/`refuted`/`abandoned`. No plan — no items. The
**current node** = `G_k`.

Neither the stack nor the cursor is stored as a field: the stack is the fold of the
focus events `descend`/`return` (append-only journal), the cursor is computed from the
plan.

**Movement (deterministic logos):**

- **advance** — executing an `action` item does not change the stack, the cursor shifts
  by itself;
- **descend** `descend(G → H)`: if the first unperformed item of `G`'s plan is a
  subgoal `H`, push `H`, focus → `H`;
- **return** `return`: pop the top, focus → the parent. It happens when the current goal
  **has closed** (a `check` gave a verdict or a `complete` closed it) or by `W`'s
  decision (change of branch). A return from the root is impossible.

**Applicable at the point `G`** (what the doxa sees as the frontier):

- there is an unperformed `action` item → `apply` (execute it);
- the first unperformed item is a subgoal `H` → `descend` into `H`;
- all items are performed and `G` is not closed: an objective `done_when` → `apply` (a
  check); a subjective one → `complete`;
- the plan is incomplete → `create goal` (add a subgoal) / `apply` (add a command);
- the branch is refuted and `alternatives` exist → pick an option;
- nothing to do and the goal does not close → `return`.

**Alternatives.** The option is proposed by the doxa; the chosen one is the one descended
into (`chosen` is set, the rest are derived `abandoned`). Switching options is also a
doxa proposal; the Arbiter intervenes only when no formal criterion exists.

**Closure through an option.** If a goal has a chosen option and it is `achieved`, the
goal is `achieved` (under its assumptions); if all options are refuted, the goal is
`refuted`.

**Example** (fix-ocaml-gc; the stack's top is on the right; `→` = change of focus):

| Turn | Stack | Doxa proposal | Logos | Tree |
|---|---|---|---|---|
| 0 | `[G0]` | — *(the Arbiter)* | — | root `G0` "fix the bootstrap", `done_when` = the criterion |
| 1 | `[G0]→[G0,G1]` | `create goal G1` "reproduce" (plan `[A1 run build]`) | accepted | `item G0→G1`; `plan Q1` with `A1`; descend |
| 2 | `[G0,G1]` | `apply A1` | executed | `A1` executed + `observation`; `cursor(G1)` shifted |
| 3 | `[G0,G1]→[G0]` | `complete G1` | accepted | `complete`→`G1`; `G1` `achieved_under`; return |
| 4 | `[G0]→[G0,G2]` | `create goal G2` "localize" | accepted | `item G0→G2`; descend |
| 5 | `[G0,G2]` | `apply` `read shared_heap.c` | executed | `observation` + `file`@`V1` |
| 6 | `[G0,G2]` | `apply` the same `read` (the same `V1`) | **refusal** `record_rejection` | no new node; the repeat counter grows (§2.7) |
| 7 | `[G0,G2]→[G0]` | `complete G2` | accepted | `complete`→`G2`; return |
| 8 | `[G0]→[G0,G3]` | `create goal G3` "fix" (`why` = hypothesis, `done_when` = the build) | accepted | `item G0→G3`; descend |
| 9 | `[G0,G3]` | `apply` `edit` | executed | `action` + `mutate V1→V2` |
| 10 | `[G0,G3]` | `apply` a check | executed | `check` `verifies→G3`, `under→G2` |
| 11 | `[G0,G3]→[G0]` | *(pass)* | derived | `G3` `achieved_under`; return |
| 11b | `[G0,G3]→[G0,G3']` | *(fail)* the doxa proposes an option | accepted | `G3` `refuted`; `alternatives` under `G3`, `G3'`; `chosen`; descend |
| 12 | `[G0,G3']` | commands and a check of the option | … | `check`→`G3'` |
| 13 | `[G0]` | — *(the Arbiter)* | — | the root is closed by the criterion |

The example also shows a repeat (turn 6): the same `read` with the same input version —
not progress. A repeat **after** an edit (a different version) is legitimate: the input
version changes.

### 2.7 Loop detection

Looping is not a separate sensor but the **absence of progress**. Progress at a point is
a cursor shift, a new observation/check, or a closure. The layers are deterministic:

- **action repeat** — the same command with the same input versions (`tool` + target +
  `ref`/`version`). The logos refuses it (`classify`) and writes `record_rejection`. A
  repeat **after** an edit (a different version) is legitimate;
- **stagnation** — the cursor does not shift and there are no new observations/checks for
  `K` steps → `return` (escalation to the parent);
- **oscillation** — a goal fluctuates `achieved` ↔ closure withdrawn without a change of
  versions or assumptions; usually due to a crude witness (the whole workspace);
- **exhaustion** — no progress at the root → stop: if a capability is missing —
  `out_of_fragment`, otherwise `no_progress`.

This is "no progress — stop" from the invariants (§9), applied to traversal.

---

## 3. Journal and folding

- **Journal** (`Event[]`) — the only truth, append-only.
- **State** — `fold(journal)`, derived.
- **Projection** — `project(state)`, derived; exactly what the model sees.

`fold` may start from a **snapshot** (checkpoint); a snapshot is a cache, the journal
remains the truth.

The event vocabulary (closed): `add_node`, `add_edge`, `mutate`, `record_check`,
`record_rejection`, plus focus changes (`descend`/`return`, §2.6). A state
change is a **new event node** (`check`, `complete`, …), not an edit of an existing
node; `set_status` is not used. New behavior is a new event or a new projection rule,
never a direct edit of the state bypassing the journal.

Determinism: the same events and parameters give one state and one projection. The only
external source is file changes; they enter through `mutate`.

---

## 4. Doxa operators

The doxa has **three operators**. It can do nothing else; this is its output interface.
Each is described by the §0 template: input → admissibility check → operation on the
tree → derived state → projection effect.

### 4.1 Goal (`create goal`)

This operator creates a subgoal relative to the **current** goal and adds it as an item
to the current goal's plan. The **first (root) goal is created by the Arbiter**: it is
given from outside and is not a doxa proposal.

**Input:** the current goal `C`; the content `{ what, why, done_when, plan? }`; `plan`
is an optional list of items.

**Admissibility check:** `what` non-empty; if `plan` is given — it is non-empty (at
least one item); the current goal exists. Otherwise — a refusal with a reason.

**Operation on the tree:**

1. create a `goal` node `G` (fields from the input);
2. embed `G` as an item in `C`'s plan: if `C` has no plan, create a `P` node and the
   edge `has_plan C → P`; then the edge `item P → G`;
3. if `G`'s plan is given: create a `Q` node, the edge `has_plan G → Q`; for each item
   create a `goal`/`action` node and the edge `item Q → item` in the given order; a
   command item is an `action` (not yet executed);
4. move to `G`.

**State (derived):** `G` and goal-items are not closed; command-items are not yet
executed.

**Projection effect:** `G` becomes the current goal; its plan (if any) and rationale are
visible.

**Completion of `G`** (see §6): objective — by an arbiter check; subjective — by the
"complete" operator; the root (first goal) — the Arbiter.

### 4.2 Command (`apply`)

**Input:** the current goal `C`; a command `D`; an optional "this is a check" marker.

**Admissibility check:** the command is admissible (constraints, executability, the
presence of a current goal). If the command changes a file, the declared basis must be
`current(ref)`; an edit on an outdated basis is refused. On refusal a `record_rejection`
is written; no nodes are created.

**Operation on the tree:**

1. **execute** the command in the environment;
2. the action as a plan item: if the command is an existing `action`-item of `C`'s
   plan, use it; otherwise create `action A` and, if needed, `C`'s plan, and add `A` as
   its item (`item`); do **not** move into `A`;
3. **record the result** — the children of `A`:
   - `observation` (output), edge `produces`;
   - `mutate` for each changed file: `from = current(ref)`, `to = V` (a new version),
     edge `mutates`;
   - if this is a check — `check` + the edge `verifies check → C`.

**State (derived):** `A` is executed ⇔ it has produced children; `observation` and
`check` are recorded.

**If this is a check:** a `check` node is created with a verdict (`pass`/`fail`/
`inconclusive`), the edge `verifies → C`, and, if the check rests on assumptions,
`under` edges to assumption-goals. On `fail` the branch is considered dropped and a
return to the parent happens.

**A verdict and a failure are different.** A `check` carries `pass`/`fail` only for a
**deterministic** outcome (an objective `done_when`). A timeout, an environment crash,
a flaky test — these are `inconclusive`: the fact is recorded, but the goal is **not**
refuted; the case is escalated to the Arbiter. `refuted` comes only from `fail`.

**Projection effect:** the action, its result and (for a check) the change of the
goal's state are visible.

### 4.3 Complete (`complete`)

**Input:** a goal `G`; a note.

**Admissibility check:** `G` has a **subjective** `done_when`. If `done_when` is
objective — a refusal: the completion of an objective goal is decided only by a check.
The root is not completed by this operator either.

**Operation on the tree:** create a `complete` node with the `closes → G` edge (and, if
the closure rests on assumptions, `under` edges to assumption-goals). This is the doxa's
assumption, not a verdict.

**Revocability:** if an assumption from `under` is refuted downstream, the closure loses
force — **derived**, without edits. The Arbiter (a human) can always revoke it.

**Projection effect:** `G` is shown as achieved under an assumption, not as proven.

---

## 5. Time, versions, witness

### 5.1 Version

A file version is a content identifier (a hash). The contents of old versions are not
stored in the IR; blobs (snapshots) live in the workspace (git/blob store). The IR
stores only version names.

### 5.2 History and current version

- `history(ref) = [V0, V1, …]` — the versions of `ref` in `mutate` order; `V0` is the
  version of the first observation;
- `current(ref)` — the last version.

Both functions are derived from the journal.

### 5.3 Actualness is computed

An observation obtained by reading a file carries that file's **version** and the
**context of assumptions** in which it was made (§6). There is no separate "outdated"
flag: actualness is a **relation of a fact to the current context**, not a property of
the fact.

```
actual(fact) ⇔ fact.version = current(fact.ref) ∧ assumptions(fact) hold
```

A fact about an old version is neither deleted nor marked: it simply does not belong to
the current context. The scope is the changed file and the active assumptions.

### 5.4 Restoring a version

`restore(ref, V)` is a workspace operation: write blob `V` and append a `mutate` with
`from = current(ref)`, `to = V`. Version `V` becomes current again, and facts about it
become actual. No flag is "reset", because there is none: actualness is always computed
from the current version and assumptions.

### 5.5 Monotonicity

The journal only grows. A change of knowledge (a new version, a refutation, a new
assumption) is new records; only the derived view is recomputed. Knowledge changes, the
trace does not.

---

## 6. Completion and honesty

| Condition | Closed by | State (derived) |
|---|---|---|
| objective, without assumptions | `check` (verdict `pass`) | `achieved` |
| objective, with assumptions | `check` (`pass`) + `under` edges | `achieved_under` |
| epistemic (`done_when` subjective) | a `complete` node (a doxa assumption) | `achieved_under` |
| root (the first goal) | the Arbiter (externally) | — |

**Honesty.** The strength of a conclusion does not exceed the strength of its premises:

- `achieved` — from the arbiter alone (test, typechecker, user) and only if the closure
  does not rest on an assumption (no `under` edges);
- `achieved_under` — reached **under an assumption**: the closing `check` has `under`,
  or the goal is closed by a `complete` node; the assumptions are named as references
  and are **revocable**;
- an assumption is an epistemic goal: if it is refuted, closures referencing it via
  `under` lose force (derived).

**Two kinds of gap** (to distinguish):

- **explanatory** — evidence exists, an explanation does not; this is a push to a new
  approach goal, not a refusal;
- **capability gap** — the needed procedure/tool is absent; an honest `out_of_fragment`
  (the mechanism is deferred, §10.1).

---

## 7. Control: who chooses the step

Three instances:

- the **logos** deterministically computes the *applicable* moves at the current
  traversal point (§2.6): which moves are admissible (execute an item, descend, check,
  complete, pick an option, fill in a plan);
- the **doxa** chooses from the applicable and fills it with content (a hypothesis, an
  option, a subgoal, a command) — this is its output interface, the three operators
  (§4);
- the **Arbiter** — external (a human; objectively — the toolchain/harness): the first
  goal, veto/override, stopping, the verdict when no criterion exists, root closure.

**`W: Σ → O`** — the operator-selection function. Usually the doxa realizes it within
the applicable set; the Arbiter intervenes on override and when no formal criterion
exists (two equally consistent hypotheses).

**There is no mode as a primitive.** "Reproduce/localize/…" are sections of *policy*
(descriptive), not state objects.

**Stopping** is the Arbiter's decision.

---

## 8. Projection

`project(state) → Context` is a pure deterministic function. Composition:

- **header** — the root/current goal, constraints, fragment, budget;
- **frontier** — the current branch: the goal, its plan (the `plan` node, items and
  their state), open obligations, the latest result;
- **artifacts** — a file index (+ the current version);
- **index** — an overview (`counts`, a window of the newest);
- **recent** — the last turns.

Rules: the context is the current branch (it grows on descent and collapses on return).
The IR does **not store** file contents or raw output (invariant 11), but an observation
of an explicit action (e.g. a read) enters the `frontier` as the action's result —
within the budget. Everything else is reachable by reference; past projections and
blobs do not enter. The order of parts is from stable to mutable (cache).

---

## 9. Invariants

| # | Invariant |
|---|---|
| 1 | `achieved` — only from a `check` with verdict `pass` and without `under` edges; the doxa does not issue verdicts |
| 2 | `achieved_under` — with a non-empty `under` at the closing `check` or with `complete`; revocable |
| 3 | the projection shows only actual facts: current versions and holding assumptions |
| 4 | `project` is deterministic: same events → same projection |
| 5 | the doxa only proposes: a goal enters unclosed, an action — without a result |
| 6 | operator selection: the logos supplies the applicable, the doxa chooses from it; with no criterion — the Arbiter |
| 7 | the trace is monotone: the base only grows; a change of knowledge is a new record (nodes are not edited) |
| 8 | the context is necessary and sufficient for the selected operator |
| 9 | no progress — stop (the Arbiter) |
| 10 | a refusal is recorded with a reason and is not stored as belief |
| 11 | file contents and secrets do not enter the IR |
| 12 | a `plan`/`alternatives` node always carries at least one item (`item`); a `goal` may be without a plan |
| 13 | the first goal is set by the Arbiter; the root is closed only by the Arbiter |
| 14 | nodes have no stored statuses: state is entirely derived |
| 15 | structural edges (`has_plan`, `item`, `has_alternatives`, `chosen`) form a forest — no cycles |
| 16 | the traversal makes at most K steps without progress at a node (a cursor shift, a new observation/check, a closure); otherwise `return` |
| 17 | the cursor does not decrease on an unchanged plan; a closed goal does not remain the focus (after closure — `return`) |

---

## 10. Open questions and non-goals

### 10.1 Open questions

- **Witness precision.** Today it is a snapshot of the workspace; the norm is a tie to
  specific files.
- **`out_of_fragment`.** Requires a separate "declared fragment" design.
- **The Arbiter's policy.** The concrete operator-selection rules (including automatic
  ones for an autonomous run).
- **Reserved.** `symbol`/`test` nodes and edges beyond §2.3 are declared but not produced
  by the current model; consider them outside the stage. The `set_status` event is not
  used: state is derived (§2.5).

### 10.2 Non-goals

- the doxa does not issue verdicts, does not infer;
- the context is not compressed by model summarization;
- file contents and secrets are not stored in the IR;
- logic is not "lowered" silently — when capabilities are lacking, an honest refusal;
- there is no "one right IR": the IR is a design parameter for the task.
