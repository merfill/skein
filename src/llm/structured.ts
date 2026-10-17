import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";

import { loadSettings, type Settings } from "../config/settings";
import type { Proposals } from "./schemas";
import { PROPOSAL_TOOLS, toProposal } from "./tools";

// Structured output as plain JSON: the JSON schema is spelled out in the prompt and the
// reply is parsed manually. Tool/function calling was dropped intentionally — under the
// real agent prompt the provider's tool calls came back flat or malformed (operator at the
// top level instead of nested under `action`), while the JSON path returns the nested
// object as required. On a completion cap or a schema violation the call is retried with a
// larger budget / a repair note (docs/testing_ru.md §8.1).

// The model surface invokeStructured needs. LangChain v1 dropped `Runnable.bind`; per-call
// model kwargs (response_format, max_tokens) go through `withConfig`. `max_tokens` is a
// constructor field, so raising the cap needs a rebuilt instance (`rebuild`).
export interface StructuredModel {
  maxTokens?: number;
  withConfig?(config: Record<string, unknown>): StructuredModel;
  invoke(messages: BaseMessage[], options?: unknown): Promise<unknown>;
}

export interface StructuredOptions {
  // Called for a call failure that is not handled by a retry (diagnostics).
  onError?: (error: unknown, phase: "json") => void;
  // Called with the raw model response of every attempt (tokens/finish_reason telemetry,
  // used by the trace replay tool).
  onResponse?: (response: unknown) => void;
  // LangChain callbacks (token metering) forwarded to every underlying invoke.
  callbacks?: unknown[];
  ceiling?: number;
  bumps?: number;
  settings?: Settings;
  // LangChain's `max_tokens` is a constructor field, so raising the completion cap needs a
  // fresh instance; the caller supplies the factory.
  rebuild?: (maxTokens: number) => BaseChatModel;
}

// The provider's own truncation signal: a reply stopped at the completion cap reports
// `finish_reason: "length"`. This is exact, unlike guessing from invalid JSON.
function finishReason(response: unknown): string | undefined {
  const record = response as
    | { response_metadata?: { finish_reason?: unknown }; additional_kwargs?: { finish_reason?: unknown } }
    | undefined;
  const fromMeta = record?.response_metadata?.finish_reason;
  if (typeof fromMeta === "string") return fromMeta;
  const fromKwargs = record?.additional_kwargs?.finish_reason;
  return typeof fromKwargs === "string" ? fromKwargs : undefined;
}

function messageText(response: unknown): string {
  if (typeof response === "string") return response;
  const content = (response as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        const text = (part as { text?: unknown } | undefined)?.text;
        return typeof text === "string" ? text : "";
      })
      .join("");
  }
  return "";
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

// One assembled model reply. A streaming model (`stream`) is drained and its chunks
// concatenated into the message `invoke` would have returned — keeping the connection busy
// during a long hidden reasoning so the gateway's idle timeout is not hit. A model without
// `stream` (test doubles) falls back to `invoke`.
interface StreamableModel {
  invoke(messages: BaseMessage[], options?: unknown): Promise<unknown>;
  stream?(messages: BaseMessage[], options?: unknown): Promise<AsyncIterable<unknown>>;
}

// A streamed message chunk: chunks accumulate into the assembled message by concatenation.
interface MessageChunk {
  concat(chunk: MessageChunk): MessageChunk;
}

async function callModel(
  target: StreamableModel,
  messages: BaseMessage[],
  invokeOptions: unknown,
  streaming: boolean,
): Promise<unknown> {
  if (!streaming || typeof target.stream !== "function") {
    return target.invoke(messages, invokeOptions);
  }
  let accumulated: MessageChunk | undefined;
  for await (const chunk of await target.stream(messages, invokeOptions)) {
    const next = chunk as MessageChunk;
    accumulated = accumulated === undefined ? next : accumulated.concat(next);
  }
  if (accumulated === undefined) throw new Error("model returned no stream content");
  return accumulated;
}

