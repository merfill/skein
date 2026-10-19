import type { EnvironmentFact, EnvironmentGroup, EnvironmentTool } from "../ir/environment";
import type { Workspace } from "../tools/workspace";

// One deterministic probe of the session environment, run once when the request starts. It is
// an engine-owned fact (the doxa neither asks for it nor executes it): the script only reads
// `command -v` and `--version`, so it cannot change the material. The result is journalled, so
// a replay reads the recorded fact instead of running the probe again.

interface Probed {
  name: string;
  group: EnvironmentGroup;
  version: boolean;
}

const PROBED: readonly Probed[] = [
  { name: "git", group: "vcs", version: true },
  { name: "hg", group: "vcs", version: true },
  { name: "svn", group: "vcs", version: true },
  { name: "make", group: "build", version: true },
  { name: "cmake", group: "build", version: true },
  { name: "ninja", group: "build", version: true },
  { name: "cargo", group: "build", version: true },
  { name: "go", group: "build", version: true },
  { name: "javac", group: "build", version: true },
  { name: "python3", group: "interpreters", version: true },
  { name: "python", group: "interpreters", version: true },
  { name: "perl", group: "interpreters", version: true },
  { name: "ruby", group: "interpreters", version: true },
  { name: "node", group: "interpreters", version: true },
  { name: "php", group: "interpreters", version: true },
  { name: "pip3", group: "pkg", version: true },
  { name: "npm", group: "pkg", version: true },
  { name: "apt-get", group: "pkg", version: true },
  { name: "jq", group: "core", version: false },
  { name: "awk", group: "core", version: false },
  { name: "sed", group: "core", version: false },
  { name: "grep", group: "core", version: false },
  { name: "find", group: "core", version: false },
  { name: "tar", group: "core", version: false },
  { name: "zip", group: "core", version: false },
  { name: "unzip", group: "core", version: false },
  { name: "dd", group: "core", version: false },
  { name: "xxd", group: "core", version: false },
  { name: "od", group: "core", version: false },
  { name: "strings", group: "core", version: false },
  { name: "file", group: "core", version: false },
  { name: "openssl", group: "crypto", version: true },
  { name: "gpg", group: "crypto", version: true },
  { name: "sqlite3", group: "data", version: true },
  { name: "7z", group: "archive", version: false },
  { name: "7za", group: "archive", version: false },
  { name: "7zr", group: "archive", version: false },
  { name: "curl", group: "net", version: true },
  { name: "wget", group: "net", version: true },
];

function script(): string {
  const lines = [`printf 'ROOT\\t%s\\n' "$PWD"`];
  for (const probed of PROBED) {
    const { name, group, version } = probed;
    const versionPart = version
      ? `v=$(timeout 2 ${name} --version 2>/dev/null | head -n 1 | tr '\\t' ' ')`
      : `v=''`;
    lines.push(
      `if p=$(command -v ${name} 2>/dev/null); then ${versionPart}; printf '${name}\\t${group}\\t%s\\t%s\\n' "$p" "$v"; else printf '${name}\\t${group}\\t-\\t\\n'; fi`,
    );
  }
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
  return value === "" ? undefined : value.slice(0, 32);
}

// Parse the probe's tab-separated lines. Exported for tests; the probe contract is one line
// per tool (`name group path version`), plus a `ROOT path` line.
export function parseProbe(stdout: string): EnvironmentFact {
  let root = "";
  const found: EnvironmentTool[] = [];
  const missing: { name: string; group: EnvironmentGroup }[] = [];
  for (const line of stdout.split("\n")) {
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

export function probeEnvironment(workspace: Workspace): EnvironmentFact | undefined {
  let result;
  try {
    result = workspace.run(script(), { timeoutMs: 20_000 });
  } catch {
    return undefined;
  }
  const fact = parseProbe(result.stdout);
  return fact.root !== "" && (fact.found.length > 0 || fact.missing.length > 0) ? fact : undefined;
}
