# Skein — projecting state into the context (specification)

> Russian mirror — `docs/projection_ru.md`.

Related: `docs/ir_semantics.md` (§2.8 — negative/summary, §8 — the place of the
projection), `docs/ir.md` (as-built), `docs/tools.md` (the tool contract),
`docs/benches/fix_ocaml_gc_run_report.md` (the context counterexample).

This is the source of truth about the **composition** of the projection. The code
(`src/ir/project.ts`) follows it. A projection change: first here, then the code, then
a test.

## 1. Purpose

The projection is the **context for the next operator**, not a state dump. For the
model the projection is **all of memory**: what is not in it, the model does not know.

The durable memory is the **tree** (the request, goals with
`what`/`why`/`done_when`, the plan and item states, alternatives, settled goals). Tool
results are **not the tree**: only the latest is shown in full, and previous ones are
summarized to signatures.

The traversal model: the tree is **ReAct unwound along a tree**; traversal is a **stack
of frames** — the spine (one frame per level, root→focus) plus each level's **arms** (the
siblings). The stack is `fold(journal)` over the **append-only** IR. Full spec:
`docs/plans/traversal_stack_spec.md`.

**Principle:** show the **traversal branch** plus exactly six things without which the
operator cannot decide:

1. **`path`** — the stack: `request → goal → … → current node`;
2. **the containers of the path's nodes** — their `plan` (items + states) and
   `alternatives` (options, the last/current one marked `chosen`) — what `create_goal`
   (and its `revises`), `apply`, and a criterion run rest on;
3. **`constraints`** — global, not to be violated;
4. **`lastResult`** — the **full** result of the latest call (within the tool's
   honestly declared limits), to decide the next move;
5. **`shown`** — the **working set**, engine-owned: the branch levels' results held
   structurally (no TTL), plus bodies pulled back via `query {id}` with a TTL (§8 of
   `docs/context_design.md`);
6. **`calls`** — a deduplicated **summary of previous calls without results**: what
   was called, the status (`ok`/`fail`/`refused`) and the reason. It gives memory of
   what was already done without inflating the context (invariant 21, §2.8 of the
   semantics).

Everything else off the branch is **not shown by default** and is reached via `query`.

## 2. What is included

```
Projection = {
  path:        PathNode[],        // the stack, top = focus
  constraints: { id, forbid[] }[],
  lastResult?: ResultView,        // the full result of the latest call
  shown:       ResultView[],      // the working set (branch levels + queried bodies)
  calls:       Call[],            // a summary of previous ones (may be empty)
  applicable:  string[],          // names of applicable operators (create_goal/apply/stop/decline)
  checkReady:  boolean,           // a run {target: focus} criterion is the expected move now
  nextAction?: string,            // informational: the action item the plan cursor points at
  budget:      { turn, maxTurns, remaining }
}

PathNode = {
  id, kind: "request" | "goal",
  state,                    // open | executed | stopped
  text?,                    // request
  what?, why?, done_when?,  // goal: done_when is the criterion command (a string)
  planHint?,                 // goal: the initial plan as a string sketch (I3)
  plan?:         { cursor?, items: Item[] },   // the node's own plan (action items)
  alternatives?: { chosen?, items: Alt[] }     // the node's own container; `chosen` = the last/current option (a label, not an edge)
}

Item = { id, kind: "goal" | "action", label, state, why?,
         alternatives?: { chosen?, items: Alt[] } }   // the item's revision history
Alt  = { id, label, state, chosen: boolean, why? }   // chosen = the last/current option (a label)

ResultView = {                 // a view, not a node
  id?,                         // absent when the call produced no result node (e.g. query)
  kind: "observation" | "action",
  command?,                    // run
  ref?,                        // read / edit — the touched file
  exitCode?,                   // run: 0 = pass, non-zero = fail, absent on a timeout
  label?,                      // action
  output?,                     // stdout of the latest call (not merged with stderr)
  error?,                      // stderr, kept separate; the primary signal of a failure
  signal?, core?, corePattern?, backtrace?   // crash diagnostics of a signal-killed run
}

Call = {                       // an aggregate, not an event
  id?: string,                 // the address of the latest result (for `query`)
  action: string,              // read f [1-100]; grep sweep 5/5; run make; tool target
  status: "ok" | "fail" | "refused",
  note?: string,               // fail/refused: the reason (last output line / reason)
  count: number                // repetitions with the same signature (≥1)
}
```

- `path[last]` is the focus; there is no separate `focus`.
- A `request` has only `text`; its goal is the next node on the path (the `has_goal`
  edge). A non-actionable request is declined (`no_goal` → `unactionable`).
