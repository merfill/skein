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
import type { PlannerAgent, PlannerCall, PlannerReply } from "../session/planner";
import { usageOf } from "../session/telemetry";
import { GENERAL_TOOLS } from "./general";
import { callModel } from "./structured";
import { proposalTools, type ExtraToolDefinition } from "./tools";

// The plan is a work order list, not a second copy of the task: the caps keep one item from
// turning into a page the session agent must reformulate on every step.
const planItemSchema = z.object({
  title: z.string().min(1).max(200),
  detail: z.string().min(1).max(4000),
  done: z.string().max(1000).optional(),
});

const submitPlanSchema = z.object({
  summary: z.string().max(1000).optional(),
  items: z.array(planItemSchema).min(1).max(12),
});

// The planner's terminal tool. It is not an IR `Action`: the planner loop records the plan
// nodes and closes the unit itself (the model does not choose a state).
export const PLAN_TOOLS: Record<string, ExtraToolDefinition> = {
  ...GENERAL_TOOLS,
  submit_plan: {
    description:
      "Submit the completed plan. Call it exactly once, after you have read enough. `items` is an ordered list; each item is one self-contained work order for a later agent. `detail` must carry the facts that work order needs (paths, commands, acceptance). If the request is to add/implement/fix/change something, every deliverable is an item that makes the change itself — never an item that only gathers facts for a step not in the list. Keep the plan linear and minimal.",
    schema: submitPlanSchema,
  },
};

// Read-only surface: the planner inspects files and writes only the plan. It gets no `shell`
// (a command can mutate the tree) and no write tools; unknown names are refused, never
// executed (docs/en/sessions.md §8).
const PLANNER_TOOL_NAMES = ["read", "grep", "list", "recall", "search", "submit_plan"];

export interface PlannerModelOptions {
  settings?: Settings;
  // Rebuild the model with reasoning disabled. A plan interrupted by the completion cap is
  // retried with reasoning off (the budget was spent thinking), not with a larger cap.
  rebuild?: (options?: { reasoningOff?: boolean }) => LanguageModel;
}

export interface PlannerModelDeps {
  agent: PlannerAgent;
}

function toolsFor(names: readonly string[]): ToolSet {
  return proposalTools(new Set(names), undefined, PLAN_TOOLS);
}

function tools(): ToolSet {
  return toolsFor(PLANNER_TOOL_NAMES);
}

function toCalls(
  calls: readonly { toolName: string; input: unknown; toolCallId: string }[],
): PlannerCall[] {
  return calls.map((call) => ({
    name: call.toolName,
    args: (call.input as Record<string, unknown> | undefined) ?? {},
    callId: call.toolCallId,
  }));
}

export function modelPlannerAgent(
  model: LanguageModel,
  options: PlannerModelOptions = {},
): PlannerAgent {
  return async (messages: ModelMessage[], callOptions = {}) => {
    const settings = options.settings ?? loadSettings();
    const final = callOptions.final === true;
    let repair: ModelMessage | undefined;
    // A plan can be cut off by the completion cap after the model spends the budget thinking.
    // Retry once with reasoning disabled (same cap) rather than raising the output limit.
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
        // The surface is the only thing the planner may execute. The provider can return a
        // tool name that was never offered (`bash`, `edit`, ...); refuse it and, when the
        // model insists, drop it — never reach `toProposal`/`executeAction` with it.
        const allowed = new Set(final ? ["submit_plan"] : PLANNER_TOOL_NAMES);
        const kept = calls.filter((call) => allowed.has(call.name));
        if (kept.length !== calls.length && repair === undefined) {
          repair = {
            role: "user",
            content: `Only these tools are available: ${[...allowed].join(", ")}. Do not call any other tool.`,
          };
          continue;
        }
        if (result.finishReason === "length" && !reasoningOff && options.rebuild !== undefined) {
          reasoningOff = true;
          repair = {
            role: "user",
            content: final
              ? "Your reply hit the output limit. Do not reason; call `submit_plan` now with a concise plan: the summary and the ordered items, each detail at most three sentences."
              : "Your reply hit the output limit. Do not reason; inspect less and call `submit_plan` with a concise plan.",
          };
          continue;
        }
        if (kept.length === 0 && repair === undefined) {
          repair = {
            role: "user",
            content: final
              ? "Call `submit_plan` now with the completed plan; do not inspect anything else. Keep it concise: the summary and the ordered items, each detail at most three sentences."
              : "Use a read-only tool to inspect the workspace, or call `submit_plan` when the plan is ready.",
          };
          continue;
        }
        const reply: PlannerReply = {
          calls: kept,
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

export function createPlannerAgentDeps(
  model: LanguageModel,
  options: PlannerModelOptions = {},
): PlannerModelDeps {
  return { agent: modelPlannerAgent(model, options) };
}
