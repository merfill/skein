import { statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface, emitKeypressEvents } from "node:readline";
import { pathToFileURL } from "node:url";

import { loadSettings, type Settings } from "./config/settings";
import { createChatModel } from "./llm/client";
import { createObserverDeps } from "./llm/observer";
import type { Action } from "./llm/schemas";
import { createSessionAgentDeps } from "./llm/session_agent";
import { modelDocumentPlanAgent, modelDocumentTextAgent } from "./llm/document";
import { modelGeneralProposer } from "./llm/general";
import { modelRevisionProposer } from "./llm/revision";
import { modelPlannerAgent } from "./llm/planner";
import { modelProposer, type Proposer } from "./loop/propose";
import { probeSession } from "./loop/probe";
import { runRepl } from "./session/repl";
import { memoryTelemetry } from "./session/telemetry";
import type { SessionTurnDeps } from "./session/driver";
import { runTui } from "./tui/run";
import { fsWorkspace, type Workspace } from "./tools/workspace";
import { createTerminalIo, runAuthLogin } from "./providers/auth";
import { runAuthCommand, runDoctorCommand, runHelpOrVersion, runModelsCommand } from "./providers/cli";
import { detectLocalProviders, listModels as listProviderModels } from "./providers/probe";
import { applyProvider, resolveProvider, type ResolvedProvider } from "./providers/resolve";
import {
  readAuth,
  readProviderConfig,
  writeProviderConfig,
  type AuthFile,
  type ProviderConfig,
} from "./providers/store";

interface CliArgs {
  dir: string;
  maxTurns?: number;
  model?: string;
  provider?: string;
  baseURL?: string;
  verbose?: boolean;
  plain?: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { dir: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--dir" && value !== undefined) {
      args.dir = value;
      index += 1;
    } else if (flag === "--max-turns" && value !== undefined) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) args.maxTurns = parsed;
      index += 1;
    } else if (flag === "--model" && value !== undefined) {
      args.model = value;
      index += 1;
    } else if (flag === "--provider" && value !== undefined) {
      args.provider = value;
      index += 1;
    } else if (flag === "--base-url" && value !== undefined) {
      args.baseURL = value;
      index += 1;
    } else if (flag === "--verbose") {
      args.verbose = true;
    } else if (flag === "--plain") {
      args.plain = true;
    } else if (flag !== undefined && !flag.startsWith("--")) {
      args.dir = flag;
    }
  }
  return args;
}

export function resolveCliDir(dir: string): string {
  const expanded =
    dir === "~" ? homedir() : dir.startsWith("~/") ? resolve(homedir(), dir.slice(2)) : dir;
  const full = resolve(expanded);
  let stat: Stats;
  try {
    stat = statSync(full);
  } catch {
    throw new Error(`workspace not found: ${full}`);
  }
  if (!stat.isDirectory()) throw new Error(`workspace is not a directory: ${full}`);
  return full;
}

function actionName(action: Action): string {
  return action.operator === "apply" ? action.action.tool : action.operator;
}

async function runPlain(args: CliArgs, deps: SessionTurnDeps, workspace: Workspace): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
  });
  emitKeypressEvents(process.stdin);
  let active: AbortController | undefined;
  rl.on("keypress", (_text, key) => {
    // Esc pauses; Ctrl-C is handled by the SIGINT handler below.
    if (key?.name === "escape" && active !== undefined && !active.signal.aborted) {
      active.abort();
    }
  });
  async function* lines(): AsyncGenerator<string> {
    for await (const line of rl) {
      yield line;
      rl.prompt();
    }
  }

  process.stdout.write(`workspace: ${workspace.root}\n`);
  rl.prompt();

  let paused = false;
  const onSigint = (): void => {
    if (active !== undefined && !active.signal.aborted) {
      active.abort();
      return;
    }
    if (paused) {
      rl.close();
      return;
    }
    process.stdout.write("\nenter a message (or exit)\n");
    rl.prompt();
  };
  process.on("SIGINT", onSigint);

  try {
    await runRepl(
      lines(),
      deps,
      (line) => process.stdout.write(`${line}\n`),
      undefined,
      {
        ...(args.verbose === true ? { verbose: true } : {}),
        createSignal: () => {
          const controller = new AbortController();
          active = controller;
          return controller.signal;
        },
        onTurnEnd: () => {
          active = undefined;
        },
        onPauseChanged: (value) => {
          paused = value;
        },
      },
    );
  } finally {
    process.off("SIGINT", onSigint);
    rl.close();
  }
}

