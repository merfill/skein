import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join, posix } from "node:path";

import { SKIP_DIRS, fsWorkspace, globMatcher, type CommandResult, type GrepMatch, type JobHandle, type JobResult, type JobWaitOptions, type PathFilter, type RunOptions, type Workspace } from "../../src/tools/workspace";

// A real-execution workspace backed by Docker, for a ported terminal-bench task: the task's
// own image already carries the exact environment (repo, toolchain), so there is nothing to
// install on the host. `run` and the file tools execute `docker exec` inside the container,
// so `/app`, `/tmp`, and the rest of the task namespace mean the same thing to both. In the
// legacy bind-mounted mode, `/app` keeps a host fast path for `grep`/`listFiles` (identical
// files); in `rootless` mode every operation goes through the container.
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

export interface DockerMount {
  // A host path bound into the container (e.g. an agent binary, a package cache).
  host: string;
  dest: string;
  readOnly?: boolean;
}

export interface DockerOptions {
  image: string;
  // Where the host root is mounted in the container.
  mountPoint?: string;
  // The container working directory (the task WORKDIR); relative paths resolve here.
  workdir?: string;
  // Docker network mode; `none` (default) keeps the agent offline.
  network?: string;
  runTimeoutMs?: number;
  // Start the task image directly, without extracting `/app` into a host root and binding it
  // back. File operations then run entirely via `docker exec`; `root` is an empty host dir
  // used only by the `Workspace` interface (background jobs/fetch are not supported here).
  rootless?: boolean;
  // Extra bind mounts and environment for an agent that runs INSIDE the container
  // (opencode); the engine's own runs do not need them.
  mounts?: DockerMount[];
  env?: Record<string, string>;
  // `--add-host` entries; e.g. `host.docker.internal:host-gateway` so the container can
  // reach a host-side proxy.
  extraHosts?: string[];
}

