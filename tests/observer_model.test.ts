import type {
  LanguageModelV3GenerateResult,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import { TurnMeter } from "../bench/metrics";
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
  it("exposes only the decision tools", () => {
    expect(Object.keys(observerTools()).sort()).toEqual(["halt", "hint", "memo"]);
  });

  it("maps a decision tool to a reaction proposal without a state", () => {
    expect(
      toObserverReply([
        { toolName: "hint", input: { text: "reuse", evidence: ["o1"] }, toolCallId: "c1" },
      ]),
    ).toEqual({
      decision: { kind: "hint", text: "reuse", evidence: ["o1"] },
    });
  });

  it("drops a survey call: there are no survey tools any more", () => {
    // A call the model still tries (out of habit) is not a decision and not a survey.
    expect(
      toObserverReply([{ toolName: "state", input: { id: "m1" }, toolCallId: "c1" }]),
    ).toEqual({});
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

  it("returns nothing for a call to a tool that no longer exists", async () => {
    const model = mockModel(() => toolReply([{ name: "state", args: { id: "m1" } }]));
    const reply = await modelRequestObserver(model, { settings })([
      { role: "system", content: "observe" },
    ]);
    expect(reply.decision).toBeUndefined();
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
        ? toolReply([{ name: "hint", args: { text: "missing evidence" } }])
        : toolReply([{ name: "halt", args: { reason: "cannot decide" } }]),
    );
    const reply = await modelRequestObserver(model, { settings })([
      { role: "system", content: "observe" },
    ]);
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(reply.decision).toEqual({ kind: "halt", reason: "cannot decide" });
  });

  // The observer's model calls run through the same transport as the task agent's, so a run's
  // token and cost totals include the advice it received. Asserted on the real meter: a stub
  // handler proves only that a callback was called, not that the numbers arrive.
  it("reports usage to the shared handlers", async () => {
    const meter = new TurnMeter();
    const model = mockModel(() => toolReply([{ name: "halt", args: { reason: "loop" } }]));
    await modelRequestObserver(model, { settings, usageHandlers: [meter] })([
      { role: "system", content: "observe" },
    ]);
    expect(meter.calls).toBe(1);
    expect(meter.inputTokens).toBe(1);
    expect(meter.outputTokens).toBe(1);
    expect(meter.usage).toHaveLength(1);
  });
});
