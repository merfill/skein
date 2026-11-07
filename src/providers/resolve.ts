import type { Settings } from "../config/settings";
import { authKey, type AuthFile, type ProviderConfig } from "./store";
import { providerById, requireProvider, type ProviderPreset } from "./presets";

// Resolution is deterministic and side-effect free: the caller supplies the environment and the
// already-read config/auth files. Precedence: CLI > env > config > preset default.

export type ProviderSource = "cli" | "env" | "config" | "preset";

export interface ResolveProviderInput {
  env?: NodeJS.ProcessEnv;
  config?: ProviderConfig;
  auth?: AuthFile;
  provider?: string;
  model?: string;
  baseURL?: string;
}

export interface ResolvedProvider {
  providerId: string;
  preset: ProviderPreset;
  baseURL: string;
  apiKey: string;
  keySource: "env" | "auth" | "none";
  model: string;
  source: ProviderSource;
  ready: boolean;
  reason?: string;
  label: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

function envKey(preset: ProviderPreset, env: NodeJS.ProcessEnv): string {
  for (const name of preset.env) {
    const value = nonEmpty(env[name]);
    if (value !== undefined) return value;
  }
  return "";
}

export function resolveProvider(input: ResolveProviderInput = {}): ResolvedProvider {
  const env = input.env ?? process.env;
  const config = input.config;
  const envProvider = nonEmpty(env.SKEIN_PROVIDER);
  const cliProvider = nonEmpty(input.provider);

  // A legacy SKEIN_API_URL without an explicit provider means a custom endpoint. It also wins
  // over the config, matching the env > config precedence.
  const legacyURL = nonEmpty(env.SKEIN_API_URL);
  const providerId =
    cliProvider ?? envProvider ?? (legacyURL !== undefined ? "custom" : config?.provider ?? "routerai");
  const source: ProviderSource =
    cliProvider !== undefined
      ? "cli"
      : envProvider !== undefined || legacyURL !== undefined
        ? "env"
        : config?.provider !== undefined
          ? "config"
          : "preset";

  const preset = requireProvider(providerId);
  const configMatches = config?.provider === providerId;

  const baseURL =
    nonEmpty(input.baseURL) ??
    nonEmpty(env.SKEIN_API_URL) ??
    (configMatches ? nonEmpty(config?.baseURL) : undefined) ??
    preset.baseURL;

  const model =
    nonEmpty(input.model) ??
    nonEmpty(env.SKEIN_MODEL) ??
    (configMatches ? nonEmpty(config?.model) : undefined) ??
    preset.defaultModel ??
    "";

  const providerEnvKey = envKey(preset, env);
  const storedKey = authKey(input.auth, providerId);
  const apiKey = providerEnvKey !== "" ? providerEnvKey : storedKey;
  const keySource: ResolvedProvider["keySource"] =
    providerEnvKey !== ""
      ? "env"
      : storedKey !== ""
        ? "auth"
        : "none";

  const reason =
    baseURL === ""
      ? "base URL is not set"
      : model === ""
        ? "model is not set (run `skein models` or add it to the config)"
        : apiKey === "" && preset.local !== true && preset.apiKeyOptional !== true
          ? "API key is not set (run `skein auth login` or set the provider's env variable)"
          : undefined;

  return {
    providerId,
    preset,
    baseURL,
    apiKey,
    keySource,
    model,
    source,
    ready: reason === undefined,
    ...(reason !== undefined ? { reason } : {}),
    label: model === "" ? `${providerId}/?` : `${providerId}/${model}`,
  };
}

export function applyProvider(settings: Settings, provider: ResolvedProvider): Settings {
  return {
    ...settings,
    apiUrl: provider.baseURL,
    // Local runtimes ignore the bearer token; a placeholder keeps the OpenAI-compatible client
    // happy without pretending it is a real secret.
    apiKey: provider.apiKey !== "" ? provider.apiKey : provider.preset.local === true ? "local" : provider.apiKey,
    model: provider.model,
    providerId: provider.providerId,
  };
}

export function providerSummary(provider: ResolvedProvider): string {
  return [
    `provider: ${provider.providerId} (${provider.preset.name})`,
    `base URL: ${provider.baseURL || "(not set)"}`,
    `model: ${provider.model || "(not set)"}`,
    `key: ${provider.keySource === "none" ? "(not set)" : `from ${provider.keySource}`}`,
    `config: ${provider.source}`,
  ].join("\n");
}

export function isKnownProvider(id: string): boolean {
  return providerById(id) !== undefined;
}
