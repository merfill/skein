import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { TurnMeter } from "../bench/metrics";
import { loadSettings } from "../src/config/settings";
import { createChatModel } from "../src/llm/client";
import { invokeStructured, invokeTools, type ToolsOptions } from "../src/llm/structured";
import { modelCall } from "../src/llm/schemas";
import { toolNamesFor, toProposal } from "../src/llm/tools";
import { runAgent } from "../src/loop/graph";
import { fsWorkspace } from "../src/tools/workspace";

// Structured output is plain JSON: the schema is in the prompt and the reply is parsed
// manually, with a raised cap on a completion cut and one repair round on a schema
// violation (docs/testing_ru.md §8.1). These tests drive it with an AI SDK mock model — no
// network.

const schema = z.object({
  thought: z.string(),
  action: z.object({ operator: z.literal("noop") }),
});
const valid = { thought: "t", action: { operator: "noop" } };

const usage = (input = 1, output = 1, reasoning = 0): LanguageModelV3Usage => ({
  inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: output, text: Math.max(0, output - reasoning), reasoning },
  raw: {
    prompt_tokens: input,
    completion_tokens: output,
    completion_tokens_details: { reasoning_tokens: reasoning },
  },
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

const toolReply = (
  calls: { name: string; args: unknown }[],
  text = "",
  reason: LanguageModelV3GenerateResult["finishReason"]["unified"] = "tool-calls",
  reasoning?: string,
): LanguageModelV3GenerateResult => ({
  content: [
    ...(text !== "" ? [{ type: "text" as const, text }] : []),
    ...(reasoning !== undefined ? [{ type: "reasoning" as const, text: reasoning }] : []),
    ...calls.map((call, index) => ({
      type: "tool-call" as const,
      toolCallId: `c${index + 1}`,
      toolName: call.name,
      input: JSON.stringify(call.args),
    })),
  ],
  finishReason: finish(reason),
  usage: usage(1, 1, reasoning !== undefined ? 1 : 0),
  warnings: [],
});

const offline = { ...loadSettings(), streaming: false };
const agent = (
  model: Parameters<typeof invokeTools>[0],
  messages: Parameters<typeof invokeTools>[1],
  options: ToolsOptions = {},
) => invokeTools(model, messages, { settings: offline, ...options });

const truncated = '{"thought":"t","action":{"operator":"noop"';
const lengthLimit = () =>
  Promise.reject(new Error("Could not parse response content as the length limit was reached"));

function mockModel(doGenerate: (call: number) => LanguageModelV3GenerateResult | Promise<LanguageModelV3GenerateResult>) {
  let call = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      call += 1;
      return doGenerate(call);
    },
  });
}

describe("invokeStructured", () => {
  it("returns a valid JSON object and asks for json_object", async () => {
    const model = mockModel(() => textReply(JSON.stringify(valid)));
    await expect(invokeStructured(model, schema, [], { settings: offline })).resolves.toEqual(valid);
    const options = model.doGenerateCalls[0];
    expect(options?.providerOptions).toMatchObject({
      routerai: { response_format: { type: "json_object" } },
    });
  });

  it("strips markdown fences and surrounding prose", async () => {
    const model = mockModel(() => textReply("Here you go:\n```json\n" + JSON.stringify(valid) + "\n```"));
    await expect(invokeStructured(model, schema, [], { settings: offline })).resolves.toEqual(valid);
  });

  it("raises max_tokens on a truncated body and retries with a rebuilt model", async () => {
    const model = mockModel((call) => textReply(call === 1 ? truncated : JSON.stringify(valid)));
    const rebuilt: number[] = [];
    const result = await invokeStructured(model, schema, [], {
      // Pin the base cap: the bump doubles `settings.maxTokens`, so it must not depend on
      // the developer's `.env`.
      settings: { ...offline, maxTokens: 4096 },
      rebuild: (maxTokens) => {
        rebuilt.push(maxTokens);
        return model;
      },
    });
    expect(result).toEqual(valid);
    expect(rebuilt).toEqual([8192]);
  });

  it("raises max_tokens on a provider length-limit error", async () => {
    const model = mockModel((call) => (call === 1 ? lengthLimit() : textReply(JSON.stringify(valid))));
    const rebuilt: number[] = [];
    await expect(
      invokeStructured(model, schema, [], {
        settings: { ...offline, maxTokens: 4096 },
        rebuild: (maxTokens) => {
          rebuilt.push(maxTokens);
          return model;
        },
      }),
    ).resolves.toEqual(valid);
    expect(rebuilt).toEqual([8192]);
  });

  it("repairs once when the JSON parses but violates the schema", async () => {
    const model = mockModel((call) => textReply(JSON.stringify(call === 1 ? { thought: "t" } : valid)));
    const result = await invokeStructured(model, schema, [], { settings: offline });
    expect(result).toEqual(valid);
    // The repair turn adds a message (the validator's complaint) to the same prompt.
    expect(model.doGenerateCalls[1]?.prompt.length ?? 0).toBeGreaterThan(
      model.doGenerateCalls[0]?.prompt.length ?? 0,
    );
  });

  it("works without a rebuild factory", async () => {
    const model = mockModel(() => textReply(JSON.stringify(valid)));
    await expect(invokeStructured(model, schema, [], { settings: offline })).resolves.toEqual(valid);
  });

  it("throws only after the fallbacks are exhausted", async () => {
    const model = mockModel(() => Promise.reject(new Error("json failed")));
    await expect(invokeStructured(model, schema, [], { settings: offline })).rejects.toThrow("json failed");
  });

  it("is size-agnostic: a large context is passed through unchanged", async () => {
    const big = "x".repeat(40_000);
    const model = mockModel(() => textReply(JSON.stringify(valid)));
    await expect(
      invokeStructured(model, schema, [{ role: "user", content: big }], { settings: offline }),
    ).resolves.toEqual(valid);
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
    // The failure text is carried out so the trace can record it.
    expect(result.stopText).toMatch(/llm_error: length limit/);
  });
});

