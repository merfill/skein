import { describe, expect, it } from "vitest";

import { AIMessage, AIMessageChunk } from "@langchain/core/messages";

import { loadSettings } from "../src/config/settings";
import { createChatModel } from "../src/llm/client";
import { openaiCompatible } from "../src/llm/provider";

// The provider seam: the hidden reasoning round-trips even though langchain-openai does not map
// RouterAI's `reasoning` (response) nor forward a per-message reasoning field (request).

describe("reasoning adapter (openai-compatible)", () => {
  it("relocates an assistant tool message's reasoning text to reasoning_content", () => {
    const body = {
      messages: [
        { role: "system", content: "base" },
        { role: "assistant", content: "Start state Localization" },
        { role: "assistant", content: "the tail advance looks wrong", tool_calls: [{ id: "a1" }] },
        { role: "tool", content: "exit 0", tool_call_id: "a1" },
      ],
    };
    openaiCompatible.toWire(body);
    // A state marker (text, no tool_calls) is never a reasoning carrier.
    expect(body.messages[1]).toMatchObject({ content: "Start state Localization" });
    // The assistant tool turn's text becomes the provider's reasoning field.
    expect(body.messages[2]).toMatchObject({ content: "", reasoning_content: "the tail advance looks wrong" });
    // A tool result is untouched.
    expect(body.messages[3]).toMatchObject({ content: "exit 0" });
  });

  it("leaves an assistant message with text but no tool_calls untouched", () => {
    const body = { messages: [{ role: "assistant", content: "Finish state Localization — done" }] };
    openaiCompatible.toWire(body);
    expect(body.messages[0]).toMatchObject({ content: "Finish state Localization — done" });
    expect(body.messages[0]).not.toHaveProperty("reasoning_content");
  });

  it("passes an empty reasoning_content back for a tool turn with no reasoning", () => {
    const body = { messages: [{ role: "assistant", content: "", tool_calls: [{ id: "a1" }] }] };
    openaiCompatible.toWire(body);
    expect(body.messages[0]).toMatchObject({ content: "", reasoning_content: "" });
  });

  it("copies the provider's reasoning field onto reasoning_content (LangChain's name)", () => {
    const json = { choices: [{ message: { role: "assistant", content: "ok", reasoning: "hmm" } }] };
    openaiCompatible.fromWire(json);
    expect(json.choices[0]?.message).toMatchObject({ reasoning_content: "hmm", reasoning: "hmm" });
  });

  it("copies the provider's per-delta reasoning onto reasoning_content (streaming)", () => {
    const chunk = { choices: [{ delta: { reasoning: "hmm" } }] };
    openaiCompatible.fromChunk(chunk);
    expect(chunk.choices[0]?.delta).toMatchObject({ reasoning_content: "hmm", reasoning: "hmm" });
  });

  it("keeps an existing delta reasoning_content", () => {
    const chunk = { choices: [{ delta: { reasoning_content: "canonical" } }] };
    openaiCompatible.fromChunk(chunk);
    expect(chunk.choices[0]?.delta).toMatchObject({ reasoning_content: "canonical" });
  });

  it("keeps an existing reasoning_content", () => {
    const json = { choices: [{ message: { role: "assistant", content: "ok", reasoning_content: "canonical" } }] };
    openaiCompatible.fromWire(json);
    expect(json.choices[0]?.message).toMatchObject({ reasoning_content: "canonical" });
  });
});

describe("reasoning survives createChatModel's fetch", () => {
  it("moves the turn's reasoning onto reasoning_content out, and reads it back in", async () => {
    const realFetch = globalThis.fetch;
    let outgoing: { messages?: { role?: string; content?: unknown; reasoning_content?: unknown }[] } = {};
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      outgoing = JSON.parse(String(init?.body ?? "{}"));
      const body = {
        id: "x",
        object: "chat.completion",
        created: 0,
        model: "probe",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok", reasoning: "why the move" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const settings = loadSettings({
        SKEIN_API_URL: "http://127.0.0.1:1/v1",
        SKEIN_API_KEY: "probe",
        SKEIN_MODEL: "probe",
        SKEIN_STREAMING: "false",
      });
      const model = createChatModel(settings);
      const reply = await model.invoke([
        new AIMessage({
          content: "the reasoning of the turn",
          tool_calls: [{ name: "bash", args: { command: "ls" }, id: "a1", type: "tool_call" }],
        }),
      ]);
      const sent = outgoing.messages ?? [];
      expect(sent[0]).toMatchObject({ role: "assistant", content: "", reasoning_content: "the reasoning of the turn" });
      expect((reply as AIMessage).additional_kwargs.reasoning_content).toBe("why the move");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// An SSE body as the provider emits it: one `data:` JSON chunk per event, reasoning on the
// delta (`delta.reasoning`), tool-call arguments split across chunks, `[DONE]` last.
function sseResponse(...chunks: unknown[]): Response {
  const body = chunks
    .map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}\n\n`)
    .join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("reasoning survives createChatModel's streaming fetch", () => {
  it("renames delta.reasoning, reassembles tool calls, and taps a full body", async () => {
    const realFetch = globalThis.fetch;
    let outgoing: { stream?: unknown; messages?: { role?: string; content?: unknown; reasoning_content?: unknown }[] } = {};
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      outgoing = JSON.parse(String(init?.body ?? "{}"));
      return sseResponse(
        { id: "x", model: "probe", choices: [{ index: 0, delta: { role: "assistant", reasoning: "why the move" }, finish_reason: null }] },
        {
          id: "x",
          model: "probe",
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, id: "a1", type: "function", function: { name: "bash", arguments: '{"command":' } }] },
              finish_reason: null,
            },
          ],
        },
        {
          id: "x",
          model: "probe",
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }, finish_reason: null }],
        },
        {
          id: "x",
          model: "probe",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
        "[DONE]",
      );
    }) as typeof fetch;
    const captured: unknown[] = [];
    try {
      const settings = loadSettings({ SKEIN_API_URL: "http://127.0.0.1:1/v1", SKEIN_API_KEY: "probe", SKEIN_MODEL: "probe" });
      const model = createChatModel(settings, { onResponseBody: (body) => captured.push(body) });
      // Stream the call as the engine does (`invokeTools` drains `model.stream`).
      let reply: AIMessageChunk | undefined;
      for await (const chunk of await model.stream([
        new AIMessage({
          content: "the reasoning of the turn",
          tool_calls: [{ name: "bash", args: { command: "ls" }, id: "a1", type: "tool_call" }],
        }),
      ])) {
        const next = chunk as AIMessageChunk;
        reply = reply === undefined ? next : reply.concat(next);
      }
      // The streamed request carries reasoning relocated to the provider field.
      expect(outgoing.stream).toBe(true);
      expect(outgoing.messages?.[0]).toMatchObject({ role: "assistant", content: "", reasoning_content: "the reasoning of the turn" });
      // The assembled message carries the provider's reasoning and the reassembled tool call.
      expect(reply?.additional_kwargs.reasoning_content).toBe("why the move");
      expect(reply?.tool_calls?.[0]).toMatchObject({ name: "bash", args: { command: "ls" } });
      // The telemetry hook receives one non-stream-shaped body.
      expect(captured).toHaveLength(1);
      const message = (captured[0] as { choices?: { message?: { reasoning?: unknown; tool_calls?: unknown[] } }[] })
        .choices?.[0]?.message;
      expect(message?.reasoning).toBe("why the move");
      expect(Array.isArray(message?.tool_calls)).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
