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
| **Arbiter** | external (in Skein — a human; objective — the toolchain) | the first request, verdict, stopping, external acceptance of the request; the choice when no criterion exists | produce content |

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
  typechecker) or the user; the doxa and logos do not do it;
- **a request is not a goal.** The first `request` is set by the Arbiter: unstructured
  motivation, the root of the forest. The doxa neither closes nor checks it — it only
  interprets it; acceptance of the request is external and implicit (§6).

---

## 2. The IR tree

### 2.1 Nodes

| kind | space | meaning |
|---|---|---|
| `request` | work | the Arbiter's request: unstructured motivation (the root) |
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

**A request and a goal are different.** A `request` is raw motivation from the Arbiter
(payload `text`), without `what`/`why`/`done_when`/plan; it is the root of the forest and
is **not closed** in the IR (acceptance is external, §6). A `goal` is the doxa's
interpretation of the request: `what` is derived from the text, `why` is the hypothesis,
`done_when` is how to tell that the interpretation succeeded.

### 2.2 Goal

A goal carries fields:

- `what` — what to achieve;
- `why` — a human-readable rationale ("why"); may be empty; the formal assumptions are
  the `under` references at the closing node (§6);
- `done_when` — the completion condition: **objective** (a command with a verdict) or
  **subjective** (a formulation).

