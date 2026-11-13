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
  type SessionAgent,
  type SessionAgentDeps,
  type SessionReply,
} from "../session/session_agent";
import {
  SESSION_INVALID_TOOL_MESSAGE,
  SESSION_REPAIR_MESSAGE,
  SESSION_REQUEST_DESCRIPTIONS,
  SESSION_TOOL_DESCRIPTIONS,
} from "../session/session_agent_prompts";
import type { SessionOperation } from "../session/types";

const respondSchema = z.object({ text: z.string() });
const taskSchema = z.object({
  request: z.string().describe(SESSION_REQUEST_DESCRIPTIONS.task),
});
const generalSchema = z.object({
  request: z.string().describe(SESSION_REQUEST_DESCRIPTIONS.general),
});
const revisionSchema = z.object({
  request: z.string().describe(SESSION_REQUEST_DESCRIPTIONS.revision),
});
const documentSchema = z.object({ request: z.string() });
const planSchema = z.object({
  request: z.string().describe(SESSION_REQUEST_DESCRIPTIONS.plan),
});

const TOOL_DEFINITIONS: { name: string; description: string; schema: z.ZodTypeAny }[] = [
  {
    name: "respond",
    description: SESSION_TOOL_DESCRIPTIONS.respond,
    schema: respondSchema,
  },
  {
    name: "general",
    description: SESSION_TOOL_DESCRIPTIONS.general,
    schema: generalSchema,
  },
  {
    name: "revision",
    description: SESSION_TOOL_DESCRIPTIONS.revision,
    schema: revisionSchema,
  },
  {
    name: "write_document",
    description: SESSION_TOOL_DESCRIPTIONS.write_document,
    schema: documentSchema,
  },
  {
    name: "task",
    description: SESSION_TOOL_DESCRIPTIONS.task,
    schema: taskSchema,
  },
  {
    name: "plan",
    description: SESSION_TOOL_DESCRIPTIONS.plan,
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
      return { kind: "task", text: value.request };
    }
    case "general": {
      const value = generalSchema.parse(input);
      return { kind: "general", text: value.request };
    }
    case "revision": {
      const value = revisionSchema.parse(input);
      return { kind: "revision", text: value.request };
    }
    case "write_document": {
      const value = documentSchema.parse(input);
      return { kind: "document", text: value.request };
    }
    case "plan": {
      const value = planSchema.parse(input);
      return { kind: "plan", text: value.request };
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
  return {};
}

export interface SessionModelOptions {
  settings?: Settings;
  onResponse?: (reply: { text: string; toolCalls: readonly NativeCall[] }) => void;
}

export type SessionAgentDepsOptions = SessionModelOptions;

export function createSessionAgentDeps(
  model: LanguageModel,
  options: SessionAgentDepsOptions = {},
): SessionAgentDeps {
  return {
    agent: modelSessionAgent(model, options),
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
              content: SESSION_REPAIR_MESSAGE,
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
            content: SESSION_INVALID_TOOL_MESSAGE,
          };
          continue;
        }
        throw error;
      }
    }
  };
}
