import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

import {
  FREE_PROVIDER_IDS,
  PROVIDERS,
  providerLabel,
  requireProvider,
  type ProviderPreset,
} from "./presets";
import { listModels, ProviderHttpError, type LocalProvider } from "./probe";
import { authKey, authPath, configPath, readAuth, redactKey, setAuthKey, writeProviderConfig } from "./store";

// The interactive setup. All prompts go through an injected `AuthIo` so the offline tests can
// script answers; the terminal implementation only adds the usual readline and a muted secret.

export interface AuthIo {
  question(prompt: string): Promise<string>;
  secret(prompt: string): Promise<string>;
  print(line: string): void;
}

export interface TerminalIo extends AuthIo {
  close(): void;
}

export function createTerminalIo(): TerminalIo {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
  });
  return {
    question: (prompt) => rl.question(prompt),
    async secret(prompt) {
      if (process.stdin.isTTY !== true || process.platform === "win32") return rl.question(prompt);
      process.stdout.write(prompt);
      const muted = spawnSync("stty", ["-echo"], { stdio: ["inherit", "ignore", "ignore"] });
      if (muted.error !== undefined || muted.status !== 0) {
        process.stdout.write("\n(terminal echo is on; the key will be visible)\n");
      }
      try {
        return await rl.question("");
      } finally {
        if (muted.status === 0) spawnSync("stty", ["echo"], { stdio: ["inherit", "ignore", "ignore"] });
        process.stdout.write("\n");
      }
    },
    print: (line) => process.stdout.write(`${line}\n`),
    close: () => rl.close(),
  };
}

export interface AuthLoginResult {
  providerId: string;
  model: string;
  baseURL: string;
}

export interface AuthLoginOptions {
  io: AuthIo;
  provider?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  // Detected local runtimes, so they can be offered first. The caller probes them.
  local?: readonly LocalProvider[];
}

function existingKey(preset: ProviderPreset, env: NodeJS.ProcessEnv): string {
  for (const name of preset.env) {
    const value = env[name];
    if (value !== undefined && value !== "") return value;
  }
  return "";
}

function remoteEntries(local: ReadonlySet<string>): ProviderPreset[] {
  // Detected local runtimes are offered separately and first; an undetected one is just another
  // option near the paid providers.
  const rank = (provider: ProviderPreset): number => {
    if (FREE_PROVIDER_IDS.includes(provider.id) && provider.local !== true) return 1;
    if (provider.id === "custom") return 3;
    return 2;
  };
  return PROVIDERS.filter((provider) => !local.has(provider.id)).sort((a, b) => rank(a) - rank(b));
}

function parseChoice(line: string, count: number): number | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return 0;
  const index = Number(trimmed);
  if (Number.isInteger(index) && index >= 1 && index <= count) return index - 1;
  return undefined;
}

function printModels(io: AuthIo, models: readonly string[]): void {
  if (models.length === 0) return;
  const shown = models.slice(0, 30);
  io.print(`Models (${models.length}):`);
  for (const [index, model] of shown.entries()) io.print(`  ${index + 1}. ${model}`);
  if (models.length > shown.length) io.print(`  … and ${models.length - shown.length} more`);
}

export async function runAuthLogin(options: AuthLoginOptions): Promise<AuthLoginResult> {
  const { io, env = process.env } = options;
  const detected = options.local ?? [];
  const detectedById = new Map(detected.map((entry) => [entry.preset.id, entry]));

  let preset: ProviderPreset;
  if (options.provider !== undefined && options.provider !== "") {
    preset = requireProvider(options.provider);
  } else {
    const entries = [
      ...detected.map((entry) => entry.preset),
      ...remoteEntries(new Set(detected.map((entry) => entry.preset.id))),
    ];
    io.print("Choose a provider:");
    for (const [index, entry] of entries.entries()) {
      const count = detectedById.get(entry.id)?.models.length;
      const suffix = count !== undefined ? ` — ${count} local model(s)` : "";
      io.print(`  ${index + 1}. ${providerLabel(entry)}${suffix}`);
    }
    let chosen: ProviderPreset | undefined;
    for (let attempt = 0; attempt < 3 && chosen === undefined; attempt += 1) {
      const line = await io.question(`Provider [1-${entries.length}] (default 1): `);
      if (line.trim() === "") {
        chosen = entries[0];
      } else {
        const index = parseChoice(line, entries.length);
        chosen = index !== undefined ? entries[index] : entries.find((entry) => entry.id === line.trim());
      }
      if (chosen === undefined) io.print(`unknown choice: ${line.trim()}`);
    }
    if (chosen === undefined) throw new Error("no provider selected");
    preset = chosen;
  }

  io.print("");
  io.print(providerLabel(preset));
  if (preset.signupURL !== undefined) io.print(`Get a key: ${preset.signupURL}`);

  const baseURL =
    preset.id === "custom"
      ? (await io.question("Base URL (e.g. https://api.example.com/v1): ")).trim()
      : preset.baseURL;
  if (baseURL === "") throw new Error("base URL is required for a custom provider");

  let apiKey = "";
  let storeKey = false;
  if (preset.local !== true && preset.apiKeyOptional !== true) {
    const previous = existingKey(preset, env) || authKey(readAuth(env), preset.id);
    if (previous !== "") {
      io.print(`Existing key: ${redactKey(previous)}`);
      const entered = (await io.secret("Press Enter to keep it, or paste a new key: ")).trim();
      apiKey = entered === "" ? previous : entered;
      storeKey = entered !== "";
    } else {
      for (let attempt = 0; attempt < 3 && apiKey === ""; attempt += 1) {
        apiKey = (await io.secret("API key: ")).trim();
        if (apiKey === "") io.print("an API key is required");
      }
      if (apiKey === "") throw new Error("no API key entered");
      storeKey = true;
    }
  }

  let models: string[] = [];
  if (detectedById.has(preset.id)) {
    models = [...(detectedById.get(preset.id)?.models ?? [])];
  } else {
    try {
      models = await listModels(baseURL, { apiKey, fetchImpl: options.fetchImpl });
    } catch (error) {
      const message =
        error instanceof ProviderHttpError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      io.print(`could not list models (${message})`);
    }
  }
  printModels(io, models);

  const fallback = preset.defaultModel ?? (models.length === 1 ? models[0] : undefined);
  const answer = (
    await io.question(fallback !== undefined ? `Model [${fallback}]: ` : "Model: ")
  ).trim();
  let model = answer;
  if (model !== "") {
    const index = Number(model);
    if (Number.isInteger(index) && index >= 1 && index <= models.length) {
      model = models[index - 1] ?? "";
    }
  } else {
    model = fallback ?? models[0] ?? "";
  }
  if (model === "") throw new Error("a model id is required");

  if (storeKey) setAuthKey(preset.id, apiKey, env);
  const explicitBase = preset.id === "custom" || baseURL !== preset.baseURL;
  writeProviderConfig(
    {
      version: 1,
      provider: preset.id,
      model,
      ...(explicitBase ? { baseURL } : {}),
    },
    env,
  );

  io.print("");
  io.print(`saved: ${configPath(env)}`);
  if (storeKey) io.print(`saved: ${authPath(env)}`);
  io.print(`provider: ${preset.id}; model: ${model}`);
  io.print("run `skein doctor` to test the connection");
  return { providerId: preset.id, model, baseURL };
}
