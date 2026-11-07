import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Config holds no secrets; auth holds keys and is written 0600. Both are small JSON files in
// XDG locations, with SKEIN_CONFIG_DIR / SKEIN_DATA_DIR overrides for tests and containers.

export interface ProviderConfig {
  version: 1;
  provider: string;
  model: string;
  // A custom endpoint, or an override of the preset's endpoint.
  baseURL?: string;
}

export interface AuthFile {
  version: 1;
  providers: Record<string, { apiKey: string }>;
}

export const CONFIG_VERSION = 1;
export const AUTH_VERSION = 1;

function envOr(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return (
    envOr(env, "SKEIN_CONFIG_DIR") ??
    join(envOr(env, "XDG_CONFIG_HOME") ?? join(homedir(), ".config"), "skein")
  );
}

export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  return (
    envOr(env, "SKEIN_DATA_DIR") ??
    join(envOr(env, "XDG_DATA_HOME") ?? join(homedir(), ".local", "share"), "skein")
  );
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "config.json");
}

export function authPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), "auth.json");
}

function readJson(path: string, label: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`cannot read ${label} ${path}: ${String(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid ${label} ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeJson(path: string, value: unknown, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temporary file may not exist; the original error is the useful one.
    }
    throw error;
  }
}

export function readProviderConfig(env: NodeJS.ProcessEnv = process.env): ProviderConfig | undefined {
  const raw = readJson(configPath(env), "config");
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`invalid config ${configPath(env)}: expected an object`);
  }
  const value = raw as Record<string, unknown>;
  const version = value.version ?? CONFIG_VERSION;
  if (version !== CONFIG_VERSION) {
    throw new Error(`unsupported config version ${String(version)} in ${configPath(env)}`);
  }
  if (typeof value.provider !== "string" || value.provider === "") {
    throw new Error(`invalid config ${configPath(env)}: provider is required`);
  }
  if (typeof value.model !== "string" || value.model === "") {
    throw new Error(`invalid config ${configPath(env)}: model is required`);
  }
  if (value.baseURL !== undefined && typeof value.baseURL !== "string") {
    throw new Error(`invalid config ${configPath(env)}: baseURL must be a string`);
  }
  return {
    version: CONFIG_VERSION,
    provider: value.provider,
    model: value.model,
    ...(typeof value.baseURL === "string" && value.baseURL !== ""
      ? { baseURL: value.baseURL }
      : {}),
  };
}

export function writeProviderConfig(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  writeJson(configPath(env), config, 0o644);
}

export function readAuth(env: NodeJS.ProcessEnv = process.env): AuthFile | undefined {
  const raw = readJson(authPath(env), "auth");
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`invalid auth ${authPath(env)}: expected an object`);
  }
  const value = raw as Record<string, unknown>;
  const version = value.version ?? AUTH_VERSION;
  if (version !== AUTH_VERSION) {
    throw new Error(`unsupported auth version ${String(version)} in ${authPath(env)}`);
  }
  const providers = value.providers;
  if (typeof providers !== "object" || providers === null) {
    throw new Error(`invalid auth ${authPath(env)}: providers is required`);
  }
  const out: AuthFile = { version: AUTH_VERSION, providers: {} };
  for (const [id, entry] of Object.entries(providers as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const apiKey = (entry as Record<string, unknown>).apiKey;
    if (typeof apiKey === "string" && apiKey !== "") out.providers[id] = { apiKey };
  }
  return out;
}

export function writeAuth(auth: AuthFile, env: NodeJS.ProcessEnv = process.env): void {
  writeJson(authPath(env), auth, 0o600);
}

export function setAuthKey(
  providerId: string,
  apiKey: string,
  env: NodeJS.ProcessEnv = process.env,
): AuthFile {
  const auth = readAuth(env) ?? { version: AUTH_VERSION, providers: {} };
  if (apiKey === "") {
    delete auth.providers[providerId];
  } else {
    auth.providers[providerId] = { apiKey };
  }
  writeAuth(auth, env);
  return auth;
}

export function removeAuthKey(
  providerId: string,
  env: NodeJS.ProcessEnv = process.env,
): AuthFile {
  return setAuthKey(providerId, "", env);
}

export function authKey(auth: AuthFile | undefined, providerId: string): string {
  return auth?.providers[providerId]?.apiKey ?? "";
}

// Never print a key. Short keys are fully masked; longer ones keep a recognizable prefix/suffix.
export function redactKey(apiKey: string): string {
  if (apiKey === "") return "(none)";
  if (apiKey.length <= 10) return "••••••";
  return `${apiKey.slice(0, 3)}…${apiKey.slice(-4)}`;
}
