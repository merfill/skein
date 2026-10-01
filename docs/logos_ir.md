# Skein — the Foundation and Internal Representation of a Coding Agent

> Working design document. Russian mirror — `docs/logos_ir_ru.md`.

We are building a coding agent whose computation is reliable and verifiable, and
whose context for the model contains only what is necessary. To design such a
device rather than assemble it from ad-hoc pieces, we must first fix the
conceptual foundation — the idea of doxa and logos — then look at how it is
implemented in a working system (Ankyra), and only after that define the coding
agent's internal representation and its logos.

The document proceeds in order: first the foundation (§1.1), then an example of
its implementation (§1.2), then the transition to a coding agent (§1.3),
practical goals (§2), and design decisions (§3–§10). Terms are introduced as they
appear.

Three levels are kept strictly apart:

- **Foundation** — the idea of doxa and logos and the operator family (Ankyra,
  `doxa_and_logos_ru.tex`). Cited, not rewritten.
- **Invariants** — never change (including the existing ones in `AGENTS.md`).
- **Decisions** — may be revised (the makeup of the context, the state model,
  statuses).

---

## 1. Conceptual foundation and an example of its implementation

### 1.1 Doxa and logos

As its conceptual frame, this project uses the idea of dividing human
consciousness into two distinct parts: **doxa** — informal knowledge of the
world, the result of experience — and **logos** — an ideal system of reasoning.
In this analogy the role of doxa is played by a language model (LLM), and the
role of logos by a formal system, a symbolic solver. Together we call this a
neuro-symbolic system (`doxa_and_logos_ru.tex`, §"Introduction").

The point of the division is simple. A language model is good at inventing, but
does not answer for the truth of what it invents; a formal system, conversely,
cannot invent, but can check rigorously. So in a neuro-symbolic system they
divide the work: **the model proposes, the logos decides**. The symbolic part may
implement not only classical logics but any other procedures a given program
needs — as long as they are deterministic and verifiable.

From this division follows the **asymmetry** the whole system rests on:

- **doxa does not own the truth** — it contributes not a fact but a *proposal*;
- **the logos decides** — it classifies the proposal and either accepts or
  rejects it;
- **the protocol records** — it keeps the journal, so the whole exchange can be
  reproduced and checked.

The main rule: **nothing enters the system without grounds**. Every proposal the
model wants to add is deterministically — that is, by fixed rules, independent of
"mood" — placed into one of four categories:

| Category | What it means | What the logos does |
|---|---|---|
| `cited` | backed by a verbatim quote from the source | accepts as a fact |
| `hypothesis` | knowledge absent from the source | accepts but marks as an assumption |
| `derivable` | already follows from what is present | accepts only as a paraphrase |
| `rejected` | fails a check | rejects and records the reason |

The key distinction is between the first two: a **fact** and an **assumption**. A
conclusion resting only on facts is counted as proven (`proven`); a conclusion
that needs assumptions is honestly marked "proven under assumptions"
(`proven_under(H)`) and names them. Hence **the strength of a conclusion never
exceeds the strength of its premises**, and an assumption cannot pass itself off
as a fact.

The exchange is described by a small set of **operators**, divided by role
(`doxa_and_logos_ru.tex`, §"External operators", §"Internal operators",
§"Protocol operators"):

- **external operators** — the steps of doxa. They only add a proposal to the
  waiting queue and change nothing in the system itself.
- **internal operators** — the steps of the logos. They recompute the system:
  account for new information, retract a previous conclusion, choose between
  competing rules, apply context.
- **protocol operators** — the steps of the environment. They keep the journal
  and ensure checkability: classify proposals, run checks, record every act.

A separate role is played by the **Arbiter** (`doxa_and_logos_ru.tex`,
§"Arbiter"). It decides not *what* to propose but **which step to take next** —
which operator to apply to the current state. The arbiter is deliberately not
fully automated: if two mutually exclusive hypotheses fit the data equally, there
is no formal criterion for the choice, and the decision stays with a human or an
external program acting by a declared rule. This matters: **the arbiter is not
doxa**. It does not invent content; it chooses the order of actions.

The process has two important properties:

- **the base grows, the answer may move.** Everything accepted — facts,
  assumptions, rules — stays in the base forever; in this sense the base is
  *monotone*. But the final answer may change when new information arrives. Each
  such change is recorded as a separate entry (`Revision`) stating what was
  revised and why. In other words: knowledge changes, but the trace of it is not
  lost.
