import type {
  LanguageModelV3GenerateResult,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import { loadSettings } from "../src/config/settings";
import { modelPlannerAgent } from "../src/llm/planner";

const usage = (): LanguageModelV3Usage => ({
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
  raw: { prompt_tokens: 1, completion_tokens: 1 },
});

const finish = (unified: LanguageModelV3GenerateResult["finishReason"]["unified"]) => ({
  unified,
  raw: unified,
});

const textReply = (
  text: string,
  reason: LanguageModelV3GenerateResult["finishReason"]["unified"] = "stop",
): LanguageModelV3GenerateResult => ({
  content: [{ type: "text", text }],
  finishReason: finish(reason),
  usage: usage(),
  warnings: [],
});

const planReply = (): LanguageModelV3GenerateResult => ({
  content: [
    {
      type: "tool-call",
      toolCallId: "c1",
      toolName: "submit_plan",
      input: JSON.stringify({
        summary: "Add Z3",
        items: [{ title: "Implement", detail: "Do it.", kind: "task" }],
      }),
    },
  ],
  finishReason: finish("tool-calls"),
  usage: usage(),
  warnings: [],
});

const offline = {
  ...loadSettings(),
  streaming: false,
  maxTokens: 4096,
  maxTokensCeiling: 16384,
  maxTokensBumps: 2,
};

describe("planner model agent", () => {
  it("retries a length-truncated reply with reasoning disabled", async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls += 1;
        return calls === 1 ? textReply("", "length") : planReply();
      },
    });
    const rebuilt: { reasoningOff?: boolean }[] = [];

    const reply = await modelPlannerAgent(model, {
      settings: offline,
      rebuild: (rebuildOptions) => {
        rebuilt.push(rebuildOptions ?? {});
        return model;
      },
    })([{ role: "system", content: "plan the work" }], { final: true });

    expect(reply.calls.map((call) => call.name)).toEqual(["submit_plan"]);
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(rebuilt).toEqual([{ reasoningOff: true }]);
    // The output cap is unchanged: only reasoning is turned off.
    expect(model.doGenerateCalls[1]?.maxOutputTokens).toBe(4096);
  });
});
