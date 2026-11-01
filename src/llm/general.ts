import type { LanguageModel, ModelMessage } from "ai";
import { z } from "zod";

import { invokeTools } from "./structured";
import type { Settings } from "../config/settings";
import type { Proposals } from "./schemas";
import { bashParams, type ExtraToolDefinition } from "./tools";

export type GeneralProposer = (
  messages: ModelMessage[],
  options?: { signal?: AbortSignal },
) => Promise<Proposals>;

export interface GeneralModelOptions {
  settings?: Settings;
}

const generalStopParams = z.object({ report: z.string() });

// Tools that exist only in the general unit. They are bound through `extraTools`, so the task
// registry and the generated base prompt never see them.
export const GENERAL_TOOLS: Record<string, ExtraToolDefinition> = {
  general_bash: {
    description:
      "Use `read` for a file's contents; this tool is for listing, searching, and other inspection. Runs a read-only command from the workspace root; workdir runs it in a subdirectory. It must not create, edit, delete, move, rename, install, or otherwise change anything; if you are unsure whether a command changes something, do not run it. Returns exit status, stdout, and stderr; the displayed output is the tail, and the full result is stored and retrievable by id.",
    schema: bashParams,
  },
  general_stop: {
    description:
      "Call this when the evidence is minimally sufficient and the answer is ready. `report` is the final answer in GitHub-flavored Markdown, shown to the user as-is. Cover what the request asks and no more: state the answer first, then the evidence that supports it; use sections only when the answer has distinct parts; omit process narration. Do not call it to acknowledge progress, ask a question, or before the answer is complete.",
    schema: generalStopParams,
  },
};

export function modelGeneralProposer(
  model: LanguageModel,
  options: GeneralModelOptions = {},
): GeneralProposer {
  return (messages, callOptions) =>
    invokeTools(model, messages, {
      ...(options.settings !== undefined ? { settings: options.settings } : {}),
      allowedTools: ["read", "recall", "general_bash", "general_stop"],
      extraTools: GENERAL_TOOLS,
      ...(callOptions?.signal !== undefined ? { signal: callOptions.signal } : {}),
    });
}
