import { describe, expect, it } from "vitest";

import { AIMessage } from "@langchain/core/messages";

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

  it("copies the provider's reasoning field onto reasoning_content (LangChain's name)", () => {
    const json = { choices: [{ message: { role: "assistant", content: "ok", reasoning: "hmm" } }] };
    openaiCompatible.fromWire(json);
    expect(json.choices[0]?.message).toMatchObject({ reasoning_content: "hmm", reasoning: "hmm" });
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
      const settings = loadSettings({ SKEIN_API_URL: "http://127.0.0.1:1/v1", SKEIN_API_KEY: "probe", SKEIN_MODEL: "probe" });
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