**A request carries only `text`.** A request has no completion condition and no plan:
acceptance of the request is external (the user's silence or the harness verdict) and
does not enter the IR. Inside, only the derived `addressed` is computed (§2.5) — "the
agent has something to show".

The plan is a **separate node** `plan`, linked to the goal by the `has_plan` edge. A
goal may lack it: the absence of a plan means "the plan is not specified yet". A
`plan` node, if present, always carries **at least one item**.

A **plan item** is a `goal` (subgoal) or an `action` (command); the items of a `plan`
node are ordered by their position in the child list. A subgoal-item may have no plan
of its own — then it is unspecified too.

**Alternatives** — a container of options: an `alternatives` node, linked to a
**request** (interpretations of the request) or to a **goal** (approach options), holds
`goal` items. For a goal it appears **lazily** — when the current approach has failed and
a new candidate is proposed; for a request it is created **at once** with the first
interpretation (a single interpretation is an option too). The chosen (current) option is
the one the **latest** `chosen` edge points to (§2.6); the rest are `abandoned`
(derived). The options are proposed by the doxa, not by the Arbiter.

### 2.3 Edges

| kind | from → to | meaning |
|---|---|---|
| `has_plan` | `goal` → `plan` | the goal's plan (optional) |
| `item` | `plan` / `alternatives` → `goal` / `action` | an item/option (order = position) |
| `has_alternatives` | `request` / `goal` → `alternatives` | a container of interpretations/approach options |
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
- a goal is `abandoned` ⇔ it is an option in `alternatives` not equal to the **current**
  chosen one (the container's latest `chosen` edge);
- a request is `addressed` ⇔ its current chosen interpretation is
  `achieved`/`achieved_under`; otherwise the request is `open` (in the IR a request is
  never "closed" — acceptance is external, §6);
- **call summary** `calls` ⇔ a derived list of executed actions and refusals
  (`record_rejection`), deduplicated by `(status, action)` and tied to the focus
  (§2.8);
- otherwise the goal is `open`.

These are `project` rules, not fields. Only the journal is monotone (§3).

### 2.6 The stack and traversal

Traversal is the deterministic part of the logos. It does **not choose** what to do; it
computes the *applicable* moves at the current point; the choice among them is the
doxa's (§7).

The **stack** `S = [G₀ … G_k]` is the path from the root to the current goal; `G₀` is
the root request (`request`). The **cursor** `cursor(G)` is a **derived** number: the index of the first
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

- the current node is the request `R` → `create goal` (propose an interpretation; on
  failure — with `revises`, §4.1);
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
| 0 | `[R]` | — *(the Arbiter)* | — | root `request R` — the instruction text; no goals |
| 1 | `[R]→[R,I,G1]` | `create goal I` "fix the bootstrap" (plan `[G1 reproduce, G2 localize, G3 fix, G4 verify]`) | accepted | `alternatives A0` under `R`; `item A0→I`; `chosen A0→I`; `I`'s plan; descend into `G1` |
| 2 | `[R,I,G1]` | `apply` `run` the build | executed | `action` + `observation`; `cursor(G1)` shifted |
| 3 | `[R,I,G1]→[R,I]` | `complete G1` | accepted | `complete`→`G1`; `G1` `achieved_under`; return |
| 4 | `[R,I]→[R,I,G2]` | *(focus)* `apply` `read`/`grep` | … | descend into `G2`; `observation` + `file`@`V1` |
| 5 | `[R,I,G2]` | `apply` the same `read` (the same `V1`) | **refusal** `record_rejection` | no new node; the repeat counter grows (§2.7) |
| 6 | `[R,I,G2]→[R,I]` | `complete G2` | accepted | `complete`→`G2`; return |
| 7 | `[R,I]→[R,I,G3]` | `create goal G3` "fix" (`why` = hypothesis, `done_when` = the build) | accepted | `item`→`G3`; descend |
| 8 | `[R,I,G3]` | `apply` `edit` | executed | `action` + `mutate V1→V2` |
| 9 | `[R,I,G3]` | `apply` a check | executed | `check` `verifies→G3`, `under→G2` |
| 10 | `[R,I,G3]→[R,I]` | *(pass)* | derived | `G3` `achieved_under`; return |
| 10b | `[R,I,G3]→[R,I,G3']` | *(fail)* the doxa proposes an option | accepted | `G3` `refuted`; `alternatives` under `G3`, `G3'`; `chosen`; descend |
| 11 | `[R,I]` | `apply` `run` the criterion (`G4`) | executed | `check` `verifies→G4` (the command from `done_when`) |
| 12 | `[R,I]→[R]` | *(all items done)* | derived | `I` `achieved`; return to `R` |
| 13 | `[R]` | — *(the Arbiter)* | — | the request is `addressed`; stop; acceptance external |

The example also shows a repeat (turn 5): the same `read` with the same input version —
not progress. A repeat **after** an edit (a different version) is legitimate: the input
version changes.

### 2.7 Loop detection

Looping is not a separate sensor but the **absence of progress**. Progress at a point is
a cursor shift, **new knowledge** (a new observation/check or a new call outcome), or a
closure. The layers are deterministic:

- **action repeat** — the same command with the same input versions (`tool` + target +
  `ref`/`version`). The logos refuses it (`classify`) and writes `record_rejection`; the
  reason names the `id` of the existing result — "retrieve it by `id`, do not repeat".
  This covers `read`/`grep` too: **the same window/scope with an unchanged world is a
  repeat**; a different window/scope is a new action. A repeat **after** an edit (a
  different version) is legitimate. The same `query {id}` is a repeat **while the body
  is in the working set** (`shown`, TTL): the second query is redundant and refused; once
  evicted/expired it is allowed again (the guard watches the live set, not an unbounded
  history). A body evicted by the cap leaves `held`, so re-querying it is **allowed**
  (the body is no longer shown). For **non-results** (`action`/`goal` etc., which have no
  body) a separate set of recently queried ids with the same TTL is kept, so a repeated
  `query` of such a node is refused too. A state query (`kind`/`predicate`/`edgesOf`) is
  not pinned or deduplicated — its answer changes as the graph grows;
- **hypothesis repeat** — a new interpretation/option whose `what` repeats a refuted one
  is refused; the proposal must list all the container's failures (`revises`, §4.1);
- **stagnation** — the cursor does not shift and there is no **new knowledge** for
  `K` steps → `return` (escalation to the parent). Repeating the same failure/refusal is
  **not** new knowledge: `knowledgeKey` includes the *set of call signatures*, not the
  number of repetitions (§2.8);
- **oscillation** — a goal fluctuates `achieved` ↔ closure withdrawn without a change of
  versions or assumptions; usually due to a crude witness (the whole workspace);
- **exhaustion** — no progress at the root → stop: if a capability is missing —
  `out_of_fragment`, otherwise `no_progress`.

This is "no progress — stop" from the invariants (§9), applied to traversal.

### 2.8 Call summary (derived)

For the model the projection is **all of memory**, so it carries not only the positive
state (goals, plans, the achieved) but also a brief **summary of calls**: what has
already been invoked and how it ended. Absence from the context = absence of knowledge
for the model.

`calls` is the **index of the current interpretation's history**: each entry is
addressed by `id`, and the result body is retrieved from the IR by `id` (`query`, §8) —
**without a repeat call**. That is why a repeated command with the same inputs is
refused (§2.7): the knowledge already exists, take it by address rather than
re-deriving it.

The index's scope is the **whole subtree of the current chosen interpretation**, not
just the current path: evidence gathered in `reproduce` stays addressable on
`locate`/`fix`. Entries of abandoned interpretations are not shown.

`calls` is derived from the journal:

- **`refused`** — a logos decision (`record_rejection`): `action = "tool target"`,
  `note = reason`; constraint refusals carry a `constraintId`;
- **`ok`/`fail`** — an executed action (an `action` with a produced
  `observation`/`check`) or a materialized failure without an `action` node. `fail` is
  a result with `verdict=fail`; `note` is the **last non-empty line** of the output.

Rules:

- **dedup.** Records with an equal `(status, action)` collapse; `count` grows; a repeat
  creates no new knowledge;
- **scope.** Each record is tagged with the focus node at the moment it appears; records
  whose focus lies in the **subtree of the current chosen interpretation** (§2.3, §2.6)
  are shown — the whole interpretation's history, not just the current path. Records of
  abandoned interpretations are not shown;
- **invalidation.** A mutation after the record clears `fail`/`refused` (in another
  world state the same might work); `ok` is kept as history. The exception is
  **constraint** refusals (`constraintId`): those are invariants, not context. Leaving
  the interpretation clears a record by the scope rule.

**The feedback invariant.** A refusal or a recorded failure **changes the projection**:
if `project` after a refusal equals `project` before it, deterministic advancement must
repeat the same proposal — a loop. This is a special case of the invariant "the context
is necessary and sufficient" (§9, no. 8).

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

An action failure (no file, pattern not found, …) is **not forgotten**: it is
materialized as an observation with `verdict=fail`, so it enters the call summary
(§2.8) uniformly with a failed command.

Determinism: the same events and parameters give one state and one projection. The only
external source is file changes; they enter through `mutate`.

---

## 4. Doxa operators

The doxa has **three operators**. It can do nothing else; this is its output interface.
Each is described by the §0 template: input → admissibility check → operation on the
tree → derived state → projection effect.

### 4.1 Goal (`create goal`)

The operator introduces a goal that interprets the request, or a subgoal of the current
goal. **The first `request` is created by the Arbiter**: it is given from outside and is
not a doxa proposal.

**Input:** the current node `C` (a request or a goal); the content
`{ what, why, done_when, plan?, revises? }`; `plan` is an optional list of items;
`revises` is a list of goals the new proposal supersedes.

**Admissibility check:** `what` non-empty; if `plan` is given — it is non-empty (at
least one item); the current node exists. If `C` is a request, or a goal whose
`alternatives` contains `refuted`/`abandoned` options, then `revises` **must** list
**all** such options (otherwise a refusal `missing_revision`/`unknown_revision`); if
there are none — `revises` is empty. Additionally, a `what` repeating a refuted one is
refused (`repeat_hypothesis`). And finally: if the current goal is **objective** and its
plan is already **fully and successfully carried out** (every item `achieved`/
`achieved_under`, or an executed action), the plan must not be grown
— the goal itself must be checked (`apply run {target: C}`), otherwise a refusal "all
plan items are fulfilled; check this goal". A `refuted`/`abandoned` item resolves the
cursor but is **not** a success, so it does **not** trigger this guard: the plan may
still grow (the failed attempt never blocks the plan). Otherwise — a refusal with a reason.

**Operation on the tree:**

1. create a `goal` node `G` (fields from the input);
2. **if `C` is a request `R`:** create (if absent) an `alternatives` container `A`, the
   edge `has_alternatives R → A`, the edge `item A → G` and the edge `chosen A → G`
   (the new interpretation becomes current);
3. **if `C` is a goal:** embed `G` as an item in `C`'s plan (if `C` has no plan, create a
   `P` node and the edge `has_plan C → P`; then `item P → G`); if `C` is refuted — embed
   `G` as an option in its `alternatives` (create the container if absent) and set
   `chosen A → G`;
4. if `G`'s plan is given: create a `Q` node, the edge `has_plan G → Q`; for each item
   create a `goal`/`action` node and the edge `item Q → item` in the given order; a
   command item is an `action` (not yet executed);
5. move to `G`.

**State (derived):** `G` and goal-items are not closed; command-items are not yet
executed; superseded options remain `refuted`/`abandoned`.

**Projection effect:** `G` becomes the current goal; its plan (if any), rationale and the
refuted interpretations/options are visible.

**Completion of `G`** (see §6): objective — by an arbiter check; subjective — by the
"complete" operator; a request — by the Arbiter's acceptance (not closed in the IR).

### 4.2 Command (`apply`)

**Input:** the current goal `C`; a command `D` (for exploration, required without
`target`); an optional check target `target` — then the command comes from its
`done_when`, and `D` is omitted.

**Admissibility check:** the command is admissible (constraints, executability, the
presence of a current goal). Without `target` `D` must be present. For a check (`target`)
a foreign command cannot be substituted: if `D` is present and differs from the goal's
`done_when.command`, it is refused (the goal's command is not substitutable). If the
command changes a file, the declared basis must be `current(ref)`; an edit on an outdated
basis is refused. On refusal a `record_rejection` is written; no nodes are created.

**Command signature.** A command's identity includes its parameters — for a search, the
**scope** (`path`/`include`/`exclude`) and the **window** (`from`/`count`); for a read, the
line range. A command with the **same** signature and unchanged inputs is a **repeat**:
refused with the `id` of the existing result (§2.7). A different scope/window is a new
action.

**Operation on the tree:**

1. **execute** the command in the environment;
2. the action as a plan item: if the command is an existing `action`-item of `C`'s
   plan, use it; otherwise, if the first unfulfilled item of `C` is an `action` with a
   different command, attach `A` as its `chosen` alternative (append-only: the previous
   attempt stays as "did not work"); otherwise create `action A` and, if needed, `C`'s
   plan, and add `A` as its item (`item`); do **not** move into `A`;
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

**The command of an objective check comes from the IR.** For an objective goal the
command checked is its `done_when.command`; the doxa only initiates the check and **does
not** substitute the command. A subjective goal cannot be checked — only `complete`
(`subjective_goal_needs_complete`). Execution must not mask the exit code (no pipes;
`pipefail`).

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
A request (the root) is not completed by this operator either.

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
| request (the root) | external acceptance: the user (silence/the next turn) or the harness | `addressed` (derived) |

**A request is not closed in the IR.** There is no "accepted" node/edge: the user's
silence means consent, and the objective harness scores the run from outside. Inside,
only `addressed` is computed — "the agent has something to show" — from the current
chosen interpretation.

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
  request, veto/override, stopping, the verdict when no criterion exists, external
  acceptance of the request.

**`W: Σ → O`** — the operator-selection function. Usually the doxa realizes it within
the applicable set; the Arbiter intervenes on override and when no formal criterion
exists (two equally consistent hypotheses).

**There is no mode as a primitive.** "Reproduce/localize/…" are sections of *policy*
(descriptive), not state objects.

**Stopping** is the Arbiter's decision.

---

## 8. Projection

`project(state) → Context` is a pure deterministic function: it is the context for the
**next operator**, not a state dump. It shows the **traversal branch** plus the
containers of its nodes (`plan`/`alternatives`), the global constraints, the branch's
**call summary** (`calls`, §2.8), and the full result of the latest call; everything
else is reached via `query`, and the **body of any past result by its `id`**
(`query { id, start?, end? }`). The composition, exact shape, limits and examples are in
the separate specification `docs/projection.md`.

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
| 11 | secrets do not enter the IR; a small tool result's body may live in a node, a large one behind a temp-file reference |
| 12 | a `plan`/`alternatives` node always carries at least one item (`item`); a `goal` may be without a plan |
| 13 | the first `request` is set by the Arbiter; a request is not closed in the IR — acceptance is external and implicit |
| 14 | nodes have no stored statuses: state is entirely derived |
| 15 | structural edges (`has_plan`, `item`, `has_alternatives`, `chosen`) form a forest — no cycles |
| 16 | the traversal makes at most K steps without progress at a node (a cursor shift, a new observation/check, a closure); otherwise `return` |
| 17 | the cursor does not decrease on an unchanged plan; a closed goal does not remain the focus (after closure — `return`) |
| 18 | on failure `create goal` must list all `refuted`/`abandoned` options of the container (`revises`); otherwise a refusal |
| 19 | the command of an objective check is the goal's `done_when.command` from the IR, not the doxa's text |
| 20 | the doxa neither completes nor checks a request: at the request point only `create goal` is applicable |
| 21 | a refusal or a failure changes the projection (`calls`, §2.8): a repeat creates no knowledge; otherwise a loop |

---

## 10. Open questions and non-goals

### 10.1 Open questions

- **Witness precision.** Today it is a snapshot of the workspace; the norm is a tie to
  specific files.
- **`out_of_fragment`.** Requires a separate "declared fragment" design.
- **The Arbiter's policy.** The concrete operator-selection rules (including automatic
  ones for an autonomous run).
- **Several requests.** Today one forest per request; open — whether each user turn is a
  separate `request` and how the projection focuses.
- **`revises` strictness.** We require listing all the container's failures; open —
  whether a semantic dedup of `what` against the refuted ones is needed (now a string
  comparison).
- **Reserved.** `symbol`/`test` nodes and edges beyond §2.3 are declared but not produced
  by the current model; consider them outside the stage. The `set_status` event is not
  used: state is derived (§2.5).

### 10.2 Non-goals

- the doxa does not issue verdicts, does not infer;
- the context is not compressed by model summarization;
- file contents and secrets are not stored in the IR;
- logic is not "lowered" silently — when capabilities are lacking, an honest refusal;
- there is no "one right IR": the IR is a design parameter for the task.
