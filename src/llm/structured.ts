import {
  InvalidToolInputError,
  NoSuchToolError,
  generateText,
  stepCountIs,
  streamText,
  type FinishReason,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { z } from "zod";

import { loadSettings, type Settings } from "../config/settings";
import { PROVIDER_NAME } from "./client";
import type { Proposals } from "./schemas";
import { proposalTools, toProposal } from "./tools";

// Structured output via native tool calls (docs/testing_ru.md §8.1). The AI SDK owns the
// provider wire format, streaming, reasoning parts and usage; this module owns the skein
// contract around it: the frontier's tool surface, the one-repair round, the completion-cap
// retries, and the mapping of a call back into the IR `Proposal`.

// One assembled model reply. Both `generateText` and `streamText` normalize to this, so the
// retry/repair logic does not know which transport produced it.
export interface ModelReply {
  text: string;
  reasoning?: string;
  toolCalls: { toolName: string; input: unknown; toolCallId: string }[];
  finishReason: FinishReason;
  usage: LanguageModelUsage;
  rawUsage: unknown;
  response: unknown;
}

export interface StructuredOptions {
  // Called for a call failure that is not handled by a retry (diagnostics).
  onError?: (error: unknown, phase: "json") => void;
  // Called with the assembled model reply of every attempt (tokens/finish_reason telemetry,
  // used by the trace replay tool).
  onResponse?: (response: unknown) => void;
  // Usage handlers (`{ handleUsage(reply) }`): the bench meter and the LangGraph adapter's
  // bridge to Harbor's inherited callbacks. The model layer does not know LangChain.
  usageHandlers?: unknown[];
  ceiling?: number;
  bumps?: number;
  settings?: Settings;
  // The completion cap is a per-call option in the AI SDK, but the model carries the
  // reasoning-effort setting; raising the cap (or disabling reasoning) needs a fresh instance.
  rebuild?: (maxTokens: number, options?: { reasoningOff?: boolean }) => LanguageModel;
}

// The provider's own truncation signal is normalized by the AI SDK to `length`. Its exactness
// is why the retry does not guess from invalid JSON.
interface ModelCall {
  model: LanguageModel;
  messages: ModelMessage[];
  settings: Settings;
  maxTokens?: number;
  tools?: ToolSet;
  json?: boolean;
  streaming: boolean;
  usageHandlers?: unknown[];
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The usage seam: one handler per successful call. The bench meter and the LangGraph
// adapter's Harbor bridge implement `handleUsage`; the model layer stays AI-SDK-only.
async function notifyUsage(handlers: unknown[] | undefined, reply: ModelReply): Promise<void> {
  if (handlers === undefined || handlers.length === 0) return;
  for (const handler of handlers) {
    const usage = handler as { handleUsage?: (reply: ModelReply) => unknown };
    if (typeof usage.handleUsage === "function") await usage.handleUsage(reply);
  }
}

async function callModel(call: ModelCall): Promise<ModelReply> {
  const options = {
    model: call.model,
    messages: call.messages,
    // The tape carries system turns in the middle (state instructions, constraints).
    allowSystemInMessages: true,
    // Skein owns the retry policy (`invokeWithRetry`): the SDK's own retries would multiply
    // the request count and hide a thrown call from `onError`.
    maxRetries: 0,
    temperature: call.settings.temperature,
    maxOutputTokens: call.maxTokens ?? call.settings.maxTokens,
    ...(call.tools !== undefined ? { tools: call.tools, stopWhen: stepCountIs(1) } : {}),
    ...(call.json === true
      ? {
          providerOptions: {
            [PROVIDER_NAME]: { response_format: { type: "json_object" } },
          },
        }
      : {}),
  };
  let reply: ModelReply;
  if (call.streaming) {
    const result = streamText(options);
    const [text, reasoningText, toolCalls, finishReason, usage, response] = await Promise.all([
      result.text,
      result.reasoningText,
      result.toolCalls,
      result.finishReason,
      result.usage,
      result.response,
    ]);
    reply = {
      text,
      ...(reasoningText !== undefined && reasoningText !== "" ? { reasoning: reasoningText } : {}),
      toolCalls: toolCalls.map((call) => ({
        toolName: call.toolName,
        input: call.input,
        toolCallId: call.toolCallId,
      })),
      finishReason,
      usage,
      rawUsage: usage.raw,
      response,
    };
  } else {
    const result = await generateText(options);
    reply = {
      text: result.text,
      ...(result.reasoningText !== undefined && result.reasoningText !== ""
        ? { reasoning: result.reasoningText }
        : {}),
      toolCalls: result.toolCalls.map((call) => ({
        toolName: call.toolName,
        input: call.input,
        toolCallId: call.toolCallId,
      })),
      finishReason: result.finishReason,
      usage: result.usage,
      rawUsage: result.usage.raw,
      response: result.response,
    };
  }
  await notifyUsage(call.usageHandlers, reply);
  return reply;
}

function isLengthLimit(error: unknown): boolean {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return text.includes("length limit") || text.includes("max_tokens") || text.includes("max tokens");
}

// A response cut off at the completion cap surfaces as invalid JSON rather than a provider
// "length limit" error; it must trigger the same raise-and-retry. V8 words the syntax error
// inconsistently, so detection is structural, not message-based.
function looksTruncated(text: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") depth -= 1;
  }
  return inString || depth > 0;
}

// Anything that means "the model did not finish": retry with a larger cap.
function isCompletionCap(error: unknown): boolean {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    isLengthLimit(error) ||
    text.includes("truncated json") ||
    text.includes("unterminated string") ||
    text.includes("unexpected end of json") ||
    text.includes("unexpected end of input")
  );
}