async function ensureProvider(args: CliArgs): Promise<ResolvedProvider> {
  let config: ProviderConfig | undefined;
  let auth: AuthFile | undefined;
  config = readProviderConfig();
  auth = readAuth();
  const resolve = (): ResolvedProvider =>
    resolveProvider({
      ...(config !== undefined ? { config } : {}),
      ...(auth !== undefined ? { auth } : {}),
      ...(args.provider !== undefined ? { provider: args.provider } : {}),
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.baseURL !== undefined ? { baseURL: args.baseURL } : {}),
    });
  let resolved = resolve();
  if (resolved.ready) return resolved;

  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error(
      `no provider ready: ${resolved.reason ?? "unknown"}\n` +
        "run `skein auth login` or set SKEIN_API_KEY",
    );
  }
  process.stdout.write(`no provider ready: ${resolved.reason ?? "unknown"}\n`);
  const local = await detectLocalProviders();
  const io = createTerminalIo();
  try {
    await runAuthLogin({
      io,
      ...(args.provider !== undefined ? { provider: args.provider } : {}),
      local,
    });
  } finally {
    io.close();
  }
  config = readProviderConfig();
  auth = readAuth();
  resolved = resolve();
  if (!resolved.ready) {
    throw new Error(`provider is still not ready: ${resolved.reason ?? "unknown"}`);
  }
  return resolved;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (runHelpOrVersion(argv)) return;
  if (argv[0] === "auth") {
    process.exitCode = await runAuthCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "models") {
    process.exitCode = await runModelsCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "doctor") {
    process.exitCode = await runDoctorCommand(argv.slice(1));
    return;
  }

  const args = parseArgs(argv);
  const root = resolveCliDir(args.dir);
  const provider = await ensureProvider(args);
  let settings = applyProvider(loadSettings(), provider);
  const workspace = fsWorkspace(root, {
    runTimeoutMs: settings.runTimeoutMs,
    checkpoints: true,
  });

  const telemetry = memoryTelemetry();

  // The session intro probe is lazy and cached: one shell + tree walk per session, not per line.
  const sessionProbe = (() => {
    let probed = false;
    let cached: ReturnType<typeof probeSession>;
    return (): ReturnType<typeof probeSession> => {
      if (!probed) {
        cached = probeSession(workspace);
        probed = true;
      }
      return cached;
    };
  })();

  const buildAgent = (agentSettings: Settings): { deps: SessionTurnDeps } => {
    const model = createChatModel(agentSettings);
    const basePropose = modelProposer(model);
    let taskTurn = 0;
    const propose: Proposer = async (context) => {
      const proposal = await basePropose(context);
      taskTurn += 1;
      if (args.plain === true && args.verbose === true) {
        const actions = proposal.actions.map(actionName).join(", ");
        process.stdout.write(`  [${taskTurn}] ${actions}\n`);
      }
      return proposal;
    };
    const deps: SessionTurnDeps = {
      sessionProbe,
      sessionAgent: {
        ...createSessionAgentDeps(model, { settings: agentSettings }),
        telemetry: telemetry.sink,
      },
      task: {
        propose,
        workspace,
        maxTurns: args.maxTurns ?? agentSettings.maxTurns,
        probe: probeSession,
        telemetry: telemetry.sink,
        ...(agentSettings.observer
          ? { observer: createObserverDeps(model, { settings: agentSettings }) }
          : {}),
      },
      general: {
        propose: modelGeneralProposer(model, { settings: agentSettings }),
        workspace,
        maxTurns: args.maxTurns ?? agentSettings.generalMaxTurns,
        telemetry: telemetry.sink,
      },
      revision: {
        propose: modelRevisionProposer(model, { settings: agentSettings }),
        workspace,
        maxTurns: args.maxTurns ?? agentSettings.maxTurns,
        telemetry: telemetry.sink,
      },
      planGeneralMaxTurns: args.maxTurns ?? agentSettings.planGeneralMaxTurns,
      budgetExtend: agentSettings.budgetExtend,
      planner: {
        agent: modelPlannerAgent(model, {
          settings: agentSettings,
          rebuild: (rebuildOptions) =>
            rebuildOptions?.reasoningOff === true
              ? createChatModel({ ...agentSettings, reasoningEffort: "none" })
              : model,
        }),
        workspace,
        maxTurns: args.maxTurns ?? agentSettings.plannerMaxTurns,
        telemetry: telemetry.sink,
      },
      document: {
        plan: modelDocumentPlanAgent(model, {
          settings: agentSettings,
          rebuild: (rebuildOptions) =>
            rebuildOptions?.reasoningOff === true
              ? createChatModel({ ...agentSettings, reasoningEffort: "none" })
              : model,
        }),
        write: modelDocumentTextAgent(model, {
          settings: agentSettings,
          rebuild: (rebuildOptions) =>
            rebuildOptions?.reasoningOff === true
              ? createChatModel({ ...agentSettings, reasoningEffort: "none" })
              : model,
        }),
        workspace,
        maxTurns: args.maxTurns ?? agentSettings.maxTurns,
        maxPlanTurns: args.maxTurns ?? agentSettings.plannerMaxTurns,
        telemetry: telemetry.sink,
      },
      telemetry: telemetry.sink,
    };
    return { deps };
  };

  let built = buildAgent(settings);

  try {
    if (args.plain === true) {
      process.stdout.write(`provider: ${provider.label}\n`);
      await runPlain(args, built.deps, workspace);
    } else {
      await runTui({
        deps: built.deps,
        telemetry,
        workspace: workspace.root,
        model: provider.label,
        listModels: () => listProviderModels(provider.baseURL, { apiKey: provider.apiKey }),
        onModelChange: async (modelId) => {
          try {
            const nextProvider: ResolvedProvider = {
              ...provider,
              model: modelId,
              label: `${provider.providerId}/${modelId}`,
              ready: true,
            };
            settings = applyProvider(loadSettings(), nextProvider);
            const explicitBase = provider.baseURL !== provider.preset.baseURL;
            writeProviderConfig({
              version: 1,
              provider: provider.providerId,
              model: modelId,
              ...(explicitBase ? { baseURL: provider.baseURL } : {}),
            });
            built = buildAgent(settings);
            return { deps: built.deps, label: nextProvider.label };
          } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
          }
        },
      });
    }
  } finally {
    workspace.clearCheckpoints?.();
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
