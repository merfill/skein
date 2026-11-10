import {
  InvalidToolInputError,
  NoSuchToolError,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { z, ZodError } from "zod";

import { isAborted } from "../abort";
import { loadSettings, type Settings } from "../config/settings";
import type {
  DocumentPlanAgent,
  DocumentPlanCall,
  DocumentPlanReply,
  DocumentTextAgent,
} from "../session/document";
import { usageOf } from "../session/telemetry";
import { GENERAL_TOOLS } from "./general";
import { callModel } from "./structured";
import { proposalTools, type ExtraToolDefinition } from "./tools";

// The document unit's outline: an ordered list of sections, each a self-contained brief for
// the section writer. `path` is the one file the unit produces.
const outlineItemSchema = z.object({
  title: z.string().min(1).max(200),
  brief: z.string().min(1).max(4000),
});

const submitPlanSchema = z.object({
  path: z.string().min(1).max(1000),
  items: z.array(outlineItemSchema).min(1).max(40),
});

// The outline tool is terminal and not an IR `Action`: the document loop records the plan
// and drives the section turns itself.
export const DOCUMENT_TOOLS: Record<string, ExtraToolDefinition> = {
  ...GENERAL_TOOLS,
  submit_plan: {
    description:
      "Submit the section plan for the document. Call it exactly once, after you have read enough. `path` is the file to write; `items` is an ordered list of sections, each a short `title` and a self-contained `brief` with the facts, quotes or file:line references that section must use. Do not write the document here.",
    schema: submitPlanSchema,
  },
};

const DOCUMENT_TOOL_NAMES = ["read", "grep", "list", "recall", "search", "shell", "submit_plan"];

function toolsFor(names: readonly string[]): ToolSet {
  return proposalTools(new Set(names), undefined, DOCUMENT_TOOLS);
}

function tools(): ToolSet {
  return toolsFor(DOCUMENT_TOOL_NAMES);
}

function toCalls(
  calls: readonly { toolName: string; input: unknown; toolCallId: string }[],
): DocumentPlanCall[] {
  return calls.map((call) => ({
    name: call.toolName,
    args: (call.input as Record<string, unknown> | undefined) ?? {},
    callId: call.toolCallId,
  }));
}

export interface DocumentModelOptions {
  settings?: Settings;
  // Rebuild the model with reasoning disabled. An outline interrupted by the completion cap
  // is retried with reasoning off (the budget was spent thinking), not with a larger cap.
  rebuild?: (options?: { reasoningOff?: boolean }) => LanguageModel;
}

export function modelDocumentPlanAgent(
  model: LanguageModel,
  options: DocumentModelOptions = {},
): DocumentPlanAgent {
  return async (messages: ModelMessage[], callOptions = {}) => {
    const settings = options.settings ?? loadSettings();
    const final = callOptions.final === true;
    let repair: ModelMessage | undefined;
    let reasoningOff = false;
    for (;;) {
      const base =
        reasoningOff && options.rebuild !== undefined
          ? options.rebuild({ reasoningOff: true })
          : model;
      try {
        const result = await callModel({
          model: base,
          messages: repair === undefined ? messages : [...messages, repair],
          settings,
          tools: final ? toolsFor(["submit_plan"]) : tools(),
          streaming: settings.streaming,
          ...(callOptions.signal !== undefined ? { abortSignal: callOptions.signal } : {}),
        });
        const calls = toCalls(result.toolCalls);
        if (result.finishReason === "length" && !reasoningOff && options.rebuild !== undefined) {
          reasoningOff = true;
          repair = {
            role: "user",
            content: final
              ? "Your reply hit the output limit. Do not reason; call `submit_plan` now with a concise outline: the path and the ordered sections."
              : "Your reply hit the output limit. Do not reason; inspect less and call `submit_plan` with a concise outline.",
          };
          continue;
        }
        if (calls.length === 0 && repair === undefined) {
          repair = {
            role: "user",
            content: final
              ? "Call `submit_plan` now with the completed outline; do not inspect anything else."
              : "Use a read-only tool to inspect the workspace, or call `submit_plan` when the outline is ready.",
          };
          continue;
        }
        const reply: DocumentPlanReply = {
          calls,
          thought: result.text,
          ...(result.reasoning !== undefined && result.reasoning !== ""
            ? { reasoning: result.reasoning }
            : {}),
          ...(usageOf(result.usage) !== undefined ? { usage: usageOf(result.usage) } : {}),
          model: settings.model,
        };
        return reply;
      } catch (error) {
        if (isAborted(callOptions.signal)) throw error;
        if (
          (NoSuchToolError.isInstance(error) ||
            InvalidToolInputError.isInstance(error) ||
            error instanceof ZodError) &&
          repair === undefined
        ) {
          repair = {
            role: "user",
            content:
              "Your tool call was invalid. Call a read-only tool or `submit_plan` with arguments matching its schema.",
          };
          continue;
        }
        throw error;
      }
    }
  };
}

// A section (or the final summary) is plain text, not a tool call: the executor owns the file
// and appends what the model returns. A reply cut by the output cap is retried once with
// reasoning disabled; if it is still cut, the caller continues the same section.
export function modelDocumentTextAgent(
  model: LanguageModel,
  options: DocumentModelOptions = {},
): DocumentTextAgent {
  return async (messages: ModelMessage[], callOptions = {}) => {
    const settings = options.settings ?? loadSettings();
    let reasoningOff = false;
    for (;;) {
      const base =
        reasoningOff && options.rebuild !== undefined
          ? options.rebuild({ reasoningOff: true })
          : model;
      const result = await callModel({
        model: base,
        messages,
        settings,
        streaming: settings.streaming,
        ...(callOptions.signal !== undefined ? { abortSignal: callOptions.signal } : {}),
      });
      if (result.finishReason === "length" && !reasoningOff && options.rebuild !== undefined) {
        reasoningOff = true;
        continue;
      }
      return {
        text: result.text,
        finishReason: result.finishReason,
        ...(result.reasoning !== undefined && result.reasoning !== ""
          ? { reasoning: result.reasoning }
          : {}),
        ...(usageOf(result.usage) !== undefined ? { usage: usageOf(result.usage) } : {}),
        model: settings.model,
      };
    }
  };
}
