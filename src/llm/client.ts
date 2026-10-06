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

export function createChatModel(settings: Settings = loadSettings()): ChatOpenAI {
  return new ChatOpenAI({
    apiKey: settings.apiKey,
    model: settings.model,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    configuration: { baseURL: settings.apiUrl },
    modelKwargs: reasoningBody(settings.reasoningEffort),
  });
}
