# Skein — Tier 0 plan

Conceptual overview — `docs/concepts.md`. Conceptual ground —
`ankyra/docs/doxa_and_logos.tex` (doxa/logos), `ankyra/docs/concepts_ru.md` (the
engine's design). This document fixes the **decisions and scope of the first
stage**. Code is written only after this document.

## 1. Fixed decisions

The full list of decisions and the roadmap are in
`docs/plans/implementation_plan.md`. The essentials for Tier 0: TypeScript (Node 22,
ESM), package manager npm; hybrid graph `work` + `artifact`; append-only journal
plus deterministic projection; first slice is bugfix by a failing test;
orchestration with LangGraph.js; LLM is the Ankyra provider with reasoning
disabled.

## 2. Mapping to the doxa/logos frame

- **Doxa** — the LLM: it only *proposes*. A proposed belief enters as a node with
  `status = "open"`, never immediately `verified` (nodes carry no provenance; the
  `llm` kind is reserved).
- **Logos** — internal operators: arbiter verdicts (`check`) and closure of the
  artifact graph (transitive dependencies, affected tests).
- **Protocol** — the event journal, `fold`, `project`, status transitions.
- The IR is **protocol plus internal state**; doxa is not stored in the IR.

## 3. Tier 0 boundaries

In scope: the closed loop `goal → locate → claim → action → check → done`, a
deterministic projection, staleness by version, an objective arbiter.

Deliberately out of scope: AST/symbol table, embeddings/similarity retrieval,
`analogy`, `intuition`, `specificity`, `Revision` as a separate type,
CSP/arithmetic, UI, multilinguality, multiple LLM providers. Strictly minimal
diff.

## 4. Project layout

```
skein/
  package.json
  tsconfig.json
  vitest.config.ts
  .env                 # secrets, not committed
  .env.example
  .gitignore
  src/
    ir/
      types.ts         # Node, Edge, Provenance, Status
      events.ts        # zod event schemas
      graph.ts         # fold(events) -> State (append-only)
      project.ts       # project(State, view) -> Context
    config/
      settings.ts      # SKEIN_* env
    llm/
      client.ts        # ChatOpenAI + reasoning off
      schemas.ts       # zod schemas for proposals
    tools/
      workspace.ts     # fsWorkspace: read/write/version/grep/run
      index.ts         # executeAction + event writing
    loop/
      state.ts         # LangGraph state annotations
      propose.ts       # one structured LLM call
      classify.ts      # deterministic classification
      graph.ts         # StateGraph: project -> propose -> classify -> execute -> route
  fixtures/
    bugfix/<id>/       # mini package with a failing test (node --test)
  tests/
    ir.test.ts         # golden: fold / project / staleness
    loop.test.ts       # offline scripted run
    gate.test.ts       # invariants (live, opt-in)
    invariants.ts      # shared invariant checks
```

## 5. IR model (`src/ir/`)

Two namespaces, one graph. Canonical artifact ids: `file:src/foo.ts`,
`sym:src/foo.ts#bar`, `test:...`.

```ts
export type NodeKind =
  | "goal" | "subgoal" | "claim" | "decision"
  | "action" | "observation" | "constraint"      // space: "work"
  | "file" | "symbol" | "test";                  // space: "artifact"

export interface Node {
  id: string;
  space: "work" | "artifact";
  kind: NodeKind;
  label: string;                 // one line for the index
  payload?: unknown;             // kind-specific content
  seq: number;                   // creation event number
}

export type Provenance =
  | { kind: "llm" }                                   // doxa entered
  | { kind: "user"; turnId: string }
  | { kind: "read"; ref: string; version: string }    // file hash
  | { kind: "grep"; pattern: string }
  | { kind: "check"; command: string; verdict: "pass" | "fail"; outputRef?: string };

export type Status =
  | "open" | "verified" | "refuted" | "superseded"    // claim / observation
  | "active" | "applied" | "reverted"                 // decision / action
  | "achieved" | "abandoned"                           // goal / subgoal
  | "must"                                             // constraint
  | "believed" | "stale" | "confirmed";                // artifact

export type EdgeKind =
  | "decomposes" | "supports" | "refutes" | "depends_on"
  | "chosen_over" | "justifies"                        // work -> work
  | "touches" | "locates" | "verifies" | "violates"    // work -> artifact
  | "calls" | "defines" | "imports" | "tests";         // artifact -> artifact

export interface Edge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  provenance: Provenance;
  status: Status;
  version?: string;              // world version at assertion time
}
```

## 6. Events, fold, staleness (`graph.ts`, `project.ts`)

The journal is **append-only**. State is `fold(events)`. Statuses are derived.

```ts
export type Event =
  | { type: "add_node"; node: Node }
  | { type: "add_edge"; edge: Edge }
  | { type: "set_status"; id: string; status: Status; reason?: string }
  | { type: "mutate"; ref: string; version: string; actionId: string }
  | { type: "record_check"; command: string; verdict: "pass" | "fail";
      output: string; claimIds: string[] };
```

**Staleness by version (the main mechanism).** Every artifact fact (`read` /
`grep`) stores `version` — the file hash at read time. A `mutate` event marks
`stale` every fact whose `ref` matches and whose `version` differs. This makes
code non-monotonicity deterministic and needs no manual retraction: the knowledge
in the journal is monotonic, while the mutable code is a derived view of replayed
actions.

Projection:

```ts
export interface Context {
  header:   { goal: Node; constraints: Node[] };      // stable prefix
  frontier: {
    claims:       Node[];   // status = "open", with brief provenance
    decisions:    Node[];   // status = "active"
    lastAction?:  Node;
    observations: Node[];   // latest per active claim
    rejected:     string[]; // refuted/superseded — one line
  };
  artifacts: { id: string; label: string; stale: boolean }[];  // index only
  index:     { id: string; kind: NodeKind; label: string }[];  // what exists
  recent:    Turn[];                                            // last N turns
}
```

"Active" means a path from an open goal through active decisions/actions to open
claims (relevance by provenance, not by similarity). Artifact contents never enter
the projection — only id plus one line; `stale` collapses to a line.

## 7. The LangGraph.js cycle (`src/loop/`)

```
START → project → propose → classify → execute → route
route ──continue──▶ project
route ──done | budget | error──▶ END
```

- **project** — a pure function of `State`; no LLM.
- **propose** — exactly one structured reply (zod) `{ thought, action }`, where
  `action` is one of `track | read | grep | edit | run | query | finish`. The
  `thought` is the turn narrative and is **not** written to the IR.
- **classify** — deterministically: `derivable | cited | hypothesis | rejected`
  (cited = backed by a tool output/quote; rejected = contradicts a `verified` fact
  or a constraint).
- **execute** — deterministically performs the action and writes events.

State is `Annotation.Root`: `events` (reducer `concat` — append-only), `context`,
`proposal`, `classification`, `turn`, `done`, `stopReason`. The split between
projection and state mirrors `WaveContext` / `build_hint` in Ankyra.

## 8. Tools (`src/tools/`)

| Tool | Writes to the IR | Role |
|---|---|---|
| `read(path, range?)` | artifact facts with `version` | locate; contents are an ephemeral observation |
| `grep(pattern)` | hit index | locate |
| `edit(path, find, replace)` | `action` + `mutate` | mutate the world (non-monotonicity) |
| `run(command, claims?)` | `record_check` | **arbiter**: verdict pass/fail |
| `track(...)` | claim/decision/constraint (`status=open`) | doxa proposes |
| `query(selector)` | nothing (one-shot answer) | query the IR |
| `finish(summary)` | `action` | request to stop |

## 9. LLM layer and settings (`src/llm/`, `src/config/`)

The same provider as Ankyra: an OpenAI-compatible endpoint, `ChatOpenAI` from
`@langchain/openai`. Structured output — `withStructuredOutput(zodSchema)`.

Reasoning is **mandatorily disabled** (as in Ankyra):

```ts
new ChatOpenAI({
  configuration: { baseURL: env.SKEIN_API_URL },
  apiKey: env.SKEIN_API_KEY,
  model: env.SKEIN_MODEL,
  temperature: Number(env.SKEIN_TEMPERATURE ?? 0.1),
  maxTokens: Number(env.SKEIN_MAX_TOKENS ?? 4096),
  modelKwargs: {
    thinking: { type: "disabled" },     // DeepSeek: do not "think"
    reasoning: { effort: "none" },      // RouterAI: reasoning budget = 0
  },
});
```

Environment variables, prefix `SKEIN_` (secrets only in `.env`):

| Variable | Default |
|---|---|
| `SKEIN_API_URL` | `https://routerai.ru/api/v1` |
| `SKEIN_API_KEY` | — (from `.env`, not committed) |
| `SKEIN_MODEL` | `~deepseek/deepseek-v4-flash-latest` |
| `SKEIN_TEMPERATURE` | `0.1` |
| `SKEIN_MAX_TOKENS` | `4096` |
| `SKEIN_REASONING_EFFORT` | `none` |
| `SKEIN_MAX_TURNS` | `24` |
| `SKEIN_LIVE` | `false` |

## 10. Gate: fixtures, invariants, verification

**Fixtures.** `fixtures/bugfix/<id>/` — a mini package with one failing test
(`node --test`). The run goal: "make the test green without breaking the rest".
Constraint: "do not edit test files". The slice is 3–5 tasks, each understandable
by hand.

**Invariants (hard, checked on every run):**
- a claim never becomes `verified` without `check` provenance;
- a `stale` fact is never shown as active content;
- `project` is deterministic: same events → same `Context`;
- the goal closes only when the arbiter passes (`run` returned `pass`);
- the `must` constraint is never violated (test files unchanged);
- bounds on the number of turns/actions.

**Verification:**
- `npm run typecheck` — `tsc --noEmit`;
- `npm test` — vitest: golden tests for `fold`/`project`/staleness plus
  invariants;
- live agent run — only when `SKEIN_LIVE=true`.

## 11. Order of work

1. TS project skeleton: `package.json`, `tsconfig`, `vitest.config`,
   `.env.example`, `.gitignore`.
2. `src/ir/`: types → events → `fold` → `project` + golden tests.
3. `src/config/` + `src/llm/`: client, zod schemas, "reasoning disabled" check.
4. `src/tools/` and `src/loop/`: classification, execution, LangGraph.
5. `fixtures/bugfix/*` + gate; run 3–5 tasks.

## 12. Open forks

- Proposal validation: strict zod contract vs a lenient JSON fallback (as in
  Ankyra `llm/structured.py`). For Tier 0 — strict zod, fallback later.
- `payload` shape for `finish`/`run`: free text vs a typed predicate. For Tier 0 —
  free text, checked by the arbiter.

## 13. Implementation status (Tier 0)

Steps 1–5 are implemented:

- `src/ir/` — types, zod events, `fold` (with staleness by version), `project`.
- `src/config/`, `src/llm/` — `SKEIN_*` settings, the Ankyra provider client with
  reasoning disabled (`reasoningOffBody`), zod schemas for proposals.
- `src/tools/` — `fsWorkspace` (read/write/version/grep/run) and `executeAction`.
- `src/loop/` — deterministic classification, `propose`, the LangGraph cycle
  (`project → propose → classify → execute → route`), `runAgent`.
- `fixtures/bugfix/{off-by-one,missing-bang,max-first}` — 3 tasks with `node --test`.
- Gate: `tests/loop.test.ts` (offline, 17 tests), `tests/gate.test.ts` (live,
  under `SKEIN_LIVE=true`).

Tier 0 simplifications (deliberate, not bugs):

- `run` verifies **all open claims** by default; it can be narrowed via `claims`
  in the action. The "which claim does the test confirm" semantics is coarse.
- File contents are **not** stored in the IR: only the artifact index plus
  ephemeral `recent` turns.
- The goal does not become `achieved` automatically; the harness (the arbiter)
  closes it.
- `finish` does not check the goal — the gate does that after the run.

The live path (`withStructuredOutput` + zod v4, `modelKwargs`) is verified: with
`SKEIN_LIVE=true` the gate passes on all three fixtures (20 tests). Secrets live
in `skein/.env`, which is in `.gitignore`.

Resolved: a constraint is enforced by effect. `edit` is checked in `classify`;
before a `run`, the files matching `payload.forbid` are snapshotted, and any
change to them is reverted, recorded as a `constraint violation` observation, and
never turned into a passing check. See `docs/plans/constraint_guard_plan.md`.