async function callJson(
  model: StructuredModel,
  schema: z.ZodTypeAny,
  messages: BaseMessage[],
  maxTokens: number | undefined,
  invokeOptions: unknown,
  options: StructuredOptions,
  streaming: boolean,
  repair?: string,
): Promise<unknown> {
  const withSchema = [
    ...messages,
    new HumanMessage(
      [
        "Return ONLY one JSON object matching the schema below.",
        "No markdown fences, no prose, no comments, no extra keys.",
        'The top-level object must carry exactly the keys listed in "required".',
        "JSON Schema:",
        jsonSchemaText(schema),
      ].join("\n"),
    ),
    ...(repair !== undefined ? [new HumanMessage(repair)] : []),
  ];
  const kwargs: Record<string, unknown> = { response_format: { type: "json_object" } };
  if (maxTokens !== undefined) kwargs.max_tokens = maxTokens;
  const base =
    maxTokens !== undefined && options.rebuild !== undefined
      ? (options.rebuild(maxTokens) as unknown as StructuredModel)
      : model;
  let target: StructuredModel = base;
  if (typeof base.withConfig === "function") {
    try {
      target = base.withConfig(kwargs);
    } catch (error) {
      options.onError?.(error, "json");
      target = base;
    }
  }
  let response: unknown;
  try {
    response = await callModel(target as unknown as StreamableModel, withSchema, invokeOptions, streaming);
  } catch (error) {
    if (isCompletionCap(error)) throw error;
    options.onError?.(error, "json");
    response = await callModel(base as unknown as StreamableModel, withSchema, invokeOptions, streaming);
  }
  options.onResponse?.(response);
  // The provider's exact truncation signal: it ran out of the completion budget. Retry
  // with a larger cap instead of trying to parse a partial body.
  if (finishReason(response) === "length") throw new Error("truncated json response");
  const text = messageText(response);
  if (text.trim() === "") throw new Error("model returned an empty JSON body");
  return parseJson(text);
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
  model: BaseChatModel,
  schema: T,
  messages: BaseMessage[],
  options: StructuredOptions = {},
): Promise<z.infer<T>> {
  const settings = options.settings ?? loadSettings();
  const ceiling = options.ceiling ?? settings.maxTokensCeiling;
  const bumps = options.bumps ?? settings.maxTokensBumps;
  const target = model as unknown as StructuredModel;
  const invokeOptions = options.callbacks !== undefined ? { callbacks: options.callbacks } : undefined;

  let maxTokens: number | undefined;
  let raised = 0;
  let repair: string | undefined;

  for (;;) {
    try {
      return schema.parse(
        await callJson(target, schema, messages, maxTokens, invokeOptions, options, settings.streaming, repair),
      ) as z.infer<T>;
    } catch (error) {
      if (isCompletionCap(error) && raised < bumps) {
        const base = maxTokens ?? target.maxTokens ?? settings.maxTokens;
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
  callbacks?: unknown[];
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
  // LangChain's `max_tokens` is a constructor field, so raising the completion cap needs a
  // fresh instance; the caller supplies the factory (as in the JSON path). `reasoningOff`
  // asks the factory to rebuild with the provider's reasoning disabled (see the truncation
  // retry in `invokeTools`).
  rebuild?: (maxTokens: number, options?: { reasoningOff?: boolean }) => BaseChatModel;
}

const RETRY_DELAY_MS = 500;
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// A provider hiccup surfaces as a thrown call (not a response). Resend the SAME request with a
// small backoff; a non-transient error just wastes the retries and is then rethrown.
async function invokeWithRetry(
  bound: StreamableModel,
  messages: BaseMessage[],
  invokeOptions: unknown,
  streaming: boolean,
  retries: number,
  delayMs: number,
  onError: ((error: unknown, phase: "tools") => void) | undefined,
): Promise<unknown> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await callModel(bound, messages, invokeOptions, streaming);
    } catch (error) {
      // Deterministic for the route: let the caller switch reasoning instead of resending.
      if (isReasoningContentRequired(error)) throw error;
      onError?.(error, "tools");
      if (attempt >= retries) throw error;
      if (delayMs > 0) await wait(delayMs * (attempt + 1));
    }
  }
}

interface ToolCallingModel extends StreamableModel {
  bindTools?(
    tools: unknown[],
    kwargs?: Record<string, unknown>,
  ): StreamableModel;
}

function toolCallsOf(response: unknown): { name: string; args: unknown }[] {
  const calls = (response as { tool_calls?: unknown } | undefined)?.tool_calls;
  if (!Array.isArray(calls)) return [];
  const out: { name: string; args: unknown }[] = [];
  for (const call of calls) {
    const name = (call as { name?: unknown } | undefined)?.name;
    const args = (call as { args?: unknown } | undefined)?.args;
    if (typeof name === "string" && name !== "") out.push({ name, args });
  }
  return out;
}

