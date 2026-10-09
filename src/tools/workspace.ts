import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as osConstants } from "node:os";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

// A scope for search/listing: a file or directory plus optional include/exclude
// globs. Globs without a slash match the basename anywhere (ripgrep-like); globs
// with a slash match the workspace-relative path.
export interface PathFilter {
  path?: string;
  include?: string;
  exclude?: string;
}

// A command's outcome. stdout and stderr are kept separate (never concatenated): the
// error stream is the primary signal of a failed run, and merging the two hides which
// stream carried the failure (docs/tools.md §4.3).
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  // The signal that killed the command (SIGSEGV, SIGABRT, …), if any. A crash is a
  // stronger fact than the exit code and must not be lost (docs/tools.md §4.3).
  signal?: string;
}

// A command started in the background: `run` returns at once with this handle, and the
// model polls it by id instead of blocking a whole turn on a long build (docs/tools.md
// §4.7). The child writes stdout and stderr to separate logs under `.skein/jobs/`.
export interface JobHandle {
  id: string;
  pid: number;
  command: string;
}

export interface JobResult {
  id: string;
  command: string;
  state: "running" | "done";
  // When the job started (ms epoch): a crash core is searched from this time.
  startedAt: number;
  // Both null while the job runs; `signal` is set when the shell was killed by a signal
  // (a segfault raised to the process group, not a normal exit).
  exitCode: number | null;
  signal: string | null;
  // The tail of each stream (bounded), never the whole log; the full log stays on disk.
  stdout: string;
  stderr: string;
}

export interface JobWaitOptions {
  // Block up to this long for the job to finish before returning its state. `startJob`
  // defaults to a short grace (a just-started job that is really short completes in the
  // start turn instead of forcing a poll); `pollJob` defaults to the foreground cap, so a
  // poll waits for the job the same way a foreground `run` would.
  waitMs?: number;
}

export interface WorkspaceOptions {
  // Cap on a foreground `run`. A background job is not capped here (its caller decides
  // when to stop polling); this exists so a slow verifier can be allowed to finish.
  runTimeoutMs?: number;
  // How long `startJob` blocks for a just-started job to finish before handing back a
  // handle (docs/tools.md §4.7). A genuinely long/open-ended command returns `running`.
  jobGraceMs?: number;
}

export interface Workspace {
  root: string;
  read(path: string): string;
  version(path: string): string;
  signature(path: string): string;
  write(path: string, content: string): void;
  exists(path: string): boolean;
  list(): string[];
  grep(pattern: string, filter?: PathFilter): GrepMatch[];
  listFiles(filter?: PathFilter): string[];
  run(command: string): CommandResult;
  startJob(command: string, options?: JobWaitOptions): JobHandle;
  pollJob(id: string, options?: JobWaitOptions): JobResult | undefined;
  // Download a URL into the workspace (read-only reference evidence). Throws on a path
  // outside the workspace, a failed download, or an unwritable target.
  fetchTo(url: string, path: string): { path: string; bytes: number };
  // Apply a unified diff with `patch -p<strip>`; throws if it does not apply cleanly.
  applyPatch(patch: string, strip?: number): void;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  ".skein",
  "_build",
  "target",
  "build",
  "out",
  "obj",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".cache",
  ".venv",
  "venv",
  ".tox",
  ".gradle",
  ".next",
  ".nuxt",
  ".terraform",
]);

// Binary detection is by content, not by an extension allowlist: a coding agent
// greps source in any language (.c, .h, .rs, .go, .py, …), not just the ones the
// fixtures happened to use.
const MAX_GREP_BYTES = 2_000_000;

function isBinary(content: string): boolean {
  return content.includes("\u0000");
}

