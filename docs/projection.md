# Skein — projecting state into the context (specification)

> Russian mirror — `docs/projection_ru.md`.

Related: `docs/ir_semantics.md` (§2.8 — negative/summary, §8 — the place of the
projection), `docs/ir.md` (as-built), `docs/tools.md` (the tool contract),
`docs/fix_ocaml_gc_run_report.md` (the context counterexample).

This is the source of truth about the **composition** of the projection. The code
(`src/ir/project.ts`) follows it. A projection change: first here, then the code, then
a test.

## 1. Purpose

The projection is the **context for the next operator**, not a state dump. For the
model the projection is **all of memory**: what is not in it, the model does not know.

The durable memory is the **tree** (the request, goals with
`what`/`why`/`done_when`, the plan and item states, alternatives, closures). Tool
results are **not the tree**: only the latest is shown in full, and previous ones are
summarized to signatures.

**Principle:** show the **traversal branch** plus exactly six things without which the
operator cannot decide:

1. **`path`** — the stack: `request → chosen interpretation → … → current node`;
2. **the containers of the path's nodes** — their `plan` (items + states) and
   `alternatives` (interpretations/options + `chosen`) — what `create_goal`,
   `revises`, `apply`, `complete`/check rest on;
3. **`constraints`** — global, not to be violated;
4. **`lastResult`** — the **full** result of the latest call (within the tool's
   honestly declared limits), to decide the next move;
5. **`shown`** — the **working set**: the results the model asked for via `need`/`query`,
   also in full, with a TTL (§8 of `docs/context_design.md`);
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
  shown:       ResultView[],      // results kept via `need` (the hypothesis)
  calls:       Call[],            // a summary of previous ones (may be empty)
  applicable:  string[],          // names of applicable operators
  checkReady:  boolean,           // a run {target: focus} check is expected now
  nextAction?: string,            // the action item the plan cursor points at
  budget:      { turn, maxTurns, remaining }
}

PathNode = {
  id, kind: "request" | "goal",
  state,
  text?,                    // request
  what?, why?, done_when?,  // goal
  plan?:         { cursor?, items: Item[] },   // the node's own plan
  alternatives?: { chosen?, items: Alt[] }     // the node's own container
}

Item = { id, kind: "goal" | "action", label, state, why? }
Alt  = { id, label, state, chosen: boolean, why? }

ResultView = {                 // a view, not a node
  id, kind: "observation" | "check" | "action",
  command?,                    // run / check
  ref?,                        // read / edit — the touched file
  verdict?,                    // check
  label?,                      // action
  output?                      // the full output of the latest call
}

Call = {                       // an aggregate, not an event
  id?: string,                 // the address of the latest result (for `need`)
  action: string,              // read f [1-100]; grep sweep 5/5; run make; tool target
  status: "ok" | "fail" | "refused",
  note?: string,               // fail/refused: the reason (last output line / reason)
  count: number                // repetitions with the same signature (≥1)
}
```

- `path[last]` is the focus; there is no separate `focus`.
- A `request` has no `plan`/`done_when`; its interpretations live in `alternatives`.
- A `goal` may have a `plan`, `alternatives`, or neither.
- A plan/alternatives item carries `why?`: for a `refuted`/`abandoned` item it is the
  failed hypothesis, so the next attempt does not repeat it.
- `applicable` lists the operator names; `checkReady` says whether a `run {target:
  path[last]}` **check** is the expected move now (an objective goal whose plan is
  done). `apply` can be listed while `checkReady` is false — that means a bare
  exploratory `run` is available, not a check of the focus; a check requires an
  **objective** goal (a subjective target is refused).
- `nextAction`, when present, is the action item the plan cursor points at: apply it
  verbatim.
- `lastResult.output` is full (the projection does not cut it); the limits are set by
  the tool itself and **declared** in the result (see `docs/tools.md`).

## 3. What is not included

- **`artifacts`** (a file list) — no. A file is a reference and is needed only as the
  `ref`/`output` of an action.
- **File versions** — no. A version is an engine detail (`stale_base`); the model does
  not need version history.
- **`index.counts`** — no.
- **`recent`** (the turn tape) — no. But **`calls`** is not a tape: it is a
  deduplicated aggregate of signatures, not a history of every turn.
- **Raw event payloads whole** — no: neither a check's `witness`, nor full file
  content; a result is shown only if a tool returned it (`lastResult`), and `calls`
  keeps only signatures.
- **Branches outside the stack** — no; reachable via `query`.

### 3.1 Rules of `calls`

- **Sources.** `refused` — from `record_rejection`; `ok`/`fail` — executed actions (an
  `action` with a produced `observation`/`check`), plus materialized failures without
  an `action` node.
- **Dedup and count.** Records with an equal `(status, action)` collapse; `count`
  grows. A repeated failure creates **no** knowledge.
- **Focus.** Only records whose focus (the node at the moment of appearance) lies on
  the current `path` are shown. Left the branch — the record is gone.
- **Invalidation.** A mutation after the record clears `fail`/`refused` (in another
  world state the same might work). `ok` is kept as history. The exception is
  constraint refusals (`constraintId`).
- **Order.** Newest first.
- **`note`.** `refused` — `reason`; `fail` — the **last non-empty line** of the output
  (errors are usually at the tail), up to ~120 chars.

## 4. Limits

- **There is no global context budget.** `SKEIN_CTX_TOTAL`/`SKEIN_CTX_EXCERPT` are not
  applied: a tool honestly returns its result within its declared limits
  (`MAX_READ_LINES`, `MAX_GREP_MATCHES`, `MAX_RUN_OUTPUT`), and the projection does
  not cut it.
- `SKEIN_CTX_ITEMS` bounds the number of items in `plan`/`alternatives` (20).
- The same journal and parameters give the same projection (§9‑4).
- The **turn** budget (`budget.turn/maxTurns/remaining`) is not about chars; it stays.

## 5. Operators and what they need

| Operator | What it reads in the projection |
|---|---|
| `create goal` | `path` (the focus and its `done_when`), the focus's `alternatives` (for `revises`), `constraints`, `calls` (do not repeat a failure) |
| `apply` (read/grep/edit/run) | `path` (the current goal), `lastResult` (to decide), `calls` (what was already tried), `constraints` |
| `complete` | `path` (the focus and its `done_when`) |
| a check (`apply run { target }`) | `path` + the goal's objective `done_when` |
| `query` | addressing: reaches any node/edge by id/kind/predicate |

## 6. Example: off-by-one, turn by turn

Request: "make `node --test` pass; do not edit tests". Constraint `k1`.

**Turn 0 — the request only.**
```json
{ "path": [ { "id": "r1", "kind": "request", "state": "open",
              "text": "make node --test pass; do not edit tests" } ],
  "constraints": [ { "id": "k1", "forbid": ["\\.test\\.mjs$"] } ],
  "calls": [],
  "applicable": ["create_goal"],
  "budget": { "turn": 0, "maxTurns": 24, "remaining": 24 } }
