# Skein — IR: formal semantics

> Russian mirror — `docs/ir_semantics_ru.md`.

Related documents:

- `docs/logos_ir.md` — the foundation: doxa and logos, goals, gap analysis.
- `docs/ir.md` — **as-built**: how the IR is arranged in the current code.
- `docs/walkthrough.md` — the end-to-end example: the tree and the context, step by step.
- `docs/ir_operations.md` — the operational reference of every operator and the
  test-coverage map (`OP-*`, `TR-*`, `DER-*`, `REF-*`).
- `docs/benches/fix_ocaml_gc_ideal.md` — the model instance: a reference trajectory.
- `docs/plans/implementation_plan.md` — stages and status.

This is the **source of truth about the IR semantics**. The code follows it, not the
other way around. A change to the code's behavior goes:

1. change the semantics here (a new/changed operator or rule);
2. change the code;
3. a test encoding the invariant this change preserves.

Without step 1, step 2 is not done.

**Status.** The document describes the currently agreed model. The doxa has **four
operators** (`create_goal`, `apply`, `stop`, `decline`); `query` is a read-only addressing
operation. A `request` is interpreted **exactly once** as a `goal` (a `has_goal` edge) or
declined (a `no_goal` edge to an `unactionable` node); the interpretation is fixed for now.
A goal is closed by **`stop` alone** — for now only once its criterion has passed: the
engine appends a `stop` node as the plan's last item and adds a `has_stopped` edge; the
request (and the run) ends when its goal is stopped. A criterion run is an ordinary
`observation`, and its `exitCode` (0 = pass, non-zero = fail) is the only "verdict". The
earlier `arbiter`/`check`/`under`/`achieved` machinery was removed
(`docs/plans/archive/stop_closure_plan.md`); the `chosen` edge and the request-`alternatives` model
were removed by `docs/plans/archive/request_goal_plan.md`. The traversal model (arm + cursor, one
frontier) is in `docs/plans/traversal_stack_spec.md`. The exact state of the code is
`docs/ir.md`.

---

## 0. The principle: semantics is an operation on the IR tree

Everything that happens in the system is described **as an operation on the IR tree**.
Not "what the agent does in general", but:

- which **nodes** and **edges** are created;
- where the **current node** moves (the focus of work);
- which **derived facts** change (but are not stored);
- what the **next projection** shows (i.e. the model on the next step);
- which **invariants** are preserved.

This applies to the doxa's moves and the logos' reactions alike. New behavior is a new
operation, described by this template, not a direct edit of the state bypassing the
journal.

The tree is not a given but the trace of operations. It branches where the agent
chooses an approach (alternative goals) and grows deeper where a goal is unfolded
into items.

---

## 1. Roles

| Role | Who | Does | Does not |
|---|---|---|---|
| **Doxa** | LLM | proposes exactly one operator per turn | issue verdicts, infer |
| **Logos** | the deterministic engine, **including the environment and tools** | executes commands; places nodes and edges from the results; recomputes the derived view; builds the projection | infer truth; choose among equals |
| **Arbiter** | external (in Skein — a human; objectively — the toolchain) | the first request; the final acceptance of the request; the choice when no criterion exists | produce content; accept a single goal |

There is no protocol/environment as a separate role: execution and recording are part
of the logos. The logos' internal operations are `o_rev` (recompute on change),
`o_def` (cancel/supersede), `o_ctx` (projection). There is no preference operator
(`o_spec`): we have no defaults or specificity, so there is nothing to prefer.

Key consequences:

- **doxa only proposes.** Any of its proposals enters as a proposal (a goal is unclosed,
  an action is without a result), but never at once as an established fact;
- **choosing is from the applicable.** The logos deterministically supplies the
  *applicable* moves at the current traversal point (§2.6); the doxa picks one of them
  and fills it with content. Equally consistent hypotheses (no criterion) are decided
  by the **Arbiter**;
- **a criterion is a command, not a role.** "Pass/fail" is the exit code of running the
  goal's `done_when`: the toolchain (a test, a typechecker) or the user's command. The
  doxa never issues it, and the logos only records and reads it;
- **a request is not a goal.** The first `request` is set by the Arbiter: unstructured
  motivation, the root of the forest. The doxa interprets it **once** as a `goal` (a
  `has_goal` edge) or declines it (a `no_goal` edge to an `unactionable` node); the
  interpretation is fixed for now. The run ends when its goal is stopped; acceptance of
  the request itself stays external and implicit (§6).
- **no per-goal acceptance.** Every goal carries a command criterion, and a goal is closed
  by the doxa's `stop`, gated by the facts (§4.3). The Arbiter is a boundary authority (the
  first request, the final acceptance of the run), not a per-goal actor.

---

## 2. The IR tree

### 2.1 Nodes

