import { readFileSync } from "node:fs";

import type { CommandResult } from "./workspace";

// The environment the crash diagnostics need: list the workspace, stat a file by its
// signature, run the debugger, and (optionally) report the kernel's core_pattern so a
// missing core can be explained. `Workspace` satisfies this structurally; tests pass a
// minimal fake (docs/tools.md §4.3).
export interface CrashEnv {
  list(): string[];
  signature(path: string): string;
  run(command: string): CommandResult;
  corePattern?(): string | undefined;
}

export interface CrashReport {
  signal: string;
  // The core file a crash left, if any (best effort: `core_pattern` may not write one).
  core?: string;
  // Why there is no core file: the kernel's core_pattern, present only when it is not a
  // plain file name in the workspace (docs/tools.md §4.3).
  corePattern?: string;
  backtrace?: string;
  backtraceError?: string;
}

const CORE_RE = /(^core(\.\d+)?$)|(\.core$)/;
// A core written in the same second as the run can have a slightly earlier mtime; the
// slack keeps it from being filtered out.
const CORE_CLOCK_SLACK_MS = 2000;

function readCorePattern(): string | undefined {
  try {
    const text = readFileSync("/proc/sys/kernel/core_pattern", "utf8").trim();
    return text === "" ? undefined : text;
  } catch {
    return undefined;
  }
}

function mtimeMs(env: CrashEnv, path: string): number | undefined {
  try {
    const value = Number(env.signature(path).split(":")[0]);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

// The newest `core*` file in the workspace at or after the run started. This is the core
// of the process that faulted, since a foreground run executes with the workspace as cwd.
function findCore(env: CrashEnv, sinceMs: number): string | undefined {
  let best: { path: string; mtime: number } | undefined;
  for (const path of env.list()) {
    const base = path.split("/").pop() ?? path;
    if (!CORE_RE.test(base)) continue;
    const mtime = mtimeMs(env, path);
    if (mtime === undefined || mtime < sinceMs - CORE_CLOCK_SLACK_MS) continue;
    if (best === undefined || mtime > best.mtime) best = { path, mtime };
  }
  return best?.path;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function backtrace(
  env: CrashEnv,
  core: string,
): Pick<CrashReport, "backtrace" | "backtraceError"> {
  if (env.run("command -v gdb >/dev/null 2>&1").code !== 0) return {};
  // `--batch` never prompts; `-nx` skips the user's init. gdb infers the executable from
  // the core's notes, so no binary name is needed.
  const result = env.run(`gdb --batch -nx -c ${quote(core)} -ex ${quote("bt")} -ex ${quote("info locals")}`);
  return {
    ...(result.stdout.trim() !== "" ? { backtrace: result.stdout } : {}),
    ...(result.stderr.trim() !== "" ? { backtraceError: result.stderr } : {}),
  };
}

// Turn a crash signal into knowledge: the core file and, when gdb is present, a
// backtrace, so the model sees the failing stack instead of just a nonzero exit. When no
// core was written, report the kernel's core_pattern so the absence is explained rather
// than silently swallowed.
export function crashReport(env: CrashEnv, signal: string, sinceMs: number): CrashReport {
  const report: CrashReport = { signal };
  const core = findCore(env, sinceMs);
  if (core === undefined) {
    const pattern = env.corePattern?.() ?? readCorePattern();
    return pattern === undefined ? report : { ...report, corePattern: pattern };
  }
  return { ...report, core, ...backtrace(env, core) };
}
