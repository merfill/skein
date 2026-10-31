import { createInterface, emitKeypressEvents } from "node:readline";

import { loadSettings } from "./config/settings";
import { createChatModel } from "./llm/client";
import { createObserverDeps } from "./llm/observer";
import type { Action } from "./llm/schemas";
import { createSessionAgentDeps } from "./llm/session_agent";
import { modelProposer, type Proposer } from "./loop/propose";
import { probeSession } from "./loop/probe";
import { runRepl } from "./session/repl";
import { createSessionWorkspace } from "./session/session_workspace";
import { memoryTelemetry } from "./session/telemetry";
import type { SessionTurnDeps } from "./session/driver";
import { fsWorkspace } from "./tools/workspace";

interface CliArgs {
  dir: string;
  maxTurns?: number;
  model?: string;
  verbose?: boolean;
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
    } else if (flag !== undefined && !flag.startsWith("--")) {
      args.dir = flag;
    }
  }
  return args;
}

function actionName(action: Action): string {
  return action.operator === "apply" ? action.action.tool : action.operator;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const settings = loadSettings();
  const model = createChatModel({
    ...settings,
    ...(args.model !== undefined ? { model: args.model } : {}),
  });
  const workspace = fsWorkspace(args.dir, {
    runTimeoutMs: settings.runTimeoutMs,
    checkpoints: true,
  });
  const basePropose = modelProposer(model);
  let taskTurn = 0;
  const propose: Proposer = async (context) => {
    const proposal = await basePropose(context);
    taskTurn += 1;
    if (args.verbose === true) {
      const actions = proposal.actions.map(actionName).join(", ");
      process.stdout.write(`  [${taskTurn}] ${actions}\n`);
    }
    return proposal;
  };

  const sessionWorkspace = createSessionWorkspace(workspace);
  const telemetry = memoryTelemetry();

  const deps: SessionTurnDeps = {
    sessionAgent: {
      ...createSessionAgentDeps(model, { settings, workspace: sessionWorkspace }),
      telemetry: telemetry.sink,
    },
    task: {
      propose,
      workspace,
      maxTurns: args.maxTurns ?? settings.maxTurns,
      probe: probeSession,
      telemetry: telemetry.sink,
      ...(settings.observer ? { observer: createObserverDeps(model, { settings }) } : {}),
    },
    telemetry: telemetry.sink,
  };

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
  });
  emitKeypressEvents(process.stdin);
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

  let active: AbortController | undefined;
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
    workspace.clearCheckpoints?.();
    process.off("SIGINT", onSigint);
    rl.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
