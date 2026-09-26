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

export function createChatModel(settings: Settings = loadSettings()): ChatOpenAI {
  return new ChatOpenAI({
    apiKey: settings.apiKey,
    model: settings.model,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    configuration: { baseURL: settings.apiUrl },
    modelKwargs: reasoningOffBody(settings.reasoningEffort),
  });
}
