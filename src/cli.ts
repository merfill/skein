import { statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface, emitKeypressEvents } from "node:readline";
import { pathToFileURL } from "node:url";

import { loadSettings } from "./config/settings";
import { createChatModel } from "./llm/client";
import { createObserverDeps } from "./llm/observer";
import type { Action } from "./llm/schemas";
import { createSessionAgentDeps } from "./llm/session_agent";
import { modelGeneralProposer } from "./llm/general";
import { modelProposer, type Proposer } from "./loop/propose";
import { probeSession } from "./loop/probe";
import { runRepl } from "./session/repl";
import { memoryTelemetry } from "./session/telemetry";
import type { SessionTurnDeps } from "./session/driver";
import { runTui } from "./tui/run";
import { fsWorkspace, type Workspace } from "./tools/workspace";

interface CliArgs {
  dir: string;
  maxTurns?: number;
  model?: string;
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = resolveCliDir(args.dir);
  const settings = loadSettings();
  const modelName = args.model ?? settings.model;
  const model = createChatModel({
    ...settings,
    model: modelName,
  });
  const workspace = fsWorkspace(root, {
    runTimeoutMs: settings.runTimeoutMs,
    checkpoints: true,
  });
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

  const deps: SessionTurnDeps = {
    sessionProbe,
    sessionAgent: {
      ...createSessionAgentDeps(model, { settings }),
      telemetry: telemetry.sink,
    },
    task: {
      propose,
      workspace,
      ...(args.maxTurns !== undefined ? { maxTurns: args.maxTurns } : {}),
      probe: probeSession,
      telemetry: telemetry.sink,
      ...(settings.observer ? { observer: createObserverDeps(model, { settings }) } : {}),
    },
    general: {
      propose: modelGeneralProposer(model, { settings }),
      workspace,
      maxTurns: args.maxTurns ?? settings.generalMaxTurns,
      telemetry: telemetry.sink,
    },
    telemetry: telemetry.sink,
  };

  try {
    if (args.plain === true) {
      await runPlain(args, deps, workspace);
    } else {
      await runTui({
        deps,
        telemetry,
        workspace: workspace.root,
        model: modelName,
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
