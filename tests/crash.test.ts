import { describe, expect, it } from "vitest";

import { crashReport, type CrashEnv } from "../src/tools/crash";
import type { CommandResult } from "../src/tools/workspace";

// The crash diagnostics are environment-dependent (core_pattern, gdb), so they are
// tested against a fake environment: a signal alone, a fresh core, a stale core, gdb
// present/absent. A real OCaml segfault is not reproducible offline (docs/tools.md §4.3).

function fakeEnv(
  signatures: Record<string, string>,
  run: (command: string) => CommandResult,
  corePattern?: string,
): { env: CrashEnv; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    env: {
      list: () => Object.keys(signatures),
      signature: (path) => signatures[path] ?? "0:0:0",
      run: (command) => {
        calls.push(command);
        return run(command);
      },
      ...(corePattern !== undefined ? { corePattern: () => corePattern } : {}),
    },
  };
}

const gdbPresent = (): CommandResult => ({ code: 0, stdout: "/usr/bin/gdb", stderr: "" });

describe("crashReport", () => {
  it("attaches the core and gdb backtrace for a fresh core", () => {
    const { env, calls } = fakeEnv({ core: "2000:2000:4096" }, (command) =>
      command.includes("command -v gdb")
        ? gdbPresent()
        : { code: 0, stdout: "#0 0x0000 in pool_sweep ()", stderr: "" },
    );
    const report = crashReport(env, "SIGSEGV", 1500);
    expect(report.signal).toBe("SIGSEGV");
    expect(report.core).toBe("core");
    expect(report.backtrace).toContain("pool_sweep");
    expect(calls.some((command) => command.includes("gdb --batch"))).toBe(true);
  });

  it("explains why there is no core via core_pattern", () => {
    const { env, calls } = fakeEnv(
      { "src/main.c": "9999:9999:10" },
      gdbPresent,
      "|/usr/lib/systemd/systemd-coredump %P",
    );
    const report = crashReport(env, "SIGABRT", 1500);
    expect(report).toEqual({
      signal: "SIGABRT",
      corePattern: "|/usr/lib/systemd/systemd-coredump %P",
    });
    expect(calls).toEqual([]);
  });

  it("ignores a core older than the run", () => {
    const { env } = fakeEnv({ core: "100:100:10" }, gdbPresent, "core");
    expect(crashReport(env, "SIGSEGV", 10_000)).toEqual({
      signal: "SIGSEGV",
      corePattern: "core",
    });
  });

  it("keeps the core but no backtrace when gdb is absent", () => {
    const { env } = fakeEnv({ "core.42": "2000:2000:10" }, () => ({
      code: 1,
      stdout: "",
      stderr: "",
    }));
    const report = crashReport(env, "SIGSEGV", 1500);
    expect(report.core).toBe("core.42");
    expect(report.backtrace).toBeUndefined();
  });
});
