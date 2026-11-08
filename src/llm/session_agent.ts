import {
  InvalidToolInputError,
  NoSuchToolError,
  generateText,
  stepCountIs,
  tool,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { z, ZodError } from "zod";

import { isAborted } from "../abort";
import { loadSettings, type Settings } from "../config/settings";
import { usageOf } from "../session/telemetry";
import {
  createSessionTools,
  type SessionAgent,
  type SessionAgentDeps,
  type SessionReply,
  type SessionToolCall,
} from "../session/session_agent";
import type { SessionOperation } from "../session/types";

const unitSchema = z.object({ id: z.string() });
const stateSchema = z.object({ unit: z.string(), id: z.string() });
const turnsSchema = z.object({
  unit: z.string(),
  id: z.string(),
  from: z.number().int().optional(),
  to: z.number().int().optional(),
});
const bodySchema = z.object({
  unit: z.string(),
  id: z.string(),
  start: z.number().int().positive().optional(),
  end: z.number().int().positive().optional(),
});
const searchSchema = z.object({
  unit: z.string(),
  pattern: z.string(),
  before: z.number().int().nonnegative().optional(),
  after: z.number().int().nonnegative().optional(),
  from: z.number().int().nonnegative().optional(),
  count: z.number().int().positive().optional(),
});
const respondSchema = z.object({ text: z.string() });
const taskSchema = z.object({ text: z.string() });
const generalSchema = z.object({ text: z.string() });
const planSchema = z.object({ text: z.string() });

const TOOL_DEFINITIONS: { name: string; description: string; schema: z.ZodTypeAny }[] = [
  {
    name: "unit",
    description:
      "Return one unit's structure: states and closures. Call with the unit id from the trace (e.g. r1, g1, m1).",
    schema: unitSchema,
  },
  {
    name: "state",
    description:
      "Return a state's turns: each action, its result id and outcome (L2). Call with { unit, id }; unit is a task id (e.g. r1).",
    schema: stateSchema,
  },
  {
    name: "turns",
    description:
      "Return a state's turns: action, result id and outcome, plus the task agent's reasoning (bounded). Call with { unit, id, from?, to? }.",
    schema: turnsSchema,
  },
  {
    name: "body",
    description:
      "Return a result in full (or a line window) when its preview was cut off. `unit` is the unit that produced it; `id` is the result id printed with it. `start`/`end` select lines.",
    schema: bodySchema,
  },
  {
    name: "search",
    description:
      "Search a unit's observation bodies by regular expression. Call with { unit, pattern, before?, after?, from?, count? }.",
    schema: searchSchema,
  },
  {
    name: "respond",
    description:
      "Answer the user from the dialogue and earlier work: greeting, thanks, confirmation, clarification or a direct factual pointer.",
    schema: respondSchema,
  },
  {
    name: "general",
    description:
      "Ask the general agent for an answer that requires investigation. `text` is the user's own words with the dialogue's references resolved, keeping their scope and level of detail. The general agent chooses how to work and how much detail to give.",
    schema: generalSchema,
  },
  {
    name: "task",
    description:
      "Change files or run side-effecting commands. The coding agent sees only this text, so it must be self-contained: the goal, the facts it needs and how completion is judged.",
    schema: taskSchema,
  },
  {
    name: "plan",
    description:
      "Develop an execution plan: a read-only agent inspects the workspace and returns an ordered list of work items (general or coding). The plan is shown to the user, who decides whether to execute it. Use it for a request that needs several steps, or when the user asks for a plan.",
    schema: planSchema,
  },
];

export function sessionAgentTools(): ToolSet {
  const tools: ToolSet = {};
  for (const definition of TOOL_DEFINITIONS) {
    tools[definition.name] = tool({
      description: definition.description,
      inputSchema: definition.schema,
    });
  }
  return tools;
}

type NativeCall = { toolName: string; input: unknown; toolCallId: string };

function operationOf(name: string, input: unknown): SessionOperation | undefined {
  switch (name) {
    case "respond": {
      const value = respondSchema.parse(input);
      return { kind: "respond", text: value.text };
    }
    case "task": {
      const value = taskSchema.parse(input);
      return { kind: "task", text: value.text };
    }
    case "general": {
      const value = generalSchema.parse(input);
      return { kind: "general", text: value.text };
    }
    case "plan": {
      const value = planSchema.parse(input);
      return { kind: "plan", text: value.text };
    }
    default:
      return undefined;
  }
}

export function toSessionReply(calls: readonly NativeCall[]): SessionReply {
  for (const call of calls) {
    const operation = operationOf(call.toolName, call.input);
    if (operation !== undefined) return { operation };
  }
  if (calls.length === 0) return {};
  const toolCalls: SessionToolCall[] = calls.map((call) => ({
    name: call.toolName,
    args: (call.input as Record<string, unknown> | undefined) ?? {},
    callId: call.toolCallId,
  }));
  return { toolCalls };
}

export interface SessionModelOptions {
  settings?: Settings;
  onResponse?: (reply: { text: string; toolCalls: readonly NativeCall[] }) => void;
}

export interface SessionAgentDepsOptions extends SessionModelOptions {
  maxTurns?: number;
  surveyLimit?: number;
}

export function createSessionAgentDeps(
  model: LanguageModel,
  options: SessionAgentDepsOptions = {},
): SessionAgentDeps {
  return {
    agent: modelSessionAgent(model, options),
    tools: createSessionTools(),
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    ...(options.surveyLimit !== undefined ? { surveyLimit: options.surveyLimit } : {}),
  };
}

export function modelSessionAgent(
  model: LanguageModel,
  options: SessionModelOptions = {},
): SessionAgent {
  return async (messages: ModelMessage[], callOptions = {}) => {
    const settings = options.settings ?? loadSettings();
    let repair: ModelMessage | undefined;
    for (;;) {
      try {
        const result = await generateText({
          model,
          messages: repair === undefined ? messages : [...messages, repair],
          tools: sessionAgentTools(),
          stopWhen: stepCountIs(1),
          allowSystemInMessages: true,
          maxRetries: 0,
          temperature: settings.temperature,
          maxOutputTokens: settings.maxTokens,
          ...(callOptions.signal !== undefined ? { abortSignal: callOptions.signal } : {}),
        });
        const calls: NativeCall[] = result.toolCalls.map((call) => ({
          toolName: call.toolName,
          input: call.input,
          toolCallId: call.toolCallId,
        }));
        options.onResponse?.({ text: result.text, toolCalls: calls });
        const reasoning =
          result.reasoningText !== undefined && result.reasoningText !== ""
            ? { reasoning: result.reasoningText }
            : {};
        if (calls.length === 0) {
          // A plain-text answer is a valid session reply. Ask once for a tool call; if the
          // model insists on text, treat it as `respond` rather than dropping the answer.
          if (result.text.trim() !== "" && repair !== undefined) {
            return {
              operation: { kind: "respond", text: result.text },
              ...reasoning,
              ...(usageOf(result.usage) !== undefined ? { usage: usageOf(result.usage) } : {}),
              model: settings.model,
            };
          }
          if (repair === undefined) {
            repair = {
              role: "user",
              content:
                "You must call one of the session tools: a read-only `unit`/`state`/`turns`/`body`/`search` query, or an operation `respond`, `general`, `task`, `plan`.",
            };
            continue;
          }
          return {
            ...reasoning,
            ...(usageOf(result.usage) !== undefined ? { usage: usageOf(result.usage) } : {}),
            model: settings.model,
          };
        }
        const reply = toSessionReply(calls);
        return {
          ...reply,
          ...(result.reasoningText !== undefined && result.reasoningText !== ""
            ? { reasoning: result.reasoningText }
            : {}),
          ...(usageOf(result.usage) !== undefined ? { usage: usageOf(result.usage) } : {}),
          model: settings.model,
        };
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
              "Your tool call was invalid. Call one of the session tools with arguments matching its schema.",
          };
          continue;
        }
        throw error;
      }
    }
  };
}
