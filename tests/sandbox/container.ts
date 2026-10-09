import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import { fsWorkspace, type CommandResult, type PathFilter, type Workspace } from "../../src/tools/workspace";

// A real-execution workspace for a terminal-bench task, isolated with `bwrap` (bubblewrap)
// instead of Docker: `run` executes a real shell inside a namespace where the workspace is
// mounted at the task's WORKDIR (`/app` by default) and the host is otherwise read-only.
// No network (`--unshare-net`), no host home, `/tmp` is a tmpfs — the model's commands
// cannot escape or persist. The host system tree (`/usr`, `/bin`, `/lib`, `/etc`) is shared
// read-only, so the tools already installed on the host are available to the task.
//
// The file tools (`read`/`write`/`edit`/`list`/`grep`) operate on the same host temp dir via
// `fsWorkspace`, rewriting a leading `/app/` prefix so the task's absolute paths work. The
// engine's three node-kinds and the projection are untouched: this is only a `Workspace`.

export interface ContainerOptions {
  // The task WORKDIR inside the namespace; the host root is bind-mounted here.
  mountPoint?: string;
  runTimeoutMs?: number;
}

// Host system trees a command needs; bound read-only, when present.
const SYSTEM_PATHS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"];

const DEFAULT_RUN_TIMEOUT_MS = 120_000;

export function containerWorkspace(root: string, options: ContainerOptions = {}): Workspace {
  const mount = options.mountPoint ?? "/app";
  const timeoutMs = options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  // The job registry lives on the host `fsWorkspace`; give it the namespace's cap so a
  // background poll waits as long as a foreground run would.
  const base = fsWorkspace(root, { runTimeoutMs: timeoutMs });
  const binds = SYSTEM_PATHS.filter((path) => existsSync(path)).flatMap((path) => ["--ro-bind", path, path]);

  // The workspace root as the task sees it: `/app` -> ".", `/app/x` -> "x", relative paths
  // unchanged. Without this a `write { path: "/app/regex.txt" }` would be rejected as
  // escaping the workspace (the task's instructions use absolute paths).
  const containerPath = (path: string): string => {
    if (path === mount) return ".";
    if (path.startsWith(`${mount}/`)) return path.slice(mount.length + 1);
    return path;
  };

  const containerFilter = (filter: PathFilter): PathFilter =>
    filter.path === undefined ? filter : { ...filter, path: containerPath(filter.path) };

  const run = (command: string): CommandResult => {
    const result = spawnSync(
      "bwrap",
      [
        "--die-with-parent",
        "--unshare-net",
        ...binds,
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--tmpfs",
        "/tmp",
        "--bind",
        root,
        mount,
        "--chdir",
        mount,
        "/bin/bash",
        "-c",
        `set -o pipefail; ulimit -c unlimited 2>/dev/null; ${command}`,
      ],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
    );
    const timedOut =
      result.signal === "SIGTERM" ||
      (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    return {
      code: result.status ?? (timedOut ? 124 : 1),
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      ...(timedOut ? { timedOut: true } : {}),
      ...(result.signal !== undefined && result.signal !== null ? { signal: result.signal } : {}),
    };
  };

  // File tools delegate to the host `fsWorkspace` with the `/app` prefix rewritten. The
  // background-job and fetch paths keep the base implementation (a documented limitation:
  // a background job would run on the host, not in the namespace).
  return {
    ...base,
    read: (path) => base.read(containerPath(path)),
    version: (path) => base.version(containerPath(path)),
    signature: (path) => base.signature(containerPath(path)),
    write: (path, content) => base.write(containerPath(path), content),
    exists: (path) => base.exists(containerPath(path)),
    grep: (pattern, filter) => base.grep(pattern, containerFilter(filter ?? {})),
    listFiles: (filter) => base.listFiles(containerFilter(filter ?? {})),
    run,
  };
}
