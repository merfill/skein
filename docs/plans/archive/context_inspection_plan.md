# Skein — inspection plan: surfacing `verified` and a status-aware `query`

> Russian mirror — `docs/plans/archive/context_inspection_plan_ru.md`.

Status: implemented (parts A–D); see `tests/ir.test.ts` and `tests/loop.test.ts`.

## Goal

Established facts (`verified`) and verdict provenance must not vanish silently,
without reintroducing a message tape or a zoo of tools.

## Scope

In: a `verified` section in the projection; a status-aware `query`; reading a
verdict trail; bounded command-output excerpts with spill-and-pointer retrieval.

Out: reading the raw journal (`Event[]`), storing contents inside the IR, tools
beyond `query`, raw log dumps into the context.

## A. `verified` section in `Context`

- `frontier` gains `verified: string[]`, mirroring `rejected` (one line
  `id: label`).
- Source: nodes `kind === "claim"` with status `verified` (`state.statuses`),
  sorted by `seq` desc, limited to N (like `recent` via `tail`).
- Files: `src/ir/project.ts` (`Context` interface + assembly), `docs/ir.md` and
  `docs/ir_ru.md` §4.
- Rationale: "what is already established" is always relevant, so it belongs in
  the projection; deterministic, no reliance on model diligence.
- Tests: `tests/ir.test.ts`, `record_check` block — on pass it currently asserts
  `frontier.claims === []`; add `frontier.verified === ["c1: off-by-one in loop"]`.
  Add an ordering/limit test; extend the `project` test.
- Open question: N and the selection rule. Simple: last N. Principled: only
  those reachable from the open goal (provenance relevance is not implemented
  yet). Start simple.

## B. Status-aware `query`

- Problem: `query` returns the node (`src/tools/index.ts:264`), while status
  lives separately in `state.statuses` / `state.edgeStatuses` — so "show
  verified claims" is impossible.
- Schema (`src/llm/schemas.ts:29`): replace `selector: z.string()` with
  structured selectors:
  - `id?`; `kind?`; `status?` (validated via `z.enum(STATUSES)` from
    `src/ir/types.ts`); `edgesOf?` with an optional `edgeKind?`.
- `executeAction` (`src/tools/index.ts:264`): filter over state, joining the
  node with its status; return the legible shape (`id, kind, label, status`),
  not a raw `Node`.
- Prompt (`src/loop/propose.ts:24`): document the query forms.
- Rules: read-only (`events: []`, tested); bounded rows and clipped output;
  never raw journal events.
- Tests: `query { kind: "claim", status: "verified" }`; `query { id }` returns
  node + edges; `query` writes no events.

## C. Verdict trail (provenance)

- Data already exists: `record_check` stores `{ command, verdict, output,
  claimIds }` (`src/ir/graph.ts:101-108`), with `output` clipped to 8000
  (`src/tools/index.ts:222-228`); `verifies` edges link `observation → claim`.
- Add a `verdictOf: <claimId>` selector: returns the checks for the claim and
  the linked observations, as `claim → verifies-edge → observation → check`.
- Tests: pass and fail cases; missing data yields an honest "no data".

## D. Command output: bounded excerpt + spill-and-pointer

Two increments, both in scope.

### D1. Head+tail excerpt (immediate)

- Problem: `clip` keeps only the head (`src/tools/index.ts:17`), so the failing
  tail of test output is dropped, and the marker only reports a byte count.
- Replace head-only clipping with a deterministic head+tail excerpt for both the
  turn text and the recorded output. Mechanical, not an LLM summary — the same
  rule that keeps the projection cheap (`docs/concepts.md`).
- The marker must be visible and recoverable: state how much is omitted and where
  the full output lives.

### D2. Spill to `.skein/` + `outputRef`

- When the output exceeds the excerpt limit, write the full output to
  `.skein/logs/run-<turn>.log`. `.skein` is already in `SKIP_DIRS`
  (`src/tools/workspace.ts:34`), so `list`, `grep`, and the constraint guard
  ignore it.
- Record `outputRef` on the observation payload and on `record_check`; fill the
  already-declared but unused `outputRef` on check provenance
  (`src/ir/types.ts:38`).
- Retrieval uses the existing `read { path, start, end }` — no new tool.
- Add `.skein/` to `.gitignore` (output may contain secrets; only `*.log` is
  ignored today).

### Rules and caveats

- Full output never enters the IR: the IR keeps a pointer plus a bounded excerpt.
- `fold` determinism is unaffected; spilled logs are ephemeral side effects, so
  session reproducibility depends on them. Retention/cleanup is a lifecycle
  concern (bounded, cleaned at run end).
- Tests: the excerpt shows both ends and an omitted-line marker; the spill file
  exists and is readable through a windowed `read`; `.skein` is excluded from
  `list()`/`grep()`; `record_check` carries `outputRef`.

## Invariants

- `project` stays a pure function of state; `verified` derives only from
  `fold(events)`.
- Full command output never enters the IR; only a pointer plus a bounded excerpt
  is stored.
- `query` stays pure (writes nothing) → append-only and determinism intact.
- Status is read from `state.statuses` / `state.edgeStatuses`, never from `Node`.
- The `verified` section shows no contents and does not resurrect `stale` facts
  as active.

## Order of work

1. `verified` in `frontier` + tests + docs.
2. Status-aware `query` (schema, `executeAction`, prompt, tests).
3. `verdictOf` extension.
4. Command output: head+tail excerpt (D1), then spill + `outputRef` (D2).

## Adjacent, out of scope

- Real provenance relevance (the path from the goal).
- Dead `frontier.observations` (built from `verifies` edges to open claims,
  which such edges never have).
