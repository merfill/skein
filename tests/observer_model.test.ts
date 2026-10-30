import type {
  LanguageModelV3GenerateResult,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import { loadSettings } from "../src/config/settings";
import {
  modelRequestObserver,
  observerTools,
  toObserverReply,
} from "../src/llm/observer";

const usage = (): LanguageModelV3Usage => ({
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
  raw: {},
});

const result = (
  content: LanguageModelV3GenerateResult["content"],
  reason: LanguageModelV3GenerateResult["finishReason"]["unified"],
): LanguageModelV3GenerateResult => ({
  content,
  finishReason: { unified: reason, raw: reason },
  usage: usage(),
  warnings: [],
});

const textReply = (text: string): LanguageModelV3GenerateResult =>
  result([{ type: "text", text }], "stop");

const toolReply = (
  calls: { name: string; args: unknown }[],
): LanguageModelV3GenerateResult =>
  result(
    calls.map((call, index) => ({
      type: "tool-call" as const,
      toolCallId: `c${index + 1}`,
      toolName: call.name,
      input: JSON.stringify(call.args),
    })),
    "tool-calls",
  );

function mockModel(
  doGenerate: (call: number) => LanguageModelV3GenerateResult,
) {
  let call = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      call += 1;
      return doGenerate(call);
    },
  });
}

const settings = { ...loadSettings(), streaming: false };

describe("observer model: tools and mapping", () => {
  it("exposes the read-only survey and decision tools", () => {
    expect(Object.keys(observerTools()).sort()).toEqual([
      "attempt",
      "body",
      "halt",
      "hint",
      "memo",
      "outline",
      "rendered",
      "state",
      "turns",
    ]);
  });

  it("maps a decision tool to a reaction", () => {
    expect(
      toObserverReply([
        { toolName: "hint", input: { text: "reuse", evidence: ["o1"], state: "m1" }, toolCallId: "c1" },
      ]),
    ).toEqual({
      decision: { kind: "hint", text: "reuse", evidence: ["o1"], state: "m1" },
    });
  });

  it("maps survey calls to tool calls", () => {
    expect(
      toObserverReply([
        { toolName: "state", input: { id: "m1" }, toolCallId: "c1" },
      ]),
    ).toEqual({
      toolCalls: [{ name: "state", args: { id: "m1" }, callId: "c1" }],
    });
  });
});

describe("observer model: the call", () => {
  it("returns a decision from a tool call", async () => {
    const model = mockModel(() =>
      toolReply([
        { name: "memo", args: { text: "keep", evidence: ["r1"] } },
      ]),
    );
    const reply = await modelRequestObserver(model, { settings })([
      { role: "system", content: "observe" },
    ]);
    expect(reply.decision).toEqual({ kind: "memo", text: "keep", evidence: ["r1"] });
  });

  it("returns a survey call for the runner to execute", async () => {
    const model = mockModel(() => toolReply([{ name: "turns", args: { id: "m1" } }]));
    const reply = await modelRequestObserver(model, { settings })([
      { role: "system", content: "observe" },
    ]);
    expect(reply.toolCalls).toEqual([
      { name: "turns", args: { id: "m1" }, callId: "c1" },
    ]);
  });

  it("repairs a text-only reply once", async () => {
    const model = mockModel((call) =>
      call === 1
        ? textReply("I think it is looping")
        : toolReply([{ name: "halt", args: { reason: "loop" } }]),
    );
    const reply = await modelRequestObserver(model, { settings })([
      { role: "system", content: "observe" },
    ]);
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(reply.decision).toEqual({ kind: "halt", reason: "loop" });
  });

  it("repairs invalid decision arguments once", async () => {
    const model = mockModel((call) =>
      call === 1
        ? toolReply([{ name: "hint", args: { text: "missing evidence", state: "m1" } }])
        : toolReply([{ name: "halt", args: { reason: "cannot decide" } }]),
    );
    const reply = await modelRequestObserver(model, { settings })([
      { role: "system", content: "observe" },
    ]);
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(reply.decision).toEqual({ kind: "halt", reason: "cannot decide" });
  });
});
