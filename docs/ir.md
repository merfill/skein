# Skein — the IR: operations, state, and control

> Russian mirror — `docs/ir_ru.md`.

Conceptual overview — `docs/concepts.md`. This document looks at the same system
from the IR's point of view: which operations it fixes, what each operation does
to state, how state becomes context, and how that context controls the agent.

## 1. Four levels

The IR is not one object but a pipeline of four levels:

```
                 append-only              pure            pure
  actions ──▶ journal (Event[]) ──fold──▶ State ──project──▶ Context ──▶ LLM
     ▲                                                            │
     └──────────────── proposal (one action per turn) ◀───────────┘
```

1. **Journal** — `Event[]`, append-only. This is the truth. Nothing is ever
   removed or rewritten (`src/ir/events.ts`).
2. **State** — `fold(events)`, a derived, in-memory view: nodes, edges, statuses,
   checks (`src/ir/graph.ts`).
3. **Context** — `project(state)`, a deterministic slice handed to the LLM
   (`src/ir/project.ts`).
4. **Message tape** — the LLM conversation. Only I/O: the system prompt plus the
   current `Context`. It is not memory.

The important inversion: **the context is a projection of the IR, not a
transcript**. The LLM never sees earlier projections, only the current state.
The journal grows, `State` is recomputed from it, `Context` is recomputed from
`State`. Nothing is "remembered" by accumulation.

Before `project`, the engine reconciles the facts that current activity depends on
against the filesystem (`src/loop/observe.ts`): an observed drift becomes a
`mutate` event, so a change made outside the engine is still recorded with a
source.

Throughout, the doxa/logos split holds: the LLM (doxa) only proposes; every
proposal is `provenance.kind = "llm"`, `status = "open"`. The engine (logos)
classifies and executes, and only the arbiter can promote a claim.

## 2. Operations the IR fixes

The IR has a **closed vocabulary**. The only way to change it is to append one of
five events (`src/ir/events.ts:39`):

| Event | Meaning |
|---|---|
| `add_node` | introduce a node (any kind, any space) |
| `add_edge` | introduce a typed, provenance-carrying edge |
| `set_status` | change a node's or edge's status (no reason needed) |
| `mutate` | a file at `ref` changed to `version` (the non-monotonicity hook) |
| `record_check` | an arbiter ran a `command` with a `verdict` for `claimIds` |

Nodes and edges are typed by closed enums (`src/ir/types.ts`). A node has a
`space` (`work` | `artifact`), a `kind`, a one-line `label`, an optional
`payload`, and a `seq`. An edge carries `provenance` — *how it is known*: `llm`,
`user`, `read` (with the file `version`), `grep`, or `check`.

The vocabulary is the protocol. New behavior means a new event or a new
projection rule — never an ad-hoc edit of `State`. This is how the first
principle (`docs/concepts.md`) is enforced: state changes only through events,
so every piece of knowledge traces back to the experience that produced it.

### Tool → events

The tools are the only producers of events (`src/tools/index.ts`,
`src/loop/graph.ts`). What each one fixes:

| Tool | Events written | Result in state |
|---|---|---|
| seed (`runAgent`) | `add_node` goal; `add_node` constraint per input | `g1` open; `k*` `must` |
| `read(path)` | `add_node` file (first time) + `add_node` observation + `add_edge` `locates` (`provenance.read` + `version`) | an artifact fact tied to a file version |
| `grep(pattern)` | `add_node` observation | a one-shot observation (contents are ephemeral) |
| `edit(path, find, replace)` | `add_node` action + `mutate` | action `applied`; old read facts go `stale` |
| `run(command, claims?)` | `add_node` observation + `record_check` + `add_edge` `verifies` per claim, each carrying a witness (`ref → version` observed at run time); on long output, a spill plus `outputRef`; a `mutate` per tracked file the command changed | claims `verified`/`refuted` by the arbiter |
| `run` (constraint guard) | `add_node` observation `constraint violation` | a forbidden file is reverted; **no** `record_check` |
| `track(kind, label, …)` | `add_node` claim/decision/constraint | `open` / `active` / `must` |
| `query(selectors)` | none | a one-shot answer (`id`/`kind`/`status`/`edgesOf`/`verdictOf`), nothing recorded |
| `finish(summary)` | `add_node` action | loop stops (`stopReason = "finish"`) |

Three consequences worth stating plainly:

- **Contents are not in the IR.** `read`/`grep`/`run` outputs live in the
  ephemeral `recent` turns (`Turn`), never as node payload. Artifacts are
  pointers plus one line.
- **Long output lives outside the IR.** When `run` output exceeds the excerpt
  limit, the full output is written to `.skein/logs/` and the IR keeps only an
  `outputRef` plus a head+tail excerpt, retrievable through a windowed `read`.
- **Only the arbiter verifies.** `verified` is reachable only through a
  `record_check` with `verdict = "pass"` (`src/ir/graph.ts:109`). A check carries
  the file versions it observed, so a later `mutate` can invalidate it — but it can
  never fabricate a verdict.

### What Tier 0 declares but does not yet produce

