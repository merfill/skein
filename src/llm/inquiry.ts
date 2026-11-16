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

const claimOpenParams = z.object({
  kind: z.enum(["probe", "change"]),
  label: z.string(),
  suppose: z.string(),
  if_true: z.string(),
  if_false: z.string(),
});

const claimCloseParams = z.object({
  id: z.string(),
  verdict: z.enum(["confirmed", "refuted", "done", "dropped"]),
  grounds: z.array(z.string()),
});

// Tools that exist only in the inquiry unit. They are bound through `extraTools`, so the task
// registry and the generated base prompt never see them.
export const INQUIRY_TOOLS: Record<string, ExtraToolDefinition> = {
  open_hypothesis: {
    description:
      "Open a hypothesis before a side-effecting command or a file change. Give what you suppose, what you will see if right (if_true), and what you will see if wrong (if_false); both are required and specific. kind: probe (a claim to test) or change (an edit). Side-effecting: bash, webfetch (any open hypothesis). File change: write, edit, apply_patch (kind=change).",
    schema: claimOpenParams,
  },
  close_hypothesis: {
    description:
      "Close the active hypothesis with a verdict and grounds: the ids shown in brackets from results recorded after it opened. Verdicts: probe — confirmed, refuted, dropped; change — done, dropped. A change is done when the effect you need is observed; whether the request is satisfied is a separate check. dropped means abandoned, not resolved.",
    schema: claimCloseParams,
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