// The meta-provider may route one turn to a subcontractor that does not emit reasoning and the
// next to a thinking-mode one, which then demands the previous turn's `reasoning_content` — a
// field that never existed (an empty value is rejected too). No amount of resending fixes it;
// turning thinking off for this call does.
function isReasoningContentRequired(error: unknown): boolean {
  const record = error as { message?: unknown; error?: { message?: unknown } } | undefined;
  const text = [record?.message, record?.error?.message, String(error)]
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .toLowerCase();
  return text.includes("reasoning_content") && text.includes("passed back");
}

// A model call the AI SDK could not parse: unknown tool name or arguments failing the tool's
// schema. Unlike a provider hiccup it is deterministic for this turn, so it gets the one
// repair round instead of a resend.
function isToolCallError(error: unknown): boolean {
  return NoSuchToolError.isInstance(error) || InvalidToolInputError.isInstance(error);
}

function parseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let firstError: unknown;
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    firstError = error;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // Both parses failed; fall through to the structural check.
    }
  }
  if (looksTruncated(trimmed)) throw new Error("truncated json response");
  throw firstError;
}

function jsonSchemaText(schema: z.ZodTypeAny): string {
  try {
    return JSON.stringify(z.toJSONSchema(schema), null, 2);
  } catch {
    return "{}";
  }
}

async function callJson(
  model: LanguageModel,
  schema: z.ZodTypeAny,
  messages: ModelMessage[],
  maxTokens: number | undefined,
  options: StructuredOptions,
  settings: Settings,
  streaming: boolean,
  repair?: string,
): Promise<unknown> {
  const withSchema: ModelMessage[] = [
    ...messages,
    {
      role: "user",
      content: [
        "Return ONLY one JSON object matching the schema below.",
        "No markdown fences, no prose, no comments, no extra keys.",
        'The top-level object must carry exactly the keys listed in "required".',
        "JSON Schema:",
        jsonSchemaText(schema),
      ].join("\n"),
    },
    ...(repair !== undefined ? [{ role: "user" as const, content: repair }] : []),
  ];
  const base = maxTokens !== undefined && options.rebuild !== undefined ? options.rebuild(maxTokens) : model;
  let reply: ModelReply;
  try {
    reply = await callModel({
      model: base,
      messages: withSchema,
      settings,
      maxTokens,
      json: true,
      streaming,
      usageHandlers: options.usageHandlers,
    });
  } catch (error) {
    if (isCompletionCap(error)) throw error;
    options.onError?.(error, "json");
    // The retry drops the JSON-mode request body (some OpenAI-compatible backends reject
    // `response_format`); the prompt already spells the schema out, so a plain reply is
    // still parsed by `parseJson`.
    reply = await callModel({
      model,
      messages: withSchema,
      settings,
      maxTokens,
      json: false,
      streaming,
      usageHandlers: options.usageHandlers,
    });
  }
  options.onResponse?.(reply);
  // The provider's exact truncation signal: it ran out of the completion budget. Retry
  // with a larger cap instead of trying to parse a partial body.
  if (reply.finishReason === "length") throw new Error("truncated json response");
  if (reply.text.trim() === "") throw new Error("model returned an empty JSON body");
  return parseJson(reply.text);
}

