# Skein

A coding agent whose context is a **projection of an IR**, not a message tape.
The LLM (doxa) only proposes; a deterministic engine and the arbiter (logos)
decide; the event journal and the projection function are the protocol. The
conceptual ground is the doxa/logos distinction (`ankyra/docs/doxa_and_logos.tex`).

## Idea

In an ordinary agent, memory is a growing message tape. In Skein, memory is a
typed IR (a graph), and what the model sees is a deterministic projection of that
graph. The model does not "remember" — it sees a slice of state.

- **Doxa (the LLM)** enters the IR only when the engine admits it, as a node with
  `status = "open"`. Never immediately `verified`.
- **Logos** — the gate and arbiter verdicts (`record_check`, `actor` objective or
  user) plus state derivation (`fold` / `project`).
- **Protocol** — the append-only event journal, `fold`, `project`, status
  transitions.

## How it works

The IR is a hybrid graph with two namespaces in one:

- `work` — goal, claims, decisions, actions, observations, constraints;
- `artifact` — files, symbols, tests.

The event journal is append-only; state is `fold(events)`; the projection is a
pure function `project(state)`. Non-monotonicity of code is handled by
**staleness by version**: an artifact fact stores the file hash at read time; a
mutation deterministically marks facts about the old version `stale`, with no
manual retraction.

Cycle (LangGraph.js):

```
START → project → propose → classify → execute → route
route ──continue──▶ project
route ──done | budget──▶ END
```

- `project` — a pure function of state; no LLM;
- `propose` — one structured reply `{ thought, action }` (zod);
- `classify` — deterministic checks (e.g. a constraint forbids an edit); a refusal
  is recorded as a `record_rejection` event and shown in `frontier.refusals`;
- `execute` — deterministically performs the action and appends events.

Actions: `read`, `grep`, `edit` (→ `mutate`), `run` (→ `check`/`record_check`),
`track` (propose a claim/decision/constraint), `query` (inspect nodes/edges/checks
by id/kind/status/edgesOf/verdictOf), `finish`.

## Code layout

```
src/
  ir/         types, zod events, fold (append-only), project (projection)
  config/     SKEIN_* settings (dotenv)
  llm/        provider client + zod schemas for proposals
  tools/      fsWorkspace and executeAction
  loop/       LangGraph: state, propose, classify, graph, runAgent
fixtures/bugfix/<id>/   mini tasks with a failing test (node --test)
tests/        IR golden tests, offline run, live gate
docs/         concept, overall plan, Tier 0 spec
```

## Install

Requires Node.js >= 22.

```bash
npm install
cp .env.example .env   # fill in SKEIN_API_KEY
```

## Commands

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest: offline + live gate (when SKEIN_LIVE=true)
npm run test:watch
```

The live agent run over the fixtures is enabled by `SKEIN_LIVE=true` (needs
`SKEIN_API_KEY`).

## Settings (`SKEIN_*`, `.env`)

| Variable | Default | Meaning |
|---|---|---|
| `SKEIN_API_URL` | `https://routerai.ru/api/v1` | OpenAI-compatible endpoint |
| `SKEIN_API_KEY` | — | key (only in `.env`) |
| `SKEIN_MODEL` | `~deepseek/deepseek-v4-flash-latest` | model |
| `SKEIN_TEMPERATURE` | `0.1` | temperature |
| `SKEIN_MAX_TOKENS` | `4096` | reply cap |
| `SKEIN_REASONING_EFFORT` | `none` | reasoning disabled |
| `SKEIN_MAX_TURNS` | `24` | turn budget |
| `SKEIN_LIVE` | `false` | live gate |

Reasoning is disabled by design (as in Ankyra): `thinking.type=disabled` and
`reasoning.effort=none`.

## Gate and invariants

The fixtures in `fixtures/bugfix/*` are mini packages with a failing test; the
goal is to make the test green without editing tests. The arbiter is objective:
the test runner.

Invariants:

- a claim never becomes `verified` without `check` provenance;
- a `stale` fact is never shown as active content;
- every node is addressable: shown in the context or retrievable via `query`;
- `project` is deterministic: same events → same `Context`;
- a constraint is never violated; the goal closes only when the arbiter passes.

## Status and documents

Tier 0 (bugfix by a failing test) is implemented.

- `docs/plans/implementation_plan.md` — overall plan, decisions, roadmap, status.
- `docs/plans/tier0_plan.md` — detailed Tier 0 spec.
- `docs/plans/tier1_plan.md` — Tier 1 scope and order of work (not started).
- `docs/plans/context_inspection_plan.md` — verified surfacing, inspection query,
  output spill.
- `docs/plans/check_soundness_plan.md` — a check carries a witness; a change
  invalidates it.
- `docs/plans/observation_plan.md` — observing changes outside the engine.
- `docs/plans/rejection_plan.md` — recording refused proposals.
- `docs/plans/index_budget_plan.md` — index as a bounded address space; turn
  budget in the header.
- `docs/plans/user_approval_plan.md` — a subjective arbiter records a user check.
- `docs/plans/staleness_scope_plan.md` — the witness lives once; transitivity by
  a workspace-wide snapshot.
- `docs/concepts.md` — conceptual overview.
- `docs/ir.md` — the IR: operations, state, and control.

## License

See `LICENSE`.
