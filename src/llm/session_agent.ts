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
  SESSION_REPORT_PROMPT,
  type SessionAgent,
  type SessionAgentDeps,
  type SessionReply,
  type SessionReporter,
  type SessionToolCall,
} from "../session/session_agent";
import type { ReadFile } from "../session/reading";
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
const startSchema = z.object({ text: z.string() });
const generalSchema = z.object({ text: z.string() });

const TOOL_DEFINITIONS: { name: string; description: string; schema: z.ZodTypeAny }[] = [
  {
    name: "unit",
    description:
      "Return one unit's structure: states and closures, or a reading unit's path/size/observation. Call with the unit id from the trace (e.g. r1, g1, reading:1).",
    schema: unitSchema,
  },
  {
    name: "state",
    description:
      "Return a state's plan: items, the current action, its result id and outcome (L2). Call with { unit, id }; unit is a task id (e.g. r1).",
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
      "Answer conversationally: greeting, thanks, confirmation, clarification or a direct factual pointer. Not for analysis or explanation of the material.",
    schema: respondSchema,
  },
  {
    name: "general",
    description:
      "Start a non-coding analysis, explanation or report on the material. Use it when that analysis is the request itself; include the goal and relevant context.",
    schema: generalSchema,
  },
  {
    name: "start",
    description:
      "Start a coding task: work that changes files or runs commands with side effects. The coding agent sees only your brief, so include the goal, relevant facts and acceptance.",
    schema: startSchema,
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
    case "start": {
      const value = startSchema.parse(input);
      return { kind: "start", text: value.text };
    }
    case "general": {
      const value = generalSchema.parse(input);
      return { kind: "general", text: value.text };
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
  readFile?: ReadFile;
}

// The report is one plain completion: the task trace is already deterministic, so it needs no
// tools and its output is not a session unit.
export function modelSessionReporter(
  model: LanguageModel,
  options: SessionModelOptions = {},
): SessionReporter {
  return async (input) => {
    const settings = options.settings ?? loadSettings();
    const result = await generateText({
      model,
      system: SESSION_REPORT_PROMPT,
      prompt: [
        `Original request:\n${input.utterance}`,
        `Task request:\n${input.request}`,
        `Task trace:\n${input.trace}`,
      ].join("\n\n"),
      maxRetries: 0,
      temperature: settings.temperature,
      maxOutputTokens: settings.maxTokens,
    });
    const text = result.text.trim();
    return text !== "" ? text : undefined;
  };
}

export function createSessionAgentDeps(
  model: LanguageModel,
  options: SessionAgentDepsOptions = {},
): SessionAgentDeps {
  const readFile = options.readFile;
  return {
    agent: modelSessionAgent(model, options),
    tools: createSessionTools(readFile),
    report: modelSessionReporter(model, options),
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
                "You must call one of the session tools: a read-only `unit`/`state`/`turns`/`body`/`search` query, or an operation `respond`, `general`, `start`.",
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
