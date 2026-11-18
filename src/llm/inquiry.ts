import type { LanguageModel, ModelMessage } from "ai";
import { z } from "zod";

import { invokeTools } from "./structured";
import type { Settings } from "../config/settings";
import type { Proposals } from "./schemas";
import type { ExtraToolDefinition } from "./tools";

export type InquiryProposer = (
  messages: ModelMessage[],
  options?: { signal?: AbortSignal; allowedTools?: readonly string[] },
) => Promise<Proposals>;

export interface InquiryModelOptions {
  settings?: Settings;
}

const hypothesisOpenParams = z.object({
  label: z.string().min(1),
  suppose: z.string().min(1),
  if_true: z.string().min(1),
  if_false: z.string().min(1),
  follows_from: z.array(z.string()),
});

const hypothesisCloseParams = z.object({
  hypothesis_id: z.string().min(1),
  verdict: z.enum(["confirmed", "refuted", "dropped"]),
  summary: z.string().min(1),
});

const goalCloseParams = z.object({
  outcome: z.enum(["achieved", "not_achieved"]),
  summary: z.string().min(1),
});

// Tools that exist only in the inquiry unit. They are bound through `extraTools`, so the task
// registry and the generated base prompt never see them.
export const INQUIRY_TOOLS: Record<string, ExtraToolDefinition> = {
  open_hypothesis: {
    description: [
      "Opens a hypothesis under the active hypothesis, or under H when none is open. Arguments:",
      "- label: a short name.",
      "- suppose: what you put forward.",
      "- if_true: the observation that confirms it.",
      "- if_false: the observation that refutes it.",
      "- follows_from: required. The ids of the earlier hypotheses this step follows from. Use [] only when there is no earlier hypothesis to depend on.",
      "",
      "The engine keeps the main formula H: the conjunction of the hypotheses you open. H is not a hypothesis and you do not write its conjunction. A hypothesis is either a work leaf or a formula, fixed by its first child: an action makes it a work leaf, a sub-hypothesis makes it a formula. Do not mix the two under one hypothesis. A hypothesis with no child cannot be closed.",
      "Call this alone, with no other tool calls in the same reply.",
      "The engine records the hypothesis and shows it on the tape as:",
      "Opening hypothesis C1: <label>.",
      "Suppose: ...",
      "If true: ...",
      "If false: ...",
      "Follows from: C1.2, C3",
      "Use the C-number (e.g. \"C1\") when you close the hypothesis. The internal journal address (`w:hypothesis:<n>`) is not a hypothesis id.",
    ].join("\n"),
    schema: hypothesisOpenParams,
  },
  close_hypothesis: {
    description: [
      "Closes the active hypothesis and only it. Arguments:",
      "- hypothesis_id: the id you got when you opened the hypothesis, e.g. \"C1\" or \"C1.2\". Use it exactly; never the internal journal address (`w:hypothesis:<n>`) or a bare number.",
      "- verdict: \"confirmed\" (the claim held), \"refuted\" (it did not), or \"dropped\" (abandoned). Choose the word that fits the claim; the request's result is the goal's outcome, not a hypothesis verdict.",
      "- summary: a detailed, human-readable account of what was done and achieved: the concrete result (commit, branch, files, answer), the checks that show it, and why the verdict holds. Write 2-4 sentences, not a bare word. It is this hypothesis's outcome, not the final answer; the final answer is written when you close the goal. For \"dropped\", say why.",
      "",
      "A work leaf closes after its actions; a formula closes after all its sub-hypotheses are closed (its verdict synthesizes them). A hypothesis with no child cannot be closed. A refuted hypothesis stays in the journal as a failed attempt; open a corrected or different one if you can. Build on a closed hypothesis's summary instead of re-deriving it.",
      "Call this alone, with no other tool calls in the same reply.",
      "The engine shows the close as: Closing hypothesis C1: confirmed. Summary: ...",
    ].join("\n"),
    schema: hypothesisCloseParams,
  },
  close_goal: {
    description: [
      "Closes the goal H with the final result. Arguments:",
      "- outcome: \"achieved\" (the request's result is reached) or \"not_achieved\" (it is not; say what blocked it).",
      "- summary: the final answer to the user, derived from the whole tape: what was done, the evidence, and the result.",
      "Call this alone; it is the only call in that reply, and it ends the work.",
    ].join("\n"),
    schema: goalCloseParams,
  },
};

// The tools available while a hypothesis is open: the workspace surface plus `close_hypothesis`.
// The run passes one of these lists explicitly per turn, so the surface follows the phase:
// `open` → open_hypothesis only; `work` → this list; `finish` → close_goal only.
export const INQUIRY_WORK_TOOL_NAMES: readonly string[] = [
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
  "close_hypothesis",
];

export const INQUIRY_TOOL_NAMES: readonly string[] = [
  ...INQUIRY_WORK_TOOL_NAMES,
  "open_hypothesis",
  "close_goal",
];

export function modelInquiryProposer(
  model: LanguageModel,
  options: InquiryModelOptions = {},
): InquiryProposer {
  return (messages, callOptions) =>
    invokeTools(model, messages, {
      ...(options.settings !== undefined ? { settings: options.settings } : {}),
      allowedTools: callOptions?.allowedTools !== undefined
        ? [...callOptions.allowedTools]
        : [...INQUIRY_TOOL_NAMES],
      extraTools: INQUIRY_TOOLS,
      allowText: true,
      ...(callOptions?.signal !== undefined ? { signal: callOptions.signal } : {}),
    });
}
