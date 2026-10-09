# Skein — the foundation and internal representation of a coding agent

> A working design document. Russian mirror — `docs/logos_ir_ru.md`.
>
> **Note.** This is a design/analysis document, not the as-built. Sections that describe
> what is "absent" or "not yet" (e.g. §4.5, §7) reflect the state at the time of writing;
> since then the operator model (three operators `create_goal`/`apply`/`stop` + read-only
> `query`), `no_progress` and the traversal stack have been implemented. The current
> as-built is `docs/ir.md`; the superseded roadmap is
> `docs/plans/archive/logos_roadmap_plan.md`.
>
> **Stop closure (later).** The `achieved`/`achieved_under`/`refuted`/`under` machinery
> described below (a per-goal arbiter acceptance via `record_check`) has since been
> **removed**. A frame closes **only** by the doxa's `stop`; every goal carries a command
> criterion, and a criterion run is an ordinary `observation` whose `exitCode` is the only
> pass/fail fact. The `Arbiter` remains only as a boundary authority (the first request,
> the final acceptance of the request), not a per-goal actor. Current model —
> `docs/ir_semantics.md`; example — `docs/walkthrough.md`.

We are building a coding agent whose computation is reliable and checkable, and whose
model context contains only what is necessary. To design such a device rather than
assemble it from improvised parts, we must first fix the conceptual foundation — the
idea of doxa and logos — then look at how it is realized in an already working system
(Ankyra), and only after that define the internal representation of the coding agent
and its logos.

The document is sequential: the foundation first (§1.1), then an example of its
realization (§1.2), then the move to the coding agent (§1.3), the practical goals
(§2), and the design decisions (§3–§10). Terms are introduced as they appear.

Three levels are kept strictly separate:

- **Foundation** — the idea of doxa and logos and the operator family (Ankyra,
  `doxa_and_logos_ru.tex`). Cited, not rewritten.
- **Invariants** — never change (including the existing ones from `AGENTS.md`).
- **Decisions** — may be revised (context composition, the state model).

---

## 1. The conceptual foundation and an example of its realization

### 1.1 Doxa and logos

As its conceptual frame this project uses the idea of splitting human consciousness
into two distinct parts: **doxa** — informal knowledge of the world, the result of
experience, and **logos** — an ideal system of reasoning. In this analogy the role of
doxa is played by the language model (LLM), and the role of logos by a formal system —
a symbolic solver. Together we call this a neuro-symbolic system
(`doxa_and_logos_ru.tex`, §"Introduction").

The point of the split is simple. A language model invents well but is not responsible
for the truth of what it invents; a formal system, on the contrary, cannot invent, but
can check rigorously. So in a neuro-symbolic system they divide the work: **the model
proposes, the logos decides**. The symbolic part may realize not only classical logics
but any other procedures a particular program needs — as long as they are
deterministic and checkable.

The split yields an **asymmetry** on which the whole system rests:

- **doxa does not own the truth** — it contributes not a fact but a *proposal*;
- **logos decides** — it classifies a proposal and either accepts or rejects it;
- **the protocol records** — it keeps a journal, so the whole exchange can be
  reproduced and checked.

The main rule: **nothing enters the system without a ground**. Every proposal the
model wants to add, deterministically — that is, by fixed rules, regardless of "mood" —
falls into one of four categories:

| Category | What it means | What the logos does |
|---|---|---|
| `cited` | supported by a verbatim quote from a source | accepts as a fact |
| `hypothesis` | knowledge the source does not have | accepts but marks as an assumption |
| `derivable` | already follows from what is present | accepts only as a paraphrase |
| `rejected` | fails the check | rejects and records the reason |

The key distinction is between the first two: **fact** and **assumption**. A
conclusion resting only on facts counts as proven (`proven`); a conclusion that needs
assumptions is honestly marked "proven under assumptions" (`proven_under(H)`) and
names those assumptions. Therefore **the strength of a conclusion never exceeds the
strength of its premises**, and an assumption cannot pass itself off as a fact.