- A `goal` may have a `plan`, `alternatives`, or neither.
- A plan/alternatives item carries `why?`: for a failed or unselected item it is the
  hypothesis that did not work, so the next attempt does not repeat it.
- `applicable` lists the operator names truly admissible at the focus, from the **same
  frontier** the gates use (`create_goal`, `apply`, `stop`, `decline`). `checkReady` says
  whether a `run {target: path[last]}` criterion run is the expected move now (the goal's
  plan is done). At a fresh request it is `[create_goal, decline]`: the request is
  interpreted once or declined. `apply` is listed for any open goal — a bare exploratory
  `run` is always available, not only a criterion of the focus. `stop` is listed only at a
  goal whose criterion passed (for now a `stop` is accepted only then); the request has no
  `stop` — the run ends when its goal is stopped. After a failed criterion the frontier
  offers `create_goal` (a revision) only.
- `nextAction`, when present, is informational: the action item the plan cursor points
  at. The doxa is handed the whole **arm** (with the cursor on the current node) and
  chooses the next move — continue, alternative, or stop.
- `plan.items[].alternatives` renders an item's revision history in place, so a bypassed
  or decomposed step's "did not work" siblings stay visible (`TR-9`).
- `lastResult.output` is full (the projection does not cut it); the limits are set by
  the tool itself and **declared** in the result (see `docs/tools.md`).

## 3. What is not included

- **A file list** — no. A file is a reference and is needed only as the `ref`/`output`
  of an action.
- **File versions** — no. A version is an engine detail (`stale_base`); the model does
  not need version history.
- **Per-kind node counts** — no.
- **A turn tape** — no. But **`calls`** is not a tape: it is a deduplicated aggregate of
  signatures, not a history of every turn.
- **Raw event payloads whole** — no: neither a criterion run's `witness`, nor full file
  content; a result is shown only if a tool returned it (`lastResult`), and `calls`
  keeps only signatures.
- **Branches outside the stack** — no; reachable via `query`.

### 3.1 Rules of `calls`

- **Sources.** `refused` — from `record_rejection`; `ok`/`fail` — executed actions (an
  `action` with a produced `observation`), plus materialized failures without an
  `action` node. `fail` is an observation flagged `failed: true` or a run with a
  non-zero `exitCode`.
- **Dedup and count.** Records with an equal `(status, action)` collapse; `count`
  grows. A repeated failure creates **no** knowledge.
- **Focus.** A record is shown when its focus (the node at the moment of appearance)
  lies in the **subtree of the request's goal**, **or on the current `path`**. The path is
  included because the request root is the parent of that subtree: a refusal recorded
  while the focus is the request (e.g. a declined request) must be visible, otherwise the
  projection does not change after the refusal (invariant 21).
- **Invalidation.** A mutation after the record clears `fail`/`refused` (in another
  world state the same might work). `ok` is kept as history. The exception is
  constraint refusals (`constraintId`).
- **Order.** Newest first.
- **`note`.** `refused` — `reason`; `fail` — the most informative line of the **stderr**
  body (the failure signal), else of stdout: the last line that names a crash
  (`segmentation`, `panic`, `traceback`, `assertion`, `fatal`, …), else the last line
  that names an error (`error`, `failed`, `cannot`, `no such file`, …), else the last
  non-empty line; up to `NOTE_LIMIT` (512) chars.

## 4. Limits

- **There is no global context budget.** `SKEIN_CTX_TOTAL`/`SKEIN_CTX_EXCERPT` are not
  applied: a tool honestly returns its result within its declared limits
  (`MAX_READ_LINES`, `MAX_GREP_MATCHES`, `OUTPUT_LIMIT`), and the projection does
  not cut it.
- `SKEIN_CTX_ITEMS` bounds the number of items in `plan`/`alternatives` (20).
- The same journal and parameters give the same projection (§9‑4).
- The **turn** budget (`budget.turn/maxTurns/remaining`) is not about chars; it stays.

## 5. Operators and what they need

| Operator | What it reads in the projection |
|---|---|
| `create_goal` | `path` (the focus and its `done_when`), the focus's `alternatives` (for `revises`), `constraints`, `calls` (do not repeat a failure) |
| `apply` (read/grep/edit/run) | `path` (the current goal), `lastResult` (to decide), `calls` (what was already tried), `constraints` |
| a criterion run (`apply run { target }`) | `path` + the goal's `done_when` command |
| `stop` | a goal whose criterion passed (for now a `stop` is accepted only then): it appends a `stop` node as the goal's last plan item and a `has_stopped` edge |
| `decline` | a fresh request whose intent is not actionable: records `unactionable` (`no_goal`) and ends the run |
| `query` | addressing: reaches any node/edge by id/kind |

