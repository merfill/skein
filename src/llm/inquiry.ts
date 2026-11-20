import type { LanguageModel, ModelMessage } from "ai";
import { z } from "zod";

import { invokeTools } from "./structured";
import type { Settings } from "../config/settings";
import type { Proposals } from "./schemas";
import type { ExtraToolDefinition } from "./tools";

export type InquiryProposer = (
  messages: ModelMessage[],
  options?: {
    signal?: AbortSignal;
    allowedTools?: readonly string[];
    toolDescriptions?: Record<string, string>;
    // The unit turn this proposal belongs to (a repair is the same turn). Drivers use it to
    // label the exact request; the proposer itself ignores it.
    turn?: number;
  },
) => Promise<Proposals>;

export interface InquiryModelOptions {
  settings?: Settings;
}

const hypothesisIdPattern = /^H\d+(?:\.\d+)*$/;

const hypothesisOpenParams = z.object({
  label: z.string().min(1),
  claim: z.string().min(1),
  done: z.string().min(1),
  follows_from: z.array(z.string().regex(hypothesisIdPattern)),
});

const hypothesisCloseParams = z.object({
  verdict: z.enum(["confirmed", "refuted", "dropped"]),
  observed: z.string().min(1),
  summary: z.string().min(1),
});

export type HypothesisClose = z.infer<typeof hypothesisCloseParams>;

// The close reply is a text-only JSON object, so the model can stop without calling a tool.
export const CLOSE_JSON_FORMAT =
  '{"verdict":"confirmed|refuted|dropped","observed":"what is now true: the files changed and how, the checks run and their result","summary":"what was done, the checks that show it, and why the verdict is justified"}';

// With no open hypothesis the work ends by a text reply too, so finishing is not a tool choice.
export const GOAL_CLOSE_JSON_FORMAT =
  '{"outcome":"achieved|not_achieved","summary":"the final report: what was done, the evidence, and the hypotheses that led to the result"}';

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? fenced.slice(start, end + 1) : fenced;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

export function parseCloseJson(text: string): HypothesisClose | undefined {
  const parsed = parseJsonObject(text);
  if (parsed === undefined) return undefined;
  const result = hypothesisCloseParams.safeParse(parsed);
  return result.success ? result.data : undefined;
}

const goalCloseParams = z.object({
  outcome: z.enum(["achieved", "not_achieved"]),
  summary: z.string().min(1),
  follows_from: z.array(z.string().regex(hypothesisIdPattern)),
});

const goalTextCloseParams = z.object({
  outcome: z.enum(["achieved", "not_achieved"]),
  summary: z.string().min(1),
});

export type GoalClose = z.infer<typeof goalTextCloseParams>;

export function parseGoalCloseJson(text: string): GoalClose | undefined {
  const parsed = parseJsonObject(text);
  if (parsed === undefined) return undefined;
  const result = goalTextCloseParams.safeParse(parsed);
  return result.success ? result.data : undefined;
}

// The close tool is bound with the open hypothesis's id, so the description names the hypothesis
// it closes at the decision point.
export function closeHypothesisDescription(hypothesisId: string): string {
  return [
    `Closes hypothesis ${hypothesisId}. A hypothesis is completed when the claim it was opened with is decided: confirmed if it holds, refuted if it does not, dropped if you abandon it. That claim is the criterion for closing, not the request; work beyond it belongs to another hypothesis.`,
    "Arguments:",
    "- verdict: \"confirmed\" (it worked), \"refuted\" (it did not), or \"dropped\" (abandoned). Choose the word that fits what you actually observed.",
    "- observed: the state the work leaves behind — what is now true: the files mutated and what changed in them, the checks run and their result.",
    "- summary: a detailed, human-readable account of the work: what was done, the checks that show it, and why the verdict is justified.",
    "",
    "This tool must be the only call in the reply.",
  ].join("\n");
}

// Tools that exist only in the inquiry unit. They are bound through `extraTools`, so the task
// registry and the generated base prompt never see them.
export const INQUIRY_TOOLS: Record<string, ExtraToolDefinition> = {
  open_hypothesis: {
    description: [
      "Opens a hypothesis. Arguments:",
      "- label: a short human-readable name for this hypothesis (2-4 words) that distinguishes it in the task list; it names the claim and is not an id — never \"H1\", \"C1\" or a number.",
      "- claim: the next claim to establish, not the whole request; a single short, high-level declarative statement.",
      "- done: the check that decides the claim — the observation or command result that would confirm or refute it.",
      "- follows_from: the ids of earlier hypotheses this claim follows from (e.g. H1, H1.1); [] if none.",
      "Write both as general statements about the work, not as first-person actions or plans.",
      "Open one claim at a time: one claim, one goal. If the work needs several claims, split it into sub-hypotheses and open one per reply.",
      "",
      "Call this tool exactly once in a reply. It must be the only call: no other tool call and no second open_hypothesis.",
    ].join("\n"),
    schema: hypothesisOpenParams,
  },
  close_hypothesis: {
    description: [
      "Closes the open hypothesis. Arguments:",
      "- verdict: \"confirmed\" (it worked), \"refuted\" (it did not), or \"dropped\" (abandoned). Choose the word that fits what you actually observed.",
      "- observed: the state the work leaves behind — what is now true: the files mutated and what changed in them, the checks run and their result.",
      "- summary: a detailed, human-readable account of the work: what was done, the checks that show it, and why the verdict is justified.",
      "",
      "Call this tool exactly once in a reply; it must be the only call.",
    ].join("\n"),
    schema: hypothesisCloseParams,
  },
  close_goal: {
    description: [
      "Closes the goal with the final result. Choose it when you consider the original goal achieved, or when all hypotheses are worked out and no new claim is needed.",
      "Arguments:",
      "- outcome: \"achieved\" (the request's result is reached) or \"not_achieved\" (it is not; say what blocked it).",
      "- summary: the final answer to the user: what was done, the evidence, and the result.",
      "- follows_from: the ids of the earlier hypotheses the result rests on (e.g. H1, H2); [] only if none.",
      "Call this tool exactly once in a reply; it must be the only call and it ends the work.",
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
];

// `close_goal` stays in `INQUIRY_TOOLS` for direct calls and old journals, but it is never part
// of the surface: the work ends by a text reply, not by choosing a tool.
export const INQUIRY_TOOL_NAMES: readonly string[] = [
  ...INQUIRY_WORK_TOOL_NAMES,
  "open_hypothesis",
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
      ...(callOptions?.toolDescriptions !== undefined
        ? { toolDescriptions: callOptions.toolDescriptions }
        : {}),
    });
}
