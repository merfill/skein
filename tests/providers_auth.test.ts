import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runAuthLogin, type AuthIo } from "../src/providers/auth";
import { resolveProvider } from "../src/providers/resolve";
import { readAuth, readProviderConfig } from "../src/providers/store";

const roots: string[] = [];

function makeEnv(): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), "skein-auth-"));
  roots.push(root);
  return {
    SKEIN_CONFIG_DIR: join(root, "config"),
    SKEIN_DATA_DIR: join(root, "data"),
  };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

interface Script {
  questions?: string[];
  secrets?: string[];
}

function scriptedIo(script: Script): AuthIo & { lines: string[] } {
  const questions = [...(script.questions ?? [])];
  const secrets = [...(script.secrets ?? [])];
  const lines: string[] = [];
  return {
    question: async (prompt) => {
      const value = questions.shift() ?? "";
      lines.push(`${prompt}${value}`);
      return value;
    },
    secret: async (prompt) => {
      const value = secrets.shift() ?? "";
      lines.push(`${prompt}<secret>`);
      return value;
    },
    print: (line) => {
      lines.push(line);
    },
    lines,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("auth login", () => {
  it("saves a key and a model chosen from the provider's list", async () => {
    const env = makeEnv();
    const io = scriptedIo({ questions: ["2"], secrets: ["sk-or-test"] });
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ id: "alpha" }, { id: "beta" }] }),
    ) as unknown as typeof fetch;

    const result = await runAuthLogin({
      io,
      env,
      provider: "openrouter",
      fetchImpl,
    });
    expect(result).toMatchObject({ providerId: "openrouter", model: "beta" });
    expect(readProviderConfig(env)).toEqual({
      version: 1,
      provider: "openrouter",
      model: "beta",
    });
    expect(readAuth(env)?.providers.openrouter?.apiKey).toBe("sk-or-test");
    expect(io.lines.join("\n")).toContain("saved:");
    expect(io.lines.join("\n")).not.toContain("sk-or-test");
  });

  it("keeps an existing env key without copying it to disk", async () => {
    const env = makeEnv();
    const withKey = { ...env, OPENROUTER_API_KEY: "sk-existing" };
    const io = scriptedIo({ questions: ["alpha"], secrets: [""] });
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ id: "alpha" }] }),
    ) as unknown as typeof fetch;

    await runAuthLogin({ io, env: withKey, provider: "openrouter", fetchImpl });
    expect(readProviderConfig(env)?.model).toBe("alpha");
    expect(readAuth(env)).toBeUndefined();
  });

  it("saves a custom base URL and a manually entered model", async () => {
    const env = makeEnv();
    const io = scriptedIo({
      questions: ["https://llm.example/v1", "my-model"],
      secrets: ["sk-custom"],
    });
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "no models" }, 404)) as unknown as typeof fetch;

    const result = await runAuthLogin({ io, env, provider: "custom", fetchImpl });
    expect(result.baseURL).toBe("https://llm.example/v1");
    expect(readProviderConfig(env)).toEqual({
      version: 1,
      provider: "custom",
      model: "my-model",
      baseURL: "https://llm.example/v1",
    });
    expect(readAuth(env)?.providers.custom?.apiKey).toBe("sk-custom");
  });

  it("uses a detected local runtime without a key", async () => {
    const env = makeEnv();
    const io = scriptedIo({ questions: [""] });
    const result = await runAuthLogin({
      io,
      env,
      provider: "ollama",
      local: [
        {
          preset: {
            id: "ollama",
            name: "Ollama (local)",
            baseURL: "http://127.0.0.1:11434/v1",
            env: [],
            local: true,
            free: true,
          },
          models: ["qwen3:8b"],
        },
      ],
    });
    expect(result).toMatchObject({ providerId: "ollama", model: "qwen3:8b" });
    expect(readAuth(env)).toBeUndefined();
    const resolved = resolveProvider({
      env,
      config: readProviderConfig(env),
    });
    expect(resolved.ready).toBe(true);
  });
});
