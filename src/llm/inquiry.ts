import type { LanguageModel, ModelMessage } from "ai";
import { z } from "zod";

import { invokeTools } from "./structured";
import type { Settings } from "../config/settings";
import type { Proposals } from "./schemas";
import type { ExtraToolDefinition } from "./tools";

export type InquiryProposer = (
  messages: ModelMessage[],
  options?: { signal?: AbortSignal; final?: boolean },
) => Promise<Proposals>;

export interface InquiryModelOptions {
  settings?: Settings;
}

const hypothesisOpenParams = z.object({
  kind: z.enum(["probe", "change"]),
  label: z.string(),
  suppose: z.string(),
  if_true: z.string(),
  if_false: z.string(),
});

const hypothesisCloseParams = z.object({
  id: z.string(),
  verdict: z.enum(["confirmed", "refuted", "done", "dropped"]),
  grounds: z.array(z.number().int().nonnegative()),
});

// Tools that exist only in the inquiry unit. They are bound through `extraTools`, so the task
// registry and the generated base prompt never see them.
export const INQUIRY_TOOLS: Record<string, ExtraToolDefinition> = {
  open_hypothesis: {
    description: [
      "Opens a hypothesis. Arguments:",
      "- kind: one of",
      '  - "change": the request asks for a result in the workspace (fix, merge, create); the result is the changed workspace.',
      '  - "probe": the request asks for an answer (find out what is true); the result is the answer.',
      "- label: a short name.",
      "- suppose: what you put forward.",
      "- if_true: the observation that confirms it.",
      "- if_false: the observation that refutes it.",
    ].join("\n"),
    schema: hypothesisOpenParams,
  },
  close_hypothesis: {
    description: [
      "Closes the active hypothesis and only it. Arguments:",
      "- id: the active hypothesis's id.",
      "- verdict: one of",
      '  - "confirmed", "refuted" or "dropped": for a probe.',
      '  - "done" or "dropped": for a change.',
      "- grounds: the numbers from the brackets of observations recorded after it opened (e.g. 42 for [obs:42]).",
      "A change is done when its observed effect holds.",
    ].join("\n"),
    schema: hypothesisCloseParams,
  },
};

// The inquiry surface: the workspace tools plus the two hypothesis tools. `allowedTools` is
// passed explicitly, so the task registry's per-state surface is unchanged.
export const INQUIRY_TOOL_NAMES: readonly string[] = [
  "read",
  "grep",
  "list",
  "edit",
  "write",
  "apply_patch",
  "bash",
  "webfetch",
  "recall",
  "search",
  "open_hypothesis",
  "close_hypothesis",
];

export function modelInquiryProposer(
  model: LanguageModel,
  options: InquiryModelOptions = {},
): InquiryProposer {
  return (messages, callOptions) =>
    invokeTools(model, messages, {
      ...(options.settings !== undefined ? { settings: options.settings } : {}),
      allowedTools:
        callOptions?.final === true ? [] : [...INQUIRY_TOOL_NAMES],
      extraTools: INQUIRY_TOOLS,
      allowText: true,
      ...(callOptions?.signal !== undefined ? { signal: callOptions.signal } : {}),
    });
}