// Translate a glob into an anchored regexp. `**` crosses path separators, `*` and
// `?` do not. A pattern without a slash matches a basename anywhere; with a slash
// it matches the workspace-relative path.
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i] as string;
    if (char === "*") {
      if (glob[i + 1] === "*") {
        i += 1;
        if (glob[i + 1] === "/") {
          i += 1;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (char === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(char)) {
      re += `\\${char}`;
    } else {
      re += char;
    }
  }
  return new RegExp(`^${re}$`);
}

function globMatcher(glob: string): (path: string) => boolean {
  const hasSlash = glob.includes("/");
  const re = globToRegExp(glob);
  return (path) => re.test(hasSlash ? path : (path.split("/").pop() ?? path));
}

const DEFAULT_RUN_TIMEOUT_MS = 120_000;
// How much of a background job's log a poll returns. The full log stays at
// `.skein/jobs/<id>.{out,err}`; the poll shows only the tail, so a long build does not
// flood the context (it is the tail — the error — that matters, tools §4.3).
const JOB_TAIL_BYTES = 8_000;
// A just-started background job is given this long to finish before `startJob` hands back
// a handle. This collapses a short command (the common case) into the start turn: the
// engine waits the way a foreground `run` would, and only a genuinely long/open-ended
// command is left to poll (docs/tools.md §4.7).
const JOB_START_GRACE_MS = 10_000;

interface JobRecord extends JobHandle {
  fullOut: string;
  fullErr: string;
  // The shell writes its exit status here as its LAST act, so a synchronous wait can
  // learn the job is done (and its code) without the Node exit event, which cannot fire
  // while the wait blocks the event loop.
  fullCode: string;
  startedAt: number;
  state: "running" | "done";
  exitCode: number | null;
  signal: string | null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// A shell reports a signal death as 128 + signum; map it back to the name so the crash
// path (core + backtrace) still fires for a backgrounded command (docs/tools.md §4.3).
function signalName(number: number): string | null {
  for (const [name, value] of Object.entries(osConstants.signals)) {
    if (value === number) return name;
  }
  return null;
}

function readTail(full: string): string {
  let size: number;
  try {
    size = statSync(full).size;
  } catch {
    return "";
  }
  const start = Math.max(0, size - JOB_TAIL_BYTES);
  const length = size - start;
  if (length === 0) return "";
  const fd = openSync(full, "r");
  try {
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, start);
    const text = buffer.toString("utf8");
    return start > 0 ? `…[truncated ${start} bytes]\n${text}` : text;
  } finally {
    closeSync(fd);
  }
}

export function fsWorkspace(root: string, options: WorkspaceOptions = {}): Workspace {
  const base = resolve(root);
  const runTimeoutMs = options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const jobGraceMs = options.jobGraceMs ?? JOB_START_GRACE_MS;

  const abs = (path: string): string => {
    const full = resolve(base, path);
    if (full !== base && !full.startsWith(base + sep)) {
      throw new Error(`path escapes workspace: ${path}`);
    }
    return full;
  };

  const read = (path: string): string => readFileSync(abs(path), "utf8");

  // Files can appear and vanish under a concurrent build; a walk or a read that
  // loses that race must not crash the agent, only skip the path.
  const list = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          walk(join(dir, entry.name));
        } else {
          out.push(relative(base, join(dir, entry.name)));
        }
      }
    };
    walk(base);
    return out.sort();
  };

  // Files in scope: `path` may be a file or a directory; directories are walked
  // skipping SKIP_DIRS and dot entries. include/exclude globs filter the result.
  const scopedFiles = (filter: PathFilter): string[] => {
    const include = filter.include !== undefined ? globMatcher(filter.include) : undefined;
    const exclude = filter.exclude !== undefined ? globMatcher(filter.exclude) : undefined;
    const keep = (rel: string): boolean =>
      (include === undefined || include(rel)) && (exclude === undefined || !exclude(rel));
    if (filter.path !== undefined) {
      const full = abs(filter.path);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        throw new Error(`path not found: ${filter.path}`);
      }
      if (stat.isFile()) {
        const rel = relative(base, full);
        return keep(rel) ? [rel] : [];
      }
    }
    const start = filter.path !== undefined ? abs(filter.path) : base;
    const out: string[] = [];
    const walk = (dir: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          walk(full);
        } else {
          const rel = relative(base, full);
          if (keep(rel)) out.push(rel);
        }
      }
    };
    walk(start);
    return out.sort();
  };

  const grep = (pattern: string, filter: PathFilter = {}): GrepMatch[] => {
    const re = new RegExp(pattern);
    const matches: GrepMatch[] = [];
    for (const path of scopedFiles(filter)) {
      let content: string;
      try {
        if (statSync(abs(path)).size > MAX_GREP_BYTES) continue;
        content = read(path);
      } catch {
        continue;
      }
      if (isBinary(content)) continue;
      const lines = content.split("\n");
      lines.forEach((text, index) => {
        if (re.test(text)) matches.push({ path, line: index + 1, text });
      });
    }
    return matches;
  };

  const listFiles = (filter: PathFilter = {}): string[] => scopedFiles(filter);

  const run = (command: string): CommandResult => {
    // `spawnSync` returns stdout and stderr separately regardless of the exit code, so
    // an error stream is never lost and never concatenated into stdout. `pipefail` makes
    // a pipeline report the failing stage's exit code: `make | tail` must tell the truth.
    const result = spawnSync("/bin/bash", ["-c", `set -o pipefail; ulimit -c unlimited 2>/dev/null; ${command}`], {
      cwd: base,
      encoding: "utf8",
      timeout: runTimeoutMs,
      maxBuffer: 64 * 1024 * 1024,
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

  // Background jobs live only for the lifetime of this workspace (one agent run): the
  // loop holds the same workspace across turns, so the registry and the child's `exit`
  // event are enough — no on-disk job metadata.
  const jobs = new Map<string, JobRecord>();
  let jobCounter = 0;

  // Learn a job's outcome from the status file the shell writes as its last act. This is
  // how a synchronous wait (below) sees completion: the Node exit event cannot fire while
  // that wait blocks the event loop.
  const finalizeFromCode = (record: JobRecord): void => {
    if (record.state === "done") return;
    let raw: string;
    try {
      raw = readFileSync(record.fullCode, "utf8").trim();
    } catch {
      return;
    }
    if (raw === "") return;
    record.state = "done";
    const code = Number.parseInt(raw, 10);
    if (Number.isFinite(code)) {
      record.exitCode = code;
      if (code > 128) record.signal = signalName(code - 128);
    }
  };

  // Block up to `waitMs` for the job to finish before returning. The watcher is a tiny
  // shell loop (a separate process, so the OS keeps the job running while we sleep) that
  // ends when the status file appears or the job dies; its own timeout bounds the wait.
  const waitForJob = (record: JobRecord, waitMs: number): void => {
    if (record.state === "done" || waitMs <= 0) return;
    const alive = record.pid > 0 ? `kill -0 ${record.pid} 2>/dev/null` : "false";
    spawnSync(
      "/bin/bash",
      ["-c", `while [ ! -s ${shellQuote(record.fullCode)} ] && ${alive}; do sleep 0.1; done`],
      { timeout: waitMs + 5_000, stdio: "ignore" },
    );
    finalizeFromCode(record);
  };

  const startJob = (command: string, options: JobWaitOptions = {}): JobHandle => {
    jobCounter += 1;
    const id = `job-${jobCounter}`;
    const relOut = `.skein/jobs/${id}.out`;
    const relErr = `.skein/jobs/${id}.err`;
    const relCode = `.skein/jobs/${id}.code`;
    const fullOut = abs(relOut);
    const fullErr = abs(relErr);
    const fullCode = abs(relCode);
    mkdirSync(dirname(fullOut), { recursive: true });
    const outFd = openSync(fullOut, "w");
    const errFd = openSync(fullErr, "w");
    // The command runs in a subshell so its own `exit` does not skip the status write; the
    // shell then records `$?` to the status file before exiting. The file lets a
    // synchronous wait see completion without the Node exit event (which cannot fire while
    // that wait blocks the event loop); `exit $__skein_ec` keeps the verdict for the event.
    const script =
      `set -o pipefail; ulimit -c unlimited 2>/dev/null; ( ${command} )\n` +
      `__skein_ec=$?; printf '%s' "$__skein_ec" > ${shellQuote(fullCode)}; exit $__skein_ec`;
    const child = spawn("/bin/bash", ["-c", script], {
      cwd: base,
      stdio: ["ignore", outFd, errFd],
    });
    // The child owns the descriptors now; close the parent's copies so they do not keep
    // the event loop alive.
    closeSync(outFd);
    closeSync(errFd);
    const record: JobRecord = {
      id,
      pid: child.pid ?? 0,
      command,
      fullOut,
      fullErr,
      fullCode,
      startedAt: Date.now(),
      state: "running",
      exitCode: null,
      signal: null,
    };
    jobs.set(id, record);
    child.on("exit", (code, signal) => {
      record.state = "done";
      record.exitCode = code;
      record.signal = signal;
    });
    child.on("error", (error) => {
      record.state = "done";
      record.exitCode = null;
      record.signal = null;
      try {
        writeFileSync(fullErr, `spawn error: ${error.message}\n`);
      } catch {
        // The job is still reported done; the empty log is enough.
      }
    });
    // Do not let a long build keep the agent process alive once its run is over.
    child.unref();
    waitForJob(record, options.waitMs ?? jobGraceMs);
    return { id, pid: record.pid, command };
  };

  const pollJob = (id: string, options: JobWaitOptions = {}): JobResult | undefined => {
    const record = jobs.get(id);
    if (record === undefined) return undefined;
    // A poll waits for the job (up to the foreground cap) rather than returning `running`
    // at once: the model asked whether it is done, so answer it, don't make it ask again.
    waitForJob(record, options.waitMs ?? runTimeoutMs);
    return {
      id: record.id,
      command: record.command,
      state: record.state,
      startedAt: record.startedAt,
      exitCode: record.exitCode,
      signal: record.signal,
      stdout: readTail(record.fullOut),
      stderr: readTail(record.fullErr),
    };
  };

  // Download a URL into the workspace as read-only reference evidence. Writes to a
  // `.part` file first and renames on success, so a failed/partial download never leaves
  // a half-written reference behind. `curl -f` fails on a non-2xx status.
  const fetchTo = (url: string, path: string): { path: string; bytes: number } => {
    const full = abs(path);
    mkdirSync(dirname(full), { recursive: true });
    const tmp = `${full}.part`;
    const timeoutSec = Math.max(1, Math.ceil(runTimeoutMs / 1000));
    const result = spawnSync(
      "curl",
      ["-fsSL", "--max-time", String(timeoutSec), "-o", tmp, url],
      { encoding: "utf8", timeout: runTimeoutMs, maxBuffer: 64 * 1024 * 1024 },
    );
    const cleanup = (): void => {
      try {
        unlinkSync(tmp);
      } catch {
        // The temp file may not have been created; nothing to clean.
      }
    };
    if (result.status !== 0) {
      cleanup();
      const detail = (result.stderr ?? "").trim();
      const reason =
        result.error !== undefined
          ? result.error.message
          : `curl exit ${result.status}`;
      throw new Error(`${reason}${detail === "" ? "" : `: ${detail}`}`);
    }
    const bytes = statSync(tmp).size;
    renameSync(tmp, full);
    return { path, bytes };
  };

  // Apply a unified diff in the workspace root. `--forward`/`--batch` make it
  // non-interactive and idempotent-leaning: an already-applied or conflicting hunk is an
  // error, not a prompt. GNU patch refuses absolute/`..` paths itself.
  const applyPatch = (patch: string, strip = 1): void => {
    const result = spawnSync("patch", [`-p${strip}`, "--forward", "--batch"], {
      cwd: base,
      input: patch,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error !== undefined) throw new Error(result.error.message);
    if (result.status !== 0) {
      const detail = (result.stderr ?? "").trim() || (result.stdout ?? "").trim();
      throw new Error(`patch exit ${result.status}${detail === "" ? "" : `: ${detail}`}`);
    }
  };

  return {
    root: base,
    read,
    version: (path) => createHash("sha1").update(read(path)).digest("hex"),
    signature: (path) => {
      const stat = statSync(abs(path));
      return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    },
    write: (path, content) => {
      const full = abs(path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, "utf8");
    },
    exists: (path) => existsSync(abs(path)),
    list,
    grep,
    listFiles,
    run,
    startJob,
    pollJob,
    fetchTo,
    applyPatch,
  };
}
