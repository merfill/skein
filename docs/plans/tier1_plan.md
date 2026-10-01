# Skein — Tier 1 plan

Conceptual overview — `docs/concepts.md`. The overall plan and roadmap —
`docs/plans/implementation_plan.md`. This document fixes the **scope of Tier 1 and
the order of work**. Code is written only after the corresponding sub-stage is
agreed; the plan is refined step by step.

The empirical basis is the `skein-plugin` prototype: it showed that non-monotonic
context reduces looping where a loop exists, and exposed the adoption and cache
risks (§8, §10).

## 1. Fixed decisions

Tier 1 is "working on a task" (`implementation_plan.md` §3):

1. `Decision` as first-class: the choice, the rejected alternatives, the rationale.
2. `Check`/arbiter as an explicit node with an objective verdict.
3. Subgoals and their decomposition.
4. Path-based relevance (C2). Staleness precision (R3b) is moved out of Tier 1 and
   deferred (§7).

Invariant of the whole stage: Tier 0's guarantees do not weaken — determinism,
addressability, a single path to `verified`, doxa/logos.

## 2. Doxa/logos mapping

- **Doxa** proposes a subgoal, a decision, an alternative to reject. All enter as
  `open`/`active`; the engine admits them (`track`) and materialises the linking
  edges.
- **Logos** computes reachability (`project`), the status transitions
  (`superseded`/`abandoned`), and the check verdict.
- **Protocol** — the same append-only journal; new node and edge kinds are just new
  typed events.

## 3. Boundaries of Tier 1

In: produce the declared work graph (subgoals, decisions, linking edges);
path-based relevance in the projection; an explicit check node.

Out (deliberately): staleness precision (R3b) — deferred (§7); embeddings/similarity,
a full AST/symbol table, `analogy`/`intuition` (Tier 3), UI, multi-provider, CSP.

## 4. What the IR gains

The projection already understands `refuted`/`superseded`, but the graph is bare:
only `locates` and `verifies` are produced, and `track` can create a `decision` with
a single `rationale`, with no edges (`src/tools/index.ts:392`).

- **node kinds:** `subgoal` starts being produced; `symbol`/`test` stay reserved
  until the dependency graph produces them (§7).
- **edges produced:** `decomposes` (goal/subgoal → subgoal), `chosen_over` (decision
  → rejected alternative), `justifies` (decision → subgoal/claim), `supports`/
  `refutes` (claim ↔ claim), `depends_on`.
- **statuses produced:** `superseded` (via `chosen_over`) and `achieved` (a proven
  subgoal); `abandoned` / `reverted` are deferred — as derived transitions, not set by
  hand.
- **decision payload:** `{ options: string[], chosen: string, rationale: string }`.

### The path edge vocabulary

For reachability from the goal (§5), T1.1 produces four kinds of edges:

| Edge | From → to | Meaning |
|---|---|---|
| `decomposes` | goal/subgoal → subgoal | this subgoal is part of that one |
| `justifies` | decision → subgoal | this decision is how we pursue the subgoal |
| `chosen_over` | chosen decision → rejected alternative | we chose A, not B |
| `supports` | claim → subgoal | this claim belongs to the subgoal |

`refutes` / `depends_on` / `touches` / `violates` are not needed for the path yet and
are not produced. The closure walk (§5) is undirected: connectivity matters, and the
directions are for meaning and display.

