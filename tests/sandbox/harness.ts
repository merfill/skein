import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { probeSession } from "../../src/loop/probe";
import { runAgent, type AgentResult } from "../../src/loop/graph";
import type { Proposer } from "../../src/loop/propose";
import type { CommandResult, Workspace } from "../../src/tools/workspace";
import { createCheckpoint, type Checkpoint } from "./checkpoint";
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

// The on-disk task root, its request and the verifier command. Shared by the engine harness
// (`runTask`) and the opencode adapter (`opencode.ts`). The verifier's own files are staged
// later (`stageVerifier`), after the agent has run — see its comment.
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

  // The harness's own directory: the instruction/config and, after the agent, the verifier
  // (`stageVerifier`). The engine's own outputs (`observations`, `jobs`, `ref`) mkdir on demand.
  mkdirSync(join(root, ".skein"), { recursive: true });

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

// Stage the task's verifier under `<root>/.skein/tests/`: the task's own pytest files plus the
// pytest-free runner and shim. It is called AFTER the agent has run, never before: the agent's
// workspace must not carry the verifier, whose Harbor `test.sh` can name the solution (it
// re-clones the exact broken revision). The agent's file tools skip `.skein`, but its shell
// does not, so "hidden" only holds if the files are simply absent during the agent phase. The
// verifier is (re)materialized here from the task cache at check time, so the reward stays
// reproducible.
export function stageVerifier(root: string, task: SandboxTask): void {
  const testsDst = join(root, ".skein", "tests");
  mkdirSync(testsDst, { recursive: true });
  cpSync(join(harborTaskDir(task.id), "tests"), testsDst, { recursive: true });
  writeFileSync(join(testsDst, "run.py"), VERIFIER_RUNNER);
  // A `pytest` stand-in next to the runner, so `import pytest` resolves without installing it.
  writeFileSync(join(testsDst, "pytest.py"), PYTEST_SHIM);
}

// The task's engine-ready world: its root, request, verifier command, the container-backed
// workspace with the checkpoint layer, and the per-turn snapshot hook. Shared by the full run
// (`runTask`) and the turn-at-a-time driver (`bench/live-step.ts`), so both run the same
// environment and the same setup.
export interface OpenedTask {
  workspace: Workspace;
  root: string;
  request: string;
  check: string;
  checkpoint: Checkpoint;
  capture: (label: string) => void;
}

export function openTaskWorkspace(
  task: SandboxTask,
  options: SandboxRunOptions = {},
): OpenedTask {
  const { root, request, check } = materializeTask(task, { stageSolution: options.stageSolution });
  // The checkpoint store lives under `.skein`, so it is skipped by the file tools and never
  // part of a snapshot. It is mounted read-only into the task so the agent's shell can read
  // it (db-wal's image has tar/cp but no git) but cannot corrupt the snapshots.
  const checkpoint = createCheckpoint(root);
  const checkpointDest = `${task.mountPoint ?? "/app"}/.skein/checkpoints`;
  const baseWorkspace =
    task.image !== undefined
      ? dockerWorkspace(root, {
          image: task.image,
          ...(task.mountPoint !== undefined ? { mountPoint: task.mountPoint } : {}),
          ...(task.workdir !== undefined ? { workdir: task.workdir } : {}),
          ...((task.network ?? options.network) !== undefined
            ? { network: task.network ?? options.network }
            : {}),
          mounts: [{ host: checkpoint.dir, dest: checkpointDest, readOnly: true }],
        })
      : containerWorkspace(root, {
          ...(task.mountPoint !== undefined ? { mountPoint: task.mountPoint } : {}),
          roBinds: [{ host: checkpoint.dir, dest: checkpointDest }],
        });
  // The engine's revert uses this only for a preimage its calls cannot reconstruct (bash,
  // write, apply_patch, deletions); the layer is absent in a plain filesystem workspace.
  const workspace: Workspace = {
    ...baseWorkspace,
    checkpoint: (label) => checkpoint.checkpoint(label),
    restoreCheckpoint: (id, paths) => checkpoint.restore(id, paths),
  };

  // The Dockerfile/setup.sh steps a task needs before the agent starts.
  for (const command of task.setup ?? []) {
    const result = workspace.run(command);
    if (result.code !== 0) {
      throw new Error(`task ${task.id} setup failed (exit ${result.code}): ${command}\n${result.stderr}`);
    }
  }

  // The baseline is the post-setup state: setup may create the artifacts the task starts from.
  // Each turn snapshots again, so a `bash` deletion/checkpoint in one turn is recoverable in
  // the next. A turn that changed nothing reuses the previous tree (see `createCheckpoint`).
  const capture = (label: string): void => {
    try {
      checkpoint.snapshot(label);
    } catch (error) {
      // The checkpoint is a safety net, never a reason to abort the task.
      console.warn(`[checkpoint] ${label} skipped: ${String(error)}`);
    }
  };
  capture("initial");
  return { workspace, root, request, check, checkpoint, capture };
}

export async function runTask(
  task: SandboxTask,
  propose: Proposer,
  options: SandboxRunOptions = {},
): Promise<TaskRun> {
  const { workspace, root, request, check, capture } = openTaskWorkspace(task, options);
  let turn = 0;
  const proposeWithCheckpoint: Proposer = async (context) => {
    capture(`turn-${turn}`);
    turn += 1;
    return propose(context);
  };

  const result = await runAgent(
    {
      propose: proposeWithCheckpoint,
      workspace,
      maxTurns: options.maxTurns ?? task.maxTurns ?? 24,
      probe: probeSession,
    },
    {
      request: { id: "r1", text: request },
      ...(options.constraints !== undefined ? { constraints: options.constraints } : {}),
    },
  );

  // The verifier is staged only now — after the agent, before the check — so the agent's
  // workspace never contained it.
  stageVerifier(root, task);

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