A bare `run` (no target) is an **observation**, never a criterion. There is no per-goal
acceptance: a goal is closed only by `stop`, once its criterion command has passed, and the
run ends when the request's goal is stopped.

## 6. Example: off-by-one, turn by turn

Request: "make `node --test` pass; do not edit tests". Constraint `k1`.

**Turn 0 — the request only.**
```json
{ "path": [ { "id": "r1", "kind": "request", "state": "open",
              "text": "make node --test pass; do not edit tests" } ],
  "constraints": [ { "id": "k1", "forbid": ["\\.test\\.mjs$"] } ],
  "shown": [],
  "calls": [],
  "applicable": ["create_goal", "decline"],
  "checkReady": false,
  "budget": { "turn": 0, "maxTurns": 24, "remaining": 24 } }
```

**Turn 1 — `create_goal` the interpretation `g1`; only the first plan step is materialized, as an action.**
```json
{ "path": [
    { "id": "r1", "kind": "request", "state": "open",
      "text": "make node --test pass; do not edit tests" },
    { "id": "g1", "kind": "goal", "state": "open",
      "what": "make the suite pass", "why": "the suite is failing",
      "done_when": "node --test",
      "planHint": "reproduce, locate+fix, verify",
      "plan": { "cursor": 0, "items": [
        { "id": "a2", "kind": "action", "label": "reproduce", "state": "open" } ] } } ],
  "constraints": [ { "id": "k1", "forbid": ["\\.test\\.mjs$"] } ],
  "calls": [ { "action": "run make test", "status": "ok", "count": 1 } ],
  "applicable": ["apply", "create_goal"],
  "checkReady": false,
  "budget": { "turn": 1, "maxTurns": 24, "remaining": 23 } }
```

**Turn 2 — `apply run node --test`; the result is shown in full; the previous call moved to `calls`.**
```json
"lastResult": { "id": "obs:12", "kind": "observation", "command": "node --test",
                "exitCode": 1, "output": "not ok 1 - sumTo(5) is 15\n…" },
"calls": [ { "action": "run make test", "status": "ok", "count": 1 } ]
```
Note: the full output, without versions or `witness`.

**Turn 3 — `read src/sum.mjs [1-400]`; the code window is shown in full.**
```json
"lastResult": { "id": "obs:14", "kind": "observation", "ref": "src/sum.mjs",
                "output": "export function sumTo(n) {\n  let total = 0;\n  …" },
"calls": [
  { "action": "run node --test", "status": "fail", "note": "not ok 1", "count": 1 },
  { "action": "run make test",   "status": "ok", "count": 1 } ]
```

**Turn 4 — `edit src/sum.mjs`; the content is no longer needed, the fact of the edit is.**
```json
"lastResult": { "id": "act:16", "kind": "action", "ref": "src/sum.mjs",
                "label": "edit src/sum.mjs" }
```

**Turn 5 — the criterion of goal `g1`: `run {target: g1}`; the witness is not shown.**
```json
"lastResult": { "id": "obs:18", "kind": "observation", "command": "node --test",
                "exitCode": 0 }
```
`g1` is **not** closed by this pass: `exitCode 0` is the criterion fact. The doxa then
`stop`s `g1` — appending a `stop` node as the goal's last plan item and a `has_stopped`
edge — so the loop ends (`request_addressed`). The request has no `stop`; the run ends
when its goal is stopped.

Note: in no turn is there a file list, versions, an `index`, or a tape; a file appears
as the `ref`/`output` of the action that touched it, or as a signature in `calls`.

## 7. Counterexample: fix-ocaml-gc

In the run `~/.skein-bench/harbor/2026-10-03__11-00-06` the context jumped
`37k → 802k → 35k` and again `803k`. The cause: `lastResult` returned a criterion
`observation` **whole**, and its payload held a `witness` — a version for **every file
in the workspace** (~7000 entries ≈ 767k chars). As soon as a fresher result
appeared (`read`), the spike vanished.

The correct projection on that turn:
```json
"lastResult": { "id": "obs:536", "kind": "observation", "command": "cd /app/ocaml && make",
                "exitCode": 0 }
```
The whole witness only via `query`, if the doxa explicitly asks.

## 8. Boundaries and open questions

- **Static parts in the system prompt.** `request.text` and `fragment` do not change
  turn to turn; it pays to keep them in the system prompt (a stable prefix for the
  cache). A separate decision.
- **Witness precision.** The spec does not cancel the task of narrowing `witness` at
  the source; the projection merely stops inlining it.
- **Bringing the budget back.** If the context becomes a problem again, we will decide
  its form (not applied for now).
