import { ChatOpenAI } from "@langchain/openai";

import { loadSettings, type Settings } from "../config/settings";
import { openaiCompatible, type ReasoningAdapter, type WireBody, type WireChunk, type WireResponse } from "./provider";

/**
 * Provider body that turns reasoning off. DeepSeek needs `thinking.type` and
 * RouterAI needs a zero reasoning budget; both are mirrored from Ankyra.
 */
export function reasoningOffBody(effort: string): Record<string, unknown> {
  return {
    thinking: { type: "disabled" },
    reasoning: { effort },
  };
}

/**
 * Provider body for the reasoning budget. With `effort === "none"` reasoning is
 * explicitly disabled; otherwise RouterAI's `reasoning.effort` enables it (the
 * DeepSeek native `thinking.type` is left unset so the provider decides). A hard
 * coding task driven without reasoning fails far more often (see the focus/OCaml
 * fix investigation), so reasoning is the default.
 */
export function reasoningBody(effort: string): Record<string, unknown> {
  return effort === "none" ? reasoningOffBody(effort) : { reasoning: { effort } };
}

export interface ChatModelHooks {
  // The (normalized) provider response body of every (non-streaming) call: telemetry that the
  // parsed LangChain message still drops, such as the hidden reasoning text.
  onResponseBody?: (body: unknown) => void;
}

// The reasoning seam: RouterAI (and any OpenAI-compatible backend) is the current provider.
const reasoning = openaiCompatible;

// --- Streaming (SSE) reasoning seam -----------------------------------------
// A streamed call returns `text/event-stream`, one `data: {...}` chunk per event, so it cannot
// be read as one JSON object. The adapter's per-delta hook (`fromChunk`) renames the provider's
// reasoning as the chunks flow, and the same pass reassembles the full response (reasoning /
// content / tool calls / finish / usage) so the `onResponseBody` telemetry hook keeps receiving
// a non-stream-shaped body.

interface StreamState {
  reasoning: string;
  content: string;
  toolCalls: Map<number, { id?: string; name: string; args: string }>;
  finishReason?: string;
  usage?: unknown;
  id?: unknown;
  model?: unknown;
}

function accumulate(state: StreamState, chunk: WireChunk): void {
  if (state.id === undefined && chunk.id !== undefined) state.id = chunk.id;
  if (state.model === undefined && chunk.model !== undefined) state.model = chunk.model;
  if (chunk.usage != null) state.usage = chunk.usage;
  for (const choice of chunk.choices ?? []) {
    if (typeof choice.finish_reason === "string") state.finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (delta === undefined) continue;
    // `fromChunk` has already copied `delta.reasoning` onto `reasoning_content` when the tape
    // adapter is on; when it is off the provider field is read directly for telemetry.
    const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoningDelta === "string") state.reasoning += reasoningDelta;
    if (typeof delta.content === "string") state.content += delta.content;
    const calls = delta.tool_calls;
    if (Array.isArray(calls)) {
      for (const call of calls as { index?: number; id?: unknown; function?: { name?: unknown; arguments?: unknown } }[]) {
        const index = call.index ?? 0;
        const current = state.toolCalls.get(index) ?? { name: "", args: "" };
        if (typeof call.id === "string") current.id = call.id;
        if (typeof call.function?.name === "string") current.name += call.function.name;
        if (typeof call.function?.arguments === "string") current.args += call.function.arguments;
        state.toolCalls.set(index, current);
      }
    }
  }
}

// The accumulated stream reshaped as the non-streaming response the telemetry consumers
// expect (`choices[0].message.reasoning`, `choices[0].finish_reason`).
function reassemble(state: StreamState): WireResponse {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: state.content,
    reasoning: state.reasoning,
    reasoning_content: state.reasoning,
  };
  if (state.toolCalls.size > 0) {
    message.tool_calls = [...state.toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({
        ...(call.id !== undefined ? { id: call.id } : {}),
        type: "function",
        function: { name: call.name, arguments: call.args },
      }));
  }
  const choice: Record<string, unknown> = { index: 0, message };
  if (state.finishReason !== undefined) choice.finish_reason = state.finishReason;
  const body: Record<string, unknown> = { choices: [choice] };
  if (state.id !== undefined) body.id = state.id;
  if (state.model !== undefined) body.model = state.model;
  if (state.usage != null) body.usage = state.usage;
  return body as WireResponse;
}

