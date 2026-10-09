import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { loadSettings } from "../src/config/settings";
import { createChatModel } from "../src/llm/client";
import { invokeStructured, invokeTools } from "../src/llm/structured";
import { toProposal } from "../src/llm/tools";
import { runAgent } from "../src/loop/graph";
import { fsWorkspace } from "../src/tools/workspace";

// Structured output is plain JSON: the schema is in the prompt and the reply is parsed
// manually, with a raised cap on a completion cut and one repair round on a schema
// violation (docs/testing_ru.md §8.1). These tests drive it with a fake model — no network.

const schema = z.object({
  thought: z.string(),
  action: z.object({ operator: z.literal("noop") }),
});
const valid = { thought: "t", action: { operator: "noop" } };

interface FakeModel {
  maxTokens?: number;
  configs: Record<string, unknown>[];
  jsonCalls: unknown[][];
  withConfig?: (config: Record<string, unknown>) => FakeModel;
  invoke: (messages: unknown, options?: unknown) => Promise<unknown>;
}

function asModel(fake: FakeModel): BaseChatModel {
  return fake as unknown as BaseChatModel;
}

// A fake whose json body is scripted (by call number); `withConfig` records the kwargs so a
// test can assert `response_format`/`max_tokens`, and routes to the json body. It has no
// `bind`: LangChain v1 dropped `Runnable.bind`.
function fakeModel(script: {
  json?: (call: number) => Promise<unknown>;
  plain?: () => Promise<unknown>;
  maxTokens?: number;
}): FakeModel {
  let call = 0;
  const model: FakeModel = {
    maxTokens: script.maxTokens,
    configs: [],
    jsonCalls: [],
    withConfig: (config) => {
      model.configs.push(config);
      return {
        maxTokens: (config.max_tokens as number | undefined) ?? model.maxTokens,
        configs: model.configs,
        jsonCalls: model.jsonCalls,
        withConfig: model.withConfig,
        invoke: async (messages) => {
          model.jsonCalls.push(messages as unknown[]);
          call += 1;
          if (!script.json) throw new Error("json body missing");
          return script.json(call);
        },
      };
    },
    invoke: async () => {
      if (!script.plain) throw new Error("plain body missing");
      return script.plain();
    },
  };
  return model;
}

const content = (value: unknown) => ({ content: JSON.stringify(value) });
const lengthLimit = () =>
  Promise.reject(new Error("Could not parse response content as the length limit was reached"));
// A response cut off at the completion cap: valid JSON prefix, no closing brace.
const truncated = '{"thought":"t","action":{"operator":"noop"';

