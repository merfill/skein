# Skein — documentation (English)

Russian: [../ru/README.md](../ru/README.md).

## What Skein is

- [concepts.md](concepts.md) — the conceptual overview: doxa/logos, the IR, the projection.
- [walkthrough.md](walkthrough.md) — the end-to-end example: states and the dynamic tape across
  execution contexts.

## The IR (the engine's source of truth)

- [ir.md](ir.md) — the source of truth for the IR: model, semantics, operators, derived facts,
  the coverage registry (`OP-MV`, `OP-CG`, `OP-AP`, `TR`, `DER`, `REF`, ...) and the as-built map.
  The coverage gate reads this file; keep the ids in sync with the tests.
- [projection.md](projection.md) — the context projection: what the model sees each turn and why.
- [tools.md](tools.md) — the tool contract.

## The model surface

- [system_prompt.md](system_prompt.md) — the behavior blocks the system prompt is assembled from.
- [states.md](states.md) — the states' goals, acceptance criteria and routes.

## Sessions and controllability

- [session_concepts.md](session_concepts.md) — sessions, the container of units, the session
  agent, its memory tools, the outline, task isolation, and the RequestObserver/triggers.

## Providers

- [providers.md](providers.md) — the OpenAI-compatible catalog, `auth login`/`models`/`doctor`,
  config/auth files, precedence, free and local options.

## Testing

- [testing.md](testing.md) — how to run tests, benches and real tasks (the sandbox, Harbor, the
  live-step driver, `bench/turn.ts`) and where the output lands.
- [state_testing.md](state_testing.md) — testing the state prompts step by step on a live task,
  including the `bench/live-step.ts` driver.

## Handoff (Russian)

- [../ru/handoff.md](../ru/handoff.md) — the working handoff log.