The model is broader than the current behavior. Declared in `types.ts` but never
written in Tier 0:

- node kinds `subgoal`, `symbol`, `test`;
- edge kinds other than `locates` and `verifies`;
- the `set_status` event (a status change is currently always a side effect of
  `record_check` or `mutate`, never an explicit event);
- statuses `superseded`, `achieved`, `abandoned`, `confirmed`, `reverted`.

These are reserved, not dead: the projection already understands
`refuted`/`superseded` (`src/ir/project.ts:114`). The document keeps the
distinction so the spec does not overclaim the implementation.

## 3. Status transitions

Statuses are **derived**, not set by hand:

- `add_node` assigns a default by kind (`src/ir/graph.ts:33`): `open` for
  goals/claims/observations, `active` for decisions, `applied` for actions,
  `must` for constraints, `believed` for artifacts.
- `record_check` sets every named claim to `verified` (pass) or `refuted` (fail)
  (`src/ir/graph.ts:119`).
- `mutate` marks `stale` both read-provenance edges with the same `ref` and a
  different `version`, and `verifies` edges whose witness contains the changed
  `ref` with another `version` (`src/ir/graph.ts:89`). The prior events are
  untouched; only their **derived status** changes.

So the journal stays monotonic while code knowledge is non-monotonic. There is no
manual retraction: a fact about an old file version simply stops being active.

A **derived** status is not a record. `fold` rebuilds `statuses` and
`edgeStatuses` from the journal on every call, so changing one — marking an edge
`stale`, for instance — overwrites a computed value, not history. The original
`add_edge` / `record_check` fields stay in the journal, and replaying the events
reproduces the earlier status. The journal is the only monotone record: it only
grows, and only the derived view loses force. A source fact is never rewritten.

## 4. Projection: how state becomes context

`project(state)` (`src/ir/project.ts:75`) is pure and deterministic: the same
events always yield the same `Context`. It has fixed sections:

- `header` — the goal and all constraints (the stable prefix);
- `frontier` — `claims` (`open`), `decisions` (`active`), the `lastAction`, the
  latest observation per active claim, and verified / invalidated / rejected claims
  as one line each. A verified claim whose checks have all gone `stale` appears
  under `invalidated`, never under `verified`;
- `artifacts` — index only (id + label + `stale` flag);
- `index` — every node as `{ id, kind, label }`, so the agent knows what exists;
- `recent` — the last few turns verbatim, for flow.

Relevance is **by provenance, not similarity**: what is active is what lies on a
path from the open goal through active decisions/actions to open claims. The
index is always present, so the agent can see that something exists and ask for
it, even when its contents are not in the context.

Note what is deliberately absent: file contents, stale facts shown as active,
and previous projections. A `stale` artifact is rendered as stale, never as
current (`docs/tier0_plan.md` §6 invariants).

## 5. How the IR controls the agent

Control is not a separate layer — it is consumed directly from `State`:

- **What the LLM sees.** `propose` sends exactly the current `Context`
  (`src/loop/propose.ts:33`). Change the projection, change the behavior.
- **The logos gate.** `classify` reads constraints from `State` and rejects an
  `edit` that targets a forbidden path (`src/loop/classify.ts`).
- **The effect guard.** Before a `run`, the engine snapshots the files matching
  `payload.forbid`; if the command changes one, it is reverted and recorded as a
  `constraint violation`, and no check is recorded — so nothing is verified
  (`src/tools/index.ts:295`). The constraint is enforced by effect, not by
  parsing the shell.
- **Observation before projection.** At the start of each turn the engine
  reconciles the `ref`s that current activity depends on (witnesses of live
  checks and live read facts) against the filesystem (`src/loop/observe.ts`); a
  drift becomes a `mutate`, so nothing relevant is built on unobserved change.
  A `mtime`/`ctime`/size signature cache avoids re-hashing files whose signature
  is unchanged (`docs/plans/watcher_plan.md`).
- **Truth only from the arbiter.** No path to `verified` bypasses
  `record_check`.
- **Budgets and stop.** The loop routes on `done`, the turn budget, and
  `stopReason` (`src/loop/graph.ts:86`).
- **Closing the goal is external.** The engine does not set the goal to
  `achieved`; the harness/arbiter checks that the test suite passes and that
  forbidden files are unchanged (`tests/gate.test.ts`). The goal node stays
  `open` even after a successful run (`tests/loop.test.ts`).

## 6. Examples

Ids and `seq` values below are illustrative; shapes and fields match the code.

### A. A fix, turn by turn (`fixtures/bugfix/off-by-one`)

Seed (`src/loop/graph.ts:107`):

```json
{ "type": "add_node", "node": { "id": "g1", "space": "work", "kind": "goal",
  "label": "make node --test pass", "seq": 0 } }
{ "type": "add_node", "node": { "id": "k1", "space": "work", "kind": "constraint",
  "label": "do not edit tests", "payload": { "forbid": ["\\.test\\.mjs$"] }, "seq": 1 } }
```

Turn 1 — `read src/sum.mjs` records an artifact fact bound to a version:

