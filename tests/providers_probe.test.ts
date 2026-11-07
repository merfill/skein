import { describe, expect, it, vi } from "vitest";

import {
  detectLocalProviders,
  describeHttpError,
  listModels,
  ProviderHttpError,
  testChat,
} from "../src/providers/probe";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("provider probes", () => {
  it("lists and sorts model ids", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ id: "b" }, { id: "a" }, { id: "a" }] })) as unknown as typeof fetch;
    const models = await listModels("https://example.test/v1/", { apiKey: "sk-test", fetchImpl });
    expect(models).toEqual(["a", "b"]);
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call?.[0]).toBe("https://example.test/v1/models");
    expect((call?.[1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer sk-test" });
  });

  it("maps an auth failure to a useful message", async () => {
    const fetchImpl = (async () => jsonResponse({ error: "bad key" }, 401)) as unknown as typeof fetch;
    await expect(listModels("https://example.test/v1", { apiKey: "x", fetchImpl })).rejects.toThrow(
      "authentication failed (401)",
    );
    try {
      await listModels("https://example.test/v1", { apiKey: "x", fetchImpl });
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderHttpError);
      expect((error as ProviderHttpError).status).toBe(401);
    }
  });

  it("times out a hanging provider", async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      })) as unknown as typeof fetch;
    await expect(
      listModels("https://example.test/v1", { fetchImpl, timeoutMs: 5 }),
    ).rejects.toThrow("timed out");
  });

  it("runs a one-token chat probe", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "pong" } }] }),
    ) as unknown as typeof fetch;
    const probe = await testChat("https://example.test/v1", "m", { apiKey: "sk", fetchImpl });
    expect(probe.ok).toBe(true);
    expect(probe.text).toBe("pong");
    expect(probe.latencyMs).toBeGreaterThanOrEqual(0);
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call?.[0]).toBe("https://example.test/v1/chat/completions");
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toMatchObject({
      model: "m",
      max_tokens: 1,
    });
  });

  it("maps common HTTP errors", () => {
    expect(describeHttpError(404, "")).toContain("not found");
    expect(describeHttpError(429, "")).toContain("rate limited");
    expect(describeHttpError(500, "")).toContain("provider error");
  });

  it("detects a local runtime", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("11434")) return jsonResponse({ data: [{ id: "qwen3:8b" }] });
      return jsonResponse({ error: "not running" }, 503);
    }) as unknown as typeof fetch;
    const local = await detectLocalProviders({ fetchImpl });
    expect(local).toHaveLength(1);
    expect(local[0]?.preset.id).toBe("ollama");
    expect(local[0]?.models).toEqual(["qwen3:8b"]);
  });
});
