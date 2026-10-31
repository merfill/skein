import type { LanguageModel, ModelMessage } from "ai";

import { invokeTools } from "./structured";
import type { Settings } from "../config/settings";
import type { Proposals } from "./schemas";

export type GeneralProposer = (
  messages: ModelMessage[],
  options?: { signal?: AbortSignal },
) => Promise<Proposals>;

export interface GeneralModelOptions {
  settings?: Settings;
}

export function modelGeneralProposer(
  model: LanguageModel,
  options: GeneralModelOptions = {},
): GeneralProposer {
  return (messages, callOptions) =>
    invokeTools(model, messages, {
      ...(options.settings !== undefined ? { settings: options.settings } : {}),
      allowedTools: ["read", "grep", "list", "stop"],
      toolDescriptions: {
        stop: "Close the general task with the final answer in `why`. Use it only when the answer is complete and supported by what you read.",
      },
      ...(callOptions?.signal !== undefined ? { signal: callOptions.signal } : {}),
    });
}
