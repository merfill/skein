import type { LanguageModel, ModelMessage } from "ai";

import { invokeTools } from "./structured";
import type { Settings } from "../config/settings";
import type { Proposals } from "./schemas";
import { bashParams, type ExtraToolDefinition } from "./tools";

export type GeneralProposer = (
  messages: ModelMessage[],
  options?: { signal?: AbortSignal; final?: boolean },
) => Promise<Proposals>;

export interface GeneralModelOptions {
  settings?: Settings;
}

// Tools that exist only in the general unit. They are bound through `extraTools`, so the task
// registry and the generated base prompt never see them. The unit closes on a text answer.
export const GENERAL_TOOLS: Record<string, ExtraToolDefinition> = {
  shell: {
    description:
      "Execute a read-only shell command from the workspace root and return its output. Prefer `read`, `grep` and `list`; use the shell when a dedicated tool cannot do the job. workdir runs it in a subdirectory. The command must not create, edit, delete, move, rename, install, or otherwise change anything. Large output is stored, and the tape shows a preview with an id for `recall`.",
    schema: bashParams,
  },
};

// The general unit reads material; these descriptions steer it to the narrow tools and keep the
// stored-result tools for truncated output instead of inviting another pass over what is in view.
const GENERAL_TOOL_DESCRIPTIONS: Record<string, string> = {
  read:
    "Read a file from the workspace (filePath). Prefer one larger read over many small slices, and use `grep` to find specific content in large files. `offset` is the 1-indexed line to start from and `limit` is the number of lines; a large file reports `[lines X-Y of Z; continue from Y+1]`. Re-reading the same unchanged window is refused.",
  recall:
    "Read the stored body of a result whose tape preview was truncated, by its id. Use it for the part that was cut off; a windowed recall pages the body.",
};

export function modelGeneralProposer(
  model: LanguageModel,
  options: GeneralModelOptions = {},
): GeneralProposer {
  return (messages, callOptions) =>
    invokeTools(model, messages, {
      ...(options.settings !== undefined ? { settings: options.settings } : {}),
      allowedTools:
        callOptions?.final === true
          ? []
          : ["read", "grep", "list", "recall", "shell"],
      toolDescriptions: GENERAL_TOOL_DESCRIPTIONS,
      extraTools: GENERAL_TOOLS,
      allowText: true,
      ...(callOptions?.signal !== undefined ? { signal: callOptions.signal } : {}),
    });
}