describe("invokeStructured", () => {
  it("returns a valid JSON object and asks for json_object", async () => {
    const model = fakeModel({ json: async () => content(valid) });
    await expect(invokeStructured(asModel(model), schema, [])).resolves.toEqual(valid);
    expect(model.configs[0]?.response_format).toEqual({ type: "json_object" });
  });

  it("strips markdown fences and surrounding prose", async () => {
    const model = fakeModel({
      json: async () => ({ content: "Here you go:\n```json\n" + JSON.stringify(valid) + "\n```\n" }),
    });
    await expect(invokeStructured(asModel(model), schema, [])).resolves.toEqual(valid);
  });

  it("raises max_tokens on a truncated body and retries with a rebuilt model", async () => {
    const model = fakeModel({
      json: async (call) => ({ content: call === 1 ? truncated : JSON.stringify(valid) }),
      maxTokens: 4096,
    });
    const rebuilt: number[] = [];
    const result = await invokeStructured(asModel(model), schema, [], {
      // Pin the base cap: the bump doubles `settings.maxTokens`, so it must not depend on
      // the developer's `.env`.
      settings: { ...loadSettings(), maxTokens: 4096 },
      rebuild: (maxTokens) => {
        rebuilt.push(maxTokens);
        return asModel(model);
      },
    });
    expect(result).toEqual(valid);
    expect(rebuilt).toEqual([8192]);
  });

  it("raises max_tokens on a provider length-limit error", async () => {
    const model = fakeModel({
      json: async (call) => (call === 1 ? lengthLimit() : content(valid)),
      maxTokens: 4096,
    });
    const rebuilt: number[] = [];
    await expect(
      invokeStructured(asModel(model), schema, [], {
        settings: { ...loadSettings(), maxTokens: 4096 },
        rebuild: (maxTokens) => {
          rebuilt.push(maxTokens);
          return asModel(model);
        },
      }),
    ).resolves.toEqual(valid);
    expect(rebuilt).toEqual([8192]);
  });

  it("repairs once when the JSON parses but violates the schema", async () => {
    const model = fakeModel({
      json: async (call) => content(call === 1 ? { thought: "t" } : valid),
    });
    const result = await invokeStructured(asModel(model), schema, []);
    expect(result).toEqual(valid);
    // The repair turn adds a message (the validator's complaint) to the same prompt.
    expect(model.jsonCalls[1]?.length ?? 0).toBeGreaterThan(model.jsonCalls[0]?.length ?? 0);
  });

  it("works with a model that has no withConfig", async () => {
    const model: FakeModel = {
      configs: [],
      jsonCalls: [],
      invoke: async () => content(valid),
    };
    await expect(invokeStructured(asModel(model), schema, [])).resolves.toEqual(valid);
  });

  it("throws only after the fallbacks are exhausted", async () => {
    const model = fakeModel({
      json: () => Promise.reject(new Error("json failed")),
      plain: () => Promise.reject(new Error("plain failed")),
    });
    await expect(invokeStructured(asModel(model), schema, [])).rejects.toThrow("plain failed");
  });

  it("is size-agnostic: a large context is passed through unchanged", async () => {
    const big = "x".repeat(40_000);
    const model = fakeModel({ json: async () => content(valid) });
    await expect(invokeStructured(asModel(model), schema, [big as never])).resolves.toEqual(valid);
  });
});

describe("runAgent on a broken model", () => {
  it("stops with llm_error instead of throwing", async () => {
    const root = mkdtempSync(join(tmpdir(), "skein-llm-error-"));
    const workspace = fsWorkspace(root);
    const result = await runAgent(
      {
        propose: () => Promise.reject(new Error("length limit")),
        workspace,
        maxTurns: 5,
      },
      { request: { id: "r1", text: "green" } },
    );
    expect(result.stopReason).toBe("llm_error");
    expect(result.done).toBe(true);
  });
});