| kind | space | meaning |
|---|---|---|
| `request` | work | the Arbiter's request: unstructured motivation (the root); interpreted once as a goal or declined |
| `goal` | work | a goal: what to achieve; carries the criterion (`done_when`) and a plan sketch (`plan`) |
| `action` | work | a command; always a plan item |
| `plan` | work | a plan container: ordered items (≥1); the last item is current |
| `alternatives` | work | a container of approach options (≥1); the last option is current |
| `observation` | work | the result of a command (a read's window, a run's output + exit code) |
| `stop` | work | the doxa's terminal move: closes the focused goal (a `has_stopped` edge); it is the plan's last item; never marks "achieved" |
| `unactionable` | work | the doxa declined to formulate a goal (payload `why?`) |
| `constraint` | work | a prohibition (payload `forbid`: path regexes) |
| `file` | artifact | a pointer to a file |

There are no separate `check`, `claim`, `decision`, `subgoal` kinds:

- **a verdict** is not a node: it is the `exitCode` of a criterion run's observation,
  read where a decision needs it (§2.5);
- **a rationale** is the goal's `why` field (human-readable text); **an assumption** is
  not a node either — an explanatory guess lives in `why` and is settled by the goal's
  own criterion (there is no `under` edge, §6 of the previous model);
- **a fact from an observation** — a command result (`observation`), not a doxa node;
- **subgoal** — a goal; there is no separate kind;
- **decision** — not a doxa node: the logos or the Arbiter chooses.

**A request and a goal are different.** A `request` is raw motivation (payload `text`),
without `what`/`why`/`done_when`/plan. It is interpreted **exactly once**: as a `goal`
(the `has_goal` edge; the interpretation is fixed for now) or, if the intent is not
actionable, declined — a `no_goal` edge to an `unactionable` node. It is the root of the
forest; the run ends when its goal is stopped, and acceptance is external (§6). A `goal`
is that interpretation of the request: `what` is derived from the text, `why` is the
hypothesis, `done_when` is the command that tells whether the interpretation succeeded.

### 2.2 Goal

A goal carries fields:

- `what` — what to achieve;
- `why` — a human-readable rationale ("why"); may be empty; it is the hypothesis for a
  fix, not a formal assumption;
- `done_when` — the criterion: a **literal command string**. The engine runs exactly
  that command and reads its exit code (0 = pass, non-zero = fail). There is no
  `kind`/`arbiter` alternative.

**A request carries only `text`.** A request has no criterion and no plan. It is
interpreted once as a goal or declined; the run ends when its goal is stopped or the
decline is recorded. Acceptance of the request is external (the user's silence or the
harness verdict) and does not enter the IR. Inside, only `requestSettled` is computed
(§2.5) — "the goal's current variant criterion passed".

The plan is a **separate node** `plan`, linked to the goal by the `has_plan` edge.
**Every goal is created with a plan** (I1): the goal payload carries `plan` — the
initial plan as a free-form **string sketch** (I3) — and the `plan` node carries **at
least one item**. A **plan item is always an `action`** (I2): a concrete command,
executable now; the items are ordered by their position in the child list, and the
**last** item is the current one. **A sub-goal never enters as a plan item** (I6): it
enters only as an **alternative** to an existing (action) step, when the doxa decomposes
that step — and then becomes the step's newest (current) option.

**Alternatives** — a container of options: an `alternatives` node, linked by
`has_alternatives` to a **goal** (approach options) or a **plan item** (a step's revision
history), and it holds `goal` or `action` items. It appears **lazily** — when the current
approach has failed and a new candidate is proposed. The current option is the container's
**last** child (§2.6); the rest are bypassed (derived `unselectedVariant`). The options
are proposed by the doxa, not by the Arbiter. A branched/decomposed step is a sub-goal
that becomes the step's newest alternative.

### 2.3 Edges

| kind | from → to | meaning |
|---|---|---|
| `has_goal` | `request` → `goal` | the request's single, fixed interpretation |
| `has_plan` | `goal` → `plan` | the goal's plan (mandatory, ≥1 item) |
| `item` | `plan` / `alternatives` → `goal` / `action` | an item/option (order = append order; the last is current) |
| `has_alternatives` | `goal` / plan item → `alternatives` | a container of approach options/revisions |
| `produces` | `action` → `observation` | a command result |
| `has_stopped` | `goal` → `stop` | the goal is closed; the `stop` node is also the plan's last item |
| `no_goal` | `request` → `unactionable` | the request's intent is not actionable |
| `mutates` | `action` → `file` | the command changed the file (with a version) |

Edges do **not** carry item/option order: it is set by the position in the container's
(`plan` / `alternatives`) child list. Edges give structure, the list gives traversal
order. A plan item is always an `action`; a goal appears as a container item only in
`alternatives`.

### 2.4 The current node

At every moment there is a **current node** — the focus of work; all doxa operators are
relative to it. The focus is set by the **traversal stack** (§2.6): the path from the
root to the current goal. The mechanics of descent/return are there too.

