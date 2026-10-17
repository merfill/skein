import { generateText, streamText } from "ai";
import { describe, expect, it } from "vitest";

import { loadSettings, type Settings } from "../src/config/settings";
import { createChatModel, reasoningBody, reasoningOffBody, transformBody } from "../src/llm/client";

// The provider seam: the hidden reasoning round-trips through the AI SDK even though it is not
// part of the OpenAI spec. RouterAI names the response field `reasoning`; the AI SDK reads both
// names, and the assistant `reasoning` part is serialized back as `reasoning_content`.

describe("provider body (openai-compatible)", () => {
  it("relocates an assistant tool turn's empty content and reasoning echo", () => {
    const body = transformBody(
      {
        messages: [
          { role: "system", content: "base" },
          { role: "assistant", content: "Start state Localization" },
          {
            role: "assistant",
            content: null,
            reasoning_content: "the tail advance looks wrong",
            tool_calls: [{ id: "a1" }],
          },
          { role: "assistant", content: null, tool_calls: [{ id: "a2" }] },
          { role: "tool", content: "exit 0", tool_call_id: "a1" },
        ],
      },
      "high",
    );
    const messages = body.messages as Record<string, unknown>[];
    // A state marker (text, no tool_calls) is never a reasoning carrier.
    expect(messages[1]).toMatchObject({ content: "Start state Localization" });
    // The assistant tool turn keeps its reasoning and gets an explicit empty content.
    expect(messages[2]).toMatchObject({ content: "", reasoning_content: "the tail advance looks wrong" });
    // A tool turn with no reasoning echoes an empty field (some subcontractors demand it).
    expect(messages[3]).toMatchObject({ content: "", reasoning_content: "" });
    // A tool result is untouched.
    expect(messages[4]).toMatchObject({ content: "exit 0" });
    // The reasoning budget rides the same body.
    expect(body).toMatchObject({ reasoning: { effort: "high" } });
  });

  it("leaves an assistant message with text but no tool_calls untouched", () => {
    const body = transformBody({ messages: [{ role: "assistant", content: "Finish state Localization — done" }] }, "low");
    expect((body.messages as Record<string, unknown>[])[0]).toMatchObject({
      content: "Finish state Localization — done",
    });
    expect((body.messages as Record<string, unknown>[])[0]).not.toHaveProperty("reasoning_content");
  });

  it("turns reasoning off with the provider's thinking field", () => {
    expect(reasoningOffBody("none")).toEqual({
      thinking: { type: "disabled" },
      reasoning: { effort: "none" },
    });
    expect(reasoningBody("none")).toEqual({
      thinking: { type: "disabled" },
      reasoning: { effort: "none" },
    });
    expect(reasoningBody("high")).toEqual({ reasoning: { effort: "high" } });
  });
});

const probeSettings = loadSettings({
  SKEIN_API_URL: "http://127.0.0.1:1/v1",
  SKEIN_API_KEY: "probe",
  SKEIN_MODEL: "probe",
});

function modelFor(overrides: Partial<Settings> = {}) {
  return createChatModel({ ...probeSettings, ...overrides });
}

describe("reasoning survives createChatModel", () => {
  it("reads the provider's reasoning field and sends the reasoning budget", async () => {
    const realFetch = globalThis.fetch;
    let outgoing: Record<string, unknown> = {};
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      outgoing = JSON.parse(String(init?.body ?? "{}"));
      const body = {
        id: "x",
        object: "chat.completion",
        created: 0,
        model: "probe",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok", reasoning: "why the move" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const model = modelFor({ reasoningEffort: "high" });
      const result = await generateText({
        model,
        messages: [{ role: "user", content: "hi" }],
        allowSystemInMessages: true,
      });
      expect(result.text).toBe("ok");
      expect(result.reasoningText).toBe("why the move");
      expect(outgoing).toMatchObject({ reasoning: { effort: "high" } });
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

describe("reasoning survives createChatModel's streaming transport", () => {
  it("reads streamed reasoning and tool calls, and asks for usage", async () => {
    const realFetch = globalThis.fetch;
    let outgoing: Record<string, unknown> = {};
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      outgoing = JSON.parse(String(init?.body ?? "{}"));
      return sseResponse(
        {
          id: "x",
          model: "probe",
          choices: [{ index: 0, delta: { role: "assistant", reasoning: "why the move" }, finish_reason: null }],
        },
        {
          id: "x",
          model: "probe",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "a1",
                    type: "function",
                    function: { name: "bash", arguments: '{"command":' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: "x",
          model: "probe",
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] },
              finish_reason: null,
            },
          ],
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
    try {
      const model = modelFor({ reasoningEffort: "high" });
      const result = streamText({
        model,
        messages: [{ role: "user", content: "hi" }],
        allowSystemInMessages: true,
      });
      const [text, reasoningText, toolCalls] = await Promise.all([
        result.text,
        result.reasoningText,
        result.toolCalls,
      ]);
      expect(text).toBe("");
      expect(reasoningText).toBe("why the move");
      expect(toolCalls[0]).toMatchObject({ toolName: "bash", input: { command: "ls" } });
      // Streaming is on the wire, with the reasoning budget and the usage opt-in.
      expect(outgoing.stream).toBe(true);
      expect(outgoing.stream_options).toMatchObject({ include_usage: true });
      expect(outgoing).toMatchObject({ reasoning: { effort: "high" } });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
