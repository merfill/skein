import { readFileSync } from "node:fs";

import { createTerminalIo, runAuthLogin } from "./auth";
import { PROVIDERS } from "./presets";
import {
  describeHttpError,
  detectLocalProviders,
  listModels,
  ProviderHttpError,
  testChat,
} from "./probe";
import { providerSummary, resolveProvider } from "./resolve";
import {
  authPath,
  configPath,
  readAuth,
  readProviderConfig,
  redactKey,
  removeAuthKey,
} from "./store";

// The provider-related CLI commands. They return an exit code and write to stdout/stderr; the
// agent path in `src/cli.ts` stays unaware of the subcommand details.

function readVersion(): string {
  // Source layout is `src/providers/cli.ts` (../../package.json); the bundled CLI is
  // `dist/cli.js` (../package.json). Try both so `--version` works in dev and installed.
  for (const url of [
    new URL("../../package.json", import.meta.url),
    new URL("../package.json", import.meta.url),
  ]) {
    try {
      const raw = readFileSync(url, "utf8");
      const pkg = JSON.parse(raw) as { version?: unknown };
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      // try the next layout
    }
  }
  return "0.0.0";
}

export function printVersion(output: (line: string) => void = console.log): void {
  output(`skein ${readVersion()}`);
}

export function printHelp(output: (line: string) => void = console.log): void {
  const lines = [
    "Skein — a coding agent whose context is a projection of its IR.",
    "",
    "Usage:",
    "  skein [options]                         start the TUI",
    "  skein --plain [options]                 start the line REPL",
    "  skein auth login [provider]             choose a provider and save its key",
    "  skein auth list                         show configured providers (keys redacted)",
    "  skein auth logout [provider]            remove a saved key",
    "  skein models [provider]                 list the provider's models",
    "  skein doctor                            test the current provider/model",
    "  skein --help                            show this help",
    "  skein --version                         show the version",
    "",
    "Options:",
    "  --dir <path>        workspace to work in (default: current directory)",
    "  --provider <id>     provider id (see below)",
    "  --model <id>        model id",
    "  --base-url <url>    override the provider's OpenAI-compatible base URL",
    "  --max-turns <n>     turn budget (default: 80)",
    "  --plain             line REPL instead of the TUI",
    "  --verbose           expand reasoning and tool results in the plain REPL",
    "",
    `Providers: ${PROVIDERS.map((provider) => provider.id).join(", ")}`,
    "",
    "Config: " + configPath(),
    "Keys:   " + authPath() + " (0600), or provider env vars (e.g. OPENROUTER_API_KEY).",
    "Precedence: CLI > env > config > preset default.",
  ];
  for (const line of lines) output(line);
}

export async function runAuthCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const sub = args[0];
  if (sub === "login") {
    const local = await detectLocalProviders();
    const io = createTerminalIo();
    try {
      await runAuthLogin({ io, provider: args[1], env, local });
    } finally {
      io.close();
    }
    return 0;
  }
  if (sub === "list") {
    const config = readProviderConfig(env);
    const auth = readAuth(env);
    console.log(`config: ${configPath(env)}`);
    console.log(`auth:   ${authPath(env)}`);
    if (config !== undefined) {
      console.log(`current: ${config.provider} / ${config.model}`);
    } else {
      console.log("current: (not configured)");
    }
    const entries = Object.entries(auth?.providers ?? {});
    if (entries.length > 0) {
      console.log("saved keys:");
      for (const [id, entry] of entries) {
        console.log(`  ${id}: ${redactKey(entry.apiKey)}`);
      }
    }
    const seenEnv = new Set<string>();
    for (const provider of PROVIDERS) {
      for (const name of provider.env) {
        if (seenEnv.has(name)) continue;
        seenEnv.add(name);
        const value = env[name];
        if (value !== undefined && value !== "") {
          console.log(`  ${name} ${redactKey(value)} (env)`);
        }
      }
    }
    const anyEnvKey = PROVIDERS.some((provider) =>
      provider.env.some((name) => (env[name] ?? "") !== ""),
    );
    if (entries.length === 0 && !anyEnvKey) {
      console.log("no keys configured; run `skein auth login`");
    }
    return 0;
  }
  if (sub === "logout") {
    const config = readProviderConfig(env);
    const provider = args[1] ?? config?.provider;
    if (provider === undefined || provider === "") {
      console.error("usage: skein auth logout <provider>");
      return 1;
    }
    removeAuthKey(provider, env);
    console.log(`removed the saved key for ${provider}`);
    const preset = PROVIDERS.find((entry) => entry.id === provider);
    if (preset !== undefined && preset.env.some((name) => (env[name] ?? "") !== "")) {
      console.log("note: an environment variable is still set for this provider");
    }
    return 0;
  }
  console.error("usage: skein auth <login|list|logout>");
  return 1;
}

export async function runModelsCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const config = readProviderConfig(env);
  const auth = readAuth(env);
  const provider = resolveProvider({
    env,
    ...(config !== undefined ? { config } : {}),
    ...(auth !== undefined ? { auth } : {}),
    ...(args[0] !== undefined ? { provider: args[0] } : {}),
  });
  if (!provider.ready) {
    console.error(provider.reason ?? "provider is not ready");
    return 1;
  }
  try {
    const models = await listModels(provider.baseURL, { apiKey: provider.apiKey });
    if (models.length === 0) {
      console.log("the provider returned no models");
      return 0;
    }
    for (const model of models) {
      console.log(`${model === provider.model ? "*" : " "} ${model}`);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function runDoctorCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const config = readProviderConfig(env);
  const auth = readAuth(env);
  const provider = resolveProvider({
    env,
    ...(config !== undefined ? { config } : {}),
    ...(auth !== undefined ? { auth } : {}),
    ...(args[0] !== undefined ? { provider: args[0] } : {}),
  });
  console.log(providerSummary(provider));
  if (!provider.ready) {
    console.error(`not ready: ${provider.reason ?? "unknown reason"}`);
    return 1;
  }

  try {
    const models = await listModels(provider.baseURL, {
      apiKey: provider.apiKey,
      fetchImpl,
      timeoutMs: 10_000,
    });
    console.log(`models: ${models.length}${models.length > 0 ? ` (example: ${models[0]})` : ""}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`models: unavailable (${message})`);
  }

  try {
    const probe = await testChat(provider.baseURL, provider.model, {
      apiKey: provider.apiKey,
      fetchImpl,
      timeoutMs: 30_000,
    });
    console.log(`chat: ok in ${probe.latencyMs}ms${probe.text !== undefined ? ` (${probe.text.trim()})` : ""}`);
    return 0;
  } catch (error) {
    if (error instanceof ProviderHttpError) {
      console.error(`chat failed: ${describeHttpError(error.status, error.body ?? "")}`);
    } else {
      console.error(`chat failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 1;
  }
}

export function runHelpOrVersion(args: readonly string[]): boolean {
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    printHelp();
    return true;
  }
  if (args.includes("--version") || args.includes("-v") || args[0] === "version") {
    printVersion();
    return true;
  }
  return false;
}
