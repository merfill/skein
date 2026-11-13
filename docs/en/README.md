# Skein — documentation (English)

Russian: [../ru/README.md](../ru/README.md).

## What Skein is

- [concepts.md](concepts.md) — the conceptual overview: the non-monotone context, the agents,
  states and transitions.
- [walkthrough.md](walkthrough.md) — the end-to-end example: states and the dynamic tape across
  execution contexts.

## The IR (the engine's source of truth)

- [ir.md](ir.md) — the conceptual model of the IR: the journal, states and transitions, records,
  the context projection and the invariants.
- [ir_operations.md](ir_operations.md) — the model surface, the operators, the detailed tool tables,
  refusals and the coverage registry (`OP-MV`, `OP-CG`, `OP-AP`, `TR`, `DER`, `REF`, ...).
  The coverage check reads this file; keep the ids in sync with the tests.
- [projection.md](projection.md) — the context projection: what the model sees each turn and why.
- [tools.md](tools.md) — the tool contract.

## The model surface

- [system_prompt.md](system_prompt.md) — the behavior blocks the system prompt is assembled from.
- [states.md](states.md) — the states' goals, completion conditions and routes.

## Sessions and controllability

- [sessions.md](sessions.md) — sessions, the container of units, the session, general, task,
  plan and document agents, the observer, the outline and isolation.

## Providers

- [providers.md](providers.md) — the OpenAI-compatible catalog, `auth login`/`models`/`doctor`,
  config/auth files, precedence, free and local options.

## Testing

- [testing.md](testing.md) — how to run tests, benches and real tasks (the sandbox, the
  step-by-step `bench/live-step.ts` driver, `bench/turn.ts`) and where the output lands.

## Handoff (Russian)

- [../ru/handoff.md](../ru/handoff.md) — the working handoff log.