function nextMaxTokens(current: number, base: number, ceiling: number): number | undefined {
  const next = Math.min(Math.max(current * 2, base * 2), Math.max(current, ceiling));
  return next > current ? next : undefined;
}

function repairInstruction(error: unknown): string {
  if (error instanceof z.ZodError) {
    const issues = error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
      .join("; ");
    return `Your previous JSON did not match the schema (${issues}). Return the FULL object again with every required field, and nothing else.`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Your previous reply was not valid JSON (${message}). Return ONLY one JSON object matching the schema, with no prose and no markdown fences.`;
}

export async function invokeStructured<T extends z.ZodTypeAny>(
  model: LanguageModel,
  schema: T,
  messages: ModelMessage[],
  options: StructuredOptions = {},
): Promise<z.infer<T>> {
  const settings = options.settings ?? loadSettings();
  const ceiling = options.ceiling ?? settings.maxTokensCeiling;
  const bumps = options.bumps ?? settings.maxTokensBumps;

  let maxTokens: number | undefined;
  let raised = 0;
  let repair: string | undefined;

  for (;;) {
    try {
      return schema.parse(
        await callJson(model, schema, messages, maxTokens, options, settings, settings.streaming, repair),
      ) as z.infer<T>;
    } catch (error) {
      if (isCompletionCap(error) && raised < bumps) {
        const base = maxTokens ?? settings.maxTokens;
        const next = nextMaxTokens(base, settings.maxTokens, ceiling);
        if (next !== undefined) {
          maxTokens = next;
          raised += 1;
          continue;
        }
      }
      // The model answered but not in our shape (schema violation, or prose instead of
      // JSON). One repair round with the failure spelled out before giving up, so a single
      // malformed reply does not sink the whole run.
      if (repair === undefined) {
        repair = repairInstruction(error);
        continue;
      }
      throw error;
    }
  }
}

// --- Native tool-calling path (docs/testing_ru.md §8.1) ----------------------
// Flat function tools instead of a JSON schema in the prompt: the provider holds the
// call far better and the JSON-mode overhead disappears. The engine rebuilds the
// projection every turn, so there is no tool-result loop — a call is only the
// structured-output channel for the proposed `Action`.
export interface ToolsOptions {
  // `{ handleUsage(reply) }` handlers: the bench meter, the LangGraph adapter's Harbor bridge.
  usageHandlers?: unknown[];
  onError?: (error: unknown, phase: "tools") => void;
  onResponse?: (response: unknown) => void;
  settings?: Settings;
  ceiling?: number;
  bumps?: number;
  // The tool names the model surface may offer (the frontier, `toolNamesFor`). When omitted,
  // the full registry is bound (direct `invokeTools` callers, tests).
  allowedTools?: string[];
  // Retries for a THROWN provider call (network/5xx/rate limit): the same request is resent
  // up to this many extra times before the error is given up. Defaults to `settings.llmRetries`.
  retries?: number;
  // Base backoff between retries, in ms (linear). Tests set 0 to stay fast.
  retryDelayMs?: number;
  // Raising the completion cap or disabling the provider's reasoning needs a fresh model
  // instance (the settings are baked into `createChatModel`).
  rebuild?: (maxTokens: number, options?: { reasoningOff?: boolean }) => LanguageModel;
}

const RETRY_DELAY_MS = 500;

async function invokeWithRetry(
  call: ModelCall,
  retries: number,
  delayMs: number,
  onError: ((error: unknown, phase: "tools") => void) | undefined,
): Promise<ModelReply> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await callModel(call);
    } catch (error) {
      // Deterministic for the route/turn: let the caller repair or switch reasoning instead
      // of resending the identical request.
      if (isReasoningContentRequired(error) || isToolCallError(error)) throw error;
      onError?.(error, "tools");
      if (attempt >= retries) throw error;
      if (delayMs > 0) await wait(delayMs * (attempt + 1));
    }
  }
}

export async function invokeTools(
  model: LanguageModel,
  messages: ModelMessage[],
  options: ToolsOptions = {},
): Promise<Proposals> {
  const settings = options.settings ?? loadSettings();
  const retries = options.retries ?? settings.llmRetries;
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  const allowed =
    options.allowedTools !== undefined ? new Set(options.allowedTools) : undefined;
  const tools = proposalTools(allowed);

  let maxTokens: number | undefined;
  let raised = 0;
  let reasoningOff = false;
  let reasoningFallback = false;
  let repair: ModelMessage | undefined;
  for (;;) {
    const base =
      (maxTokens !== undefined || reasoningOff) && options.rebuild !== undefined
        ? options.rebuild(maxTokens ?? settings.maxTokens, reasoningOff ? { reasoningOff: true } : undefined)
        : model;
    let reply: ModelReply;
    try {
      reply = await invokeWithRetry(
        {
          model: base,
          messages: repair === undefined ? messages : [...messages, repair],
          settings,
          maxTokens,
          tools,
          streaming: settings.streaming,
          usageHandlers: options.usageHandlers,
        },
        retries,
        retryDelayMs,
        options.onError,
      );
    } catch (error) {
      // A malformed call (unknown tool, args that fail the schema) gets one repair round,
      // as the JSON path does, instead of sinking the whole run as `llm_error`.
      if (isToolCallError(error)) {
        if (repair !== undefined) throw error;
        repair = {
          role: "user",
          content: `Your tool call was invalid (${error instanceof Error ? error.message : String(error)}). Call one or more tools with valid arguments matching their schemas.`,
        };
        continue;
      }
      // Cross-subcontractor routing: the previous turn has no reasoning to echo back, so this
      // thinking-mode route cannot serve the request. Retry once with thinking disabled.
      if (!reasoningFallback && !reasoningOff && options.rebuild !== undefined && isReasoningContentRequired(error)) {
        reasoningFallback = true;
        reasoningOff = true;
        continue;
      }
      throw error;
    }
    options.onResponse?.(reply);
    // No `tool_choice`: forcing `required` routes the meta-provider to thinking upstreams that
    // either reject it or are rate-limited (docs/state_testing §7). The prompt asks for a call;
    // a text reply is handled by the one-repair round below.
    if (reply.toolCalls.length > 0) {
      try {
        // Every call in the message is a move; the engine decides and runs them in order.
        const actions = reply.toolCalls.map(
          (call) => toProposal(call.toolName, call.input, "").action,
        );
        return {
          thought: reply.text,
          actions,
          ...(settings.reasoningTape && reply.reasoning !== undefined
            ? { reasoning: reply.reasoning }
            : {}),
        };
      } catch (error) {
        if (repair !== undefined) throw error;
        repair = {
          role: "user",
          content: `Your tool call was invalid (${error instanceof Error ? error.message : String(error)}). Call one or more tools with valid arguments matching their schemas.`,
        };
        continue;
      }
    }
    // No tool call. A response cut at the completion cap means the model burned the whole
    // completion budget on hidden reasoning (a live fix-ocaml-gc run: 8192, then even 32768,
    // tokens of reasoning with no call). Retry ONCE — but do NOT raise the cap (a bigger
    // budget only invites more reasoning). Rebuild with reasoning DISABLED so the model must
    // answer with a call, and add a brevity note. Any other no-call gets one repair round.
    if (reply.finishReason === "length") {
      if (raised === 0) {
        raised = 1;
        reasoningOff = true;
        repair = {
          role: "user",
          content:
            "Your last reply was cut off by the length limit — that is excessive reasoning. Call one or more tools now, with minimal reasoning; do not restate analysis.",
        };
        continue;
      }
      throw new Error("model returned no tool call");
    }
    if (repair !== undefined) throw new Error("model returned no tool call");
    repair = {
      role: "user",
      content: "You did not call a tool. Call one or more of the provided tools.",
    };
  }
}