```json
{ "type": "add_node", "node": { "id": "file:src/sum.mjs", "space": "artifact",
  "kind": "file", "label": "src/sum.mjs" } }
{ "type": "add_node", "node": { "id": "obs:3", "space": "work", "kind": "observation",
  "label": "read src/sum.mjs",
  "payload": { "ref": "file:src/sum.mjs", "version": "<sha1>", "bytes": <n> } } }
{ "type": "add_edge", "edge": { "id": "e:4", "from": "file:src/sum.mjs", "to": "obs:3",
  "kind": "locates", "provenance": { "kind": "read", "ref": "file:src/sum.mjs",
  "version": "<sha1>" }, "status": "believed" } }
```

Turn 2 — `track` a hypothesis (doxa enters at `open`):

```json
{ "type": "add_node", "node": { "id": "w:claim:5", "space": "work", "kind": "claim",
  "label": "loop stops one short", "payload": { "rationale": "" } } }
```

Turn 3 — `edit src/sum.mjs` mutates the world:

```json
{ "type": "add_node", "node": { "id": "act:6", "space": "work", "kind": "action",
  "label": "edit src/sum.mjs",
  "payload": { "path": "src/sum.mjs", "find": "i < n", "replace": "i <= n" } } }
{ "type": "mutate", "ref": "file:src/sum.mjs", "version": "<new sha1>", "actionId": "act:6" }
```

`mutate` marks `e:4` `stale` — the old read is no longer active. The journal is
unchanged; a derived status moved.

Turn 4 — `run node --test` lets the arbiter decide:

```json
{ "type": "add_node", "node": { "id": "obs:8", "space": "work", "kind": "observation",
  "label": "run node --test",
  "payload": { "code": 0, "verdict": "pass",
    "witness": [ { "ref": "file:src/sum.mjs", "version": "<new sha1>" } ] } } }
{ "type": "record_check", "command": "node --test", "verdict": "pass",
  "output": "…",
  "witness": [ { "ref": "file:src/sum.mjs", "version": "<new sha1>" } ],
  "claimIds": ["w:claim:5"] }
{ "type": "add_edge", "edge": { "id": "e:9", "from": "obs:8", "to": "w:claim:5",
  "kind": "verifies",
  "provenance": { "kind": "check", "command": "node --test", "verdict": "pass",
    "witness": [ { "ref": "file:src/sum.mjs", "version": "<new sha1>" } ] },
  "status": "open" } }
```

`record_check` sets `w:claim:5` to `verified`.

Turn 5 — `finish` records one action and stops.

The projection after turn 4 is roughly:

```json
{
  "header": { "goal": { "id": "g1", "label": "make node --test pass" },
              "constraints": [ { "id": "k1" } ] },
  "frontier": { "claims": [], "decisions": [], "lastAction": { "id": "act:6" },
                "observations": [], "verified": ["w:claim:5: loop stops one short"],
                "invalidated": [], "rejected": [] },
  "artifacts": [ { "id": "file:src/sum.mjs", "label": "src/sum.mjs", "stale": true } ],
  "index": [ /* every node: g1, k1, file:…, obs:3, w:claim:5, act:6, obs:8 */ ],
  "recent": [ /* the last turns */ ]
}
```

The verified claim has left `frontier.claims` and now appears in
`frontier.verified`; the artifact is shown, but flagged `stale`, because its last
read predates the edit.

### B. A forbidden change through `run`

Instead of `edit`, the LLM runs
`printf '15\n' > test/sum.test.mjs`. The engine (`src/tools/index.ts:295`):

1. snapshots every file matching `\.test\.mjs$` (the test file's content);
2. runs the command;
3. sees the file changed, restores the snapshot, and appends:

```json
{ "type": "add_node", "node": { "id": "obs:7", "space": "work", "kind": "observation",
  "label": "constraint violation (\\.test\\.mjs$): reverted test/sum.test.mjs",
  "payload": { "pattern": "\\.test\\.mjs$", "paths": ["test/sum.test.mjs"],
  "reverted": true } } }
```

No `record_check` is written, so no claim becomes `verified`. The shell string is
never parsed; the constraint holds by effect.

### C. Monotonicity in one line

`mutate` does not delete the earlier `read`; it only flips a derived edge status:

```
e:4  locates  file:src/sum.mjs → obs:3   believed → stale
```

Replay the same events and you get the same `State` and the same `Context`. Code
is mutable; the journal is not.

## 7. Invariants and Tier 0 boundaries

Guaranteed by the IR and checked in tests (`tests/invariants.ts`,
`tests/gate.test.ts`):

- a claim is `verified` only with `check` provenance;
- a `stale` fact is never presented as active content;
- `project` is deterministic: same events → same `Context`;
- doxa only proposes (`status = open`); logos decides.

Deliberately outside Tier 0: file contents in the IR, an explicit `set_status`
event, `subgoal`/`symbol`/`test` nodes, the unused edge kinds, goal closure inside
the engine, and a shell sandbox (the `run` guard is post-hoc, with revert).
