import type { EnvironmentFact, EnvironmentGroup, EnvironmentTool } from "../ir/environment";
import type { SessionProbe } from "../ir/session";
import type { Workspace } from "../tools/workspace";
import { probeMaterial } from "./material";

// One deterministic probe of the session at request start: the environment (which tools
// exist and their versions) and the material (the map built in `material.ts`). It is an
// engine-owned fact (the doxa neither asks for it nor executes it): the script only reads
// `command -v` and versions, so it cannot change the material. The result is journalled, so
// a replay reads the recorded fact instead of running the probe again.

interface Probed {
  name: string;
  group: EnvironmentGroup;
  // The version command's arguments, when the tool has a cheap, reliable one. `undefined`
  // means "do not ask for a version" (presence is the fact).
  version?: readonly string[];
}

const PROBED: readonly Probed[] = [
  { name: "git", group: "vcs", version: ["--version"] },
  { name: "hg", group: "vcs", version: ["--version"] },
  { name: "svn", group: "vcs", version: ["--version"] },
  { name: "make", group: "build", version: ["--version"] },
  { name: "cmake", group: "build", version: ["--version"] },
  { name: "ninja", group: "build", version: ["--version"] },
  { name: "meson", group: "build", version: ["--version"] },
  { name: "bazel", group: "build", version: ["--version"] },
  { name: "cargo", group: "build", version: ["--version"] },
  { name: "go", group: "build", version: ["version"] },
  { name: "dotnet", group: "build", version: ["--version"] },
  { name: "gcc", group: "compilers", version: ["--version"] },
  { name: "g++", group: "compilers", version: ["--version"] },
  { name: "clang", group: "compilers", version: ["--version"] },
  { name: "clang++", group: "compilers", version: ["--version"] },
  { name: "cc", group: "compilers", version: ["--version"] },
  { name: "rustc", group: "compilers", version: ["--version"] },
  { name: "javac", group: "compilers", version: ["-version"] },
  { name: "python3", group: "interpreters", version: ["--version"] },
  { name: "python", group: "interpreters", version: ["--version"] },
  { name: "perl", group: "interpreters", version: ["--version"] },
  { name: "ruby", group: "interpreters", version: ["--version"] },
  { name: "node", group: "interpreters", version: ["--version"] },
  { name: "php", group: "interpreters", version: ["--version"] },
  { name: "lua", group: "interpreters", version: ["-v"] },
  { name: "Rscript", group: "interpreters", version: ["--version"] },
  { name: "julia", group: "interpreters", version: ["--version"] },
  { name: "deno", group: "interpreters", version: ["--version"] },
  { name: "bun", group: "interpreters", version: ["--version"] },
  { name: "java", group: "interpreters", version: ["-version"] },
  { name: "pip", group: "pkg", version: ["--version"] },
  { name: "pip3", group: "pkg", version: ["--version"] },
  { name: "uv", group: "pkg", version: ["--version"] },
  { name: "poetry", group: "pkg", version: ["--version"] },
  { name: "npm", group: "pkg", version: ["--version"] },
  { name: "yarn", group: "pkg", version: ["--version"] },
  { name: "pnpm", group: "pkg", version: ["--version"] },
  { name: "apt-get", group: "pkg", version: ["--version"] },
  { name: "apk", group: "pkg", version: ["--version"] },
  { name: "dnf", group: "pkg", version: ["--version"] },
  { name: "yum", group: "pkg", version: ["--version"] },
  { name: "pacman", group: "pkg", version: ["--version"] },
  { name: "brew", group: "pkg", version: ["--version"] },
  { name: "pytest", group: "test", version: ["--version"] },
  { name: "tox", group: "test", version: ["--version"] },
  { name: "nox", group: "test", version: ["--version"] },
  { name: "jest", group: "test", version: ["--version"] },
  { name: "vitest", group: "test", version: ["--version"] },
  { name: "mocha", group: "test", version: ["--version"] },
  { name: "rspec", group: "test", version: ["--version"] },
  { name: "phpunit", group: "test", version: ["--version"] },
  { name: "ctest", group: "test", version: ["--version"] },
  { name: "bats", group: "test", version: ["--version"] },
  { name: "jq", group: "core" },
  { name: "yq", group: "core" },
  { name: "awk", group: "core" },
  { name: "sed", group: "core" },
  { name: "grep", group: "core" },
  { name: "find", group: "core" },
  { name: "dd", group: "core" },
  { name: "xxd", group: "core" },
  { name: "od", group: "core" },
  { name: "strings", group: "core" },
  { name: "file", group: "core" },
  { name: "base64", group: "core" },
  { name: "sha256sum", group: "core" },
  { name: "md5sum", group: "core" },
  { name: "openssl", group: "crypto", version: ["version"] },
  { name: "gpg", group: "crypto", version: ["--version"] },
  { name: "sqlite3", group: "data", version: ["--version"] },
  { name: "psql", group: "data", version: ["--version"] },
  { name: "mysql", group: "data", version: ["--version"] },
  { name: "redis-cli", group: "data", version: ["--version"] },
  { name: "mongosh", group: "data", version: ["--version"] },
  { name: "tar", group: "archive" },
  { name: "zip", group: "archive" },
  { name: "unzip", group: "archive" },
  { name: "7z", group: "archive", version: ["i"] },
  { name: "7za", group: "archive", version: ["i"] },
  { name: "7zr", group: "archive", version: ["i"] },
  { name: "gzip", group: "archive" },
  { name: "bzip2", group: "archive" },
  { name: "xz", group: "archive" },
  { name: "zstd", group: "archive" },
  { name: "curl", group: "net", version: ["--version"] },
  { name: "wget", group: "net", version: ["--version"] },
  { name: "nc", group: "net" },
  { name: "ssh", group: "net" },
  { name: "scp", group: "net" },
  { name: "rsync", group: "net", version: ["--version"] },
  { name: "cobc", group: "compilers", version: ["--version"] },
  { name: "john", group: "crypto" },
  { name: "hashcat", group: "crypto", version: ["--version"] },
  { name: "valgrind", group: "core", version: ["--version"] },
  { name: "gdb", group: "core", version: ["--version"] },
  { name: "strace", group: "core", version: ["-V"] },
  { name: "objdump", group: "core", version: ["--version"] },
  { name: "readelf", group: "core", version: ["--version"] },
  { name: "nm", group: "core", version: ["--version"] },
  { name: "ldd", group: "core", version: ["--version"] },
  { name: "debugfs", group: "data", version: ["-V"] },
  { name: "fsstat", group: "data", version: ["-V"] },
  { name: "dumpe2fs", group: "data", version: ["-V"] },
  { name: "fls", group: "data", version: ["-V"] },
  { name: "icat", group: "data", version: ["-V"] },
  { name: "binwalk", group: "archive", version: ["--version"] },
  { name: "foremost", group: "archive", version: ["-V"] },
  { name: "testdisk", group: "archive", version: ["--version"] },
];