### 2.5 State is derived

Nodes have **no stored statuses**: nodes do not change. The displayed state is computed
in the projection (`stateOf`), and the facts a decision needs are read from the nodes:

- an action is `executed` ⇔ it has a produced child (`produces`/`mutates`); otherwise
  the item is merely planned (state `open`);
- a **goal** is `stopped` ⇔ it has a `has_stopped` edge to a `stop` node; otherwise it is
  `open`. A **request** is done ⇔ its goal is `stopped` or it has a `no_goal` edge to an
  `unactionable` node; the request is never itself `stopped`;
- **`goalOf(request)`** — the goal via `has_goal`; **`unactionableOf(request)`** — the
  node via `no_goal`;
- **`lastChild(container)`** — the current item of a `plan`/`alternatives` (the last
  `item`); a plan item is an `action`, an option is a `goal` or an `action`;
- **an action is superseded** (`actionSuperseded`) ⇔ its `alternatives` container has a
  newer (last) option (a bypassed/decomposed step) — a derived fact, not a displayed state;
- **a goal/option is unselected** (`unselectedVariant`) ⇔ it is an option in `alternatives`
  that is **not the last** child (the current one) — a derived fact, used by
  `revises`/`repeat_hypothesis`, not a displayed state;
- **the criterion result** `criterionResult(state, G)` is the latest `observation` whose
  `target` is `G`; `criterionExit` is its `exitCode`; `criterionPass` ⇔ `=== 0`;
  `criterionFailed` ⇔ present and non-zero;
- **plan exhausted** `planExhausted(state, G)` ⇔ `G` has no unfulfilled plan item (an
  item is unfulfilled unless the action executed, or its last option is done);
- a request is **`requestSettled`** ⇔ its goal, through its current variant (the last
  option of its `alternatives`, if any), passed its criterion (`criterionPass`);
- **call summary** `calls` ⇔ a derived list of executed actions and refusals
  (`record_rejection`), deduplicated by `(status, action)` and tied to the focus
  (§2.8).

There are **no truth predicates** `achieved`/`refuted`/`abandoned`. A criterion run
settles nothing by itself: the goal is closed only by the doxa's `stop` (§4.3), and the
exit code is the fact the gates read. A passing criterion does **not** auto-close the
goal — the doxa must still `stop` it (one extra turn, uniform closure).

These are `project`/read rules, not fields. Only the journal is monotone (§3).

### 2.6 The stack and traversal

Traversal is the deterministic part of the logos. It does **not choose** what to do; it
computes the *applicable* moves at the current point; the choice among them is the
doxa's (§7).

The **stack** `S = [G₀ … G_k]` is the path from the root to the current goal; `G₀` is
the root request (`request`). The **cursor** `cursor(G)` is a **derived** number: the
index of the first **unperformed** plan item of `G`, left to right. An item is performed
if it is an `action` that executed, or a `goal` that is `stopped`, or an item whose
`alternatives` container has a performed **last** option (`itemFulfilled`). No plan — no
items. The **current node** = `G_k`.

Neither the stack nor the cursor is stored as a field: the stack is the fold of the
focus events `descend`/`return` (append-only journal), the cursor is computed from the
plan.

**Movement (deterministic logos):**

- **advance** — executing an `action` item does not change the stack, the cursor shifts
  by itself;
- **descend** `descend(G → H)`: push `H`, focus → `H` — the doxa descends into the
  request's single goal (`has_goal`), or into a sub-goal just created as the last option
  of a step's `alternatives` (I6). Plan items themselves are actions, executed in place
  (no descent);
- **return** `return`: pop the top, focus → the parent. It happens when the current goal
  is **finished** (`has_stopped`, or an executed action) or by `W`'s decision (change of
  branch). A return from the root is impossible. A finished goal does not keep its
  descendants in focus: the branch is trimmed under a finished ancestor, not only when
  the top itself finishes (invariant 17).

**The arm and the cursor.** At a focus the doxa is handed the whole **arm** — the
ordered siblings (`plan` items or `alternatives` options) with their states — and the
**cursor** marks the current node only. The engine does not dictate a single next move;
it states the **frontier**: what is admissible at this point. One frontier computation
feeds both the projection and `classify` — there is no second copy.

**The doxa's four node-kinds.** Every accepted doxa turn adds exactly one node (a
rejected one adds `record_rejection` and changes the projection):

- **continue** — `apply` a command: execute the next step. The engine attaches it to the
  plan (reuse an unexecuted matching action item; else it becomes the last alternative of
  the current unfulfilled item; else a new `item`) — §4.2;
- **alternative** — "let's try another": `create_goal` (the request's goal, a variant of
  a failed goal, or a sub-goal decomposing the current step) or `apply` a different
  command (recorded as the last alternative of the current item);
- **stop** — `stop`: finish the focused goal (the engine appends it as the plan's last
  item); accepted under the gate of §4.3. The request ends when its goal is stopped;