```

**Turn 1 — `create_goal` the interpretation `g1` with a plan; the focus descended into `g2`.**
```json
{ "path": [
    { "id": "r1", "kind": "request", "state": "open",
      "text": "make node --test pass; do not edit tests" },
    { "id": "g1", "kind": "goal", "state": "open",
      "what": "make the suite pass",
      "done_when": { "kind": "objective", "command": "node --test" },
      "plan": { "cursor": 0, "items": [
        { "id": "g2", "kind": "goal",   "label": "reproduce",  "state": "open" },
        { "id": "g3", "kind": "goal",   "label": "locate+fix", "state": "open" },
        { "id": "g4", "kind": "goal",   "label": "verify",     "state": "open" } ] },
      "alternatives": { "chosen": "g1", "items": [
        { "id": "g1", "label": "make the suite pass", "state": "open", "chosen": true } ] } },
    { "id": "g2", "kind": "goal", "state": "open",
      "what": "reproduce", "done_when": { "kind": "subjective", "text": "see it fail" } } ],
  "constraints": [ { "id": "k1", "forbid": ["\\.test\\.mjs$"] } ],
  "calls": [ { "action": "run make test", "status": "ok", "count": 1 } ],
  "applicable": ["apply", "create_goal"],
  "budget": { "turn": 1, "maxTurns": 24, "remaining": 23 } }
```

**Turn 2 — `apply run node --test`; the result is shown in full; the previous call moved to `calls`.**
```json
"lastResult": { "id": "obs:12", "kind": "observation", "command": "node --test",
                "verdict": "fail", "output": "not ok 1 - sumTo(5) is 15\n…" },
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

**Turn 5 — a check of goal `g1`; the witness is not shown.**
```json
"lastResult": { "id": "chk:18", "kind": "check", "command": "node --test", "verdict": "pass" }
```
After this `g1` is `achieved`, the request is `addressed`, and the loop stops
(`request_addressed`).

Note: in no turn is there a file list, versions, an `index`, or a tape; a file appears
as the `ref`/`output` of the action that touched it, or as a signature in `calls`.

## 7. Counterexample: fix-ocaml-gc

In the run `~/.skein-bench/harbor/2026-10-03__11-00-06` the context jumped
`37k → 802k → 35k` and again `803k`. The cause: `frontier.lastResult` returned a
`check` node **whole**, and its payload held a `witness` — a version for **every file
in the workspace** (~7000 entries ≈ 767k chars). As soon as a fresher result
appeared (`read`), the spike vanished.

The correct projection on that turn:
```json
"lastResult": { "id": "chk:536", "kind": "check",
                "command": "cd /app/ocaml && make", "verdict": "pass" }
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