const PROBE_TIMEOUT_MS = 20_000;
const VERSION_TIMEOUT_SECONDS = 1;

function script(): string {
  // Versions are collected in parallel: a probe is one cheap observation, not a sequence of
  // process spawns. The temp directory keeps the output ordered by the catalog index.
  const lines = [`d=$(mktemp -d)`, `printf 'ROOT\\t%s\\n' "$PWD"`];
  for (const [index, probed] of PROBED.entries()) {
    const { name, group, version } = probed;
    const slot = `$d/${String(index).padStart(3, "0")}`;
    const args = version ?? [];
    if (args.length > 0) {
      lines.push(
        `if p=$(command -v ${name} 2>/dev/null); then (v=$(timeout ${VERSION_TIMEOUT_SECONDS} ${name} ${args.join(" ")} 2>&1 | head -n 1 | tr '\\t' ' '); printf '${name}\\t${group}\\t%s\\t%s\\n' "$p" "$v" > ${slot}) & else printf '${name}\\t${group}\\t-\\t\\n' > ${slot}; fi`,
      );
    } else {
      lines.push(
        `if p=$(command -v ${name} 2>/dev/null); then printf '${name}\\t${group}\\t%s\\t\\n' "$p" > ${slot}; else printf '${name}\\t${group}\\t-\\t\\n' > ${slot}; fi`,
      );
    }
  }
  lines.push(`wait`, `cat "$d"/*`, `rm -rf "$d"`);
  return `${lines.join("\n")}\n`;
}