// Native tool calling: the flat tool call is mapped into the IR Action (docs/testing_ru.md §8.1).
describe("tool calling", () => {
  it("maps a flat tool call into the IR Action", () => {
    expect(toProposal("write", { path: "a.txt", content: "hi" }, "t").action).toEqual({
      operator: "apply",
      action: { tool: "write", path: "a.txt", content: "hi" },
    });
    expect(toProposal("run", { target: "w:goal:1" }, "t").action).toEqual({
      operator: "apply",
      action: { tool: "run", target: "w:goal:1" },
    });
    expect(toProposal("fetch", { url: "http://x/y" }, "t").action).toEqual({
      operator: "apply",
      action: { tool: "fetch", url: "http://x/y" },
    });
    expect(toProposal("apply_patch", { patch: "--- a/x\n+++ b/x\n" }, "t").action).toEqual({
      operator: "apply",
      action: { tool: "apply_patch", patch: "--- a/x\n+++ b/x\n" },
    });
    expect(() => toProposal("nope", {}, "t")).toThrow(/unknown tool/);
  });

  it("invokeTools reads the first tool call and the message text", async () => {
    const model = {
      bindTools: () => ({
        invoke: async () => ({ content: "do it", tool_calls: [{ name: "read", args: { path: "a" } }] }),
      }),
      invoke: async () => {
        throw new Error("must use the bound model");
      },
    } as unknown as BaseChatModel;
    const proposal = await invokeTools(model, [new HumanMessage("go")]);
    expect(proposal.thought).toBe("do it");
    expect(proposal.action).toEqual({ operator: "apply", action: { tool: "read", path: "a" } });
  });

  it("invokeTools repairs once when the model called no tool", async () => {
    let calls = 0;
    const model = {
      bindTools: () => ({
        invoke: async () => {
          calls += 1;
          return calls === 1 ? { content: "thinking", tool_calls: [] } : { content: "", tool_calls: [{ name: "list", args: {} }] };
        },
      }),
      invoke: async () => {
        throw new Error("must use the bound model");
      },
    } as unknown as BaseChatModel;
    const proposal = await invokeTools(model, [new HumanMessage("go")]);
    expect(calls).toBe(2);
    expect(proposal.action).toEqual({ operator: "apply", action: { tool: "list" } });
  });

  it("invokeTools raises the completion cap on a truncated no-tool response", async () => {
    const caps: number[] = [];
    let calls = 0;
    const makeModel = (): unknown => ({
      bindTools: () => ({
        invoke: async () => {
          calls += 1;
          return calls === 1
            ? { content: "", tool_calls: [], response_metadata: { finish_reason: "length" } }
            : { content: "", tool_calls: [{ name: "list", args: {} }] };
        },
      }),
    });
    const model = makeModel() as unknown as BaseChatModel;
    const settings = loadSettings();
    const rebuild = (maxTokens: number) => {
      caps.push(maxTokens);
      return makeModel() as unknown as BaseChatModel;
    };
    const proposal = await invokeTools(model, [new HumanMessage("go")], { settings, rebuild });
    expect(caps).toHaveLength(1);
    expect(caps[0]).toBeGreaterThan(settings.maxTokens);
    expect(proposal.action).toEqual({ operator: "apply", action: { tool: "list" } });
  });

  it("invokeTools bounds a truncation storm: one brevity retry, then throws", async () => {
    let calls = 0;
    const model = {
      bindTools: () => ({
        invoke: async () => {
          calls += 1;
          return { content: "", tool_calls: [], response_metadata: { finish_reason: "length" } };
        },
      }),
    } as unknown as BaseChatModel;
    // A model that only ever truncates must not loop: one retry at the ceiling with a
    // brevity hint, then give up (a live run turned one `read` into 4 calls / 60.9k tokens).
    await expect(invokeTools(model, [new HumanMessage("go")])).rejects.toThrow();
    expect(calls).toBe(2);
  });

  it("invokeTools repairs once when the tool call is malformed", async () => {
    let calls = 0;
    const model = {
      bindTools: () => ({
        invoke: async () => {
          calls += 1;
          return calls === 1
            ? { content: "", tool_calls: [{ name: "write", args: { path: "a" } }] }
            : { content: "", tool_calls: [{ name: "read", args: { path: "a" } }] };
        },
      }),
      invoke: async () => {
        throw new Error("must use the bound model");
      },
    } as unknown as BaseChatModel;
    const proposal = await invokeTools(model, [new HumanMessage("go")]);
    expect(calls).toBe(2);
    expect(proposal.action).toEqual({ operator: "apply", action: { tool: "read", path: "a" } });
  });
});

// Live smoke test (skipped offline): a real call is the only way to confirm the JSON path
// returns schema-valid output from the deployed provider.
describe.skipIf(!loadSettings().live)("invokeStructured (live)", () => {
  it(
    "returns schema-valid JSON from the real model",
    async () => {
      const settings = loadSettings();
      const model = createChatModel(settings);
      const liveSchema = z.object({ ok: z.boolean(), note: z.string() });
      const messages = [new HumanMessage("Return JSON with ok=true and a one-word note.")];
      const rebuild = (maxTokens: number) => createChatModel({ ...settings, maxTokens });
      await expect(invokeStructured(model, liveSchema, messages, { rebuild })).resolves.toMatchObject({
        ok: true,
      });
      await expect(invokeStructured(model, liveSchema, messages, { rebuild })).resolves.toHaveProperty(
        "note",
      );
    },
    120_000,
  );
});