// Native tool calling: the flat tool call is mapped into the IR Action (docs/testing_ru.md §8.1).
describe("tool calling", () => {
  it("maps a flat tool call into the IR Action", () => {
    expect(toProposal("write", { filePath: "a.txt", content: "hi" }, "t").action).toEqual({
      operator: "apply",
      action: { tool: "write", path: "a.txt", content: "hi" },
    });
    expect(toProposal("bash", { command: "node --test" }, "t").action).toEqual({
      operator: "apply",
      action: { tool: "bash", command: "node --test" },
    });
    expect(
      toProposal("bash", { command: "make", workdir: "ocaml", timeout: 1000 }, "t").action,
    ).toEqual({
      operator: "apply",
      action: { tool: "bash", command: "make", workdir: "ocaml", timeout: 1000 },
    });
    expect(toProposal("read", { filePath: "a.txt", offset: 5, limit: 10 }, "t").action).toEqual({
      operator: "apply",
      action: { tool: "read", path: "a.txt", start: 5, end: 14 },
    });
    expect(toProposal("read", { filePath: "a.txt" }, "t").action).toEqual({
      operator: "apply",
      action: { tool: "read", path: "a.txt" },
    });
    expect(toProposal("edit", { filePath: "a.txt", oldString: "a", newString: "b" }, "t").action).toEqual({
      operator: "apply",
      action: { tool: "edit", path: "a.txt", find: "a", replace: "b" },
    });
    expect(toProposal("webfetch", { url: "http://x/y" }, "t").action).toEqual({
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
    const model = mockModel(() => toolReply([{ name: "read", args: { filePath: "a" } }], "do it"));
    const proposal = await agent(model, [{ role: "user", content: "go" }]);
    expect(proposal.thought).toBe("do it");
    expect(proposal.actions[0]).toEqual({ operator: "apply", action: { tool: "read", path: "a" } });
  });

  it("invokeTools maps every call of a batch move", async () => {
    const model = mockModel(() =>
      toolReply(
        [
          { name: "read", args: { filePath: "a" } },
          { name: "bash", args: { command: "ls" } },
        ],
        "probe",
      ),
    );
    const proposal = await agent(model, [{ role: "user", content: "go" }]);
    expect(proposal.thought).toBe("probe");
    expect(proposal.actions).toEqual([
      { operator: "apply", action: { tool: "read", path: "a" } },
      { operator: "apply", action: { tool: "bash", command: "ls" } },
    ]);
  });

  it("invokeTools maps the provider's reasoning", async () => {
    const model = mockModel(() =>
      toolReply([{ name: "list", args: {} }], "", "tool-calls", "the tail advance looks wrong"),
    );
    const proposal = await agent(model, [{ role: "user", content: "go" }]);
    expect(proposal.reasoning).toBe("the tail advance looks wrong");
  });

  it("invokeTools drops reasoning from the move when SKEIN_REASONING_TAPE is false", async () => {
    const model = mockModel(() =>
      toolReply([{ name: "list", args: {} }], "", "tool-calls", "the tail advance looks wrong"),
    );
    const proposal = await agent(model, [{ role: "user", content: "go" }], {
      settings: { ...offline, reasoningTape: false },
    });
    expect(proposal.reasoning).toBeUndefined();
  });

  it("invokeTools drains the stream when streaming is on", async () => {
    const chunks: LanguageModelV3StreamPart[] = [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "do " },
      { type: "text-delta", id: "t", delta: "it" },
      { type: "text-end", id: "t" },
      { type: "tool-call", toolCallId: "c1", toolName: "list", input: "{}" },
      { type: "finish", usage: usage(), finishReason: finish("tool-calls") },
    ];
    const model = new MockLanguageModelV3({
      doStream: { stream: simulateReadableStream({ chunks }) },
    });
    const proposal = await agent(model, [{ role: "user", content: "go" }], {
      settings: { ...loadSettings(), streaming: true },
    });
    expect(proposal.thought).toBe("do it");
    expect(proposal.actions[0]).toEqual({ operator: "apply", action: { tool: "list" } });
    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("invokeTools uses generate when streaming is off", async () => {
    const model = mockModel(() => toolReply([{ name: "list", args: {} }]));
    await agent(model, [{ role: "user", content: "go" }], {
      settings: { ...loadSettings(), streaming: false },
    });
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it("invokeTools binds only the allowed tools", async () => {
    const model = mockModel(() => toolReply([{ name: "move", args: { state: "orientation" } }]));
    const proposal = await agent(model, [{ role: "user", content: "go" }], {
      allowedTools: ["move", "recall"],
    });
    const bound = (model.doGenerateCalls[0]?.tools ?? []).map((tool) => tool.name);
    expect(bound).toEqual(["move", "recall"]);
    expect(proposal.actions[0]).toEqual({ operator: "move", state: "orientation", what: "" });
  });

  it("invokeTools repairs once when the model called no tool", async () => {
    const model = mockModel((call) =>
      call === 1 ? textReply("thinking") : toolReply([{ name: "list", args: {} }]),
    );
    const proposal = await agent(model, [{ role: "user", content: "go" }]);
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(proposal.actions[0]).toEqual({ operator: "apply", action: { tool: "list" } });
  });

  it("invokeTools disables reasoning on a truncated no-tool response", async () => {
    const rebuilds: { maxTokens: number; reasoningOff: boolean }[] = [];
    const model = mockModel((call) =>
      call === 1 ? textReply("", "length") : toolReply([{ name: "list", args: {} }]),
    );
    const rebuild = (maxTokens: number, opts?: { reasoningOff?: boolean }) => {
      rebuilds.push({ maxTokens, reasoningOff: opts?.reasoningOff === true });
      return model;
    };
    const proposal = await agent(model, [{ role: "user", content: "go" }], { rebuild });
    // The retry does NOT raise the cap (a bigger budget only invites more reasoning); it
    // rebuilds with reasoning disabled so the model must answer with a tool call.
    expect(rebuilds).toHaveLength(1);
    expect(rebuilds[0]?.reasoningOff).toBe(true);
    expect(proposal.actions[0]).toEqual({ operator: "apply", action: { tool: "list" } });
  });

  it("invokeTools bounds a truncation storm: one brevity retry, then throws", async () => {
    const model = mockModel(() => textReply("", "length"));
    // A model that only ever truncates must not loop: one retry at the ceiling with a
    // brevity hint, then give up (a live run turned one `read` into 4 calls / 60.9k tokens).
    await expect(agent(model, [{ role: "user", content: "go" }])).rejects.toThrow();
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it("invokeTools retries a thrown provider call with the same request, then succeeds", async () => {
    const model = mockModel((call) => {
      if (call < 3) throw new Error("502 bad gateway");
      return toolReply([{ name: "list", args: {} }]);
    });
    const proposal = await agent(model, [{ role: "user", content: "go" }], {
      retries: 2,
      retryDelayMs: 0,
    });
    expect(model.doGenerateCalls).toHaveLength(3);
    expect(proposal.actions[0]).toEqual({ operator: "apply", action: { tool: "list" } });
  });

  it("invokeTools gives up after the retries are exhausted", async () => {
    const model = mockModel(() => {
      throw new Error("connection reset");
    });
    await expect(
      agent(model, [{ role: "user", content: "go" }], { retries: 2, retryDelayMs: 0 }),
    ).rejects.toThrow("connection reset");
    expect(model.doGenerateCalls).toHaveLength(3); // the first try plus two retries
  });

  it("invokeTools does not force tool_choice", async () => {
    const model = mockModel(() => toolReply([{ name: "list", args: {} }]));
    await agent(model, [{ role: "user", content: "go" }]);
    // Forcing `required` routes the meta-provider to thinking upstreams that reject it or are
    // rate-limited; opencode does not force it either.
    expect(model.doGenerateCalls[0]?.toolChoice).toEqual({ type: "auto" });
  });

  it("invokeTools retries with thinking off when the route demands reasoning it never got", async () => {
    const rebuilds: { reasoningOff: boolean }[] = [];
    const model = mockModel(() => {
      throw new Error("The `reasoning_content` in the thinking mode must be passed back to the API.");
    });
    const ok = mockModel(() => toolReply([{ name: "list", args: {} }]));
    const rebuild = (_maxTokens: number, opts?: { reasoningOff?: boolean }) => {
      rebuilds.push({ reasoningOff: opts?.reasoningOff === true });
      return ok;
    };
    const proposal = await agent(model, [{ role: "user", content: "go" }], {
      rebuild,
      retries: 0,
    });
    expect(rebuilds).toEqual([{ reasoningOff: true }]);
    expect(proposal.actions[0]).toEqual({ operator: "apply", action: { tool: "list" } });
  });

  it("invokeTools repairs once when the tool call is malformed", async () => {
    const model = mockModel((call) => {
      if (call === 1) {
        return toolReply([{ name: "write", args: { filePath: "a" } }]);
      }
      return toolReply([{ name: "read", args: { filePath: "a" } }]);
    });
    const proposal = await agent(model, [{ role: "user", content: "go" }]);
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(proposal.actions[0]).toEqual({ operator: "apply", action: { tool: "read", path: "a" } });
  });

  it("invokeTools forwards usage to the callback meter", async () => {
    const model = mockModel(() => toolReply([{ name: "list", args: {} }]));
    const meter = new TurnMeter();
    await agent(model, [{ role: "user", content: "go" }], { usageHandlers: [meter] });
    expect(meter.calls).toBe(1);
    expect(meter.inputTokens).toBe(1);
    expect(meter.outputTokens).toBe(1);
  });
});

// The model surface follows the frontier (docs/ir_semantics §2.6): only the admissible moves
// are offered, so a refused move cannot be called at all.
describe("tool surface (toolNamesFor)", () => {
  const frontier = (over: Partial<Record<"move" | "createGoal" | "apply" | "stop" | "decline", boolean>>) => ({
    move: false,
    createGoal: false,
    apply: false,
    stop: false,
    decline: false,
    ...over,
  });

  it("offers move alone at a transition (recall/search belong to an open state)", () => {
    expect(toolNamesFor(frontier({ move: true }))).toEqual(["move"]);
  });

  it("offers the apply vocabulary at an open state and decline at the request", () => {
    expect(toolNamesFor(frontier({ apply: true, stop: true }))).toEqual([
      "recall",
      "search",
      "read",
      "grep",
      "list",
      "edit",
      "bash",
      "write",
      "webfetch",
      "apply_patch",
      "stop",
    ]);
    expect(toolNamesFor(frontier({ move: true, decline: true }))).toEqual([
      "move",
      "decline",
    ]);
  });

  it("offers only the frontier's `applies` (the state's tools; the write-class is Patch's)", () => {
    expect(
      toolNamesFor({
        move: false,
        apply: true,
        stop: true,
        decline: false,
        applies: ["read", "grep", "list", "bash", "webfetch"],
      }),
    ).toEqual(["recall", "search", "read", "grep", "list", "bash", "webfetch", "stop"]);
  });
});

// modelCall is the reverse of toProposal (docs/ir_semantics §7): the tape shows the model
// its own history in the native vocabulary it calls with.
describe("modelCall: IR -> native call", () => {
  it("renders read/edit/write/bash/webfetch with their native names and args", () => {
    expect(modelCall({ operator: "apply", action: { tool: "read", path: "a", start: 5, end: 14 } })).toEqual({
      name: "read",
      args: { filePath: "a", offset: 5, limit: 10 },
    });
    expect(
      modelCall({ operator: "apply", action: { tool: "edit", path: "a", find: "x", replace: "y" } }),
    ).toEqual({ name: "edit", args: { filePath: "a", oldString: "x", newString: "y" } });
    expect(modelCall({ operator: "apply", action: { tool: "write", path: "a", content: "c" } })).toEqual({
      name: "write",
      args: { filePath: "a", content: "c" },
    });
    expect(
      modelCall({
        operator: "apply",
        action: { tool: "bash", command: "make", workdir: "ocaml", timeout: 1000 },
      }),
    ).toEqual({ name: "bash", args: { command: "make", workdir: "ocaml", timeout: 1000 } });
    expect(modelCall({ operator: "apply", action: { tool: "fetch", url: "http://u" } })).toEqual({
      name: "webfetch",
      args: { url: "http://u" },
    });
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
      const messages = [{ role: "user" as const, content: "Return JSON with ok=true and a one-word note." }];
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
