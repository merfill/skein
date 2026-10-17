import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type ModelMessage } from "ai";

import { transformBody } from "../src/llm/client";

// The exact wire messages the provider receives, produced by the real AI SDK conversion path
// (`buildMessages` → `@ai-sdk/openai-compatible`). The transport is a stub `fetch` that
// captures the request body — no network, deterministic. Shared by `messages.test.ts` and
// `tape_contract.test.ts` so the "final JSON" is always the real provider payload.

export interface WireMessage {
  role: string;
  content: unknown;
  reasoning_content?: unknown;
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export async function wire(messages: ModelMessage[]): Promise<WireMessage[]> {
  let captured: { messages: WireMessage[] } | undefined;
  const fetchStub = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    captured = JSON.parse(String(init?.body ?? "{}"));
    const body = {
      id: "x",
      object: "chat.completion",
      created: 0,
      model: "probe",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const provider = createOpenAICompatible({
    name: "routerai",
    apiKey: "probe",
    baseURL: "http://127.0.0.1:1/v1",
    fetch: fetchStub,
    transformRequestBody: (body) => transformBody(body, "low"),
  });
  await generateText({
    model: provider("probe"),
    messages,
    allowSystemInMessages: true,
    maxRetries: 0,
  });
  if (captured === undefined) throw new Error("no request captured");
  return captured.messages;
}

// A compact, readable view of a wire message: the tape's own vocabulary (`role`, `call`,
// `tool_call_id`, text) rather than the provider's verbose envelope. Dynamic ids stay in
// `tool_call_id`/text; a test asserts those with `expect.stringMatching`.
export interface CompactWire {
  role: string;
  content?: string;
  call?: { name: string; args: unknown };
  tool_call_id?: string;
}

export function compact(messages: readonly WireMessage[]): CompactWire[] {
  return messages.map((message) => {
    const content = typeof message.content === "string" ? message.content : "";
    const call = message.tool_calls?.[0];
    return {
      role: message.role,
      ...(content !== "" ? { content } : {}),
      ...(call !== undefined
        ? { call: { name: call.function.name, args: JSON.parse(call.function.arguments || "{}") } }
        : {}),
      ...(message.tool_call_id !== undefined ? { tool_call_id: message.tool_call_id } : {}),
    };
  });
}