The exchange is described by a small set of **operators**, divided by role
(`doxa_and_logos_ru.tex`, §"External operators", §"Internal operators", §"Protocol
operators"):

- **external operators** — the doxa's steps. They only add a proposal to a waiting
  queue and change nothing in the system itself.
- **internal operators** — the logos' steps. They recompute the system: take new
  information into account, cancel a previous conclusion, choose between competing
  rules, apply context.
- **protocol operators** — the environment's steps. They keep the journal and provide
  checkability: classify proposals, run checks, record every act.

A separate role is played by the **Arbiter** (`doxa_and_logos_ru.tex`, §"Arbiter"). He
decides not *what* to propose but **which step to take next** — which operator to apply
to the current state. The Arbiter is intentionally not fully automated: if two mutually
exclusive hypotheses agree equally well with the data, there is no formal criterion for
the choice, and the decision remains with a human or an external program acting by a
declared rule. This is important: **the arbiter is not the doxa**. He does not invent
content; he chooses the order of actions.

The process has two important properties:

- **the base grows, the answer may change.** Everything accepted — facts,
  assumptions, rules — stays in the base forever; in this sense the base is
  *monotone*. But the final answer may change when new information arrives. Every
  such change is recorded by a separate record (`Revision`) stating what was revised
  and why. In other words: knowledge changes, but the trace of it is not lost.
- **one step at a time.** One cycle of consulting the doxa is exactly one proposal.
  So every step is checkable: it is always visible at which step and why the state
  changed. The cycle stops when a decisive answer is obtained, when two consecutive
  steps changed nothing (`no_progress`), when the budget is exhausted, or when
  assumptions are disallowed.

Finally, the system must honestly acknowledge the limits of its logic. The
formalization of the task is analyzed, and from it the procedure needed is derived —
this is called the **declared fragment** (`ankyra_paper_ru.tex` §"Declared fragment").
If the available logic is not enough, the system answers `out_of_fragment` ("outside
the fragment") instead of trying to solve the task in a weaker way and passing it off
as a full result.

### 1.2 Ankyra: one foundation, different formalisms

To solve tasks, a formal system needs somewhere to store its objects, rules, and
conclusions — and a procedure that computes over that storage. The storage together
with the procedure we will call the **internal representation** (IR).

The key observation we will need later: **there is no single "correct" IR** — it is
chosen for the task. The best example is Ankyra.

Ankyra is not one solver but a **coordinator of several formalisms**
(`ankyra_paper_ru.tex` §"Formalisms and decision procedures"). Their exchange protocol
is common (doxa proposes, logos decides, protocol records), but the internal
representation and the decision procedure are their own:

| Stage | Formalism | Procedure | How knowledge is obtained |
|---|---|---|---|
| L0 | definite Horn clauses, open world | forward inference to a fixed point | **derived** |
| L1 | stratified negation (NAF), closed world | closure, incompatibility constraints | derived |
| L2 | positive first-order logic: disjunction, quantifiers | bounded resolution, case analysis | derived |
| L3 | finite-domain constraints (CSP/SAT) | **search over finite domains with backtracking** | **searched** |
| L4 | arithmetic terms and equations | exact rational elimination | **computed** |
| D | defaults with specificity via `is_a` | a default layer over the strict core | derived with preference |

What matters is not the number of logics but that the nature of "counting" in them is
**different** — knowledge is obtained in three different ways:

- **derived** (L0–L2). The storage is rules and facts, the procedure is closure.
  Example: "If it rains, the ground is wet. It rains." — the goal "the ground is wet"
  is derived in one step, no model needed.
- **searched** (L3). The storage is variables, their admissible values and
  constraints ("all different", "order", "next to", "in the same group"), the
  procedure is enumeration with backtracking. Example AR-LSAT: five plays must be put
  in some order; the question "which sequence is admissible" is solved by walking the
  tree of arrangements.
- **computed** (L4). The storage is a graph of quantities and equations, the procedure
  is the exact solution of a system of equations in fractions. Example GSM8K: a
  60-mile trip, two stops; the answer `60 − 20 − 15 = 25` is obtained exactly, and an
  arithmetic error is impossible by construction — one can err only in *modeling*, not
  in the computation.

Hence the main conclusion:

> **The IR is a design parameter fitted to the task.** The foundation (doxa proposes,
> logos decides, protocol records) is one; the storage and procedure are chosen so
> that the task is solved correctly and checkably. There is no "correct IR in
> general" — there is one suited to the given logic.

And one more observation we will use directly. **Backtracking search is a tree walk.**
The solver's context in L3 is exactly the current branch of the tree plus the active
constraints; backtracking is a step back (`pop`). So "context as a stack that changes
like an accordion while walking a tree" is not a metaphor but the operating mode of
an already existing Ankyra engine.

### 1.3 Moving to the coding agent

So far we have spoken of a system that only **reasons**: its proposals extend
knowledge but do not change the world. A coding agent is an **acting** system: it
edits files and runs commands (`edit`, `run`), so its actions change the world.
Therefore it needs **its own** internal representation and its own logos — fitted to
coding, not copied from Ankyra.

What is added to the reasoning system:

1. **Actions on files.** Editing and running commands change the contents of the
   storage, and this must be tracked deterministically: a file change can be learned
   only from a performed action, not from the model's guess.
2. **Witness of a check.** When a test confirmed a hypothesis, one must remember in
   what state of the code that was. Otherwise a later edit leaves the hypothesis
   "confirmed" for a different code — that is, silently wrong.
3. **Two arbiters.** The objective one — the toolchain (tests, typechecker) decides
   whether a check passed. The arbiter (the user) decides by acceptance
   criteria whether the goal is reached.

The foundation is inherited unchanged: doxa proposes, logos decides, protocol records;
nothing enters without a ground; the base is monotone, the answer moves. Only the roles
change: for coding, "theory" is the working graph and the world of files, "solver" is
tests, typechecker and other checks, "fragment" is the kind of task and the available
capabilities.

It is convenient to represent the work on a task as a **tree**: a goal carries a
**plan** (a `plan` node with ordered items) — a plan item is either a subgoal or a
command (`action`); when approaches compete, the goal gets an `alternatives` container
with options. To move forward is to descend one level in the tree; to abandon a failed
branch is to step back. And since the backtracking from §1.2 already shows the context
as a branch of the walk, the coding agent's context must likewise be a **slice of the
walk of this tree**, not a budget window.

Let us name Skein's difference from the Ankyra foundation right away: the doxa issues
exactly **two operators** — create a goal (`create goal`) and execute a command
(`apply`). Actions on the world (`read`/`grep`/`edit`/`run`) are
`apply`; there are no belief nodes or grounding quotes (the rationale is the `why`
text, an assumption is an `under` reference to a goal); there is no preference operator
(`o_spec`); the environment and tools are part of the **logos**, not a separate role.

This is the subject of the following sections: what practical goals we set, what
invariants we fix, what the logos' operator family and the state model should be, and
what we lack for that.

---

## 2. The task and practical goals

**How we test our agent.** We run it (henceforth **Skein**) on real tasks from the
terminal-bench set. In such a task the agent is given a repository and an instruction,
and the result is scored by an automatic verifier: it runs the tests and assigns a
`reward` — 1 if the task is solved and 0 if not. For comparison we use a **reference
agent** — another coding agent, `opencode`. A **run** is one complete launch of a task
by an agent from beginning to end.

### 2.1 The task, the ideal route, and what actually happened

**The task.** `fix-ocaml-gc` from terminal-bench. In the OCaml garbage collector,
run-length compression of free space in the major heap was recently enabled, and the
compiler began to crash during bootstrap. One must find and fix the bug, then show that
the basic test set passes: `make -C testsuite one DIR=tests/basic`. Importantly, the
task has an **objective completion criterion** — a concrete command that must finish
successfully, not "the model thinks it fixed it".

**The ideal route** the agent should aim for:

1. **Reproduce** the crash: build the compiler and run bootstrap, see the crash with
   one's own eyes.
2. **Localize**: the crash is in the garbage collector; the recent change is free-space
   compression, so the suspicion falls on `runtime/shared_heap.c`.
3. **Formulate a hypothesis**: what exactly was not accounted for (for example, the
   handling of free-block headers under compression).
4. **Make an edit** — narrowly, under this hypothesis.
5. **Check** with the same criterion: bootstrap and `testsuite`.
6. **Revise** if it did not pass: do not repeat the same thing, refine the hypothesis.
   Every check is recorded and settles the hypothesis's fate.

The key is the loop: at each turn there is a hypothesis, an edit, and **a check that
settles the hypothesis's fate**. This is what makes the route converge.

**What actually happened.** Skein was run on this task twice. In the **second** run it
made 60 steps: 17 reads, 18 searches, 23 command runs, **one** code edit, and
`finish`. Goals with plans and checks in the IR — zero. In the final answer Skein
named the cause itself: a segfault while compiling `utils/config.cmi` due to free-block
handling in `pool_sweep`/`pool_allocate` in `runtime/shared_heap.c`. That is, it
**understood** where to look — but gave no verified fix and finished on budget
exhaustion; the task was not counted (`reward` 0). In the **first** run the same Skein
managed to apply a fix before the process crashed with an `ENOENT`, and the verifier
counted the task (`reward` 1). So the problem is not the impossibility of the task but
an unmanaged process.

**Why it turned out that way.** Not because the context is large: the reference agent
(`opencode`) peaked at 60k tokens — three times more — and the task passed. The causes
are in the management:

- **no memory of the work.** Not a single goal with a plan or check as a
  node; Skein kept only a window of "last turns", which quickly "leaks", and it re-read
  and re-ran the same thing.
- **checks are tied to nothing.** 23 command runs, but not one confirms a concrete
  statement.
- **the single edit is tied to nothing**, so after it it is unclear what exactly to
  check.
- **stagnation is not noticed.** The deterministic part of Skein (its logos) saw more
  than ten steps without new knowledge and did not react. (For comparison: Ankyra
  stops the cycle itself after two steps without changes.)
- **the only limiter is the step budget** (60). It fired on time, not on progress.

**How to achieve this in our model.** The route above must cease to be a wish and
become a device:

- **the Arbiter chooses the operator, not the doxa.** The "route" (reproduce →
  localize → hypothesis → edit → check → revise) is the Arbiter's *policy*, descriptive
  sections, not state primitives. The model fills the chosen operator with content but
  does not decide for itself what is appropriate now.
- **the work's memory is in the IR**, not in the window of last turns: goals, plan
  items, commands, observations, and checks become nodes.
- **the check is tied to the goal** (`check` + the `verifies` edge): a run settles the
  fate of a concrete goal, not of "something in general"; when resting on an assumption
  the check has `under` edges.
- **stagnation is detected**: no new knowledge in K steps → stop or change branch
  (`no_progress`).
- **the context is the current branch of the route**, not a raw stream of outputs.

These five points are the subject of the following sections: goals (§2.2–2.3),
invariants (§3), the operator family (§4), the state model (§5), context (§6), and
operator selection (§7).

### 2.2 Practical goals

**T1. Reliable, checkable computation.** Every statement in the system's state must
have a source. Only a check may issue the verdict "confirmed" — a test, a typechecker,
or the user — but not the model. If the code changed after the check, the verdict loses
force rather than remaining silently true.

How we will know we have achieved it:

- the invariants hold: no statement "confirmed" without a check; an outdated fact is
  not shown as active;
- the context-building function is deterministic: the same events give the same
  context;
- the model has no step by which it could issue a verdict to itself.

**T2. Context necessary and sufficient.** The context must contain exactly what the
language model needs to decide in the current state of the IR — no more, no less. Two
sides of the criterion:

- **sufficient** — the model does not lose the thread and does not re-ask what is
  already established;
- **no more** — nothing extra distracts it or wastes tokens.

On long tasks this implies a stack: as the work tree is traversed, the current branch
is exactly what becomes necessary and sufficient — on descent the context grows, on
return it collapses (the very "accordion"). So its size is determined by the **depth of
the walk**, not by how much has already been traversed.

How we will know we have achieved it:

- on a long task the context does not grow linearly with the number of steps but
  plateaus; the peak corresponds to the depth of the work tree;
- the stable part does not change every step, so the cache share grows (the provider
  can cache a stable prefix: in the second Skein run, at steps 24–26 the cache read
  reached 8k tokens at 97%);
- the context has no multi-thousand-character dumps: full data — file contents, the
  test log — are reachable by identifier but do not hang in front of the eyes;
- Skein stops re-reading and re-running the same thing: fewer repeats of
  `read`/`grep`/`run` on the same files;
- the "thread" is not lost: what has already been done on the current path is visible.

### 2.3 Meta-result

Skein stops drifting. On `fix-ocaml-gc` it either converges to a solution or stops
honestly (`no_progress` — "no progress", `out_of_fragment` — "outside the available
logic"), instead of spinning 60 steps and giving up.

## 3. Invariants and non-goals

### 3.1 Invariants

An invariant is what must hold **always**, in any state and at any step. Violating it is
a design error, not "bad model behavior".

Already accepted (see `AGENTS.md`):

1. **No verdict without a check.** A goal cannot become "achieved" except through a
   check (`check` with verdict `pass`). The model proposes but does not certify.
2. **The non-actual does not act.** A fact that lost force due to a code change or the
   withdrawal of an assumption is never shown as active.
3. **The projection is deterministic.** The same events give the same context —
   regardless of time and order of calls.
4. **The doxa only proposes.** The model does not change state directly: its every step
   passes through classification, and an accepted proposal enters unclosed, not
   "confirmed".

New, from this design:

5. **The operator is not chosen by the doxa.** The decision of which operator is
   appropriate (create a goal, execute a command) is made by the **Arbiter** —
   an external instance (a human or the toolchain); the model only fills the chosen
   operator with content. The "route" is a descriptive policy of the Arbiter, not a
   state object.
6. **The trace is monotone.** The base only grows; a change of knowledge is a new event
   node (`check`, `mutate`, …), not a silent edit of a node. Knowledge changes, the
   trace of it is not lost.
7. **The context is necessary and sufficient for the selected operator.** The
   projection must give the model everything needed for the current step and nothing
   beyond (T2). Sufficiency is measured by the step's obligations, not "just in case".
8. **No progress — stop.** If in several steps no new knowledge appeared, the cycle
   stops or changes branch instead of spinning to the end of the budget.
9. **Nodes have no stored statuses.** State (executed, achieved, under an assumption,
   refuted) is **derived** from event nodes; nodes do not change.
10. **An assumption is honestly named.** Achievement with non-empty `under` is
    `achieved_under`, not `achieved`; `achieved` is only a `pass` check **without**
    assumptions.

The full list of invariants is in `docs/ir_semantics.md` §9.

### 3.2 Non-goals

What we deliberately do **not** do, so as not to pull the project sideways:

- **We do not let the model issue verdicts and statuses.** A verdict is the work of a
  check or the arbiter, not the doxa.
- **We do not introduce modes as a primitive.** The order of steps is the Arbiter's
  policy, not a state object; the state changes only through operators.
- **We do not make the model a critic or arbiter.** That would put the doxa in the
  logos' role.
- **We do not compress the context by model summarization.** Only deterministic rules;
  otherwise the savings vanish and correctness blurs.
- **We do not store file contents in the IR.** Artifacts are pointers; full data is on
  request.
- **We do not "lower" logic silently.** If a task is outside the available
  capabilities — an honest `out_of_fragment`, not a weak solution posing as a full one.
- **We do not optimize at the cost of correctness.** Cache, context size, and speed are
  secondary to the invariants.
- **We do not look for the "correct IR in general".** The IR is fitted to the task
  (§1.2).

> Process rules (minimal diff, no incidental refactoring, secrets only in `.env`)
> remain in `AGENTS.md` and are not duplicated here.

## 4. The operator family of the coding logos

In §1.1 we listed the roles the exchange consists of: external operators (doxa),
internal (logos), protocol (environment), and the Arbiter. Now let us see what each role
is filled with in a coding agent and where it is still empty. This list of roles is the
requirement for the logos.

### 4.1 External operators: the doxa proposes

In Skein the doxa makes exactly **one proposal** per step — one of the **two
operators**:

- **`create goal`** — create a subgoal and embed it as an item in the current goal's
  plan; the new goal may have its own plan (subgoal/command items);
- **`apply`** — execute a command (this includes `read`/`grep`/`edit`/`run`).

Actions on the world are a special case of `apply`, not separate operators. Both
are only proposals: none changes state until the logos executes it.

### 4.2 Internal operators: the logos recomputes

- **recompute on new information** (`o_rev`): a file change (`mutate`) — knowledge
  about the previous version ceases to be actual. The source is the agent's own action
  (`apply`) or observation of the outside world.
- **cancel/refute** (`o_def`): a failed check or the withdrawal of an assumption —
  closures resting on `under` lose force. This is a derived recomputation, not an edit
  of nodes.
- **context** (`o_ctx`): `project` — building what the model sees (T2).

There is **no** preference operator (`o_spec`): we have no defaults or specificity, so
there is nothing to prefer. The environment and tools are part of the logos, not a
separate role.

### 4.3 Fixation: journal and classification

The "protocol" role is not split into a standalone instance — the logos keeps the
journal and does the classification:

- **journal**: every event is appended; old ones are not rewritten;
- **classification**: deterministic gates (constraints, executability, the presence of
  a current node);
- **refusals**: `record_rejection` — a refusal is recorded with a reason;
- **checks**: `record_check` — the arbiter's verdict becomes a `check` node.

A state change is a **new event node** (`check`, `mutate`, …), not an edit of an
existing node.

### 4.4 The Arbiter: verdict and step selection

The verdict is issued not by the doxa and not by the logos, but by an external
instance:

- **objective arbiter** — the toolchain: tests, typechecker;
- **arbiter** — the user: by acceptance criteria.

The same Arbiter is the external selection function `W: Σ → O`: which operator to apply
next (§7). The doxa does not interfere.

### 4.5 What is missing

Let us summarize the roles and their filling:

| Role (Ankyra) | Meaning | In Skein | Status |
|---|---|---|---|
| abduction | propose new knowledge | `create goal` (subgoal/hypothesis) | present |
| action on the world | change the world | `apply` (`read`/`edit`/`run`) | present (specific) |
| revision | recompute on new information | `mutate` + actualness recomputation | present |
| cancellation | withdraw a previous conclusion | `o_def`: failed check/withdrawn assumption | present |
| preference | choose among competitors | — | **absent** (and not needed) |
| context | build the visible | `project` | present |
| journal | record an act | journal events | present |
| classification | assign a proposal to a category | `classify` (without `cited`) | present (without grounding) |
| Arbiter | issue a verdict | toolchain and user via `check` | present |
| **operator selection (`W`)** | **choose the next step** | **—** | **absent** |
| `no_progress` | stagnation stop | — | absent |
| `out_of_fragment` | honest refusal | — | absent |

Two gaps are immediately visible. The first is **operator selection (`W`)**. In §1.1
the Arbiter decides *which step to take next*; in Skein this decision is currently made
by the model itself — the doxa has taken the Arbiter's place, hence the drift of §2.1.
The direction of work: introduce `W` as an **external** function (a human or a rule), so
that the "route" is a policy rather than the model's whim.

The second is **honesty and stopping**: there is no stagnation stop (`no_progress`) and
no honest refusal of an inexpressible task (`out_of_fragment`). We deliberately do not
introduce beliefs and grounding (`cited`): the rationale is the `why` text, a formal
assumption is an `under` reference (§8).

## 5. The state model

The logos works with state. To choose a step and build context, the state must contain
not a "chat history" but several distinguishable parts. Some of them already exist in
Skein; some are the subject of work.

### 5.1 The base — accumulated knowledge

This is the graph of the work and the world: nodes (goal, plan, subgoal/command items,
alternatives, actions, observations, checks, constraints) and the links
between them; here too are pointers to files. The base is **monotone**: nodes and links
are only added, nothing is deleted. A code change does not erase knowledge about it —
the previous knowledge merely ceases to be actual (computed, §1.1).

### 5.2 The journal — an append-only trace

All events — add a node, add a link, note a file change, record a check, record a
refusal — are appended to the journal and never rewritten. The base is the fold of the
journal. Hence determinism: the same events give the same state, and therefore the same
context. The journal is the protocol by which every step can be checked.

### 5.3 The proposal queue

Between "proposed" and "accepted" stands a queue. A proposal goes there and waits for
the logos' decision: the accepted one goes into the base, the rejected one is recorded
as a refusal, the undecided one may wait for the next step. In the current cycle there
is exactly one proposal per step, so the queue is effectively one-element; but as a
concept it is needed — it is what separates a doxa proposal from a base fact.

### 5.4 The traversal stack — where we are in the tree

Work on a task is a tree (§1.3). The **stack** holds the current path in it: goal → plan
item (or an `alternatives` option) → action. Descent (create a subgoal, choose an
option) pushes a new branch onto the stack; abandoning a failed branch pops it. It is
the stack that makes the context an "accordion": on descent it grows, on return it
collapses. Conceptually the tree is "ReAct unwound along a tree": the stack is a stack
of frames — the **spine** — plus each level's siblings, the **arms**; it is
`fold(journal)`, a derived value rather than independent state. This is a new part:
currently Skein has no explicit "where we are in the tree". The full specification is
`docs/plans/traversal_stack_spec.md`.

### 5.5 Records of a change of answer

When the answer changes — a goal was `achieved`, and after a code change or the
withdrawal of an assumption the closure lost force — this is **derived** and requires
no edits: a new event node (`mutate`, `check`) changes the computed state,
while the original nodes remain. Thus the base is monotone and the answer honestly
moves: knowledge changes, the trace of it is preserved.

### 5.6 How it connects

The journal accumulates events; its fold gives the base. Executed proposals from the
queue replenish the base. The stack sets the current branch of the tree. The projection
reads the base and the stack and builds what the model sees. A state change is a new
event node, and the derived state is recomputed.

## 6. Context as a projection of state

### 6.1 What it is

A projection is a deterministic function that builds from the state exactly what the
model sees. Its role is called "context" in §4. It is **not** a model retelling of the
history and **not** a similarity search (as in RAG): the rules are fixed, the result
depends only on the state. The same events and the same step give the same context.

### 6.2 What goes in

The projection is assembled from what is needed for the **current step**, the selected
operator:

- **goal and constraints** — what we solve and what must not be violated;
- **the current branch** (top of the stack) — where we are now in the work tree;
- **the branch's obligations** — what remains: plan items, unchosen `alternatives`
  options, unclosed subgoals;
- **evidence** — what confirms or refutes these obligations: the last check (`check`),
  an observation;
- **backtrack points** — `alternatives` and rejected branches: where to return if the
  current one fails;
- **a brief summary** — what just happened, compressed (not raw output);
- **pointers** — identifiers by which details can be fetched on request.

### 6.3 What does not go in

Raw tool output, the full step history, branches unrelated to the current one, file
contents. None of this is "forgotten": it remains in the base and is fetched by
identifier. The only difference is that it does not constantly occupy attention. An
explicit read's observation is shown as the action's result — within the budget; the
full data is always fetched by reference.

### 6.4 Why "necessary and sufficient"

**Sufficient**: the set is assembled from the obligations of the current step — each
operator knows in advance what it needs. To propose a subgoal, one needs the goal and
its plan; to execute a check — the goal and the manner of checking. **No more**:
anything not on the current branch and not an obligation does not enter the context.

Example. On the task from §2.1, at the moment of setting the subgoal "find the cause of
the segfault", the context needs: the goal, the current plan, the evidence (where it
crashes, what recently changed) and the backtrack points. The eight-kilobyte build logs
are not needed there — they are reachable by reference.

### 6.5 Stability and cache

The order of the parts is chosen so that the beginning is as stable as possible: first
the unchanging (goal, constraints, settled knowledge — in chronological order), at the
end the mutable (the current branch, the last result). Then the provider caches a long
stable prefix, and only the tail is recomputed. This directly serves T2.

## 7. Operator selection (`W`)

### 7.1 What it is

In §1.1 the Arbiter decides *which step to take next*. This is exactly `W: Σ → O` —
the choice of an operator by state. It is **external** and intentionally not fully
automated: if two options are equally consistent, there is no formal criterion and a
human decides (or an external program by a fixed rule).

As shown in §4.5, the choice is currently made by the model itself — it is free to take
any operator. The direction of work: make `W` an explicit external function, so that the
doxa fills the chosen operator with content rather than choosing it.

### 7.2 The route as policy

The "route" of §2.1 (reproduce → localize → hypothesis → edit → check → revise → stop)
consists of *policy* sections of the Arbiter, descriptive. These are **not** state
objects and not primitives: a concrete route may be a rule of the external function
`W`, but the IR itself has no modes. The content of each step is filled by the doxa.

### 7.3 How it is chosen

By the rules of the external policy (a human or a program). For example:

- there is no crash evidence yet → the subgoal "reproduce";
- the goal has an unclosed plan item → execute it;
- an edit was made but the goal is not checked → `apply` a check;
- the goal is refuted → a new option in `alternatives`;
- several steps in a row without new knowledge → "stop".

This is only an illustration; the exact rule set is the subject of §9.

### 7.4 The model's role

The model does **not choose** the operator — it fills the chosen step with content. For
example, in the step "set a subgoal" it proposes `what` and a plan, in the step "check"
— the checking command. The doxa supplies content, the Arbiter the order of steps.

### 7.5 Why this is needed

- **the drift disappears**: the model cannot wander off into senseless enumeration,
  because the order of operators is set by the Arbiter;
- **progress becomes measurable**: it is visible which obligations are closed and which
  are not — this is what the stagnation stop is based on;
- **the context becomes necessary and sufficient**: the step declares in advance what
  is needed, and the projection (§6.4) is assembled exactly for that.

### 7.6 Loop detection

Looping is not a separate sensor but **the absence of progress**, and progress here is
relative to the selected step. So detection is composed of layers; all of them are
deterministic logos rules, not the model's judgment.

Three forms to distinguish:

- **repeat** — the same action with the same inputs (re-read a file, re-run a command);
- **stagnation** — steps proceed but obligations do not close;
- **oscillation** — the state fluctuates (`achieved` ↔ closure withdrawn, branch A ↔ B)
  without converging.

Detection layers:

1. **Action signature.** `tool` + normalized target + **input versions** (`ref`/witness).
   A repeat with the same versions and no new knowledge is rejected by `classify` and
   recorded as a refusal (dedup and `×count` already exist in `frontier.refusals`). The
   input version is mandatory: re-running **after** an edit is legitimate — this is
   exactly what the witness/`mutate` provides.
2. **Step terminus.** Each policy step declares what it counts as progress and its exit
   condition: localization — a new distinguishable `ref`; reproduction — crash
   evidence; check — a verdict. No exit within K steps — escalation (change of tactic,
   backtrack), not continuation.
3. **Obligation cooldown.** The delta of open and closed obligations and actual facts is
   counted, **not** of nodes: every `read` writes a fresh `observation`. Consider not
   only "nothing new" but also closure rate ≈ 0 with a growing frontier — otherwise a
   stream of new hypotheses masks the loop.
4. **Traversal control.** A loop is a non-converging branch. K steps without closing at
   the top of the stack → `pop`; exhaustion of the root → `no_progress` or
   `out_of_fragment`.
5. **Witness churn (backstop).** While the witness is crude (the whole workspace, §9),
   the build itself kills checks. N fluctuations of one goal `achieved` ↔ closure
   withdrawn without drift of its witness — a signal; the cure is witness precision
   (step 5 §9.3).

The stop reason is chosen by §8.3: evidence exists but there is no check — a capability
gap → `out_of_fragment`; there is no explanation — an explanatory gap → a new
hypothesis is still appropriate. The budget remains the last resort, not the only
limiter (§2.1).

## 8. Honesty: `achieved` / `achieved_under` / `out_of_fragment`

### 8.1 Principle

The strength of a conclusion must not exceed the strength of its premises (§1.1). In
coding terms this means: an agent may not present an edit as "works" if that is not
confirmed by a check, and may not conceal that the confirmation rested on a guess.

### 8.2 Three closure outcomes

- **`achieved`** — the goal is closed by a check (`check` with verdict `pass`) and
  **does not rest on assumptions** (no `under` edges). Example: the test passes.
- **`achieved_under`** — reached **under an assumption**: the closing check has `under`
  edges (references to assumption-goals). The assumptions are named and revocable.
  Example: "suppose the cause is in the handling of free blocks" — the edit helped but
  the mechanism is not confirmed.
- **outside the fragment** (`out_of_fragment`) — the task requires capabilities the
  system lacks: the needed logic, tool, or time. This is an honest refusal, not a weak
  answer posing as a full one. The mechanism is deferred.

A goal without closure remains `open`; a failed check — `refuted`; an unchosen
`alternatives` option — `abandoned` (all derived).

### 8.3 Two kinds of gap

It is important not to conflate two different signals that arise when something is
missing.

- **Explanatory gap.** Evidence exists but the explanation does not: the crash was
  reproduced but the cause is unknown. This is a push to **abduction** — the step "set
  a hypothesis-subgoal" (§7): the model proposes an explanation that a check will later
  confirm or refute.
- **Capability gap.** There may be any amount of knowledge, but the system lacks the
  needed procedure or tool — for example, there is no way to check the hypothesis, or
  the task requires logic beyond the available one. This is `out_of_fragment`: an
  honest refusal, not a reason to propose new hypotheses.

The difference is fundamental: the first signal leads to new knowledge, the second to a
stop. Conflating them means either endlessly proposing hypotheses where there is no way
to check, or giving up where only one guess was missing.

### 8.4 Grounding in an observation, not in a quote

In Ankyra a statement is grounded by a verbatim quote. Skein does not keep belief nodes:
the evidence is a command **observation** (`observation`), and a goal's rationale is the
`why` text field. The statement "line 42 has `<`, not `<=`" is not a fact node but a
read observation; the statement "it is a boundary condition" is a `why` that can be
**made an assumption** by creating a hypothesis-goal and referencing it with the `under`
edge. The distinction matters: on `under` a closure is honestly marked `achieved_under`;
on an observation it is not.

### 8.5 How this is reflected in the state

- `achieved` appears only through a `pass` check **without** `under`; if its witness
  (file version) ceases to be actual, the force is withdrawn, derived.
- A closure resting on assumptions remains `achieved_under`, and the assumptions are
  listed as `under` references.
- The closure of the root goal itself is external: the Arbiter decides it by acceptance
  criteria.

### 8.6 Why

The user has the right to know what the result stands on. And this directly cures the
failure of §2.1: the agent named the root cause but had no verified fix — an honest mark
would have forced it to leave the goal explicitly unclosed rather than finish the work
as if it were done.

## 9. Gap analysis and roadmap

### 9.1 What is already done

Part of the mechanics was closed along the way in this design (it does not concern
`W`):

- `run` without hypotheses no longer produces a "check" — previously, with an empty
  graph, garbage checks appeared; now it is an observation;
- file changes are tracked by signatures rather than hashing the whole workspace on
  every step; only changed files are hashed;
- the fragility on disappearing build files (`ENOENT`) has been removed;
- the visibility budget is split: memory (closures, refusals, subgoals) is not
  truncated, the stream of last steps is limited by characters, `index` is a window.

This removes part of the cost and noise but does not cure the management — the main
cause of the failure of §2.1.

### 9.2 What is missing

The gaps from §4.5 fall into three groups:

1. **Management.** There is no `W` (external operator selection) and no traversal
   stack. Currently the model chooses the step, and "where we are in the tree" is
   stored nowhere.
2. **Stopping and honesty.** There is no `no_progress`, no `Revision` records, no
   `out_of_fragment`, no distinction between "grounded in code" and "hypothesis";
   repeat and oscillation are not detected (§7.6).
3. **Check precision.** The witness is a snapshot of the whole workspace: sound but
   crude (it kills checks on unrelated changes). Precision is deferred as before.

### 9.3 Proposed order

The order was revised relative to the first edition: measurement first, then management,
then honesty. What and why changed is in §9.5.

0. **Baseline and a no-degradation gate.** Freeze the base metrics (steps, tokens,
   cost) on a simple set and a terminal-bench sample and make them a check before
   accepting any next step. Without this, treatment is blind: one cannot tell "better"
   from "worse". It relies on the existing `bench/`.
1. **A `W` gate and linear routes.** The first rule — "you may not change code while
   there is no open hypothesis"; the routes proceed linearly (reproduce → hypothesis →
   check → revise). An explicit fast path for trivial tasks where the tree does not
   unfold. Full per-state route selection (§7.3) is the next step, not this one: it
   requires branching and projection. This closes the drift and makes progress
   measurable.
2. **`cited`.** Distinguish what is grounded in code from a hypothesis. It stands next
   to `W`, because the `W` gates are keyed on "an open hypothesis", and without
   grounding every statement is a hypothesis. The category already exists in
   `classify` but is not returned.
3. **Branch in the projection, then the stack and rollback.** First show only the
   active path as a filter over the already existing reachable closure; measure; then
   the full traversal stack with rollback. This is T2; the full route selection from
   step 1 moves here too.
4. **`no_progress` and loop detection.** Stop or change branch on repeat, stagnation,
   or oscillation (§7.6). "New knowledge" is defined semantically (new obligations and
   facts), not by node growth: every `read` creates a fresh `observation`, so counting
   nodes will not catch stagnation. The detection layers are distributed over the
   steps: action signature — in step 1, step terminus and traversal control — in step 3,
   witness churn — in step 5.
5. **`Revision` and crude witness precision.** Record the change of answer; if
   derivation from the journal suffices — as a projection rather than new state. Along
   with this, exclude generated and build artifacts from the witness: currently the
   witness is the whole workspace, and the check command itself writes `_build`, so
   checks kill each other and management loops on churn.
6. **`out_of_fragment`.** An honest refusal of an inexpressible task — after a separate
   "declared fragment" design (an inventory of procedures and tools), otherwise one
   cannot distinguish an explanatory gap from a capability gap (§8.3).
7. **(deferred) full witness precision** — narrow it to the dependency closure via the
   ecosystem's tools.

### 9.4 How we verify

- the invariants (§3) hold — by tests;
- on `fix-ocaml-gc` Skein either converges or stops honestly; comparison with the saved
  reference run;
- the context plateaus and the cache share does not fall;
- fewer repeats of `read`/`grep`/`run` on the same files;
- **there is no degradation on simple tasks.** The routes and gates must not worsen
  short tasks: the number of steps, tokens, and cost — no higher than the reference on
  a simple set. If a task is solved at once, the system need not create hypotheses and
  unfold a tree: the overhead must be proportional to the task's complexity, not its
  constant cost. (A warning sign already occurred: in the previous design, on easy
  tasks the steps and context grew noticeably.)

This order is consistent with the overall plan
(`docs/plans/implementation_plan.md`) and refines it; the detailed work plan is
`docs/plans/archive/logos_roadmap_plan.md`.

### 9.5 Roadmap revision (what changed and why)

In the spirit of §10: we do not rewrite silently. Relative to the first edition of
§9.3:

- **Step 0 (baseline and no-degradation gate) added.** §9.4 names the risk of
  degradation on simple tasks but checked it at the end; without metrics captured in
  advance and a gate, one cannot tell benefit from harm.
- **`W` split** into a gate and linear routes (step 1) and full per-state selection
  (inside step 3). A full `W` requires branching and projection; making it first would
  force a rewrite.
- **`cited` raised from 5th place to `W`.** This is not late honesty but a condition
  for the correctness of the `W` gates.
- **`no_progress` refined.** Defining "new knowledge" by node growth is unworkable
  (`read` always writes a new node); a semantic metric is needed.
- **Witness precision raised from "deferred" to step 5 (crude version).** A crude
  witness interacts with `W`, `Revision`, and `no_progress`: the build itself kills
  checks, producing false churn. Full precision remains deferred.
- **`out_of_fragment` marked as requiring a separate "declared fragment" design.**
- **`Revision` refined** as a possible projection over the append-only journal rather
  than new state.
- **§7.6 added and step 4 expanded — loop detection.** Repeat, stagnation, and
  oscillation are caught by layers (signature, terminus, cooldown, traversal, churn),
  not one counter; so the definition of progress is tied to the step.

### 9.6 Bringing it to the IR semantics

The terms and the operator model of this document have been brought to the source of
truth — `docs/ir_semantics.md`. What changed:

- **Two operators instead of a set of actions.** The doxa proposes `create goal` and
  `apply`; `read`/`grep`/`edit`/`run` are special cases of `apply` (§4.1).
  The "mode selection" steps in §7 are renamed to *policy*.
- **`W` is external.** The operator is chosen by the Arbiter (a human or a rule), not
  by the logos and not by the doxa (§4.5, §7.1). The phrasing "move `W` into the logos"
  is replaced by "make `W` an explicit external function".
- **No mode primitives.** "Reproduce/localize/…" are policy sections, not state objects
  (§7.2).
- **Honesty — `achieved`/`achieved_under`.** There are no belief nodes and no grounding
  (`cited`): the rationale is `why`, an assumption is an `under` reference; achievement
  under an assumption is `achieved_under` (§8).
- **State is derived.** There are no status fields and no `stale`; the file version and
  actualness are computed (§5).
- **No preference operator (`o_spec`); the environment is part of the logos** (§4.2).

Consequences for the roadmap: step 2 ("`cited`") is cancelled — the "grounded /
hypothesis" distinction is replaced by the pair "observation / `why`+`under`"; step 1
speaks of `W` as an external function; mentions of "modes" should be read as "policy".
The remaining steps (0, 3–7) are preserved.

## 10. Revision of `concepts.md`

This document refines and partly changes `concepts.md` version 1.0. To make the changes
explicit rather than a silent edit, let us list them; the new version of the concepts
will be assembled from this document.

**What changes in substance:**

1. **Context is not a "window with a `tail` parameter".** In version 1.0 the visibility
   budget was set by a single parameter. Now the context is a projection of state, and
   its composition is derived from the obligations of the current step (§6). Memory is
   not truncated by line count; the stream of last steps is limited by characters.
2. **Step selection is not the doxa's.** In version 1.0 the model chose any action. Now
   `W` is introduced — an external operator-selection function (§7): the doxa fills the
   chosen step but does not choose it.
3. **The state model is extended.** A proposal queue, a traversal stack, and `Revision`
   records are added (§5).
4. **Honesty becomes explicit.** `achieved` / `achieved_under` / `out_of_fragment`; the
   distinction "observation" versus "`why`+`under`" (§8).
5. **A stagnation stop appears** (`no_progress`, §3).
6. **The raw stream of outputs goes away.** Instead of dumps — a compressed summary and
   fetching details by identifier (§6).
7. **The operator model is refined.** The doxa proposes two operators
   (`create goal`/`apply`); `W` is an external Arbiter; routes are policy;
   honesty is `achieved`/`achieved_under`; state is derived (§4.1, §7, §8).

**What remains unchanged:** the doxa/logos distinction, the invariants (extended but not
revoked), the determinism of the projection, the prohibition of a verdict from the
model.

**On the manner of revision itself.** In the spirit of the "monotone base" we do not
rewrite version 1.0 silently: the new version will be a separate document, and here it
is recorded what changed and why.