- **one step at a time.** One cycle of addressing doxa yields exactly one
  proposal. So every step is checkable: it is always visible at which step and
  why the state changed. The cycle stops when a decisive answer is obtained, when
  two steps in a row changed nothing (`no_progress`), when the budget is
  exhausted, or when assumptions are disallowed.

Finally, the system must honestly acknowledge the limits of its logic. The
formalization of the task is analyzed, and the procedure it requires is derived —
this is called the **declared fragment** (`ankyra_paper_ru.tex` §"Declared
fragment"). If the available logic is insufficient, the system answers
`out_of_fragment` ("outside the fragment") rather than trying to solve the task
by a weaker method and passing it off as a full result.

### 1.2 Ankyra: one foundation, different formalisms

To solve tasks, a formal system needs somewhere to store its objects, rules and
conclusions — and a procedure that computes over that store. The store together
with the procedure we call the **internal representation** (further — **IR**).

The key observation we will need later: **there is no single "correct" IR** — it
is tailored to the task. The best example is Ankyra.

Ankyra is not a single solver but a **coordinator of several formalisms**
(`ankyra_paper_ru.tex` §"Formalisms and decision procedures"). Their exchange
protocol is common (doxa proposes, the logos decides, the protocol records),
while the internal representation and the decision procedure are specific to
each:

| Stage | Formalism | Procedure | How knowledge is obtained |
|---|---|---|---|
| L0 | definite Horn clauses, open world | forward chaining to a fixed point | **derived** |
| L1 | stratified negation (NAF), closed world | closure, inconsistency constraints | derived |
| L2 | positive first-order logic: disjunction, quantifiers | bounded resolution, case analysis | derived |
| L3 | finite-domain constraints (CSP/SAT) | **search over finite domains with backtracking** | **searched** |
| L4 | arithmetic terms and equations | exact rational elimination | **computed** |
| D | defaults with specificity via `is_a` | a default layer over a strict core | derived with preference |

What matters is not the number of logics but that the nature of "computing" is
**different** in each — knowledge is obtained in three different ways:

- **derived** (L0–L2). The store is rules and facts, the procedure is closure.
  Example: "If it rains, the ground is wet. It rains." — the goal "the ground is
  wet" is derived in one step; no model is needed.
- **searched** (L3). The store is variables, their allowed values, and
  constraints ("all different", "order", "adjacent", "in the same group"); the
  procedure is enumerating options with backtracking. Example AR-LSAT: five plays
  must be arranged in some order; the question "which sequence is admissible" is
  answered by traversing the tree of arrangements.
- **computed** (L4). The store is a graph of quantities and equations; the
  procedure is exact solution of a system of equations in fractions. Example
  GSM8K: a 60-mile trip with two stops; the answer `60 − 20 − 15 = 25` is exact,
  and an arithmetic error is impossible here by construction — one can err only
  in *modelling*, not in arithmetic.

Hence the main conclusion:

> **IR is a design parameter tailored to the task.** The foundation (doxa
> proposes, the logos decides, the protocol records) is one; the store and the
> procedure are chosen so that the task is solved correctly and checkably. There
> is no "correct IR in general" — only one suited to a given logic.

And one more observation we will put to direct use. **Backtracking search is a
tree traversal.** The solver's context in L3 is exactly the current branch of the
tree plus the active constraints; backtracking is a step back (`pop`). That is,
"context as a stack that behaves like an accordion as the tree is traversed" is
not a metaphor but the operating mode of an engine Ankyra already has.

### 1.3 Moving to a coding agent

So far the subject has been a system that only **reasons**: its proposals expand
knowledge but do not change the world. A coding agent is a system that **acts**:
it edits files and runs commands (`edit`, `run`), so its actions change the
world. Hence it needs **its own** internal representation and its own logos —
tailored to coding, not copied from Ankyra.

What is added to a reasoning system:

1. **Actions on files.** Editing and running commands change the contents of the
   store, and this must be tracked deterministically: a file change can be known
   only from a performed action, not from the model's guess.
2. **A check witness.** When a test confirmed a hypothesis, we must remember the
   state of the code under which it was confirmed. Otherwise a later edit leaves
   the hypothesis "confirmed" for different code — that is, silently wrong.
3. **Two arbiters.** The objective one — the toolchain (tests, type checker) —
   decides whether a check passed. The subjective one — the user — decides by
   acceptance criteria whether the goal is achieved.

The foundation is inherited unchanged: doxa proposes, the logos decides, the
protocol records; nothing enters without grounds; the base is monotone, the
answer moves. Only the roles change: for coding, the "theory" is the work graph
and the world of files, the "solver" is tests, the type checker and other checks,
and the "fragment" is the kind of task and the available capabilities.

It is convenient to view the work on a task as a **tree**: the goal splits into
subgoals, subgoals into hypotheses and decisions, those into actions and checks.
To move forward is to descend one level in the tree; to abandon a failed branch
is to step back. And since backtracking search from §1.2 already shows context as
a branch of a traversal, the coding agent's context must likewise be **a slice of
the traversal of this tree**, not a budget window.

This is the subject of the following sections: what practical goals we set, which
invariants we fix, what the logos's operator family and the state model should
be, and what we lack for that.

---

## 2. The task and practical goals

**How we test our agent.** We run it (further — **Skein**) on real tasks from the
terminal-bench set. In such a task the agent is given a repository and an
instruction, and the result is judged by an automatic verifier: it runs tests and
assigns a score `reward` — 1 if the task is solved, and 0 if not. For comparison
we use a **baseline agent** — another coding agent, `opencode`. A **run** is one
complete execution of a task by an agent from start to finish.

### 2.1 The task, the ideal route, and what actually happened

**The task.** `fix-ocaml-gc` from terminal-bench. In the OCaml garbage collector,
run-length compression of free space in the major heap was recently enabled, and
the compiler began to crash while bootstrapping itself. The task is to find and
fix the error, and then show that the basic test set passes:
`make -C testsuite one DIR=tests/basic`. Importantly, the task has an
**objective completion criterion** — a concrete command that must succeed — not
"the model thinks it fixed it".

**The ideal route** the agent should strive for:

1. **Reproduce** the crash: build the compiler and run the bootstrap, see the
   crash with one's own eyes.
2. **Localize**: the crash is in the garbage collector; the recent change is
   free-space compression, so suspicion falls on `runtime/shared_heap.c`.
3. **Form a hypothesis**: what exactly was not accounted for (for example, the
   handling of free-block headers under compression).
4. **Make an edit** — narrowly, under this hypothesis.
5. **Check** by the same criterion: bootstrap and `testsuite`.
6. **Revise** if it does not pass: do not repeat the same thing but refine the
   hypothesis. Each check is recorded and decides the fate of the hypothesis.

The key here is the cycle: each turn has a hypothesis, an edit, and **a check
that decides the fate of the hypothesis**. That is what makes the route converge.

**What actually happened.** Skein was run on this task twice. In the **second**
run it made 60 steps: 17 reads, 18 searches, 23 command runs, **one** code edit
and `finish`. Hypotheses in the IR — zero (0 claims, 0 decisions, 0 subgoals). In
its final answer Skein itself named the cause: a segfault while compiling
`utils/config.cmi`, due to the handling of free blocks in `pool_sweep` /
`pool_allocate` in `runtime/shared_heap.c`. That is, it **understood** where to
look — but produced no checked fix and finished by exhausting the budget; the
task was not counted (`reward` 0). In the **first** run the same Skein managed to
apply a fix before the process died with an `ENOENT` error, and the verifier
counted the task (`reward` 1). So the issue is not the impossibility of the task
but an unmanaged process.

**Why it turned out this way.** Not because the context is large: the baseline
agent (`opencode`) peaked at 60k tokens — three times more — and passed the task.
The reasons are in management:

- **no memory of the work.** Not a single hypothesis, edit or check as a node;
  Skein retained only a window of "recent steps", which quickly "leaked", and it
  re-read and re-ran the same things.
- **checks are attached to nothing.** 23 command runs, but not one confirms a
  specific statement.
- **the single edit is attached to nothing**, so after it it is unclear what to
  check.
- **stagnation is not noticed.** The deterministic part of Skein (its logos) saw
  more than ten steps without new knowledge and did not react. (For comparison:
  Ankyra stops the cycle by itself after two steps without change.)
- **the only limiter is the step budget** (60). It triggered on time, not on
  progress.

**How to achieve this in our model.** The route above must stop being a wish and
become a device:

- **the logos chooses the next step, not doxa.** The route becomes a sequence of
  modes: reproduce → localize → form a hypothesis → make an edit → check →
  revise. The model fills the step with content but does not itself decide what
  is appropriate now.
- **the memory of the work is in the IR**, not in a window of recent steps:
  hypotheses, edits and checks become nodes.
- **a check is attached to a hypothesis**: a run confirms or refutes a specific
  statement, not "something in general".
- **stagnation is detected**: no new knowledge for K steps → stop or change
  branch (`no_progress`).
- **the context is the current branch of the route**, not a raw stream of output.

These five points are the subject of the following sections: goals (§2.2–2.3),
invariants (§3), the operator family (§4), the state model (§5), context (§6),
and operator selection (§7).

### 2.2 Practical goals

**T1. Reliable, checkable computation.** Every statement in the system's state
must have a source. Only a check may issue the verdict "confirmed" — a test, a
type checker, or the user — but not the model. If the code changed after a check,
the verdict loses its force rather than silently remaining true.

How we will know we have achieved it:

- the invariants hold: there is no statement "confirmed" without a check; a stale
  fact is not shown as active;
- the context-building function is deterministic: the same events give the same
  context;
- the model has no step by which it could issue a verdict to itself.

**T2. Context necessary and sufficient.** The context must contain exactly what
the language model needs to make a decision in the current IR state — no more and
no less. Two sides of the criterion:

- **sufficient** — the model does not lose the thread and does not re-ask what is
  already established;
- **no more** — nothing extra distracts its attention or spends tokens.

On long tasks a stack follows from this: as the work tree is traversed, it is
exactly the current branch that becomes necessary and sufficient — going deeper,
the context grows; backtracking, it collapses (the "accordion"). So its size is
determined by the **depth of the traversal**, not by how much has already been
covered.

How we will know we have achieved it:

- on a long task the context does not grow linearly with the number of steps but
  reaches a plateau; the peak corresponds to the depth of the work tree;
- the stable part does not change every step, so the cache share grows (the
  provider can cache a stable prefix: in the second Skein run, at steps 24–26 the
  cache read reached 8k tokens at 97%);
- the context contains no dumps of thousands of characters: the full data — file
  contents, a test log — is available by identifier but does not hang in front of
  one's eyes;
- Skein stops re-reading and re-running the same things: fewer repeats of
  `read`/`grep`/`run` over the same files;
- the "thread" is not lost: what has already been done on the current path is
  visible.

### 2.3 Meta-result

Skein stops drifting. On `fix-ocaml-gc` it either converges to a solution or
stops honestly (`no_progress` — "no progress", `out_of_fragment` — "outside the
available logic"), instead of spinning for 60 steps and giving up.

## 3. Invariants and non-goals

### 3.1 Invariants

An invariant is what must hold **always**, in any state and at any step. Violating
it is a design error, not "bad model behaviour".

Already adopted (see `AGENTS.md`):

1. **No verdict without a check.** A statement cannot become "confirmed" except
   through a check. The model proposes but does not certify.
2. **The stale does not act.** A fact that lost its force due to a code change is
   never shown as active.
3. **The projection is deterministic.** The same events give the same context —
   regardless of time and call order.
4. **Doxa only proposes.** The model does not change the state directly: each of
   its steps passes through classification, and an accepted proposal enters with
   status "open", not "confirmed".

New, from this design work:

5. **The logos chooses the operator, not doxa.** The model fills a step with
   content; the decision of which step is appropriate now (reproduce, form a
   hypothesis, check, backtrack) is made by the deterministic part. This is
   exactly what the run in §2.1 lacked.
6. **The trace is monotone.** The base only grows; a status change is a new entry
   (a revision), not a silent edit of the old one. Knowledge changes, but the
   trace of it is not lost.
7. **The context is necessary and sufficient for the chosen operator.** The
   projection must give the model everything needed for the current step and
   nothing extra (T2). Sufficiency is counted by the step's obligations, not "just
   in case".
8. **No progress — stop.** If no new knowledge appeared over several steps, the
   cycle stops or changes branch rather than spinning until the end of the budget.

### 3.2 Non-goals

What we deliberately **do not** do, so as not to drag the project sideways:

- **We do not let the model issue verdicts or statuses.** A verdict is the work
  of a check or an arbiter, not doxa.
- **We do not make the model a critic or an arbiter.** That would put doxa in the
  role of the logos.
- **We do not compress context by model summarization.** Only deterministic rules;
  otherwise the saving disappears and correctness blurs.
- **We do not store file contents in the IR.** Artifacts are pointers; the full
  data is on request.
- **We do not "downgrade" the logic silently.** If a task is beyond the available
  capabilities — an honest `out_of_fragment`, not a weak solution posing as a
  complete one.
- **We do not optimize at the cost of correctness.** Cache, context size and
  speed are secondary to the invariants.
- **We do not seek "the correct IR in general".** IR is tailored to the task
  (§1.2).

> Process rules (minimal diff, no incidental refactoring, secrets only in `.env`)
> remain in `AGENTS.md` and are not duplicated here.

## 4. The logos's operator family for a coding agent

In §1.1 we listed the roles that make up the exchange: external operators
(doxa's), internal ones (the logos's), protocol ones (the environment's), and the
Arbiter. Now let us see how each role is filled for a coding agent and where it
is still empty. This list of roles is exactly the requirements on the logos.

### 4.1 External operators: doxa proposes

In Skein doxa makes exactly one proposal per step — an action. Actions are of
three kinds:

- **introduce knowledge**: `track` (a hypothesis), `decompose` (a subgoal),
  `decide` (a decision). This is a direct analogue of abduction: new knowledge is
  proposed, not derived.
- **act on the world**: `read`, `grep`, `edit`, `run`. Ankyra has nothing like
  this — its doxa only expands the theory. This is specific to a coding agent.
- **stop the work**: `finish`.

All of them are only proposals. None changes the state until the logos accepts
it.

### 4.2 Internal operators: the logos recomputes

- **recomputing on new information** (`o_rev`): `mutate` — a file changed, and
  knowledge of the previous version loses its force. The source of the change is
  either one's own action (`edit`, `run`) or observation of the external world
  (`reconcile`).
- **retraction** (`o_def`): invalidation of a check. A later code change removes
  the verdict "confirmed", and the statement ceases to be active.
- **preference** (`o_spec`): choosing between competing decisions (the accepted
  one displaces the rejected ones) and deriving subgoal achievement.
- **context** (`o_ctx`): `project` — building what the model sees. This is where
  T2 is realized: context as a projection of the state.

### 4.3 Protocol operators: the environment records

- **journal**: each event is appended; old ones are not rewritten.
- **classification**: `classify` — the deterministic gate that assigns a proposal
  to the categories from §1.1.
- **refusals**: `record_rejection` — a refusal is recorded with a reason rather
  than merely being shown for one step.
- **checks**: `record_check` — the arbiter's verdict enters the state.
- **declared context**: the rules by which the projection is built.

### 4.4 Arbiters: who issues the verdict

The verdict is issued not by doxa and not by the logos, but by an external
instance:

- **the objective arbiter** — the toolchain: tests, the type checker. It decides
  whether a check passed.
- **the subjective arbiter** — the user: by acceptance criteria, decides whether
  the goal is achieved.

Both go through `record_check`, so the status "confirmed" has exactly one path.

### 4.5 What is missing

Let us tabulate the roles and how they are filled:

| Role (Ankyra) | Meaning | In Skein | Status |
|---|---|---|---|
| abduction | propose new knowledge | `track`, `decompose`, `decide` | present |
| action on the world | change the world | `read`, `grep`, `edit`, `run` | present (specific) |
| revision | recompute on new information | `mutate` + `reconcile` | present |
| retraction | remove a previous conclusion | check invalidation | present |
| preference | choose among competing | decisions displaced, `achieved` derived | present (partial) |
| context | build what is visible | `project` | present |
| journal | record an act | journal events | present |
| classification | assign a proposal to a category | `classify` (without `cited`) | present (partial) |
| Arbiter | issue a verdict | tests and the user via `check` | present |
| **operator selection (`W`)** | **choose the next step** | **—** | **absent** |
| `no_progress` | stop on stagnation | — | absent |
| `Revision` | record of a change of answer | — | absent |
| `out_of_fragment` | honest refusal | — | absent |

Two gaps are immediately visible. The first is **operator selection (`W`)**. In
§1.1 the Arbiter decides *which step to take next*. In Skein that decision is now
made by the model itself: it is free to choose any action. That is, doxa has taken
the Arbiter's place — precisely where the drift in §2.1 comes from. The direction
of work: move `W` into the logos, so that steps follow modes ("reproduce →
hypothesis → check → backtrack") while the model fills them with content.

The second is **honesty and stopping**: there is no explicit record of a change of
answer (`Revision`), no stagnation stop (`no_progress`), and no honest refusal of
an inexpressible task (`out_of_fragment`). Moreover, classification does not
distinguish a statement **grounded in code** from a **hypothesis** (Ankyra's
`cited` category): right now any proposed statement is a hypothesis. These gaps
are collected and ordered in §9.

## 5. The state model

The logos works with state. To choose a step and build context, the state must
contain not a "chat history" but several distinguishable parts. Some of them
Skein already has; some are the subject of work.

### 5.1 The base — accumulated knowledge

This is the graph of the work and the world: nodes (goal, subgoals, hypotheses,
decisions, actions, observations, checks, constraints) and the links between
them; plus pointers to files. The base is **monotone**: nodes and links are only
added, nothing is deleted. A code change does not erase knowledge of it — it only
marks the previous knowledge as stale (§1.1).

### 5.2 The journal — a trace that is only appended

All events — add a node, add a link, mark a file change, record a check, record a
refusal — are appended to the journal and never rewritten. The base is a fold of
the journal. Hence determinism: the same events give the same state, and
therefore the same context. The journal is the protocol by which every step can
be checked.

### 5.3 The proposal queue

Between "proposed" and "accepted" there is a queue. A proposal enters it and waits
for the logos's decision: an accepted one goes into the base, a rejected one is
recorded as a refusal, an undecided one may wait for the next step. In the current
cycle one step accounts for exactly one proposal, so the queue is effectively
single-slot; but as a notion it is needed — it is what separates a doxa proposal
from a fact of the base.

### 5.4 The traversal stack — where we are in the tree

The work on a task is a tree (§1.3). The **stack** holds the current path in it:
goal → subgoals → hypothesis or decision → action. Descending (splitting into
subgoals, choosing a hypothesis) pushes a new branch onto the stack; abandoning a
failed branch pops it. It is the stack that makes the context an "accordion": it
grows on descent and collapses on return. This is a new part: Skein currently has
no explicit "where we are in the tree".

### 5.5 Records of a change of answer

When the answer changes — a hypothesis was confirmed and after a code edit is no
longer — this is recorded as a separate entry (a revision), not by editing the old
one. Thus the base stays monotone while the answer honestly moves: knowledge
changes, and the trace of it is preserved.

### 5.6 How it all connects

The journal accumulates events; its fold yields the base. Accepted proposals from
the queue replenish the base. The stack sets the current branch of the tree. The
projection reads the base and the stack and builds what the model sees. A status
change is both a change of answer and a revision record.

## 6. Context as a projection of state

### 6.1 What it is

The projection is a deterministic function that builds, from the state, exactly
what the model sees. Its role was called "context" in §4. It is **not** a
retelling of the history by the model and **not** a similarity search (as in
RAG): the rules are fixed, and the result depends only on the state. The same
events and the same step give the same context.

### 6.2 What it contains

The projection is assembled from what is needed for the **current step** chosen
by the logos:

- **goal and constraints** — what we are solving and what must not be violated;
- **the current branch** (top of the stack) — where we are now in the work tree;
- **the branch's obligations** — what remains: open hypotheses, subgoals,
  decisions;
- **evidence** — what confirms or refutes those obligations: the latest check, an
  observation;
- **backtrack points** — alternatives and rejected branches: where to return if
  the current one fails;
- **a brief summary** — what just happened, concisely (not raw output);
- **pointers** — identifiers by which details can be fetched on request.

### 6.3 What it does not contain

Raw tool output, the full history of steps, branches unrelated to the current one,
file contents. None of this is "forgotten": it stays in the base and is fetched by
identifier. The only difference is that it does not occupy attention constantly.

### 6.4 Why "necessary and sufficient"

**Sufficient**: the set is assembled from the obligations of the current step —
each operator knows in advance what it needs. To propose a hypothesis, one needs
the goal, the current subgoal and evidence; to check, one needs the hypothesis
itself and the means of checking. **No more**: everything that is not on the
current branch and is not an obligation does not enter the context.

Example. On the task from §2.1, at the moment "form a hypothesis about the cause
of the crash", the context needs only: the goal, the current subgoal "find the
cause of the segfault", evidence (where it crashes, what changed recently), and
backtrack points. Eight-kilobyte build logs are not needed there — they are
available by reference.

### 6.5 Stability and cache

The order of the parts is chosen so that the beginning is as stable as possible:
first the unchanging (goal, constraints, settled knowledge — in chronological
order), last the changing (the current branch, the latest result). Then the
provider caches a long stable prefix, and only the tail is recomputed. This
directly serves T2.

## 7. Operator selection (`W`)

### 7.1 What it is

In §1.1 the Arbiter decides *which step to take next*. In Skein this role is
played by `W` — the deterministic choice of "what kind of step is appropriate
now". As shown in §4.5, it is now performed by the model itself: it is free to
choose any action. Moving `W` into the logos is the main work of this section.

### 7.2 Step modes

The ideal route from §2.1 turns into a small set of modes:

- **reproduce** — obtain evidence that the task really reproduces;
- **localize** — narrow down the place of the problem;
- **form a hypothesis** — introduce a statement that can be checked;
- **act** — make an edit;
- **check** — run a check against a specific hypothesis;
- **revise** — roll back or refine after a refutation;
- **stop** — the goal is achieved or there is no progress.

### 7.3 How it is chosen

By deterministic rules over the state. For example:

- there is no evidence of the crash yet → "reproduce";
- there is an open hypothesis and an available check → "check";
- there is an edit made but not checked → "check";
- there is no hypothesis, and the next step changes code → "form a hypothesis";
- the hypothesis is refuted → "revise";
- several steps in a row without new knowledge → "stop".

This is only an illustration; the exact set of rules is the subject of §9.

### 7.4 The model's role

The model **does not choose** the mode — it fills the chosen step with content. In
the "form a hypothesis" mode it proposes a hypothesis; in the "check" mode, a
means of checking. In other words: doxa supplies content, the logos supplies the
order of steps.

### 7.5 Why it is needed

- **drift disappears**: the model cannot "depart" into senseless enumeration,
  because the logos sets the order of steps;
- **progress becomes measurable**: it is visible which obligations are closed and
  which are not — the stagnation stop rests on this;
- **the context becomes necessary and sufficient**: the mode declares in advance
  what the step needs, and the projection (§6.4) is assembled exactly for that.

## 8. Honesty: `proven` / `proven_under(H)` / `out_of_fragment`

### 8.1 The principle

The strength of a conclusion must not exceed the strength of its premises (§1.1).
In the language of coding this means: the agent may not present an edit as
"working" if it is not confirmed by a check, and may not conceal that the
confirmation rested on a guess.

### 8.2 Four outcomes

- **proven** — the statement rests only on facts and is confirmed by a check.
  Example: a test passes on the fixed code, and the hypothesis was formulated from
  the code that was read, not invented.
- **proven under assumptions** (`proven_under(H)`) — the conclusion rests on
  assumptions: hypotheses that are unchecked or uncheckable. Example: "suppose the
  cause is in the handling of free blocks" — the fix helped, but the mechanism is
  not confirmed. The assumptions are listed by name.
- **not proven** (`not_proven`) — nothing is established.
- **outside the fragment** (`out_of_fragment`) — the task requires capabilities
  the system does not have: the needed logic, tool or time. This is an honest
  refusal, not a weak answer posing as a complete one.

### 8.3 Two kinds of gap

It is important not to conflate two different signals that arise when something
is lacking.

- **An explanatory gap.** There is an observation but no explanation: the crash
  was reproduced, but the cause is unknown. This is a push toward **abduction** —
  the "form a hypothesis" mode (§7): the model proposes an explanation that a
  check will later confirm or refute.
- **A capability gap.** There may be any amount of knowledge, but the system
  lacks the needed procedure or tool — for example, there is no way to check the
  hypothesis, or the task requires logic beyond what is available. This is
  `out_of_fragment`: an honest refusal, not a reason to propose new hypotheses.

The difference is fundamental: the first signal leads to new knowledge, the second
to a stop. Conflating them means either endlessly proposing hypotheses where there
is no way to check, or giving up where a single guess was all that was missing.

### 8.4 Grounding in code

In Ankyra a statement can be grounded by a verbatim quote — and is then counted
as a fact, not a hypothesis. For a coding agent the analogue of a quote is code
that was read: the statement "line 42 has `<`, not `<=`", backed by a read, is a
fact; the statement "the issue is in the boundary condition" is a hypothesis.
Skein currently does not distinguish these two cases: any proposed statement is a
hypothesis. Distinguishing them matters, because what counts as proven depends on
it.

### 8.5 How this is reflected in the state

- The status "confirmed" appears only through a check, and if its witness has
  become stale it is removed (§1.1).
- A statement confirmed with reliance on assumptions remains "proven under
  assumptions", with the assumptions listed.
- The closure of the goal itself is external: the user decides it by acceptance
  criteria.

### 8.6 Why

The user has a right to know what a result rests on. And this directly addresses
the failure from §2.1: the agent named the root cause but had no checked fix — an
honest label would have forced it to say "not proven" explicitly, rather than
finish as if the work were done.

## 9. Gap analysis and roadmap

### 9.1 What is already done

Part of the mechanics was closed during this design work (it does not concern
`W`):

- `run` without hypotheses no longer produces a "check" — previously an empty
  graph produced junk checks; now it is an observation;
- file changes are tracked by signatures rather than by hashing the whole
  workspace on every step; only changed files are hashed;
- the fragility on vanishing build files was removed (`ENOENT`);
- the visibility budget is split: memory (`verified`, refusals, subgoals) is not
  truncated, the stream of recent steps is bounded by characters, `index` is a
  window.

This removes part of the cost and noise, but does not address management — the
main cause of the failure in §2.1.

### 9.2 What is missing

The gaps from §4.5 fall into three groups:

1. **Management.** There is no `W` (step modes) and no traversal stack. The model
   currently chooses the step, and "where we are in the tree" is stored nowhere.
2. **Stopping and honesty.** There is no `no_progress`, no `Revision` records, no
   `out_of_fragment`, and no distinction between "grounded in code" and
   "hypothesis".
3. **Check precision.** The witness is a snapshot of the whole workspace: sound
   but coarse (it invalidates checks on unrelated changes). Precision was already
   deferred.

### 9.3 Proposed order

1. **`W` and modes.** Introduce step modes and deterministic selection; the first
   rule — "code may not be changed while there is no open hypothesis". This
   closes the drift and makes progress measurable.
2. **Traversal stack and projection.** Store the current branch and assemble the
   context for the chosen mode — this is T2.
3. **`no_progress`.** Stop or change branch on stagnation.
4. **`Revision`.** Record a change of answer as a separate entry, not an edit.
5. **`cited`.** Distinguish what is grounded in code from a hypothesis.
6. **`out_of_fragment`.** Honest refusal of an inexpressible task.
7. **(deferred) witness precision** — narrow it to related files.

### 9.4 How we verify

- the invariants (§3) hold — by tests;
- on `fix-ocaml-gc` Skein either converges or stops honestly; comparison with the
  saved baseline run;
- the context reaches a plateau and the cache share does not fall;
- fewer repeats of `read`/`grep`/`run` over the same files;
- **no degradation on simple tasks.** Modes and gates must not worsen short
  tasks: the number of steps, tokens and cost — no higher than the baseline on a
  simple set. If a task is solved at once, the system is not obliged to introduce
  hypotheses and unfold a tree: overhead must be proportional to the complexity of
  the task, not a constant price. (A warning sign already occurred: in the
  previous design work, steps and context grew noticeably on easy tasks.)

This order is consistent with the overall plan
(`docs/plans/implementation_plan_ru.md`) and refines it.

## 10. Revision of `concepts_ru.md`

This document refines and partly changes `concepts_ru.md` version 1.0. So that
the changes are explicit rather than a silent edit, we list them; the new version
of the concepts will be assembled from this document.

**What changes in substance:**

1. **Context is not "a window with a `tail` parameter".** In version 1.0 the
   visibility budget set one parameter. Now context is a projection of the state,
   and its makeup is derived from the obligations of the current step (§6).
   Memory is not truncated by line count; the stream of recent steps is bounded
   by characters.
2. **The step is chosen by the logos.** In version 1.0 the model chose any
   action. Now `W` is introduced — step modes (§7): doxa fills a step but does not
   choose it.
3. **The state model expands.** A proposal queue, a traversal stack and
   `Revision` records are added (§5).
4. **Honesty becomes explicit.** `proven` / `proven_under(H)` /
   `out_of_fragment` and the distinction between "grounded in code" and a
   hypothesis (§8).
5. **A stagnation stop appears** (`no_progress`, §3).
6. **The raw output stream goes away.** Instead of dumps — a concise summary and
   the fetching of details by identifier (§6).

**What remains unchanged:** the distinction of doxa and logos, the invariants
(extended but not revoked), the determinism of the projection, and the ban on a
verdict from the model.

**On the manner of revision itself.** In the spirit of the "monotone base" we do
not silently rewrite version 1.0: the new version will be a separate document,
and what changed and why is recorded here.
