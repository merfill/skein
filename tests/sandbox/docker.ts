import { spawnSync } from "node:child_process";

import { fsWorkspace, type CommandResult, type PathFilter, type Workspace } from "../../src/tools/workspace";

// A real-execution workspace backed by Docker, for a ported terminal-bench task: the task's
// own image already carries the exact environment (repo, toolchain), so there is nothing to
// install on the host. `run` executes `docker exec` inside the container; the file tools
// operate on the same `/app` tree via a host bind mount and `fsWorkspace`.
//
// Why Docker rather than bwrap (`container.ts`): bwrap isolates but shares the host `/usr`,
// so every task toolchain would have to be installed on the host. The task image provides
// it. Startup is fast because the images are already local; the only slow step is the
// task's own build, which is inherent.
//
// The image's `/app` is copied out once into a temp root, then that root is bind-mounted at
// `/app` in a fresh `sleep` container, so the agent's mutations are visible to the host
// file tools. Isolation: `--network none` by default, no host home mounted, removable on
// cleanup.

export interface DockerOptions {
  image: string;
  // Where the host root is mounted in the container.
  mountPoint?: string;
  // The container working directory (the task WORKDIR); relative paths resolve here.
  workdir?: string;
  // Docker network mode; `none` (default) keeps the agent offline.
  network?: string;
  runTimeoutMs?: number;
}

// Generous by default: a task's own build (fix-ocaml-gc, crack-7z-hash) runs inside the
// container and can take minutes.
const DEFAULT_RUN_TIMEOUT_MS = 600_000;

// Containers created here, removed by `cleanupContainers` (called from the test/CLI teardown).
// `root`/`mount` are kept so cleanup can first wipe the (root-owned) mount from inside the
// container; otherwise the host user cannot delete the files the container wrote as root.
interface Tracked {
  name: string;
  root: string;
  mount: string;
}
const containers: Tracked[] = [];
let counter = 0;

function docker(args: string[], timeoutMs = 300_000): { code: number; stdout: string; stderr: string } {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function dockerAvailable(): boolean {
  try {
    return spawnSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
}

export function dockerImageAvailable(image: string): boolean {
  return spawnSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 10_000 }).status === 0;
}

export function dockerWorkspace(root: string, options: DockerOptions): Workspace {
  const base = fsWorkspace(root);
  const mount = options.mountPoint ?? "/app";
  const workdir = options.workdir ?? mount;
  const network = options.network ?? "none";
  const timeoutMs = options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  counter += 1;
  const name = `skein-${process.pid}-${Date.now()}-${counter}`;

  // Extract the image's WORKDIR tree into the host root via a tar pipe. A plain `docker cp`
  // preserves the image's ownership (often root), which the host user then cannot read or
  // edit through the file tools; piping through the host `tar` (run as the host user) makes
  // the extracted tree host-owned.
  const extracted = spawnSync(
    "bash",
    ["-c", `set -o pipefail; docker run --rm --entrypoint tar ${shellQuote(options.image)} -C ${shellQuote(mount)} -cf - . | tar -C ${shellQuote(root)} -xf -`],
    { encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 },
  );
  if (extracted.status !== 0) throw new Error(`image extract failed: ${(extracted.stderr ?? "").trim()}`);

  // A long-lived container with the root bind-mounted at the WORKDIR; the agent's `run`
  // goes through `docker exec` so every command sees the same tree.
  const started = docker([
    "run", "-d", "--name", name,
    "--entrypoint", "sleep",
    "--network", network,
    "-v", `${root}:${mount}`,
    // A sane fd limit: the host's (huge) RLIMIT_NOFILE is inherited and breaks valgrind's
    // private-file allocation ("lower this limit").
    "--ulimit", "nofile=16384:16384",
    // The task image's files are owned by its own user (often not root); the container runs
    // as root, which git rejects as "dubious ownership". Trust every directory inside.
    "-e", "GIT_CONFIG_COUNT=1",
    "-e", "GIT_CONFIG_KEY_0=safe.directory",
    "-e", "GIT_CONFIG_VALUE_0=*",
    "-w", workdir,
    options.image,
    "infinity",
  ]);
  if (started.code !== 0) throw new Error(`docker run failed: ${started.stderr.trim()}`);
  containers.push({ name, root, mount });

  // `/app` -> root-relative, a relative path -> relative to the WORKDIR, so both the task's
  // absolute paths and the agent's relative ones resolve inside the mounted tree.
  const workdirRel = workdir === mount ? "" : workdir.startsWith(`${mount}/`) ? workdir.slice(mount.length + 1) : "";
  const containerPath = (path: string): string => {
    if (path === mount) return ".";
    if (path.startsWith(`${mount}/`)) return path.slice(mount.length + 1);
    if (path.startsWith("/")) return path.slice(1);
    return workdirRel === "" ? path : `${workdirRel}/${path}`;
  };
  const containerFilter = (filter: PathFilter): PathFilter =>
    filter.path === undefined ? filter : { ...filter, path: containerPath(filter.path) };

  const run = (command: string): CommandResult => {
    const result = spawnSync(
      "docker",
      // `umask 000` so files the agent creates inside (as root) are world-writable and the
      // host file tools can read/edit them (the two share the bind-mounted tree).
      ["exec", "-w", workdir, name, "bash", "-lc", `set -o pipefail; umask 000; ${command}`],
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

export function cleanupContainers(): void {
  while (containers.length > 0) {
    const entry = containers.pop();
    if (entry === undefined) continue;
    // Wipe the mount from inside (the container is root, so it can delete what it wrote),
    // then remove the container; the host can now delete the emptied temp root.
    docker(["exec", entry.name, "bash", "-c", `rm -rf ${entry.mount}/* ${entry.mount}/.[!.]* 2>/dev/null; true`], 60_000);
    docker(["rm", "-f", entry.name], 60_000);
  }
}