- **decline** — `decline`: only at a fresh request, record an `unactionable` node and end
  the run (§4.4).

**Applicable at the point `G`** (the frontier the doxa sees):

- the current node is the request `R` with no goal yet → `create_goal` (propose the
  single interpretation) or `decline` (the intent is not actionable). There is no `stop`
  and no `decline` once `R` has a goal (the focus is then inside the goal);
- the current node is a goal whose criterion **failed** → only `create_goal` (a
  revision: a variant, §4.1). The frontier nudges revision;
- the current node is a goal already `stopped` → `return` (engine-internal);
- otherwise (an open goal) → `apply` is always available (execute a command — one step
  per turn, I4); `create_goal` is available while there is a current unfulfilled
  `action` step to decompose (I6); `stop` is available once the criterion has passed (for
  now, positive stops only); `checkReady` when the plan is done and the goal has ≥1 item
  (the expected move is `apply run {target: G}`).

A criterion move (`apply run {target: G}`) acts on the node in focus `G_k` alone: it
targets `G_k`. Targeting an ancestor or a sibling is refused (`not_current_goal`) — the
current node is settled first, and the traversal returns to the parent on its own. This
keeps a finished ancestor from ever being produced from inside its own subtree.

**Alternatives.** The option is proposed by the doxa; the current one is the container's
**last** child (the rest are derived `unselectedVariant`). Switching options is also a
doxa proposal; the Arbiter intervenes only when no formal criterion exists.

**A criterion of an option.** A goal's criterion is read from an observation targeting
that goal; the **last** option is the one whose facts count for the parent. If a goal has
alternatives, the last option's criterion is the goal's de-facto criterion through the
`criterionResult` relation; but a goal is still closed only by its own `stop`.