// The model's hidden reasoning, when the provider surfaced it. langchain-openai maps the
// canonical `reasoning_content` field into `additional_kwargs`; `client.ts` normalizes
// RouterAI's `reasoning` onto that name.
function reasoningOf(response: unknown): string | undefined {
  const value = (response as { additional_kwargs?: { reasoning_content?: unknown } } | undefined)
    ?.additional_kwargs?.reasoning_content;
  return typeof value === "string" && value !== "" ? value : undefined;
}

export async function invokeTools(
  model: BaseChatModel,
  messages: BaseMessage[],
  options: ToolsOptions = {},
): Promise<Proposals> {
  const settings = options.settings ?? loadSettings();
  const invokeOptions = options.callbacks !== undefined ? { callbacks: options.callbacks } : undefined;
  const retries = options.retries ?? settings.llmRetries;
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  const allowed =
    options.allowedTools !== undefined
      ? new Set(options.allowedTools)
      : undefined;
  const tools =
    allowed !== undefined
      ? PROPOSAL_TOOLS.filter((tool) => allowed.has(tool.function.name))
      : PROPOSAL_TOOLS;

  let maxTokens: number | undefined;
  let raised = 0;
  let reasoningOff = false;
  let reasoningFallback = false;
  let repair: HumanMessage | undefined;
  for (;;) {
    const base =
      (maxTokens !== undefined || reasoningOff) && options.rebuild !== undefined
        ? options.rebuild(maxTokens ?? settings.maxTokens, reasoningOff ? { reasoningOff: true } : undefined)
        : model;
    const target = base as unknown as ToolCallingModel;
    // No `tool_choice`: forcing `required` routes the meta-provider to thinking upstreams that
    // either reject it or are rate-limited (docs/state_testing §7). The prompt asks for a call;
    // a text reply is handled by the one-repair round below.
    const bound =
      typeof target.bindTools === "function" ? target.bindTools(tools as unknown[]) : target;
    let response: unknown;
    try {
      response = await invokeWithRetry(
        bound,
        repair === undefined ? messages : [...messages, repair],
        invokeOptions,
        settings.streaming,
        retries,
        retryDelayMs,
        options.onError,
      );
    } catch (error) {
      // Cross-subcontractor routing: the previous turn has no reasoning to echo back, so this
      // thinking-mode route cannot serve the request. Retry once with thinking disabled.
      if (!reasoningFallback && !reasoningOff && options.rebuild !== undefined && isReasoningContentRequired(error)) {
        reasoningFallback = true;
        reasoningOff = true;
        continue;
      }
      throw error;
    }
    options.onResponse?.(response);
    const calls = toolCallsOf(response);
    if (calls.length > 0) {
      try {
        // Every call in the message is a move; the engine decides and runs them in order.
        const actions = calls.map((call) => toProposal(call.name, call.args, "").action);
        const reasoning = reasoningOf(response);
        return { thought: messageText(response), actions, ...(reasoning !== undefined ? { reasoning } : {}) };
      } catch (error) {
        // A malformed call (unknown tool, args that fail the schema) gets one repair round,
        // as the JSON path does, instead of sinking the whole run as `llm_error`.
        if (repair !== undefined) throw error;
        repair = new HumanMessage(
          `Your tool call was invalid (${error instanceof Error ? error.message : String(error)}). Call one or more tools with valid arguments matching their schemas.`,
        );
        continue;
      }
    }
    // No tool call. A response cut at the completion cap means the model burned the whole
    // completion budget on hidden reasoning (a live fix-ocaml-gc run: 8192, then even 32768,
    // tokens of reasoning with no call). Retry ONCE — but do NOT raise the cap (a bigger
    // budget only invites more reasoning). Rebuild with reasoning DISABLED so the model must
    // answer with a call, and add a brevity note. Any other no-call gets one repair round.
    if (finishReason(response) === "length") {
      if (raised === 0) {
        raised = 1;
        reasoningOff = true;
        repair = new HumanMessage(
          "Your last reply was cut off by the length limit — that is excessive reasoning. Call one or more tools now, with minimal reasoning; do not restate analysis.",
        );
        continue;
      }
      throw new Error("model returned no tool call");
    }
    if (repair !== undefined) throw new Error("model returned no tool call");
    repair = new HumanMessage(
      "You did not call a tool. Call one or more of the provided tools.",
    );
  }
}
