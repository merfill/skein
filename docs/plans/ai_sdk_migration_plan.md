# Migrating the model layer to the Vercel AI SDK (option A)

> Russian mirror — `docs/plans/ai_sdk_migration_plan_ru.md`.
>
> Status: proposed; no code yet. Scope: the **model layer only**. The IR, the tape, the loop,
> the tools and LangGraph stay.

## 1. Why

opencode uses the **Vercel AI SDK** (`ai` v6, `@ai-sdk/openai-compatible`, `@ai-sdk/google`,
`@ai-sdk/mistral`; even its OpenAI-compatible package is patched). We use
`@langchain/core` + `@langchain/langgraph` + `@langchain/openai`, plus a bespoke provider adapter
(`src/llm/provider.ts`) and an SSE/fetch transport (`src/llm/client.ts`) written to survive
RouterAI: `reasoning`/`reasoning_content`, empty reasoning fields, `tool_choice` routing,
streaming, retries.

The bespoke layer is the source of most provider friction. The AI SDK owns the same concerns
(messages, tool calls, streaming, reasoning parts, provider options) and is the path opencode
already exercises against the same gateway.

## 2. Scope

**In:**

- model creation and the provider configuration (`src/llm/client.ts`);
- message construction for the provider (`src/loop/propose.ts`, `buildMessages`);
- tool binding and the native tool-call round trip (`src/llm/tools.ts`,
  `src/llm/structured.ts`);
- streaming and usage/reasoning extraction (`src/llm/client.ts`, `src/llm/structured.ts`);
- settings mapping (`SKEIN_STREAMING`, `SKEIN_REASONING_TAPE`, reasoning effort);
- tests and the live A/B.

**Out:**

- removing LangGraph, the IR, `project`, `executeAction`, the tool implementations;
- changing state semantics, the tape format or the criteria;
- UI streaming/abort (still deferred);
- adding other providers.

## 3. The seam we already have

`Proposer` in `src/loop/propose.ts` is the boundary:

```ts
type Proposer = (context: Context) => Promise<Proposals>;
```

LangGraph calls `propose(context)`; it does not care which SDK produced the proposals. So the
migration is contained if we keep the `Proposer` contract and change only what is behind it.
`buildMessages` is the other boundary: it turns the neutral `TapeMessage[]` into the SDK's
message array. `bench/turn.ts`, `bench/rollout.ts` and the tests use it.

## 4. Target layout

### 4.1 Provider (`src/llm/client.ts`)

- Replace `ChatOpenAI` with `createOpenAICompatible` (or `createOpenAI`) from
  `@ai-sdk/openai-compatible`; the model is an AI SDK `LanguageModelV2`.
- Keep the stable settings surface: `SKEIN_API_URL`, `SKEIN_API_KEY`, `SKEIN_MODEL`,
  `SKEIN_MAX_TOKENS`, `SKEIN_TEMPERATURE`, `SKEIN_REASONING_EFFORT`.
- Keep a custom `fetch` only if the gateway needs it (headers, proxy policy, telemetry taps).
  Do not carry the old SSE parser: the SDK owns the stream.
- `SKEIN_STREAMING`: `streamText` vs `generateText`.

### 4.2 Messages (`src/loop/propose.ts`)

- `buildMessages` returns AI SDK `ModelMessage[]` (`system` / `user` / `assistant` / `tool`).
- `toMessage` maps the tape:
  - assistant text → an assistant message;
  - assistant tool calls → assistant content parts with `tool-call`;
  - tool result → `tool-result` with the same `toolCallId`;
  - transitions stay a `user` turn (the prefill workaround is provider-independent).
- `promptText` renders the same messages for benchmarks.

### 4.3 Tools and proposals (`src/llm/tools.ts`, `src/llm/structured.ts`)

- The zod schemas remain the single source. Build AI SDK tools with
  `tool({ description, inputSchema: schema })` from the existing `DEFINITIONS`.
