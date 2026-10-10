import { ChatOpenAI } from "@langchain/openai";

import { loadSettings, type Settings } from "../config/settings";

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

export interface ChatModelHooks {
  // The raw provider response body of every (non-streaming) call: telemetry that the parsed
  // LangChain message drops, such as the hidden reasoning text in `choices[0].message.reasoning`.
  onResponseBody?: (body: unknown) => void;
}

export function createChatModel(settings: Settings = loadSettings(), hooks: ChatModelHooks = {}): ChatOpenAI {
  const configuration: { baseURL: string; fetch?: typeof fetch } = { baseURL: settings.apiUrl };
  if (hooks.onResponseBody !== undefined) {
    const onResponseBody = hooks.onResponseBody;
    configuration.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const response = await fetch(input, init);
      void response
        .clone()
        .json()
        .then(onResponseBody)
        .catch(() => undefined);
      return response;
    }) as typeof fetch;
  }
  return new ChatOpenAI({
    apiKey: settings.apiKey,
    model: settings.model,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    configuration,
    modelKwargs: reasoningBody(settings.reasoningEffort),
  });
}
