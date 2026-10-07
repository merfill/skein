# Skein

A coding agent whose context is a **projection of an IR**, not a message tape.
The LLM (doxa) only proposes; a deterministic engine and the arbiter (logos)
decide; the event journal and the projection function are the protocol. The
conceptual ground is the doxa/logos distinction (`ankyra/docs/doxa_and_logos.tex`).

## Idea

In an ordinary agent, memory is a growing message tape. In Skein, memory is a
typed IR (a graph), and what the model sees is a deterministic projection of that
graph. The model does not "remember" — it sees a slice of state.

- **Doxa (the LLM)** proposes exactly one operator per turn (`create_goal` or
  `apply`; `query` is read-only addressing). A goal enters `open` and is never at
  once achieved.
- **Logos** — the gate (`classify`), the verdicts (`record_check`, `actor`
  objective or user), state derivation (`fold` / `project`), and the traversal that
  decides where the focus moves.
- **Arbiter** — the authority outside doxa and logos: the toolchain (objective) and
  the user (acceptance).

The tree unwinds the ReAct loop: `request → goal → plan → action →
observation/check`. With no alternatives it degenerates to a flat, addressable
list; the tree buys an explicit termination criterion, verifiable closure,
branching, and a bounded context.

## How it works

The IR is a hybrid graph with two namespaces in one:

- `work` — `request`, `goal`, `plan`, `alternatives`, `action`, `observation`,
  `check`, `constraint`;
- `artifact` — `file` (reserved `symbol`/`test` are not produced).

`done_when` has two kinds: `objective` (a literal command whose exit code settles
the goal) and `arbiter` (external acceptance by the user/arbiter). A goal is
settled only by its own check (`apply run { target }`) or by external acceptance —
doxa never closes a goal (there is no `complete`).

The event journal is append-only; state is `fold(events)`; the projection is a
pure function `project(state)`. Non-monotonicity of code is handled by
**staleness by version**: a read fact stores the file hash at read time; a
mutation deterministically makes facts about the old version stale, with no
manual retraction.

Cycle (LangGraph.js):

```
START → project → propose → classify → execute → progress
progress ──continue──▶ project
progress ──addressed | no_progress | budget──▶ END
```

- `project` — a pure function of state; no LLM;
- `propose` — one structured reply `{ thought, action }` (zod);
- `classify` — deterministic admissibility gates; a refusal is recorded as a
  `record_rejection` event and surfaces in `calls`;
- `execute` — deterministically performs the action and appends events.

Operators: `create_goal { what, why?, done_when, plan?, revises? }`; `apply
{ action }` with `read`/`grep`/`list`/`edit`/`write`/`fetch`/`apply_patch`/`run`,
where `run { target }` is a check and a bare `run` is an observation; `query`
(inspect nodes/edges by id/kind/predicate/edgesOf).

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
docs/         concepts, IR, semantics, plans
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
SKEIN_LIVE=false npx vitest run   # offline tests (.env sets SKEIN_LIVE=true)
npm test            # vitest: offline + live gate (when SKEIN_LIVE=true)
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
| `SKEIN_MAX_TOKENS` | `8192` | reply cap (shares the reasoning budget) |
| `SKEIN_REASONING_EFFORT` | `low` | reasoning effort |
| `SKEIN_MAX_TURNS` | `24` | turn budget |
| `SKEIN_LIVE` | `false` | live gate |

Reasoning is on by default at `low` effort; a hard task raises it per run via
`SKEIN_REASONING_EFFORT` or the adapter's `configurable.reasoningEffort`.

## Gate and invariants

The fixtures in `fixtures/bugfix/*` are mini packages with a failing test; the
goal is to make the test green without editing tests. The arbiter is objective:
the test runner.

Invariants:

- a goal never becomes `achieved` without `check` provenance;
- a `stale` fact is never shown as active content;
- every node is addressable: shown in the context or retrievable via `query`;
- `project` is deterministic: same events → same `Context`;
- a constraint is never violated; an objective goal is settled only by its own
  check, an arbiter goal only by external acceptance.

## Status and documents

The current model has two doxa operators and no `complete`; the tree, the
traversal stack, and verification by an explicit check are documented below.

- `docs/concepts.md` — conceptual overview (the tree, spine and arms, doxa/logos).
- `docs/ir.md` — the IR: operations, state, and control (as-built).
- `docs/ir_semantics.md` — the IR semantics (source of truth).
- `docs/plans/traversal_stack_spec.md` — the traversal stack (spine and arms).
- `docs/plans/step_reduction_plan.md` — step reduction and context format.
- `docs/plans/implementation_plan.md` — overall plan, decisions, roadmap, status.
- `docs/plans/tier0_plan.md` — detailed Tier 0 spec.
- `docs/plans/user_approval_plan.md` — an arbiter records a user check.

## License

See `LICENSE`.