function cleanVersion(name: string, raw: string): string | undefined {
  let value = raw.replace(/\s+/g, " ").trim();
  if (value === "") return undefined;
  const lower = value.toLowerCase();
  const prefixes = [name.toLowerCase(), name.replace(/[0-9]+$/, "").toLowerCase()];
  for (const prefix of prefixes) {
    if (prefix !== "" && lower.startsWith(prefix)) {
      value = value.slice(prefix.length).trim();
      break;
    }
  }
  value = value.replace(/^version\s+/i, "").trim();
  // Keep the version token itself (`sqlite3 3.45.1 2024-01-30 …` -> `3.45.1`).
  const match = /v?(\d+(?:\.\d+){0,3})/.exec(value);
  if (match?.[1] !== undefined) return match[1];
  // An error message is not a version (`cmake` here is a wrapper that prints a traceback);
  // presence is still the fact, the version is simply unknown.
  return undefined;
}

// Parse the probe's tab-separated lines. Exported for tests; the probe contract is one line
// per tool (`name group path version`), plus a `ROOT path` line.
export function parseProbe(stdout: string): EnvironmentFact {
  let root = "";
  const found: EnvironmentTool[] = [];
  const missing: { name: string; group: EnvironmentGroup }[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "") continue;
    const [name, group, path, version] = line.split("\t");
    if (name === "ROOT") {
      root = group ?? "";
      continue;
    }
    if (name === undefined || group === undefined) continue;
    if (path === undefined || path === "-" || path === "") {
      missing.push({ name, group: group as EnvironmentGroup });
      continue;
    }
    const tool: EnvironmentTool = { name, group: group as EnvironmentGroup, path };
    const cleaned = version !== undefined ? cleanVersion(name, version) : undefined;
    if (cleaned !== undefined) tool.version = cleaned;
    found.push(tool);
  }
  return { root, found, missing };
}

export interface ProbeOptions {
  // The agent's network policy, known to the harness; not probed by a shell. It is the fact
  // that tells a state whether a missing runtime can be installed.
  network?: "on" | "off";
}

export function probeEnvironment(workspace: Workspace, options: ProbeOptions = {}): EnvironmentFact | undefined {
  let result;
  try {
    result = workspace.run(script(), { timeoutMs: PROBE_TIMEOUT_MS });
  } catch {
    return undefined;
  }
  const fact = parseProbe(result.stdout);
  if (workspace.displayRoot !== undefined && workspace.displayRoot !== "") {
    fact.root = workspace.displayRoot;
  } else if (fact.root === "" && workspace.root !== "") {
    fact.root = workspace.root;
  }
  if (result.timedOut === true) fact.partial = true;
  if (options.network !== undefined) fact.network = options.network;
  return fact.root !== "" && (fact.found.length > 0 || fact.missing.length > 0) ? fact : undefined;
}

// The session probe: environment and material, journalled once as `SESSION_PROBE_ID`.
// Each half can be absent (a failed shell or an unreadable tree) independently; the
// projection renders whatever was actually observed.
export function probeSession(workspace: Workspace, options: ProbeOptions = {}): SessionProbe | undefined {
  const environment = probeEnvironment(workspace, options);
  // The material map's paths must read the way the agent sees them: the probe shell's PWD
  // (the container's mount point) wins over the host-side workspace root.
  const root =
    workspace.displayRoot !== undefined && workspace.displayRoot !== ""
      ? workspace.displayRoot
      : environment !== undefined && environment.root !== ""
        ? environment.root
        : workspace.root;
  const material = probeMaterial(workspace, root);
  if (environment === undefined && material === undefined) return undefined;
  const probe: SessionProbe = {};
  if (environment !== undefined) probe.environment = environment;
  if (material !== undefined) probe.material = material;
  if (environment?.partial === true) probe.partial = true;
  return probe;
}