- Keep `toolNamesFor` / the per-island surface unchanged.
- `invokeTools` becomes `generateText`/`streamText` with `tools`, `stopWhen`/`stepCountIs`,
  and the chosen `toolChoice` policy (we still do **not** force `required`).
- Map `tool-call` / `tool-result` / `reasoning` / usage parts back into `Proposals`:
  `actions`, `thought`, `reasoning`.
- Preserve the current repair behaviour: a text-only or malformed call gets one repair attempt;
  a completion cut by the cap is mapped from the SDK `finishReason`.

### 4.4 Provider quirks (`src/llm/provider.ts`)

- Delete the LangChain adapter.
- If RouterAI still needs `reasoning_content` renamed / an empty field echoed, express it as
  AI SDK `providerOptions` or a small `fetch` middleware. Measure first; do not re-create the
  adapter by default.
- The known routing effects (`tool_choice` → thinking upstreams, cross-subcontractor reasoning
  mismatch) stay documented and get one fallback, not a prompt hack.

## 5. Work breakdown

1. **Spike (half day).** A single script against RouterAI: `generateText` and `streamText` with
   one tool, read `reasoning`, `tool-call`, `usage`. Confirm the gateway works without the
   LangChain adapter.
2. **Messages (half day).** `buildMessages` → AI SDK messages; keep the tape tests, update
   `tests/wire.ts` / `tests/prompt.test.ts` expectations.
3. **Tools (half day).** `invokeTools` on AI SDK tools; map proposals; keep the schema/tool
   surface; unit tests.
4. **Provider (half day).** `client.ts` on `@ai-sdk/openai-compatible`; settings; streaming
   toggle; remove dead adapter code.
5. **Tests + live A/B (half day).** Offline suite; then the same recorded seeds, K≥3, streaming
   on/off, comparing actions, reasoning, cost, `llm_error`.
6. **Cleanup.** Remove `@langchain/openai` from the model path; keep `@langchain/core` only if
   LangGraph still needs it; update docs and the plan status.

Total: **1–2 days**, dominated by the live A/B, not by the code.

## 6. Acceptance criteria

- Typecheck and the offline suite pass; the wire/message/tool tests assert AI SDK shapes.
- `fix-ocaml-gc` live, K≥3, same seeds: no transport `llm_error`; tool calls and reasoning on
  the tape; cost not worse than the current streaming-off arm.
- `SKEIN_STREAMING=false` and `SKEIN_STREAMING=true` both work.
- `SKEIN_REASONING_TAPE=false` still removes reasoning from the tape.
- The `Proposer`/`Proposals` boundary is unchanged; LangGraph, `project`, `executeAction` and
  the state semantics are untouched.
- No prompt change is needed to compensate for the SDK.

## 7. Risks

- **RouterAI quirks remain.** opencode patching `@ai-sdk/openai-compatible` is evidence that
  the gateway is not a clean OpenAI. Keep the fallback for `reasoning_content`; do not assume
  the SDK fixes routing.
- **AI SDK v6 API surface.** Message roles, tool-call parts, `finishReason`, usage fields and
  `stopWhen` may differ from the LangChain model. Pin the version; isolate the mapping in one
  file.
- **Tool repair.** Our one-repair/truncation logic must be mapped explicitly; the SDK does not
  repair a text answer for us.
- **Streaming.** `streamText` full-stream assembly must preserve reasoning, tool calls and
  usage; do not regress the idle-timeout behaviour.
- **Tests.** LangChain message types leak into `tests/wire.ts`, `tests/prompt.test.ts` and the
  benches; update them in the same change.

## 8. Rollback

Work on a branch; while migrating, keep the old `Proposer` implementation behind a temporary
`SKEIN_PROVIDER=langchain|ai-sdk` switch (or a separate module selected in `client.ts`). Remove
the switch only after the live A/B. The IR and the container harness are untouched, so a
rollback is a revert of the model-layer commit.

## 9. Out of scope / later

- Removing LangGraph and the LangChain core dependency (option B; 3–5 days).
- UI streaming/abort.
- A second provider family.
