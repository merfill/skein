import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";

import { loadSettings, type Settings } from "../config/settings";
import type { Proposal } from "./schemas";
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
  model: StructuredModel,
  schema: z.ZodTypeAny,
  messages: BaseMessage[],
  maxTokens: number | undefined,
  invokeOptions: unknown,
  options: StructuredOptions,
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
    response = await target.invoke(withSchema, invokeOptions);
  } catch (error) {
    if (isCompletionCap(error)) throw error;
    options.onError?.(error, "json");
    response = await base.invoke(withSchema, invokeOptions);
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
        await callJson(target, schema, messages, maxTokens, invokeOptions, options, repair),
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
  // LangChain's `max_tokens` is a constructor field, so raising the completion cap needs a
  // fresh instance; the caller supplies the factory (as in the JSON path).
  rebuild?: (maxTokens: number) => BaseChatModel;
}

interface ToolCallingModel {
  bindTools?(
    tools: unknown[],
    kwargs?: Record<string, unknown>,
  ): { invoke(messages: BaseMessage[], options?: unknown): Promise<unknown> };
  invoke(messages: BaseMessage[], options?: unknown): Promise<unknown>;
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

export async function invokeTools(
  model: BaseChatModel,
  messages: BaseMessage[],
  options: ToolsOptions = {},
): Promise<Proposal> {
  const settings = options.settings ?? loadSettings();
  const ceiling = options.ceiling ?? settings.maxTokensCeiling;
  const bumps = options.bumps ?? settings.maxTokensBumps;
  const invokeOptions = options.callbacks !== undefined ? { callbacks: options.callbacks } : undefined;

  let maxTokens: number | undefined;
  let raised = 0;
  let repair: HumanMessage | undefined;
  for (;;) {
    const base =
      maxTokens !== undefined && options.rebuild !== undefined
        ? options.rebuild(maxTokens)
        : model;
    const target = base as unknown as ToolCallingModel;
    const bound =
      typeof target.bindTools === "function"
        ? target.bindTools(PROPOSAL_TOOLS as unknown[], { tool_choice: "required" })
        : target;
    let response: unknown;
    try {
      response = await bound.invoke(
        repair === undefined ? messages : [...messages, repair],
        invokeOptions,
      );
    } catch (error) {
      options.onError?.(error, "tools");
      throw error;
    }
    options.onResponse?.(response);
    const first = toolCallsOf(response)[0];
    if (first !== undefined) {
      try {
        return toProposal(first.name, first.args, messageText(response));
      } catch (error) {
        // A malformed call (unknown tool, args that fail the schema) gets one repair round,
        // as the JSON path does, instead of sinking the whole run as `llm_error`.
        if (repair !== undefined) throw error;
        repair = new HumanMessage(
          `Your tool call was invalid (${error instanceof Error ? error.message : String(error)}). Call exactly one tool with valid arguments matching its schema.`,
        );
        continue;
      }
    }
    // No tool call. A response cut at the completion cap surfaces exactly as
    // `finish_reason: "length"` and carries no call: retry with a larger budget, as the
    // JSON path does, instead of treating a truncation as a bare no-call. Any other
    // no-call gets one repair round.
    if (finishReason(response) === "length" && raised < bumps) {
      const current = maxTokens ?? settings.maxTokens;
      const next = nextMaxTokens(current, settings.maxTokens, ceiling);
      if (next !== undefined) {
        maxTokens = next;
        raised += 1;
        continue;
      }
    }
    if (repair !== undefined) throw new Error("model returned no tool call");
    repair = new HumanMessage(
      "You did not call a tool. Call exactly one of the provided tools; put a one-sentence thought in the message text first.",
    );
  }
}
