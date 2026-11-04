import {
  InvalidToolInputError,
  NoSuchToolError,
  tool,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { z, ZodError } from "zod";

import { isAborted } from "../abort";
import { loadSettings, type Settings } from "../config/settings";
import { usageOf } from "../session/telemetry";
import type { Reaction, ReactionProposal } from "../session/types";
import type {
  ObserverDeps,
  ObserverReply,
  RequestObserver,
} from "../session/observer";
import { callModel } from "./structured";

const hintSchema = z.object({
  text: z.string(),
  evidence: z.array(z.string()).min(1),
});
const memoSchema = z.object({
  text: z.string(),
  evidence: z.array(z.string()).min(1),
});
const haltSchema = z.object({ reason: z.string() });

// The observer reads the tape it is handed and decides; it has no survey tools, because nothing
// outside the seeded state body would reach it anyway (the state's record is the whole input).
const TOOL_DEFINITIONS: { name: string; description: string; schema: z.ZodTypeAny }[] = [
  {
    name: "hint",
    description:
      "Give the coding agent one short hint for the state in the tape. State the problem and one concrete next step; cite only the evidence ids that support it.",
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

function decisionOf(name: string, input: unknown): ReactionProposal | undefined {
  switch (name) {
    case "hint": {
      const value = hintSchema.parse(input);
      return { kind: "hint", text: value.text, evidence: value.evidence };
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
  return {};
}

export interface ObserverModelOptions {
  settings?: Settings;
  onResponse?: (reply: { text: string; toolCalls: readonly NativeCall[] }) => void;
  // The same usage seam the task proposer uses (`bench/metrics.ts` TurnMeter). Without it the
  // observer's model calls are invisible to the run's token and cost totals.
  usageHandlers?: unknown[];
}

export type ObserverDepsOptions = ObserverModelOptions;

export function createObserverDeps(
  model: LanguageModel,
  options: ObserverDepsOptions = {},
): ObserverDeps {
  return { agent: modelRequestObserver(model, options) };
}

export function modelRequestObserver(
  model: LanguageModel,
  options: ObserverModelOptions = {},
): RequestObserver {
  return async (messages: ModelMessage[], callOptions = {}) => {
    const settings = options.settings ?? loadSettings();
    let repair: ModelMessage | undefined;
    for (;;) {
      try {
        // Through the shared transport, not `generateText` directly: the observer's tokens must
        // reach the same usage seam as the task agent's, or every run silently under-reports
        // what the observer cost. Retry/repair policy stays here — `callModel` is one call.
        // `streaming: false` keeps the observer's previous transport: it awaits one whole reply,
        // so a stream would add nothing but a second code path.
        const result = await callModel({
          model,
          messages: repair === undefined ? messages : [...messages, repair],
          settings,
          tools: observerTools(),
          streaming: false,
          ...(options.usageHandlers !== undefined ? { usageHandlers: options.usageHandlers } : {}),
          ...(callOptions.signal !== undefined ? { abortSignal: callOptions.signal } : {}),
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
              "You must answer with one of the decision tools: `hint`, `memo`, or `halt`.",
          };
          continue;
        }
        return {
          ...toObserverReply(calls),
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
              "Your tool call was invalid. Call `hint`, `memo`, or `halt` with arguments matching its schema.",
          };
          continue;
        }
        throw error;
      }
    }
  };
}