// Rewrite one SSE line: a `data:` JSON chunk gets its reasoning normalized (`adapter`) and is
// accumulated; every other line (comments, blank separators) passes through. The `[DONE]`
// sentinel marks a complete stream: the hook fires there (not only on `flush`, which the SDK
// skips when it cancels the stream at `[DONE]`).
function handleSseLine(
  line: string,
  adapter: ReasoningAdapter | undefined,
  state: StreamState,
  complete: () => void,
): string {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("data:")) return line;
  const payload = trimmed.slice(5).trim();
  if (payload === "[DONE]") {
    complete();
    return line;
  }
  if (payload === "") return line;
  let chunk: WireChunk;
  try {
    chunk = JSON.parse(payload) as WireChunk;
  } catch {
    return line;
  }
  adapter?.fromChunk(chunk);
  accumulate(state, chunk);
  return adapter === undefined ? line : `data: ${JSON.stringify(chunk)}`;
}

// Pipe an SSE body through the line rewrite, accumulating state as it flows. The reassembled
// body is handed to the telemetry hook once per call — on `[DONE]`, or on `flush` if the
// provider ended the stream without the sentinel.
function transformSse(
  body: ReadableStream<Uint8Array>,
  adapter: ReasoningAdapter | undefined,
  onResponseBody: ((body: unknown) => void) | undefined,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const state: StreamState = { reasoning: "", content: "", toolCalls: new Map() };
  let buffer = "";
  let fired = false;
  const complete = (): void => {
    if (fired) return;
    fired = true;
    onResponseBody?.(reassemble(state));
  };
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, "");
          buffer = buffer.slice(index + 1);
          controller.enqueue(encoder.encode(`${handleSseLine(line, adapter, state, complete)}\n`));
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer !== "") controller.enqueue(encoder.encode(handleSseLine(buffer, adapter, state, complete)));
        complete();
      },
    }),
  );
}

// A `fetch` around the real HTTP call that normalizes reasoning both ways, so the hidden
// reasoning round-trips even though langchain-openai neither maps RouterAI's `reasoning` field
// nor forwards a per-message reasoning field (`provider.ts`). Streaming is detected from the
// outbound body (`stream: true`), since an SSE body cannot be read as one JSON object.
function modelFetch(
  baseFetch: typeof fetch,
  adapter: ReasoningAdapter | undefined,
  onResponseBody: ((body: unknown) => void) | undefined,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // Outbound: the projection carries the turn's reasoning as the assistant tool message's
    // text; move it into the provider's field before the SDK serializes the body.
    let outgoing = init;
    let streaming = false;
    if (typeof init?.body === "string") {
      try {
        const body = JSON.parse(init.body) as WireBody;
        adapter?.toWire(body);
        streaming = body.stream === true;
        outgoing = { ...init, body: JSON.stringify(body) };
      } catch {
        // A non-JSON body is passed through untouched.
      }
    }
    const response = await baseFetch(input, outgoing);
    if (streaming) {
      if (response.body === null || (adapter === undefined && onResponseBody === undefined)) return response;
      const headers = new Headers(response.headers);
      // The body is re-serialized, so the original length/encoding headers no longer hold.
      headers.delete("content-length");
      headers.delete("content-encoding");
      headers.delete("transfer-encoding");
      return new Response(transformSse(response.body, adapter, onResponseBody), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    if (adapter === undefined && onResponseBody === undefined) return response;
    // Inbound: normalize the provider's reasoning field to the name langchain-openai maps,
    // then hand the rewritten body to its parser.
    let json: WireResponse;
    try {
      json = (await response.clone().json()) as WireResponse;
    } catch {
      // A non-JSON body (an error page) is passed through untouched.
      return response;
    }
    if (adapter === undefined) {
      onResponseBody?.(json);
      return response;
    }
    adapter.fromWire(json);
    onResponseBody?.(json);
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.delete("transfer-encoding");
    return new Response(JSON.stringify(json), { status: response.status, statusText: response.statusText, headers });
  }) as typeof fetch;
}

export function createChatModel(settings: Settings = loadSettings(), hooks: ChatModelHooks = {}): ChatOpenAI {
  const configuration: { baseURL: string; fetch?: typeof fetch } = {
    baseURL: settings.apiUrl,
    fetch: modelFetch(
      globalThis.fetch,
      settings.reasoningTape ? reasoning : undefined,
      hooks.onResponseBody,
    ),
  };
  return new ChatOpenAI({
    apiKey: settings.apiKey,
    model: settings.model,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    streaming: settings.streaming,
    configuration,
    modelKwargs: reasoningBody(settings.reasoningEffort),
  });
}