**Example** (fix-ocaml-gc; the stack's top is on the right; `→` = change of focus). A
fuller version is in `docs/walkthrough.md`:

| Turn | Stack | Doxa proposal | Logos | Tree |
|---|---|---|---|---|
| 0 | `[R]` | — *(the Arbiter)* | — | root `request R` — the instruction text; no goals |
| 1 | `[R]→[R,I]` | `create_goal I` "fix the bootstrap" (`done_when: "make test"`, `plan`: "reproduce, localize, fix"; `step: "make test"`) | accepted | `has_goal R→I`; `I`'s plan = [`make test` action]; focus `I` |
| 2 | `[R,I]` | `apply run "make test"` (reproduce; **no `target`**) | executed | `action` + `observation` (a bare run: `command`, `exitCode`, no `target` — an observation, not the criterion); cursor shifted |
| 3 | `[R,I]` | `apply` `read`/`grep` (localize) | executed | `action` + `observation` + `file`@`V1`; cursor shifted |
| 4 | `[R,I]` | `apply` the same `read` (the same `V1`) | **refusal** `record_rejection` | no new node; the repeat counter grows (§2.7) |
| 5 | `[R,I]` | `apply` `edit` | executed | `action` + `mutate V1→V2` |
| 6 | `[R,I]` | `apply run { target: I }` (the criterion; command from `I.done_when`) | executed | `observation` with `target: I`, `exitCode: 0` → `criterionPass(I)` |
| 7 | `[R,I]` | `stop` (finish `I`) | accepted | a `stop` node appended as `I`'s last plan item; `has_stopped I→stop`; `stateOf(I) = stopped`; return to `R` |
| 7b | `[R,I]` | `create_goal I' { revises: [I] }` (on `exitCode ≠ 0`) | accepted | `criterionFailed(I)`; the frontier offers revision; `I'` becomes the last option in `I`'s alternatives; descend into `I'` |
| 8 | `[R]` | — *(no further turn)* | the run ends | the request ends once its goal is stopped: `request_addressed` (the criterion passed) or `request_stopped` |

The example also shows a repeat (turn 4): the same `read` with the same input version —
not progress. A repeat **after** an edit (a different version) is legitimate: the input
version changes.

### 2.7 Loop detection

Looping is not a separate sensor but the **absence of progress**. Progress at a point is
a cursor shift, **new knowledge** (a new observation or a new call outcome), or a
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
  `query` of such a node is refused too. A state query (`kind`/`edgesOf`) is
  not pinned or deduplicated — its answer changes as the graph grows;
- **a non-decisive run** — a criterion run whose observation has **no `exitCode`** (a
  timeout) brought no knowledge: an identical re-check is **not** a repeat-refusal, and
  a run of timeouts does not count as progress (§2.5). The goal stays `open` until a
  decisive exit code arrives or the run stops on no progress;
- **hypothesis repeat** — a new interpretation/option whose `what` repeats a failed one
  is refused; the proposal must list all the container's failures (`revises`, §4.1);
- **stagnation** — the cursor does not shift and there is no **new knowledge** for
  `K` steps → `return` (escalation to the parent). Repeating the same failure/refusal is
  **not** new knowledge: `knowledgeKey` includes the *set of call signatures*, not the
  number of repetitions (§2.8);
- **oscillation** — a goal fluctuates in focus without a change of versions or facts;
  usually due to a crude witness (the whole workspace);
- **exhaustion** — no progress at the root → stop: if a capability is missing —
  `out_of_fragment`, otherwise `no_progress`.

This is "no progress — stop" from the invariants (§9), applied to traversal.

### 2.8 Call summary (derived)

For the model the projection is **all of memory**, so it carries not only the positive
state (goals, plans, the stopped) but also a brief **summary of calls**: what has
already been invoked and how it ended. Absence from the context = absence of knowledge
for the model.

`calls` is the **index of the current interpretation's history**: each entry is
addressed by `id`, and the result body is retrieved from the IR by `id` (`query`, §8) —
**without a repeat call**. That is why a repeated command with the same inputs is
refused (§2.7): the knowledge already exists, take it by address rather than
re-deriving it.

The index's scope is the **whole subtree of the request's current goal** (through its
current variant), not just the current path: evidence gathered in `reproduce` stays
addressable on `locate`/`fix`. Entries of unselected variants are not shown.

`calls` is derived from the journal:

- **`refused`** — a logos decision (`record_rejection`): `action = "tool target"`,
  `note = reason`; constraint refusals carry a `constraintId`;
- **`ok`/`fail`** — an executed action (an `action` with a produced `observation`) or a
  materialized failure without an `action` node. `fail` is a result flagged
  `failed: true` or a run with a non-zero `exitCode`; the failure signal is **stderr**
  (`error`), kept separate from stdout; `note` is its most informative line (the last
  crash/error line, else the last non-empty line of stderr, else of stdout).

Rules:

- **dedup.** Records with an equal `(status, action)` collapse; `count` grows; a repeat
  creates no new knowledge;
- **scope.** Each record is tagged with the focus node at the moment it appears; records
  whose focus lies in the **subtree of the request's current goal** (§2.3, §2.6)
  **or on the current path** are shown — the whole interpretation's history, not just
  the current path, and the path itself so a refusal at the request root (outside that
  subtree) is visible. Records of unselected variants are not shown;
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

The event vocabulary (closed): `add_node`, `add_edge`, `mutate`, `record_rejection`,
plus focus changes (`descend`/`return`, §2.6). A state change is a **new event node**
(`observation`, `mutate`, `stop`, …), not an edit of an existing node; `set_status` is
not used, and there is no `record_check`. New behavior is a new event or a new
projection rule, never a direct edit of the state bypassing the journal.

An action failure (no file, pattern not found, …) is **not forgotten**: it is
materialized as an observation flagged `failed: true`, so it enters the call summary
(§2.8) uniformly with a failed command.

Determinism: the same events and parameters give one state and one projection. The only
external source is file changes; they enter through `mutate`.

---

## 4. Doxa operators

The doxa has **four operators** (`create_goal`, `apply`, `stop`, `decline`); `query` is
a read-only addressing operation, not a move. It can do nothing else; this is its output
interface. Each is described by the §0 template: input → admissibility check → operation
on the tree → derived state → projection effect.

### 4.1 Goal (`create_goal`)

The operator introduces a goal that interprets the request, a variant of a failed goal,
or a sub-goal of the current goal. **The first `request` is created by the Arbiter**: it
is given from outside and is not a doxa proposal.

**Input:** the current node `C` (a request or a goal); the content
`{ what, why, done_when, plan, step, revises? }`; `done_when` is the **criterion
command**; `plan` is the initial plan as a **string sketch** (I3); `step` is the **first
concrete step** `{ command, label? }` — an action; `revises` is a list of goals the new
proposal supersedes.

**Admissibility check:** `what` non-empty; `done_when` non-empty; `plan` a non-empty
string; `step.command` non-empty; the current node exists. At a request that already has
a goal (or was declined) the move is refused (`interpreted`): the interpretation is
created once. If the current goal's criterion **failed**, then `revises` **must** list
**all** such failed options of the container (otherwise a refusal
`missing_revision`/`unknown_revision`); if there are none — `revises` is empty.
Additionally, a `what` repeating a failed one is refused (`repeat_hypothesis`). And
finally: if the current goal's plan is already **fully and successfully carried out**
(every item fulfilled and the plan carries a checkable step), the plan must not be grown —
the goal itself must be checked (`apply run {target: C}`), otherwise a refusal "all plan
items are fulfilled; check this goal". A bypassed item resolves the cursor but is **not**
a success, so it does **not** trigger this guard. Otherwise — a refusal with a reason.

Decomposing an **open goal** requires a **current action step** to replace; with none,
the engine records a fail observation (`create goal failed: no current step to
decompose`) — not a classify refusal.

**Operation on the tree:**

1. create a `goal` node `G` (fields from the input, storing `plan` on the payload);
2. **if `C` is a request `R`:** add the edge `has_goal R → G` (the single, fixed
   interpretation);
3. **if `C` is a goal whose criterion failed:** embed `G` as the last option of the
   container `C` already belongs to, or of `C`'s own `alternatives` (create the container
   if absent) — the revision becomes the current option;
4. **otherwise (`C` an open goal): decompose the current step** (I6) — let `s` be the
   first unfulfilled (action) plan item of `C`; create (if absent) an `alternatives`
   container `Aₛ` under `s` and the edge `item Aₛ → G` (the sub-goal becomes the step's
   newest/current option);
5. create the `plan` container `Q` of `G` (edge `has_plan G → Q`) with **exactly one**
   item — the `step` `action` (not yet executed) (I1, I2);
6. move to `G`.

**State (derived):** `G` is `open`; the `step` action is not yet executed; superseded
options are `unselectedVariant`.

**Projection effect:** `G` becomes the current goal; its plan (if any), rationale and the
failed variants/options are visible.

**Completion of `G`** (see §6): by the doxa's `stop`, gated by the criterion result. A
request ends once its goal is stopped.

### 4.2 Command (`apply`)

**Input:** the current goal `C`; a command `D` (for exploration, required without
`target`); an optional criterion target `target` — then the command comes from its
`done_when`, and `D` is omitted. `target` must be `C` itself (the criterion acts on the
focus); targeting another goal is refused (`not_current_goal`).

**Admissibility check:** the command is admissible (constraints, executability, the
presence of a current goal). Without `target` `D` must be present. For a criterion
(`target`) a foreign command cannot be substituted: if `D` is present and differs from
the goal's `done_when`, it is refused (the goal's command is not substitutable). If the
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
   different command, attach `A` as its last alternative (append-only: the previous
   attempt stays as "did not work"); otherwise create `action A` and, if needed, `C`'s
   plan, and add `A` as its item (`item`); do **not** move into `A`;
3. **record the result** — the children of `A`:
   - `observation` (the output, the exit code, and — for a criterion run — `target` and
     `witness`), edge `produces`;
   - `mutate` for each changed file: `from = current(ref)`, `to = V` (a new version),
     edge `mutates`.

**State (derived):** `A` is `executed` ⇔ it has produced children; the `observation` is
recorded.

**If this is a criterion run (`target`):** the command is the goal's `done_when` from
the IR — the doxa only initiates it and **does not** substitute the command. The
resulting observation carries `target: G` and `exitCode` (`0` = pass, non-zero = fail,
absent on a timeout); a `witness` snapshot of the workspace is attached. Execution must
not mask the exit code (no pipes; `pipefail`).

**A verdict and a failure are different.** A decisive exit code (`0`/non-zero) is the
only "pass/fail". A timeout, an environment crash, a flaky test produce an observation
**without** `exitCode`: the fact is recorded, but the goal gets **no verdict** and stays
`open`; the model may retry (§2.7). A non-decisive result never counts as progress.

**Projection effect:** the action, its result and the goal's criterion outcome (the
`exitCode` in `shown`/`calls`) are visible.

**Continue vs alternative.** Attaching `A` as a new `item` of the plan is a *continue*;
making it the last alternative of the current unfulfilled item is an *alternative*
(§2.6). Both are `apply`; the distinction is only in where the node lands.

### 4.3 Stop (`stop`)

The operator is the doxa's terminal move on a **goal**: **the only way a frame closes**.
It finishes the focused goal (the engine returns to the parent and continues); the run
ends when the request's goal is stopped. It never settles a criterion by itself.

**Input:** the current **goal** `C`; `{ why? }`. A `stop` on the request is refused (the
request has no `stop`; it ends when its goal is stopped).

**Admissibility check (the hard gate):** `C` is a goal → accepted **iff** its criterion
has passed (`criterionPass`); otherwise refused `check_not_run`. For now only positive
stops are considered (a give-up with an exhausted plan is a later step).

**Operation on the tree:** create a `stop` node (payload `{ why? }`); append it as the
goal plan's **last item** (`item plan → stop`) **and** add the `has_stopped` edge
`goal → stop`. Focus does not move on the turn; the next projection returns (`return`)
out of the stopped goal to its parent.

**State (derived):** a goal with a `has_stopped` edge is `stopped` — closed; the `stop`
node is the plan's last item, so the closure and its reason live in the plan. The criterion
fact is **unchanged**: `stop` never invents a pass and never marks a request "achieved";
`requestSettled` stays derived from the goal's current variant.

**Projection effect:** a stopped goal shows state `stopped`; the run stops once the
request's goal is stopped (`request_addressed` when the criterion passed, `request_stopped`
otherwise).

**Why.** It makes the loop explicit and ReAct-shaped — the doxa claims the frame is
finished, the logos validates it against the facts (a passing criterion). The doxa does
not issue a verdict: a pass is still just the exit code of a run it asked for, and
acceptance of the request stays external.

### 4.4 Decline (`decline`)

The operator ends a **request** whose intent is not actionable, without inventing a goal.
It is accepted only at a **fresh request** (no goal and no `unactionable` node yet).

**Input:** the current node `C` (a request `R`); `{ why? }`.

**Admissibility check:** `C` is a fresh request (no `has_goal`, no `no_goal`); otherwise
refused (`addressed`/`not_addressed` at a settled or already-interpreted request).

**Operation on the tree:** create an `unactionable` node (payload `{ why? }`) and the edge
`no_goal R → unactionable`. No goal and no plan are created.

**State (derived):** the request has an `unactionable` node; the run ends
(`request_unactionable`). There is no criterion to run and no goal to stop.

**Projection effect:** the request shows its `unactionable` note; the run stops.

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

An observation obtained by reading a file carries that file's **version**. There is no
separate "outdated" flag: actualness is a **relation of a fact to the current context**,
not a property of the fact.

```
actual(fact) ⇔ fact.version = current(fact.ref)
```

A fact about an old version is neither deleted nor marked: it simply does not belong to
the current context. The scope is the changed file.

### 5.4 Restoring a version

`restore(ref, V)` is a workspace operation: write blob `V` and append a `mutate` with
`from = current(ref)`, `to = V`. Version `V` becomes current again, and facts about it
become actual. No flag is "reset", because there is none: actualness is always computed
from the current version.

### 5.5 Monotonicity

The journal only grows. A change of knowledge (a new version, a criterion result, a new
hypothesis) is new records; only the derived view is recomputed. Knowledge changes, the
trace does not.

---

## 6. Completion and honesty

| Condition | Closed by | State (derived) |
|---|---|---|
| a goal, criterion passed | `stop` (the gate accepts a `criterionPass`) | `stopped`; the pass is visible as the criterion observation's `exitCode 0` |
| a goal, criterion failed/not run | — (refused `check_not_run`; a give-up is deferred) | `open`; the frontier offers a revision |
| a goal whose criterion failed | `create_goal` (a variant) | `open`; the revision becomes the current option |
| request (the root) | ends when its goal is `stopped` (`request_addressed`/`request_stopped`) or on `decline` (`request_unactionable`); there is no `stop` on the request | the run ends |

**A request is not closed in the IR.** There is no "accepted" node/edge: the user's
silence means consent, and the objective harness scores the run from outside. The request
ends when its goal is stopped (the closure lives in the goal's plan) or when the doxa
declines it. Inside, only `requestSettled` is computed — "the goal's current variant
criterion passed".

**Honesty.** The strength of a conclusion does not exceed the strength of its premises:

- a "pass" is exactly the exit code of the goal's own criterion run — nothing else
  produces one;
- for now a `stop` is accepted only with a passing criterion; the request is never marked
  "achieved" — acceptance stays external;
- an explanatory guess (the `why` hypothesis) is settled by the goal's own criterion; it
  is not stored as an assumption and does not weaken a pass into a lesser grade.

**Two kinds of gap** (to distinguish):

- **explanatory** — evidence exists, an explanation does not; this is a push to a new
  approach goal, not a refusal;
- **capability gap** — the needed procedure/tool is absent; an honest `out_of_fragment`
  (the mechanism is deferred, §10.1).

---

## 7. Control: who chooses the step

Three instances:

- the **logos** deterministically computes the *applicable* moves at the current
  traversal point (§2.6): which moves are admissible (execute an item, descend, run a
  criterion, pick an option, fill in a plan);
- the **doxa** chooses from the applicable and fills it with content (a hypothesis, an
  option, a subgoal, a command, a `stop`, or a `decline`) — this is its output interface,
  the four operators (§4);
- the **Arbiter** — external (a human; objectively — the toolchain/harness): the first
  request, veto/override, the final acceptance of the request when no criterion exists.

**`W: Σ → O`** — the operator-selection function. Usually the doxa realizes it within
the applicable set; the Arbiter intervenes on override and when no formal criterion
exists (two equally consistent hypotheses).

**There is no mode as a primitive.** "Reproduce/localize/…" are sections of *policy*
(descriptive), not state objects.

**Stopping** is the doxa's proposal (`stop`) on a goal, validated by the logos against
the gate of §4.3; declining a non-actionable request is `decline` (§4.4). Acceptance of
the request itself stays external (the Arbiter/harness).

---

## 8. Projection

`project(state) → Context` is a pure deterministic function: it is the context for the
**next operator**, not a state dump. It shows the **traversal branch** (`path`) plus the
containers of its nodes (`plan`/`alternatives`), the global `constraints`, the branch's
**call summary** (`calls`, §2.8), the full result of the latest call (`lastResult`), the
working set (`shown`), the `applicable` operators with `checkReady`/`nextAction`, and the
turn `budget`; everything else is reached via `query`, and the **body of any past result
by its `id`** (`query { id, start?, end? }`). A result view carries `exitCode` (not a
`verdict`), and a node a `state` of `open|executed|stopped`. The composition, exact
shape, limits and examples are in the separate specification `docs/projection.md`.

---

## 9. Invariants

| # | Invariant |
|---|---|
| 1 | a goal is closed **only** by `stop` (a `has_stopped` edge, and the `stop` node is the plan's last item); the request ends when its goal is stopped or it is declined — the doxa does not otherwise close anything |
| 2 | a criterion run is an ordinary `observation`; its `exitCode` (0 = pass, non-zero = fail) is the only verdict; absent `exitCode` = no verdict |
| 3 | for now a `stop` is accepted only with a passing criterion observation (`exitCode 0`); a give-up is deferred |
| 4 | the projection shows only actual facts: current versions, no stale content |
| 5 | `project` is deterministic: same events → same projection |
| 6 | the doxa only proposes: a goal enters unclosed, an action — without a result |
| 7 | operator selection: the logos supplies the applicable, the doxa chooses from it; with no criterion — the Arbiter |
| 8 | the trace is monotone: the base only grows; a change of knowledge is a new record (nodes are not edited) |
| 9 | the context is necessary and sufficient for the selected operator |
| 10 | no progress — stop (the Arbiter) |
| 11 | a refusal is recorded with a reason and is not stored as belief |
| 12 | secrets do not enter the IR; a small tool result's body may live in a node, a large one behind a temp-file reference |
| 13 | a `plan`/`alternatives` node always carries at least one item (`item`); every `goal` is created with a plan (≥1 item), and a plan item is only ever an `action` (I1–I2) |
| 14 | the first `request` is set by the Arbiter; it is interpreted exactly once (`has_goal`) or declined (`no_goal`); a request is not closed in the IR — acceptance is external and implicit |
| 15 | nodes have no stored statuses: state (`open`/`executed`/`stopped`) and the facts are entirely derived |
| 16 | structural edges (`has_goal`, `has_plan`, `item`, `has_alternatives`, `has_stopped`, `no_goal`) form a DAG — no cycles (a `stop` node is both the plan's last item and the `has_stopped` target) |
| 17 | the traversal makes at most K steps without progress at a node (a cursor shift, a new observation, a closure); otherwise `return` |
| 18 | the cursor does not decrease on an unchanged plan; a finished goal does not remain the focus, nor do its descendants (the branch is trimmed under a finished ancestor; after closure — `return`) |
| 19 | on failure `create goal` must list all failed options of the container (`revises`); otherwise a refusal |
| 20 | the command of a criterion run is the goal's `done_when` from the IR, not the doxa's text |
| 21 | the doxa never closes a goal by a verdict; `stop` is a proposal validated by the gate (a passing criterion); at a fresh request `create_goal` or `decline` applies — a request is never checked |
| 22 | a refusal or a failure changes the projection (`calls`, §2.8): a repeat creates no knowledge; otherwise a loop |
| 23 | a criterion move (`apply run { target }`) acts only on the node in focus; targeting an ancestor or a sibling is refused (`not_current_goal`) |
| 24 | a run without `target` (a bare `run`) is an observation, never a criterion |
| 25 | an observation without an `exitCode` (a timeout) leaves the goal `open` and may be repeated; it is not a repeat-refusal and not progress |
| 26 | the goal payload stores the initial plan as a string sketch (`plan`); the plan container materializes only the first concrete `step` (I3) |
| 27 | a sub-goal enters only as an alternative to an existing step; it is never a plan item (I6) |
| 28 | traversal is strictly step-by-step: one action per turn, the next chosen from its result; the engine never auto-runs the plan (I4) |
| 29 | every accepted doxa turn adds a node (continue / alternative / stop / decline); a rejected one adds `record_rejection` and changes the projection |
| 30 | a passing criterion does not auto-close a goal: the doxa must still `stop` it |

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
  whether a semantic dedup of `what` against the failed ones is needed (now a string
  comparison).
- **Give-up stops.** Today `stop` is accepted only once the criterion has passed
  (positive stops); a give-up on an exhausted plan (and whether the frontier should
  advertise it) is a later step.
- **Re-interpretation of a request.** Today the interpretation is created once and fixed
  (`has_goal`); whether a request may be re-interpreted is open.
- **Reserved.** `symbol`/`test` nodes and edges beyond §2.3 are declared but not produced
  by the current model; consider them outside the stage. The `set_status` event is not
  used: state is derived (§2.5).

### 10.2 Non-goals

- the doxa does not issue verdicts, does not infer;
- the context is not compressed by model summarization;
- file contents and secrets are not stored in the IR;
- logic is not "lowered" silently — when capabilities are lacking, an honest refusal;
- there is no "one right IR": the IR is a design parameter for the task.
