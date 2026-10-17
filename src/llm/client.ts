import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

import { loadSettings, type Settings } from "../config/settings";

// The OpenAI-compatible provider name. It is also the key `providerOptions` uses to add
// fields to the request body (`src/llm/structured.ts`).
export const PROVIDER_NAME = "routerai";

/**
 * Provider body that turns reasoning off. DeepSeek needs `thinking.type` and
 * RouterAI needs a zero reasoning budget; both are mirrored from Ankyra.
 */
export function reasoningOffBody(effort: string): Record<string, unknown> {
  return {
    thinking: { type: "disabled" },
    reasoning: { effort },
  };
}

/**
 * Provider body for the reasoning budget. With `effort === "none"` reasoning is
 * explicitly disabled; otherwise RouterAI's `reasoning.effort` enables it (the
 * DeepSeek native `thinking.type` is left unset so the provider decides). A hard
 * coding task driven without reasoning fails far more often (see the focus/OCaml
 * fix investigation), so reasoning is the default.
 */
export function reasoningBody(effort: string): Record<string, unknown> {
  return effort === "none" ? reasoningOffBody(effort) : { reasoning: { effort } };
}

// RouterAI's wire body: the reasoning budget, plus two normalizations that keep the
// assistant tool-turn shape LangChain used to produce. AI SDK emits `content: null` and
// omits an empty `reasoning_content`; some subcontractors behind the meta-provider demand
// both fields on every assistant tool turn in thinking mode ("must be passed back to the
// API"). The reasoning itself already rides as an AI SDK `reasoning` part and is serialized
// by the provider; this only fills the absent/empty cases.
export function transformBody(
  body: Record<string, unknown>,
  effort: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body, ...reasoningBody(effort) };
  const messages = out.messages;
  if (!Array.isArray(messages)) return out;
  for (const raw of messages) {
    if (typeof raw !== "object" || raw === null) continue;
    const message = raw as Record<string, unknown>;
    if (message.role !== "assistant") continue;
    const calls = message.tool_calls;
    if (!Array.isArray(calls) || calls.length === 0) continue;
    if (message.content === null || message.content === undefined) message.content = "";
    if (typeof message.reasoning_content !== "string") message.reasoning_content = "";
  }
  return out;
}

// The provider the doxa is called through. `includeUsage` asks the stream to carry usage;
// reasoning arrives as an AI SDK `reasoning` part (both `reasoning` and `reasoning_content`
// are read by `@ai-sdk/openai-compatible`). Temperature/token caps are per call
// (`src/llm/structured.ts`), not model properties.
export function createChatModel(settings: Settings = loadSettings()): LanguageModel {
  const provider = createOpenAICompatible({
    name: PROVIDER_NAME,
    baseURL: settings.apiUrl,
    apiKey: settings.apiKey,
    includeUsage: true,
    transformRequestBody: (body) => transformBody(body, settings.reasoningEffort),
  });
  return provider(settings.model);
}
