import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { probeSession } from "../../src/loop/probe";
import { runAgent, type AgentResult } from "../../src/loop/graph";
import type { Proposer } from "../../src/loop/propose";
import type { CommandResult, Workspace } from "../../src/tools/workspace";
import { createCheckpoint, createCheckpointWithBackend, type Checkpoint } from "./checkpoint";
import { DockerBackend } from "./checkpoint-docker";
import { containerWorkspace } from "./container";
import { dockerWorkspace, type DockerWorkspace } from "./docker";
import { resolveNetwork, type NetworkPlan } from "./network";
import type { SandboxRunOptions } from "./run";
import { APT_SHIM, DEFAULT_TASK_CHECK, PYTEST_SHIM, VERIFIER_RUNNER, harborTaskDir, type SandboxTask } from "./task";
import { newSandboxRoot } from "./workspace";

// Runs a real terminal-bench task against the real engine, without Harbor: an image task runs
// rootless in its own Docker container (`docker.ts`); an image-less fallback materializes a
// temp root and runs under `bwrap` (`container.ts`). The task's own verifier scores the
// result. The engine, the projection and the metric extraction are the same as in production —
// this only swaps the `Workspace`.

export interface TaskRun {
  result: AgentResult;
  workspace: Workspace;
  reward: number;
  // The acceptance that produced the reward: the task's own `test.sh` (Harbor's path) or,
  // on the legacy/bwrap path, the task's `check` command.
  acceptance: "test.sh" | "task-check";
  // Where the reward came from. `reward.txt` is written by `test.sh` and is authoritative;
  // `exit` is the legacy check's exit code; `missing` means `test.sh` did not produce one
  // (an infrastructure failure in the verifier phase).
  rewardSource: "reward.txt" | "exit" | "missing";
  check: CommandResult;
  network: NetworkPlan;
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
  network: NetworkPlan;
  // Docker tasks run the image directly; `/app` is never extracted to the host.
  rootless?: boolean;
  container?: DockerWorkspace;
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

// Test-only: stage the task's own solution inside the task container, so the offline harness
// can replay it without extracting `/app` to the host. An offline task's solution may begin
// with `apt-get install`; a no-op shim on PATH lets it proceed because the image already has
// the tool. A networked task (crack-7z-hash) keeps the real apt.
function stageSolutionInContainer(workspace: Workspace, task: SandboxTask, taskDir: string): void {
  const solution = join(taskDir, "solution", "solve.sh");
  if (!existsSync(solution)) return;
  const mount = task.mountPoint ?? "/app";
  if (task.network === undefined) {
    const shim = `${mount}/.skein/bin/apt-get`;
    workspace.write(shim, APT_SHIM);
    const chmod = workspace.run(`chmod 755 ${shellQuote(shim)}`);
    if (chmod.code !== 0) throw new Error(`apt shim chmod failed: ${chmod.stderr.trim()}`);
  }
  workspace.write(`${mount}/.skein/solve.sh`, readFileSync(solution, "utf8"));
}

const TEST_SH = "bash /tests/test.sh";
const VERIFIER_TIMEOUT_MS = 900_000;

// Stage the task's own `tests/` at `/tests` INSIDE the agent's container, exactly where
// Harbor puts them. Called only after the agent has run, so the verifier is never visible
// during the work (fix-ocaml-gc's test.sh re-clones the solution).
function stageTestSh(container: DockerWorkspace, task: SandboxTask): void {
  const prepared = container.exec("rm -rf /tests /logs/verifier && mkdir -p /tests /logs/verifier");
  if (prepared.code !== 0) throw new Error(prepared.stderr.trim() || "test dirs failed");
  const staged = spawnSync(
    "docker",
    ["cp", `${join(harborTaskDir(task.id), "tests")}/.`, `${container.name}:/tests`],
    { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
  );
  if (staged.status !== 0) {
    throw new Error((staged.stderr ?? "").trim() || "test.sh staging failed");
  }
}

export interface VerificationOutcome {
  checked: CommandResult;
  reward: number;
  rewardSource: "reward.txt" | "missing";
}

// Run the task's own `tests/test.sh` in the agent's container and read the verdict it wrote.
// Shared by the engine path and the opencode baseline so both are accepted by exactly the
// same script. Called only after the agent; its network is the caller's responsibility.
export function runTestSh(task: SandboxTask, container: DockerWorkspace): VerificationOutcome {
  stageTestSh(container, task);
  const checked = container.run(TEST_SH, { timeoutMs: VERIFIER_TIMEOUT_MS });
  const verdict = readReward(container);
  return { checked, reward: verdict.reward, rewardSource: verdict.source };
}

// `test.sh` writes the verdict to `/logs/verifier/reward.txt`; its exit code is not the
// reward (the scripts end with a successful `echo`, even when pytest failed). A missing file
// is a verifier failure, not a pass.
function readReward(container: DockerWorkspace): { reward: number; source: "reward.txt" | "missing" } {
  const result = container.exec("cat /logs/verifier/reward.txt");
  const raw = result.stdout.trim();
  if (result.code === 0 && (raw === "0" || raw === "1")) {
    return { reward: Number(raw), source: "reward.txt" };
  }
  return { reward: 0, source: "missing" };
}

// Docker tasks: start the task image directly. No `tar | tar`, no `-v root:/app`; the
// checkpoint store lives in the container (`/tmp/.skein`) and the host only orchestrates.
function openRootlessTask(task: SandboxTask, options: SandboxRunOptions, network: NetworkPlan): OpenedTask {
  const taskDir = harborTaskDir(task.id);
  const request = task.request ?? readFileSync(join(taskDir, "instruction.md"), "utf8");
  const check = TEST_SH;
  const root = newSandboxRoot(`skein-rootless-${task.id}-`);
  const mount = task.mountPoint ?? "/app";
  // Rootless Docker cannot connect a network to a container started with `--network none`.
  // Start on the verifier's network, detach it for an offline agent, and reattach it before
  // `test.sh` (Harbor's verifier has network; see `network.ts`).
  const startNetwork = task.network ?? (network.verifier === "host" ? "bridge" : network.verifier);
  const container = dockerWorkspace(root, {
    image: task.image as string,
    rootless: true,
    network: startNetwork,
    ...(task.mountPoint !== undefined ? { mountPoint: task.mountPoint } : {}),
    ...(task.workdir !== undefined ? { workdir: task.workdir } : {}),
  });
  for (const [path, content] of Object.entries(task.files ?? {})) {
    container.write(path.startsWith("/") ? path : `${mount}/${path}`, content);
  }
  if (options.stageSolution === true) stageSolutionInContainer(container, task, taskDir);
  const checkpoint = createCheckpointWithBackend(new DockerBackend(container, "/tmp/.skein", mount));
  const workspace: Workspace = {
    ...container,
    checkpoint: (label) => checkpoint.checkpoint(label),
    restoreCheckpoint: (id, paths) => checkpoint.restore(id, paths),
  };
  for (const command of task.setup ?? []) {
    const result = workspace.run(command);
    if (result.code !== 0) {
      throw new Error(`task ${task.id} setup failed (exit ${result.code}): ${command}\n${result.stderr}`);
    }
  }
  // There is no task `setup` today; if one appears, it runs before this point and keeps the
  // network. The agent starts after the detach, so `off` is honest for its work.
  if (network.agent === "none") container.detachNetwork(startNetwork);
  const capture = (label: string): void => {
    try {
      checkpoint.snapshot(label);
    } catch (error) {
      console.warn(`[checkpoint] ${label} skipped: ${String(error)}`);
    }
  };
  capture("initial");
  return { workspace, root, request, check, checkpoint, capture, network, rootless: true, container };
}

export function openTaskWorkspace(
  task: SandboxTask,
  options: SandboxRunOptions = {},
): OpenedTask {
  const network = resolveNetwork(options.network ?? "on");
  if (task.image !== undefined) {
    if (task.network !== undefined && network.requested === "off") {
      throw new Error(`task ${task.id} requires network; run with --net on`);
    }
    return openRootlessTask(task, options, network);
  }
  const { root, request, check } = materializeTask(task, { stageSolution: options.stageSolution });
  // Image-less fallback (none of the ported tasks today): a host root under bwrap. The
  // checkpoint store lives under `.skein`, so it is skipped by the file tools and never part
  // of a snapshot; it is mounted read-only so the agent's shell can read it but not corrupt it.
  const checkpoint = createCheckpoint(root);
  const checkpointDest = `${task.mountPoint ?? "/app"}/.skein/checkpoints`;
  const baseWorkspace = containerWorkspace(root, {
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
  return { workspace, root, request, check, checkpoint, capture, network: { ...network, agent: "host", verifier: "host" } };
}

export async function runTask(
  task: SandboxTask,
  propose: Proposer,
  options: SandboxRunOptions = {},
): Promise<TaskRun> {
  const { workspace, root, request, check, capture, network, rootless, container } = openTaskWorkspace(task, options);
  let turn = 0;
  const timings = process.env.SKEIN_TIMINGS === "1";
  const proposeWithCheckpoint: Proposer = async (context) => {
    if (timings) console.info(`[timing] capture start turn-${turn}`);
    const started = Date.now();
    capture(`turn-${turn}`);
    if (timings) console.info(`[timing] capture turn-${turn} ${Date.now() - started}ms`);
    turn += 1;
    return propose(context);
  };

  const result = await runAgent(
    {
      propose: proposeWithCheckpoint,
      workspace,
      maxTurns: options.maxTurns ?? task.maxTurns ?? 24,
      probe: (workspace) => probeSession(workspace, { network: network.requested }),
    },
    {
      request: { id: "r1", text: request },
      ...(options.constraints !== undefined ? { constraints: options.constraints } : {}),
    },
  );

  // Acceptance is staged only now — after the agent, before the check — so the agent's
  // workspace never contained it. On the Docker path this is the task's own `tests/test.sh`,
  // exactly as Harbor runs it: in the agent's container, with the agent's environment, and
  // with the verifier's network (independent of `--net off`). `checkSetup` is not run: the
  // task's `test.sh` owns its own preparation (fix-ocaml-gc re-clones, rebuilds and recreates
  // tests.txt there).
  let checkRoot = root;
  let checked: CommandResult;
  let reward: number;
  let rewardSource: TaskRun["rewardSource"];
  let acceptance: TaskRun["acceptance"];
  if (rootless) {
    const docker = container as DockerWorkspace;
    if (network.agent !== network.verifier) {
      docker.attachNetwork(network.verifier === "host" ? "bridge" : network.verifier);
    }
    const verdict = runTestSh(task, docker);
    checked = verdict.checked;
    reward = verdict.reward;
    rewardSource = verdict.rewardSource;
    acceptance = "test.sh";
  } else {
    stageVerifier(root, task);
    // A pre-verifier step in the task container (e.g. fix-ocaml-gc rebuilds and regenerates
    // the tests.txt the verifier reads); its exit code is left to the verifier to reflect.
    if (task.checkSetup !== undefined) workspace.run(task.checkSetup);
    // The verifier runs in the task container by default; a task whose image lacks the
    // verifier's runtime (git-leak-recovery has no Python) can run it via bwrap on the host.
    const checker = task.checkIn === "host" ? containerWorkspace(root) : workspace;
    checked = checker.run(check);
    reward = checked.code === 0 ? 1 : 0;
    rewardSource = "exit";
    acceptance = "task-check";
  }
  return {
    result,
    workspace,
    reward,
    acceptance,
    rewardSource,
    check: checked,
    network,
    root: checkRoot,
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
