import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { runAgent, type AgentResult } from "../../src/loop/graph";
import type { Proposer } from "../../src/loop/propose";
import type { CommandResult, Workspace } from "../../src/tools/workspace";
import { containerWorkspace } from "./container";
import { dockerWorkspace } from "./docker";
import type { SandboxRunOptions } from "./run";
import { APT_SHIM, DEFAULT_TASK_CHECK, PYTEST_SHIM, VERIFIER_RUNNER, harborTaskDir, type SandboxTask } from "./task";
import { newSandboxRoot } from "./workspace";

// Runs a real terminal-bench task against the real engine, without Docker: the environment
// is materialized into a temp root, the agent runs in a `bwrap` namespace (`container.ts`),
// and the task's own verifier scores the result. The engine, the projection and the metric
// extraction are the same as in production — this only swaps the `Workspace`.

export interface TaskRun {
  result: AgentResult;
  workspace: Workspace;
  reward: number;
  check: CommandResult;
  root: string;
  request: string;
}

// The on-disk task root and its verifier: the environment's files, the task's own verifier
// (under `.skein/`, hidden from the agent's file tools) and the pytest-free runner. Shared
// by the engine harness (`runTask`) and the opencode adapter (`opencode.ts`).
export interface MaterializedTask {
  root: string;
  request: string;
  check: string;
}

export function materializeTask(
  task: SandboxTask,
  options: { stageSolution?: boolean } = {},
): MaterializedTask {
  const taskDir = harborTaskDir(task.id);
  const root = newSandboxRoot(`skein-task-${task.id}-`);

  // The environment's own files (a Docker `COPY` in the task).
  for (const [path, content] of Object.entries(task.files ?? {})) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  // The task's verifier, copied under `.skein/` (hidden from the agent's file tools, which
  // skip SKIP_DIRS) together with the pytest-free runner.
  const testsDst = join(root, ".skein", "tests");
  mkdirSync(testsDst, { recursive: true });
  cpSync(join(taskDir, "tests"), testsDst, { recursive: true });
  writeFileSync(join(testsDst, "run.py"), VERIFIER_RUNNER);
  // A `pytest` stand-in next to the runner, so `import pytest` resolves without installing it.
  writeFileSync(join(testsDst, "pytest.py"), PYTEST_SHIM);

  // Test-only: stage the task's solution for the offline harness check. For an offline task
  // (network "none") a no-op apt shim lets a solution that begins with `apt-get install`
  // proceed (the tool is already in the image); a networked task (crack-7z-hash) gets real
  // apt instead.
  if (options.stageSolution === true && existsSync(join(taskDir, "solution", "solve.sh"))) {
    if (task.network === undefined) {
      const binDir = join(root, ".skein", "bin");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, "apt-get"), APT_SHIM);
      chmodSync(join(binDir, "apt-get"), 0o755);
    }
    cpSync(join(taskDir, "solution", "solve.sh"), join(root, ".skein", "solve.sh"));
  }

  const request = task.request ?? readFileSync(join(taskDir, "instruction.md"), "utf8");
  const check = task.check ?? DEFAULT_TASK_CHECK;
  return { root, request, check };
}

export async function runTask(
  task: SandboxTask,
  propose: Proposer,
  options: SandboxRunOptions = {},
): Promise<TaskRun> {
  const { root, request, check } = materializeTask(task, { stageSolution: options.stageSolution });
  const workspace =
    task.image !== undefined
      ? dockerWorkspace(root, {
          image: task.image,
          ...(task.mountPoint !== undefined ? { mountPoint: task.mountPoint } : {}),
          ...(task.workdir !== undefined ? { workdir: task.workdir } : {}),
          ...((task.network ?? options.network) !== undefined
            ? { network: task.network ?? options.network }
            : {}),
        })
      : containerWorkspace(root, {
          ...(task.mountPoint !== undefined ? { mountPoint: task.mountPoint } : {}),
        });

  // The Dockerfile/setup.sh steps a task needs before the agent starts.
  for (const command of task.setup ?? []) {
    const result = workspace.run(command);
    if (result.code !== 0) {
      throw new Error(`task ${task.id} setup failed (exit ${result.code}): ${command}\n${result.stderr}`);
    }
  }

  const result = await runAgent(
    {
      propose,
      workspace,
      maxTurns: options.maxTurns ?? task.maxTurns ?? 24,
    },
    {
      request: { id: "r1", text: request },
      ...(options.constraints !== undefined ? { constraints: options.constraints } : {}),
    },
  );

  // A pre-verifier step in the task container (e.g. fix-ocaml-gc rebuilds and regenerates
  // the tests.txt the verifier reads); its exit code is left to the verifier to reflect.
  if (task.checkSetup !== undefined) workspace.run(task.checkSetup);

  // The verifier runs in the task container by default; a task whose image lacks the
  // verifier's runtime (git-leak-recovery has no Python) can run it via bwrap on the host.
  const checker = task.checkIn === "host" ? containerWorkspace(root) : workspace;
  const checked = checker.run(check);
  return {
    result,
    workspace,
    reward: checked.code === 0 ? 1 : 0,
    check: checked,
    root,
    request,
  };
}

// True when the task's Harbor cache is present (so a test can skip on a machine without it).
export function taskAvailable(id: string): boolean {
  try {
    return existsSync(join(harborTaskDir(id), "instruction.md"));
  } catch {
    return false;
  }
}
