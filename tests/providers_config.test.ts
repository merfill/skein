import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { applyProvider, resolveProvider } from "../src/providers/resolve";
import {
  authPath,
  configPath,
  readAuth,
  readProviderConfig,
  redactKey,
  setAuthKey,
  writeAuth,
  writeProviderConfig,
} from "../src/providers/store";
import { loadSettings } from "../src/config/settings";

const roots: string[] = [];

function envFor(root: string): NodeJS.ProcessEnv {
  return {
    SKEIN_CONFIG_DIR: join(root, "config"),
    SKEIN_DATA_DIR: join(root, "data"),
  };
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "skein-providers-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("provider resolution", () => {
  it("defaults to RouterAI with the current model but waits for a key", () => {
    const resolved = resolveProvider({ env: {} });
    expect(resolved.providerId).toBe("routerai");
    expect(resolved.model).toBe("~deepseek/deepseek-v4-flash-latest");
    expect(resolved.baseURL).toBe("https://routerai.ru/api/v1");
    expect(resolved.ready).toBe(false);
    expect(resolved.reason).toContain("API key");
    expect(resolved.label).toBe("routerai/~deepseek/deepseek-v4-flash-latest");
  });

  it("uses the provider's env key", () => {
    const resolved = resolveProvider({ env: { OPENROUTER_API_KEY: "sk-or-test" } });
    expect(resolved.providerId).toBe("routerai");
    expect(resolved.ready).toBe(false);

    const openrouter = resolveProvider({
      env: { OPENROUTER_API_KEY: "sk-or-test" },
      provider: "openrouter",
      model: "qwen/qwen3-coder:free",
    });
    expect(openrouter.ready).toBe(true);
    expect(openrouter.keySource).toBe("env");
    expect(openrouter.baseURL).toBe("https://openrouter.ai/api/v1");
  });

  it("reads the config file and the saved key", () => {
    const resolved = resolveProvider({
      env: {},
      config: { version: 1, provider: "openrouter", model: "deepseek/deepseek-chat:free" },
      auth: { version: 1, providers: { openrouter: { apiKey: "sk-or-test" } } },
    });
    expect(resolved.ready).toBe(true);
    expect(resolved.source).toBe("config");
    expect(resolved.keySource).toBe("auth");
    expect(resolved.baseURL).toBe("https://openrouter.ai/api/v1");
    expect(resolved.model).toBe("deepseek/deepseek-chat:free");
  });

  it("lets CLI flags win over env and config", () => {
    const resolved = resolveProvider({
      env: {
        SKEIN_PROVIDER: "routerai",
        SKEIN_MODEL: "from-env",
        OPENROUTER_API_KEY: "sk-or-test",
      },
      config: { version: 1, provider: "routerai", model: "from-config" },
      provider: "openrouter",
      model: "from-cli",
    });
    expect(resolved.providerId).toBe("openrouter");
    expect(resolved.model).toBe("from-cli");
    expect(resolved.keySource).toBe("env");
    expect(resolved.source).toBe("cli");
  });

  it("treats a legacy SKEIN_API_URL as a custom endpoint", () => {
    const resolved = resolveProvider({
      env: {
        SKEIN_API_URL: "https://llm.example/v1",
        SKEIN_API_KEY: "sk-test",
        SKEIN_MODEL: "example-model",
      },
    });
    expect(resolved.providerId).toBe("custom");
    expect(resolved.baseURL).toBe("https://llm.example/v1");
    expect(resolved.model).toBe("example-model");
    expect(resolved.ready).toBe(true);
    expect(resolved.source).toBe("env");
  });

  it("requires a key for a remote provider and no key for a local one", () => {
    expect(resolveProvider({ env: {}, provider: "openai", model: "gpt-test" }).ready).toBe(false);
    const local = resolveProvider({ env: {}, provider: "ollama", model: "qwen3:8b" });
    expect(local.ready).toBe(true);
    expect(local.keySource).toBe("none");
  });

  it("requires a base URL for the custom provider", () => {
    const resolved = resolveProvider({ env: {}, provider: "custom", model: "x" });
    expect(resolved.ready).toBe(false);
    expect(resolved.reason).toContain("base URL");
  });

  it("rejects an unknown provider", () => {
    expect(() => resolveProvider({ env: {}, provider: "nope" })).toThrow("unknown provider");
  });

  it("applies the provider to settings and gives local runtimes a placeholder key", () => {
    const resolved = resolveProvider({ env: {}, provider: "ollama", model: "qwen3:8b" });
    const settings = applyProvider(loadSettings({}), resolved);
    expect(settings.apiUrl).toBe("http://127.0.0.1:11434/v1");
    expect(settings.model).toBe("qwen3:8b");
    expect(settings.providerId).toBe("ollama");
    expect(settings.apiKey).toBe("local");
  });
});

describe("config and auth files", () => {
  it("round-trips the config and writes auth 0600", () => {
    const root = makeRoot();
    const env = envFor(root);
    writeProviderConfig(
      { version: 1, provider: "openrouter", model: "m", baseURL: "https://x/v1" },
      env,
    );
    expect(readProviderConfig(env)).toEqual({
      version: 1,
      provider: "openrouter",
      model: "m",
      baseURL: "https://x/v1",
    });

    setAuthKey("openrouter", "sk-or-secret", env);
    expect(readAuth(env)?.providers.openrouter?.apiKey).toBe("sk-or-secret");
    const mode = statSync(authPath(env)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("returns undefined when the files are absent", () => {
    const env = envFor(makeRoot());
    expect(readProviderConfig(env)).toBeUndefined();
    expect(readAuth(env)).toBeUndefined();
  });

  it("rejects invalid JSON and unsupported versions", () => {
    const root = makeRoot();
    const env = envFor(root);
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(configPath(env), "{");
    expect(() => readProviderConfig(env)).toThrow("invalid config");

    writeFileSync(configPath(env), JSON.stringify({ version: 99, provider: "x", model: "y" }));
    expect(() => readProviderConfig(env)).toThrow("unsupported config version");
  });

  it("redacts keys", () => {
    expect(redactKey("")).toBe("(none)");
    expect(redactKey("short")).toBe("••••••");
    expect(redactKey("sk-or-1234567890")).toBe("sk-…7890");
  });
});
