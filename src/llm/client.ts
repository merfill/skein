import { ChatOpenAI } from "@langchain/openai";

import { loadSettings, type Settings } from "../config/settings";
import { openaiCompatible } from "./provider";

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

// A `fetch` that normalizes reasoning both ways around the real HTTP call, so the hidden
// reasoning round-trips even though langchain-openai neither maps RouterAI's `reasoning` field
// on the response nor forwards a per-message reasoning field on the request (`provider.ts`).
// Non-streaming only: the body is a single JSON object, not an SSE stream.
function reasoningFetch(
  baseFetch: typeof fetch,
  onResponseBody: ((body: unknown) => void) | undefined,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // Outbound: the projection carries the turn's reasoning as the assistant tool message's
    // text; move it into the provider's field before the SDK serializes the body.
    let outgoing = init;
    if (typeof init?.body === "string") {
      try {
        const body = JSON.parse(init.body) as Parameters<typeof reasoning.toWire>[0];
        reasoning.toWire(body);
        outgoing = { ...init, body: JSON.stringify(body) };
      } catch {
        // A non-JSON body is passed through untouched.
      }
    }
    const response = await baseFetch(input, outgoing);
    // Inbound: normalize the provider's reasoning field to the name langchain-openai maps,
    // then hand the rewritten body to its parser.
    let json: Parameters<typeof reasoning.fromWire>[0];
    try {
      json = (await response.clone().json()) as Parameters<typeof reasoning.fromWire>[0];
    } catch {
      // A non-JSON body (an error page, an empty stream) is passed through untouched.
      return response;
    }
    reasoning.fromWire(json);
    onResponseBody?.(json);
    const headers = new Headers(response.headers);
    // The body is re-serialized, so the original length/encoding headers no longer hold.
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.delete("transfer-encoding");
    return new Response(JSON.stringify(json), { status: response.status, statusText: response.statusText, headers });
  }) as typeof fetch;
}

// The reasoning-off path (`SKEIN_REASONING_TAPE=false`): read the raw response body for
// telemetry only, leaving request and response otherwise untouched.
function telemetryFetch(
  baseFetch: typeof fetch,
  onResponseBody: ((body: unknown) => void) | undefined,
): typeof fetch {
  if (onResponseBody === undefined) return baseFetch;
  const hook = onResponseBody;
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const response = await baseFetch(input, init);
    void response
      .clone()
      .json()
      .then(hook)
      .catch(() => undefined);
    return response;
  }) as typeof fetch;
}

export function createChatModel(settings: Settings = loadSettings(), hooks: ChatModelHooks = {}): ChatOpenAI {
  const configuration: { baseURL: string; fetch?: typeof fetch } = {
    baseURL: settings.apiUrl,
    fetch: settings.reasoningTape
      ? reasoningFetch(globalThis.fetch, hooks.onResponseBody)
      : telemetryFetch(globalThis.fetch, hooks.onResponseBody),
  };
  return new ChatOpenAI({
    apiKey: settings.apiKey,
    model: settings.model,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    configuration,
    modelKwargs: reasoningBody(settings.reasoningEffort),
  });
}