// The sandbox `Workspace` plus the container handle: `exec` runs a command with its own
// timeout (an agent run outlives the 10-minute `run` cap) and `name` lets a caller drop
// files in with `docker cp`.
export interface DockerWorkspace extends Workspace {
  name: string;
  exec(command: string, timeoutMs?: number): CommandResult;
  execInput(command: string, input: string, timeoutMs?: number): CommandResult;
  // Connect/disconnect a network on the running container. Rootless Docker refuses to
  // reconnect a container started with `--network none`, so callers start on the bridge and
  // detach for the agent when the run is offline, then reattach for the verifier.
  attachNetwork(network: string): void;
  detachNetwork(network: string): void;
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

export function dockerWorkspace(root: string, options: DockerOptions): DockerWorkspace {
  const mount = options.mountPoint ?? "/app";
  const workdir = options.workdir ?? mount;
  const network = options.network ?? "none";
  const timeoutMs = options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const rootless = options.rootless === true;
  // The host base is used by the bind-mounted fast path and by background jobs/fetch. In
  // rootless mode it is an empty interface root; file operations/grep/list go to the container.
  const base = fsWorkspace(root, { runTimeoutMs: timeoutMs });
  counter += 1;
  // `SKEIN_CONTAINER_PREFIX` lets an out-of-process runner kill a timed-out run's containers
  // by name: the runner knows the prefix, not the pid of the process that actually created them.
  const name = `skein-${process.env.SKEIN_CONTAINER_PREFIX ?? process.pid}-${Date.now()}-${counter}`;

  // Extract the image's WORKDIR tree into the host root via a tar pipe. A plain `docker cp`
  // preserves the image's ownership (often root), which the host user then cannot read or
  // edit through the file tools; piping through the host `tar` (run as the host user) makes
  // the extracted tree host-owned.
  if (!rootless) {
    const extracted = spawnSync(
      "bash",
      ["-c", `set -o pipefail; docker run --rm --entrypoint tar ${shellQuote(options.image)} -C ${shellQuote(mount)} -cf - . | tar -C ${shellQuote(root)} -xf -`],
      { encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 },
    );
    if (extracted.status !== 0) throw new Error(`image extract failed: ${(extracted.stderr ?? "").trim()}`);
  }

  // A long-lived container with the root bind-mounted at the WORKDIR; the agent's `run`
  // goes through `docker exec` so every command sees the same tree.
  const started = docker([
    "run", "-d", "--name", name,
    "--entrypoint", "sleep",
    "--network", network,
    ...(rootless ? [] : ["-v", `${root}:${mount}`]),
    ...(options.mounts ?? []).flatMap((entry) => [
      "-v",
      `${entry.host}:${entry.dest}${entry.readOnly === true ? ":ro" : ""}`,
    ]),
    ...(options.env !== undefined
      ? Object.entries(options.env).flatMap(([key, value]) => ["-e", `${key}=${value}`])
      : []),
    ...(options.extraHosts ?? []).flatMap((host) => ["--add-host", host]),
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

  // The agent-visible path in the container. Absolute paths are container paths; relative
  // ones resolve like `bash` does (against the task WORKDIR), not against the host root.
  const agentPath = (path: string): string => {
    if (path === mount) return mount;
    if (path.startsWith(`${mount}/`)) return path;
    if (path.startsWith("/")) return path;
    return `${workdir}/${path}`;
  };
  const outsideMount = (path: string | undefined): boolean =>
    path !== undefined && path.startsWith("/") && path !== mount && !path.startsWith(`${mount}/`);

  const execAt = (
    command: string,
    execWorkdir = workdir,
    execTimeoutMs = timeoutMs,
    input?: string,
  ): CommandResult => {
    // `umask 000` so files the agent creates inside (as root) are world-writable and the
    // host checkpoint can read them (the workspace is a bind-mounted tree).
    const args = ["exec"];
    if (input !== undefined) args.push("-i");
    args.push("-w", execWorkdir, name, "bash", "-lc", `set -o pipefail; umask 000; ${command}`);
    const result = spawnSync("docker", args, {
      encoding: "utf8",
      timeout: execTimeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      ...(input !== undefined ? { input } : {}),
    });
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
  const exec = (command: string, execTimeoutMs = timeoutMs): CommandResult =>
    execAt(command, workdir, execTimeoutMs);
  const execInput = (command: string, input: string, execTimeoutMs = timeoutMs): CommandResult =>
    execAt(command, workdir, execTimeoutMs, input);
  const attachNetwork = (network: string): void => {
    const result = docker(["network", "connect", network, name]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `network connect ${network} failed`);
  };
  const detachNetwork = (network: string): void => {
    const result = docker(["network", "disconnect", network, name]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `network disconnect ${network} failed`);
  };

  // File operations run in the task container, so `/tmp` and other container paths mean the
  // same thing to the file tools and to `bash`. In the legacy bind-mount mode, paths under
  // the workspace keep the host fast path in `grep`/`listFiles`; paths outside it, and every
  // path in `rootless` mode, are served by the container.
  const read = (path: string): string => {
    const result = execAt(`cat -- ${shellQuote(agentPath(path))}`);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `read failed: ${path}`);
    }
    return result.stdout;
  };
  const write = (path: string, content: string): void => {
    const target = agentPath(path);
    const result = execAt(
      `mkdir -p ${shellQuote(dirname(target))} && cat > ${shellQuote(target)}`,
      workdir,
      timeoutMs,
      content,
    );
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `write failed: ${path}`);
    }
  };
  const exists = (path: string): boolean =>
    execAt(`test -e ${shellQuote(agentPath(path))}`).code === 0;
  const version = (path: string): string => {
    const result = execAt(`sha1sum -- ${shellQuote(agentPath(path))}`);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `sha1 failed: ${path}`);
    }
    return result.stdout.trim().split(/\s+/)[0] ?? "";
  };
  const signature = (path: string): string => {
    const result = execAt(`stat -c '%y:%z:%s' -- ${shellQuote(agentPath(path))}`);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `stat failed: ${path}`);
    }
    return result.stdout.trim();
  };
  // Batch form for the engine's before/after mutation scan: one `stat` process for the
  // whole workspace instead of one `docker exec` per file (thousands).
  const signatures = (paths: readonly string[]): Map<string, string> => {
    const out = new Map<string, string>();
    if (paths.length === 0) return out;
    const requested = new Map<string, string>();
    const list = `${paths
      .map((path) => {
        const absolute = path.startsWith("/") ? path : `${mount}/${path}`;
        requested.set(absolute, path);
        return absolute;
      })
      .join("\0")}\0`;
    const result = execInput(
      "xargs -0 stat -c '%n\\0%y\\0%z\\0%s\\0' -- 2>/dev/null || true",
      list,
    );
    const fields = result.stdout.split("\0");
    for (let index = 0; index + 3 < fields.length; index += 4) {
      const absolute = fields[index] as string;
      const mtime = fields[index + 1] as string;
      const ctime = fields[index + 2] as string;
      const size = fields[index + 3] as string;
      const relative = absolute.startsWith(`${mount}/`) ? absolute.slice(mount.length + 1) : absolute;
      out.set(requested.get(absolute) ?? relative, `${mtime}:${ctime}:${size}`);
    }
    return out;
  };
  const applyPatch = (patch: string, strip = 1): void => {
    const result = execAt(`patch -p${strip} --forward --batch`, mount, timeoutMs, patch);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `patch exit ${result.code}`);
    }
  };

  // File selection mirrors `fsWorkspace`: skip VCS/build dirs (`SKIP_DIRS`) and, for
  // `listFiles`/`grep`, dot entries; apply the same include/exclude globs; report
  // workspace-relative paths (not container-absolute). `list()` itself keeps dot files, like
  // the host walk.
  const relativeToMount = (path: string): string =>
    path === mount ? "" : path.startsWith(`${mount}/`) ? path.slice(mount.length + 1) : path;
  const skipNames = [...SKIP_DIRS].map((name) => `-name ${shellQuote(name)}`).join(" -o ");
  const skipDirs = `\\( -type d \\( ${skipNames} \\) \\)`;
  const containerFiles = (filter: PathFilter): string[] => {
    const scope = posix.normalize(agentPath(filter.path ?? mount));
    // Rootless mirrors `fsWorkspace`, which rejects paths outside the material root. The
    // legacy bind-mount mode still serves paths outside `/app` from the container.
    if (rootless && scope !== mount && !scope.startsWith(`${mount}/`)) {
      throw new Error(`path escapes workspace: ${filter.path}`);
    }
    let files: string[];
    if (execAt(`test -f ${shellQuote(scope)}`).code === 0) {
      files = [scope];
    } else {
      if (execAt(`test -d ${shellQuote(scope)}`).code !== 0) {
        throw new Error(`path not found: ${filter.path ?? "."}`);
      }
      const result = execAt(
        `find ${shellQuote(scope)} -mindepth 1 \\( -name '.*' -o ${skipDirs} \\) -prune -o -type f -print`,
      );
      if (result.code !== 0) throw new Error(result.stderr.trim() || `find exit ${result.code}`);
      files = result.stdout.split("\n").filter((line) => line !== "");
    }
    const include = filter.include !== undefined ? globMatcher(filter.include) : undefined;
    const exclude = filter.exclude !== undefined ? globMatcher(filter.exclude) : undefined;
    return files
      .filter((path) => {
        const relative = relativeToMount(path);
        return (include === undefined || include(relative)) && (exclude === undefined || !exclude(relative));
      })
      .sort();
  };
  const containerGrep = (pattern: string, filter: PathFilter): GrepMatch[] => {
    const files = containerFiles(filter);
    if (files.length === 0) return [];
    const list = `${files.join("\0")}\0`;
    const runGrep = (flag: string): CommandResult =>
      execInput(`xargs -0 grep -In${flag} -e ${shellQuote(pattern)} --`, list);
    let result = runGrep("P");
    if (result.code !== 0 && /support|invalid option/i.test(result.stderr)) result = runGrep("E");
    if (result.stdout === "") {
      // `xargs` reports a batch whose grep found nothing (exit 1) as 123. A clean stderr is
      // what distinguishes that from an invalid pattern or an unreadable file.
      if ((result.code === 0 || result.code === 123) && result.stderr.trim() === "") return [];
      throw new Error(result.stderr.trim() || `grep exit ${result.code}`);
    }
    return result.stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => /^(.*?):(\d+):(.*)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({
        // Match the host fast path: paths are workspace-relative, not container-absolute.
        path: relativeToMount(match[1] as string),
        line: Number(match[2]),
        text: match[3] as string,
      }));
  };
  const containerListFiles = (filter: PathFilter): string[] =>
    containerFiles(filter).map(relativeToMount);

  const containerList = (): string[] => {
    const result = execAt(`find ${shellQuote(mount)} ${skipDirs} -prune -o -type f -print`);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `list exit ${result.code}`);
    return result.stdout
      .split("\n")
      .filter((line) => line !== "")
      .map(relativeToMount)
      .sort();
  };
  const run = (command: string, options: RunOptions = {}): CommandResult => {
    const execWorkdir =
      options.workdir === undefined
        ? workdir
        : options.workdir.startsWith("/")
          ? options.workdir
          : `${workdir}/${options.workdir}`;
    return execAt(command, execWorkdir, options.timeoutMs ?? timeoutMs);
  };

  const execDetached = (command: string, execWorkdir = workdir): CommandResult => {
    const result = spawnSync(
      "docker",
      ["exec", "-d", "-w", execWorkdir, name, "bash", "-lc", `set -o pipefail; umask 000; ${command}`],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
    );
    return {
      code: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };

  // Background commands run in the task container, like `run`; the job writes its logs and
  // exit code under the container-local checkpoint store so `pollJob` can read them.
  const jobDir = "/tmp/.skein/jobs";
  const jobs = new Map<string, { command: string; startedAt: number; id: string }>();
  let jobCounter = 0;
  const startJob = (command: string, _options: JobWaitOptions = {}): JobHandle => {
    jobCounter += 1;
    const id = `job-${jobCounter}`;
    const startedAt = Date.now();
    const out = `${jobDir}/${id}.out`;
    const err = `${jobDir}/${id}.err`;
    const code = `${jobDir}/${id}.code`;
    const result = execDetached(
      `mkdir -p ${shellQuote(jobDir)} && ( ${command} ) > ${shellQuote(out)} 2> ${shellQuote(err)}; echo $? > ${shellQuote(code)}`,
    );
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `job start failed: ${command}`);
    }
    jobs.set(id, { command, startedAt, id });
    return { id, pid: 0, command };
  };
  const pollJob = (id: string, options: JobWaitOptions = {}): JobResult | undefined => {
    const job = jobs.get(id);
    if (job === undefined) return undefined;
    const code = `${jobDir}/${id}.code`;
    const out = `${jobDir}/${id}.out`;
    const err = `${jobDir}/${id}.err`;
    const steps = Math.max(1, Math.ceil((options.waitMs ?? 0) / 100));
    const script =
      `for i in $(seq 1 ${steps}); do [ -f ${shellQuote(code)} ] && break; sleep 0.1; done; ` +
      `if [ -f ${shellQuote(code)} ]; then printf 'DONE%s' "$(cat ${shellQuote(code)})"; else printf RUNNING; fi; ` +
      `printf '\\0'; tail -c 8000 ${shellQuote(out)} 2>/dev/null || true; ` +
      `printf '\\0'; tail -c 8000 ${shellQuote(err)} 2>/dev/null || true`;
    const result = execAt(script, workdir, Math.max(5000, (options.waitMs ?? 0) + 5000));
    const [statePart = "RUNNING", stdout = "", stderr = ""] = result.stdout.split("\0");
    const done = statePart.startsWith("DONE");
    const exit = done ? Number.parseInt(statePart.slice(4), 10) : Number.NaN;
    return {
      id,
      command: job.command,
      state: done ? "done" : "running",
      startedAt: job.startedAt,
      exitCode: done && Number.isFinite(exit) ? exit : null,
      signal: null,
      stdout,
      stderr,
    };
  };
  const fetchTo = (url: string, path: string): { path: string; bytes: number } => {
    if (!rootless) return base.fetchTo(url, path);
    // Fetch on the host (allowlist/constraints live there), then copy the bytes into the
    // container. `docker cp` keeps binary payloads intact; a utf8 read/write would corrupt
    // them.
    const temp = join(root, ".skein", `fetch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const fetched = base.fetchTo(url, temp);
    const target = agentPath(path);
    try {
      const prepared = execAt(`mkdir -p ${shellQuote(dirname(target))}`);
      if (prepared.code !== 0) {
        throw new Error(prepared.stderr.trim() || `fetch target dir failed: ${path}`);
      }
      const copied = spawnSync("docker", ["cp", temp, `${name}:${target}`], {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      });
      if (copied.status !== 0) {
        throw new Error((copied.stderr ?? "").trim() || `fetch copy failed: ${path}`);
      }
    } finally {
      rmSync(temp, { force: true });
    }
    return { path, bytes: fetched.bytes };
  };

  return {
    ...base,
    root: rootless ? mount : base.root,
    displayRoot: mount,
    read,
    version,
    signature,
    signatures,
    write,
    exists,
    grep: (pattern, filter) =>
      rootless
        ? containerGrep(pattern, filter ?? {})
        : outsideMount(filter?.path)
          ? containerGrep(pattern, filter as PathFilter)
          : base.grep(pattern, containerFilter(filter ?? {})),
    list: rootless ? containerList : base.list,
    listFiles: (filter) =>
      rootless
        ? containerListFiles(filter ?? {})
        : outsideMount(filter?.path)
          ? containerListFiles(filter as PathFilter)
          : base.listFiles(containerFilter(filter ?? {})),
    startJob,
    pollJob,
    fetchTo,
    applyPatch,
    run,
    name,
    exec,
    execInput,
    attachNetwork,
    detachNetwork,
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