**Provenance is `llm`.** These edges are born from doxa's proposals that the engine
admitted, so they carry `provenance.kind = "llm"`. This is the first production of
`llm` provenance: the wording in `docs/concepts*.md` and `docs/ir*.md` ("declared but
not produced") is fixed on T1.1 — not earlier, or the docs would describe something
unimplemented. We do not introduce a separate kind (`admitted`/`proposal`): `llm`
already means "doxa proposed it".

### Actions: dedicated `decompose` and `decide`

Decided: add dedicated actions instead of extending `track`. This keeps the intent
explicit in the `propose` schema under "one proposal per turn" — is the proposal to
split the goal or to make a choice? — so the classifier need not guess from `kind`.

Schema (`src/llm/schemas.ts`):

```
decompose { parent: string, label: string }
decide    { parent: string, label: string, alternatives?: string[], rationale: string }
track     { kind: "claim" | "constraint", label, parent?, rationale?, forbid? }
```

Engine (`src/tools/index.ts`):

- `decompose` → a `subgoal` node (`open`) + a `decomposes` edge from `parent`;
- `decide` → the chosen decision node (`active`) + a `justifies` edge to `parent`; one
  decision node per alternative + a `chosen_over` edge from the chosen one to it;
- `track` (claim) → a `claim` node (`open`) + a `supports` edge to `parent`;
  `constraint` stays global, without a parent.

Resolutions of the forks:

- **`parent`, not `subgoal`.** The field allows the goal or a subgoal: a decision may
  attach directly to the goal, and attachment must not forbid that.
- **Alternatives are nodes.** `chosen_over` points at a node, so each alternative is
  materialised as a decision node.
- **`decide` without alternatives is allowed.** A decision with no rejected
  alternative is still a decision; then there is simply no `chosen_over`.
- **`decision` is removed from `track`.** Otherwise there are two paths to one node,
  and `track` would create a decision with no edges — a hole in mandatory attachment.
  Tests use only `claim`/`constraint`, so the change is local (schema, the `propose`
  prompt, `classify`).
- **`superseded` is derived from `chosen_over`.** `add_node` makes a decision
  `active`, and we do not produce `set_status`, so `fold` derives "rejected": a
  decision that a `chosen_over` edge points at is `superseded`. Otherwise the rejected
  alternative would stay `active` and show up in `frontier.decisions`.
- **Alternative hygiene.** Dedupe `alternatives` and forbid an alternative equal to
  `label`.

### Example: `Decision` as first-class

In short: a "decision" is not a line of text but a **node with edges** — to the
rejected alternatives and to the work it justifies.

**Now.** `track` creates a `decision` node with a single `rationale` and no edges
(`src/tools/index.ts:392`) — a "sticker on the fridge". Fifteen turns later the
agent cannot see why the path was chosen or what was rejected.

**In Tier 1** the decision is linked: `chosen_over` (chosen → rejected alternative)
and `justifies` (decision → subgoal/claim).

Task "add caching to the API", turn 6 — the fork "cache in the data layer or via
middleware":

```
w:decision:7  "cache in the data layer"   status=active
  ──chosen_over──▶  w:decision:8 "cache via middleware"  status=superseded
  ──justifies───▶  w:subgoal:2 "cache the read path"
```

Now the `frontier` shows the decision and the rejected alternative, and the agent
does not propose middleware again — it is recorded and addressable.

**Why.** Path-based relevance (§5) walks from the goal through decision and action
edges. While decisions are isolated stickers there is nothing to walk; so a
first-class decision is a prerequisite of §5, not a decoration.

### Example: subgoals and decomposition

**Now.** The node kind `subgoal` is declared (`src/ir/types.ts:7`) but never
produced, and the `track` schema does not even allow it (`src/llm/schemas.ts:26`).
The goal is a monolith: it has no children, and claims hang directly off it.

**In Tier 1** the `decompose` action creates a `subgoal` and a `decomposes` edge
from the parent (the goal or another subgoal). Task "add caching to the API":

```
g1  "add caching to the API"
  ──decomposes──▶  sg1  "cache the read path"
  ──decomposes──▶  sg2  "invalidate the cache on write"
  ──decomposes──▶  sg3  "make TTL configurable"
```

Then decisions and claims attach to a specific subgoal:

```
d1  "cache in the data layer"   ──justifies──▶  sg1
c1  "hits are served from memory"  (claim, open)  over sg1
```

**Why.** Path-based relevance (§5) walks down from the open goal:
`g1 → sg1 → decision → action → claim`. While the goal has no `decomposes` edges
there is nowhere to walk. Subgoals are the second prerequisite of §5 (the first is
decisions, above).

**A subgoal's status is derived** (logos decides, not set by hand): a subgoal is
`achieved` when its claims are confirmed, and `abandoned` when it is dropped. The
exact rule ("all claims" vs "at least one") is refined later in T1.1. The goal is
still closed externally — that is by design (`tests/gate.test.ts`) — but a subgoal is
an internal node, and its status is honestly derived from confirmed claims.

### Attaching claims

Today `track` creates a claim as a bare node. For a claim to be reachable from the
goal (§5) it must, when created, name a parent and get a `supports` edge:

```
track { kind: "claim", label, parent, rationale? }   // parent is required
track { kind: "constraint", label, forbid? }         // no parent, global
```

The parent is **exactly one**, and it is the goal or a subgoal. Chains `claim → claim`
(`supports` / `refutes` between claims) and multiple support are deferred: the path
currently ends at a claim. No parent, or a parent off the path → the gate refuses it
(`record_rejection`); existing Tier 0 claims without a parent are a migration concern
(a separate T1.1 task).

### Actions are not attached

An `action` is born from `edit`, from a `run` that changed files, and from `finish`.
The relevance path is the work/decision graph (`decomposes` / `justifies` /
`chosen_over` / `supports`); observations land on the path by themselves, through
`verifies`. Actions remain history: the last one in the `frontier`, the rest through
`query`.

We do not attach an action to a claim/subgoal: the relevance meaning is already in the
observation and the claim's check, and a mandatory parent on every action is the very
ceremony that broke adoption in `skein-plugin`. A reserved direction (if per-branch
activity is ever needed): link an action to its observation by the fact of a **single
execution** — deterministic and with no model involvement.

### The attachment gate

Refusal happens in `classify` (the logos gate), and the refusal is recorded as
`record_rejection`, as with a constraint. The parent is **always explicit** — there is
no default to the goal, or the model would attach everything to `g1` and the graph
would stay flat.

| Action | `parent` | Allowed parent |
|---|---|---|
| `decompose` | required | goal or subgoal |
| `decide` | required | goal or subgoal |
| `track` claim | required | goal or subgoal |
| `track` constraint | none | — (global) |
| seed `goal` | — | root |

It is enough to check that the parent **exists** and its kind is allowed: reachability
is guaranteed by construction (every new node attaches to an existing one), and the
"activity" of abandoned branches is handled by status in T1.2. Tests that create
claims without a parent are updated; the prompt teaches calling `decompose`/`decide`
and naming `parent` explicitly.

### Derived statuses

- **`superseded`** — a decision that a `chosen_over` edge points at. One rule covers
  both rejected alternatives at `decide` time and a later change of mind (the model
  calls `decide` again and lists the old decision in `alternatives`).
- **`achieved`** — a subgoal that has at least one confirmed claim and no open or
  invalidated ones:

  > `achieved` ⟺ ≥1 `verified` and 0 `open`/`invalidated` among attached claims.

  `refuted` does not block: a false hypothesis is not unfinished work. The status is
  derived, so a later `mutate` that invalidates a claim honestly returns the subgoal to
  `open`.
- **`abandoned`** — **deferred** from T1.1: subgoals are only achieved, not dropped.
  Reason — `set_status` is rejected (C3), and the workarounds (an `abandon` action;
  deriving from `chosen_over`/`refutes`) are either a weak `set_status` or a stretch.
  Revisit when there is a real need.
- **One active decision per parent — not derived.** The model expresses a replacement
  itself by listing the old decision in `alternatives`; otherwise the engine would
  silently cancel a decision the model did not cancel.

### Projecting the graph

T1.1 builds the graph, but the agent must **see** it. `project`
(`src/ir/project.ts`) shows subgoals and enriches decisions and claims with their
links — otherwise the value of a first-class decision is lost and the model proposes
the rejected option again:

```
frontier:
  subgoals:         { id, label }[]                 // open, bounded by tail
  achievedSubgoals: string[]                        // one line each
  claims:           { id, label, supports? }[]       // open; supports is the parent
  decisions:        { id, label, over: string[] }[]  // active; over — rejected
```

This changes the shape of `frontier.claims` / `frontier.decisions` (they were raw
`Node[]`) — the prompt and tests are updated. Subgoals are shown **by status** (like
claims); selecting the reachable set is T1.2. Bounds are the same `tail`, and the full
listing is through `query`.

### Migration

The event journal **is not persisted** — events live in memory for one run — so there
are no old journals with orphan nodes at runtime. Migration is unnecessary: we only
update tests that hand-build a claim without a parent. The `fold` rule ("orphan work
node → goal") is **not** introduced — it would be logic for a case that does not exist.
Reserved: if the journal is ever saved to disk (session reproducibility), add that
rule so replaying an old record stays meaningful.

## 5. Path-based relevance (C2)

**What it is.** The projection decides what to show the agent. Today relevance is
flat — **by status** (`src/ir/project.ts:169`): all open claims, all active
decisions, all constraints. It does not care whether a node is connected to the
current goal, so on a long task open claims and active decisions from abandoned
branches crowd the `frontier` alongside the live ones.

**In Tier 1** the active work set is the **reachable closure** from the open goal:
a node is active iff it is reachable from `g1` along `decomposes` / `chosen_over` /
`justifies` / `supports` edges. The projection shows that closure in the `frontier`;
the unreachable stays addressable through `query`.

```
g1 "add caching" ──decomposes──▶ sg1 "cache the read path"
                                      ▲
                                      └──supports── c1 "hits served from memory"
```

`c1` is reachable from `g1` → active. An old `c9` hanging off an abandoned `sg9` is
unreachable → not shown in the `frontier`.

**For the filter to be complete, attachment is mandatory.** The projection shows
only what is reachable; therefore everything meaningful must be reachable.
`decompose` names a parent (the goal or an already reachable subgoal), `decide`
names the subgoal it justifies, `track` (claim) names the subgoal or goal. No parent,
or a parent off the path → the logos gate refuses it (`record_rejection`), as with a
constraint.

Without this we would need a fallback ("show by status when the closure is empty"),
which is a crutch hiding an incompletely connected graph. Mandatory attachment makes
the filter honest and dissolves the "filtering vs annotation" fork: filter, and that
is all.

**Consequence for T1.1.** Decisions and **claims** must be attached (§4): today
`track` creates a claim as a bare node, and reaching it from a subgoal needs a link
(`supports`). Actions are **not** attached: the relevance meaning is already in the
observation and the claim's check, and a mandatory parent on every action is the very
ceremony that broke adoption in `skein-plugin`.

**The root is always reachable**, so the closure is never empty: it contains at
least `g1`. "Empty beyond the goal" means exactly one thing — the task is stated but
no work has entered the graph. Old journals do not exist (the journal is not
persisted), so no runtime migration is needed — only tests are updated, and the `fold`
rule for orphan nodes is reserved for future persistence (§4, "Migration").

Determinism is preserved: the closure is a pure graph walk over `fold(events)`.

## 6. Check as a first-class node

**What it is.** A "check" is an arbiter's verdict: "the command `node --test`
passed and confirms claim `c1`".

**Now** the verdict is spread across three places: the `record_check` event (the
journal), the provenance of the `verifies` edge
(`{ kind: "check", command, verdict }`), and the witness in the observation's
payload. There is no check node (`src/ir/types.ts:16`), so it has no id: a check
cannot be referenced, and answering "which check confirms `c1`, and is it still
live?" makes `query { verdictOf }` piece the answer together.

**In Tier 1** a check is an **addressable node**: id, verdict, command, witness. The
`verifies` edge points at it, `query { verdictOf }` reads one node, and the
`frontier` can list checks.

```
chk3  kind=check  "node --test"  verdict=pass
      witness: [ {file:src/cache.mjs, v2} ]
  ◀──verifies──  c1 "hits served from memory"
```

**Decided: a new node kind, in the `work` space.** A check is knowledge about work,
so it is the same domain as `observation` (which is also engine-produced and lives
in `work`). The doxa/logos split is expressed by roles (`actor`, event types), not
by space; a third space for a single node kind is premature. `check` joins
`WORK_KINDS` next to `observation` and is queryable at once (`NODE_KINDS`), while
`verifies` stays work→work (`check → claim`). A dedicated space
(`witness`/`logos`) would be warranted only once a family of verdict nodes appears
(for example `record_rejection` as a node); that is out of scope for now.

## 7. Deferred: staleness precision (R3b)

Now the witness is a snapshot of the whole workspace, so any change invalidates a
check; sound but coarse (`docs/plans/staleness_scope_plan.md`). The temptation is to
scope the witness to the dependency closure of the checked files. **Deferred.**

**Why.** A precise closure needs dependency knowledge, and there is no single
mechanism across languages: each has its own ecosystem — `gcc`/`clang -M` and `.d`
files for C/C++, `jdeps` for Java, `coverage`/`modulefinder` for Python, Node
coverage and `tsc --listFiles` for JS/TS, `go list -deps`, `rustc --emit=dep-info`
and `cargo`. The only language-agnostic route is OS-level tracing (`LD_PRELOAD`,
`strace`, eBPF), but it is heavy and platform-specific. So a "general solution" is in
fact a set of per-ecosystem adapters: a separate product, orthogonal to the core.

Heaviness is not the only reason. The coarse witness is **sound**: it errs toward
extra re-checks, never toward a false `verified`. Its price is turns, not
correctness. So R3b does not block the essence of Tier 1 (projection and relevance)
and is deferred beyond it.

**Direction, when needed.** Ask the build tools of each language for dependencies
(never parse by hand): for C/C++ the compiler (`-M`/`.d`), for the rest their
tooling. First measure on the bench (§8) how often coarseness actually costs turns;
if rarely, do not do it at all.

## 8. Bench: acceptance on the `skein-plugin` results

The bench is **not invented**: the `skein-plugin` prototype (a sibling repo) already
produced the metric, the tasks, and the baseline.

- **Loop metric** — `skein-plugin/src/loop.ts` (`repeats`, `repeatsAfterFailure`,
  `rereads`, `maxStreak`, `loopScore`). It is computed from behavior, without the
  tracking tool, so it is comparable across both arms.
- **Tasks with a measured loop** — not synthetic (they do not loop with this model):
  `cobol-modernization` (19%), `openssl-selfsigned-cert` (29%),
  `modernize-scientific-stack` (29%), and the long `fix-ocaml-gc` (36 steps, 60k) to
  check that needed context is not dropped.
- **Baseline** — the saved Harbor job (`skein-plugin`, `2026-09-26__11-50-39`); do
  not re-run it.
- **What we measure** — loop down while the solution is preserved; rereads not above
  baseline (otherwise needed context was dropped); overhead: steps, peak context, and
  **input cost** (prompt cache).

Tier 1 acceptance is on this bench: success = loop below baseline without losing the
solution and without more rereads.

## 9. Order of work (variant A)

We start with the graph, not with measurement: the metric and the tasks already exist
(the plugin, §8).

1. **T1.1 — produce the declared graph.** Checklist:
   - the path edge vocabulary (`decomposes` / `justifies` / `chosen_over` /
     `supports`), provenance `llm`;
   - the `decompose` and `decide` actions; `decision` removed from `track`;
   - `track` claim with a mandatory explicit `parent`; `constraint` without a parent;
   - the attachment gate in `classify` (`record_rejection`);
   - derived `superseded` (from `chosen_over`) and `achieved`
     (`≥1 verified, 0 open/invalidated`); `abandoned` deferred;
   - projection: `subgoals`, `over` on decisions, `supports` on claims;
   - no migration (the journal is not persisted) — tests only;
   - tests and invariants (parts 1–9).
2. **T1.2 — path-based relevance.** The closure in `project`.
3. **T1.3 — explicit check node.**

Acceptance is on the bench (§8). T1.1 is fixed in detail; T1.2–T1.3 are refined when
their turn comes.

## 10. Tier 1 risks

- **Adoption.** The model does not create subgoals/decisions/claims by itself. In the
  plugin `skein_track` was called in 2 of 13 tasks; only a hard gate worked. Mandatory
  attachment (§5) is the structural gate; if that is not enough, an active gate is
  needed (no `edit` without a subgoal). Without it the IR is thin and the projection
  is empty — worse than the tape.
- **Prompt cache.** The projection changes the `frontier` every turn, and rewriting
  the context breaks the provider's cache: the plugin measured input ×5–10 and cost
  up to 1.5 ₽. Mitigation — keep a large stable prefix (goal, constraints, settled
  facts) and change only the tail; account for this in §5.
- **Strong model and short tasks.** Where there is no loop there is no gain and the
  overhead grows (plugin subset: steps 25.5→31, ctx 47k→62k). Target only tasks with
  a loop (§8).

## 11. Open forks

- `check` as a node kind vs an observation payload.

## 12. Status

Tier 1 has not started. This plan is a working document; each sub-stage is agreed
before its code.
