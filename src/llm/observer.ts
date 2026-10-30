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

import { loadSettings, type Settings } from "../config/settings";
import type { Reaction } from "../session/types";
import {
  defaultObserverTools,
  type ObserverDeps,
  type ObserverReply,
  type ObserverToolCall,
  type RequestObserver,
} from "../session/observer";

const outlineSchema = z.object({});
const stateSchema = z.object({ id: z.string() });
const turnsSchema = z.object({
  id: z.string(),
  from: z.number().int().optional(),
  to: z.number().int().optional(),
});
const hintSchema = z.object({
  text: z.string(),
  evidence: z.array(z.string()).min(1),
  state: z.string(),
});
const memoSchema = z.object({
  text: z.string(),
  evidence: z.array(z.string()).min(1),
});
const haltSchema = z.object({ reason: z.string() });

const TOOL_DEFINITIONS: { name: string; description: string; schema: z.ZodTypeAny }[] = [
  {
    name: "outline",
    description: "Return the request and its states: the U/S survey of the running request.",
    schema: outlineSchema,
  },
  {
    name: "state",
    description: "Return one state's structure, plan and closure. Call with { id }.",
    schema: stateSchema,
  },
  {
    name: "turns",
    description: "Return a state's action→observation turns. Call with { id, from?, to? }.",
    schema: turnsSchema,
  },
  {
    name: "attempt",
    description: "Return a plan item's alternatives, results and status. Call with { id }.",
    schema: stateSchema,
  },
  {
    name: "body",
    description:
      "Return a node's stored content: an observation body, an action result, or a closure label. Call with { id }.",
    schema: stateSchema,
  },
  {
    name: "rendered",
    description: "Return the exact task tape render for a state. Call with { id }.",
    schema: stateSchema,
  },
  {
    name: "hint",
    description:
      "Give the coding agent one short hint for the current state. Set `state` to the state id named in the situation. State the problem and one concrete next step; cite only the evidence ids that support it.",
    schema: hintSchema,
  },
  {
    name: "memo",
    description:
      "Leave one short note in the agent's context for the rest of the request. Cite only the supporting evidence ids.",
    schema: memoSchema,
  },
  {
    name: "halt",
    description: "Stop the run when continuing is clearly futile. Give one short reason.",
    schema: haltSchema,
  },
];

export function observerTools(): ToolSet {
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

function decisionOf(name: string, input: unknown): Reaction | undefined {
  switch (name) {
    case "hint": {
      const value = hintSchema.parse(input);
      return { kind: "hint", text: value.text, evidence: value.evidence, state: value.state };
    }
    case "memo": {
      const value = memoSchema.parse(input);
      return { kind: "memo", text: value.text, evidence: value.evidence };
    }
    case "halt": {
      const value = haltSchema.parse(input);
      return { kind: "halt", reason: value.reason };
    }
    default:
      return undefined;
  }
}

export function toObserverReply(calls: readonly NativeCall[]): ObserverReply {
  for (const call of calls) {
    const decision = decisionOf(call.toolName, call.input);
    if (decision !== undefined) return { decision };
  }
  if (calls.length === 0) return {};
  const toolCalls: ObserverToolCall[] = calls.map((call) => ({
    name: call.toolName,
    args: (call.input as Record<string, unknown> | undefined) ?? {},
    callId: call.toolCallId,
  }));
  return { toolCalls };
}

export interface ObserverModelOptions {
  settings?: Settings;
  onResponse?: (reply: { text: string; toolCalls: readonly NativeCall[] }) => void;
}

export interface ObserverDepsOptions extends ObserverModelOptions {
  maxTurns?: number;
  maxDepth?: number;
  surveyLimit?: number;
}

export function createObserverDeps(
  model: LanguageModel,
  options: ObserverDepsOptions = {},
): ObserverDeps {
  return {
    agent: modelRequestObserver(model, options),
    tools: defaultObserverTools,
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
    ...(options.surveyLimit !== undefined ? { surveyLimit: options.surveyLimit } : {}),
  };
}

export function modelRequestObserver(
  model: LanguageModel,
  options: ObserverModelOptions = {},
): RequestObserver {
  return async (messages: ModelMessage[]) => {
    const settings = options.settings ?? loadSettings();
    let repair: ModelMessage | undefined;
    for (;;) {
      try {
        const result = await generateText({
          model,
          messages: repair === undefined ? messages : [...messages, repair],
          tools: observerTools(),
          stopWhen: stepCountIs(1),
          allowSystemInMessages: true,
          maxRetries: 0,
          temperature: settings.temperature,
          maxOutputTokens: settings.maxTokens,
        });
        const calls: NativeCall[] = result.toolCalls.map((call) => ({
          toolName: call.toolName,
          input: call.input,
          toolCallId: call.toolCallId,
        }));
        options.onResponse?.({ text: result.text, toolCalls: calls });
        if (calls.length === 0 && repair === undefined) {
          repair = {
            role: "user",
            content:
              "You must call one of the observer tools: a read-only survey tool, or `hint`, `memo`, or `halt`.",
          };
          continue;
        }
        return toObserverReply(calls);
      } catch (error) {
        if (
          (NoSuchToolError.isInstance(error) ||
            InvalidToolInputError.isInstance(error) ||
            error instanceof ZodError) &&
          repair === undefined
        ) {
          repair = {
            role: "user",
            content:
              "Your tool call was invalid. Call one of the observer tools with arguments matching its schema.",
          };
          continue;
        }
        throw error;
      }
    }
  };
}
