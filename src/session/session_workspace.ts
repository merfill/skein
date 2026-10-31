import {
  ALL_ENVIRONMENT_GROUPS,
  environmentGroupsBrief,
  type EnvironmentGroup,
} from "../ir/environment";
import { workspaceLines } from "../ir/material";
import type { SessionProbe } from "../ir/session";
import { probeSession } from "../loop/probe";
import type { GrepMatch, PathFilter, Workspace } from "../tools/workspace";
import type { ReadFileResult } from "./reading";

// The workspace capabilities the session agent may use: read, locate and probe. It is a
// read-only subset of `Workspace` (no write/run/edit), so the session unit stays a dialogue
// layer while the task unit owns mutation.

export const PROBE_KINDS = [
  "environment",
  "packages",
  "interpreters",
  "build",
  "tests",
  "vcs",
  "tools",
  "material",
  "all",
] as const;

export type ProbeKind = (typeof PROBE_KINDS)[number];

export interface SessionWorkspace {
  read(path: string): ReadFileResult;
  listFiles(filter?: PathFilter): string[];
  grep(pattern: string, filter?: PathFilter): GrepMatch[];
  // The session probe, computed once and cached: one shell per session, not per call.
  probe(): SessionProbe | undefined;
}

export function createSessionWorkspace(workspace: Workspace): SessionWorkspace {
  let probed = false;
  let cached: SessionProbe | undefined;
  return {
    read: (path) => {
      const text = workspace.read(path);
      return {
        text,
        version: workspace.version(path),
        bytes: text.length,
        lines: text.split("\n").length,
      };
    },
    listFiles: (filter = {}) => workspace.listFiles(filter),
    grep: (pattern, filter = {}) => workspace.grep(pattern, filter),
    probe: () => {
      if (!probed) {
        cached = probeSession(workspace);
        probed = true;
      }
      return cached;
    },
  };
}

export const GREP_MATCH_LIMIT = 100;
export const GREP_PREVIEW_LIMIT = 16_000;
export const LIST_FILE_LIMIT = 200;
export const LIST_PREVIEW_LIMIT = 8_000;

// A window of grep matches (`path:line: text`), bounded by whole matches. The cursor pages
// the next window; the renderer never cuts a match mid-line.
export function grepText(matches: readonly GrepMatch[], from = 1): string {
  const total = matches.length;
  if (total === 0) return "no matches";
  const start = Math.min(Math.max(from - 1, 0), total);
  const page = matches.slice(start, start + GREP_MATCH_LIMIT);
  if (page.length === 0) return `no matches from ${from}; ${total} total`;

  const build = (kept: number): string => {
    const lines = page.slice(0, kept).map((match) => `${match.path}:${match.line}: ${match.text}`);
    const more =
      start + kept < total
        ? `\n--\n[showing ${kept} of ${total} matches; continue from ${start + kept + 1}]`
        : "";
    return lines.join("\n") + more;
  };
  let kept = page.length;
  let text = build(kept);
  while (kept > 1 && text.length > GREP_PREVIEW_LIMIT) {
    kept -= 1;
    text = build(kept);
  }
  return text;
}

// A window of workspace files, bounded by whole entries. The JSON shape matches the task
// agent's `list` result, so the model already knows how to page it.
export function listText(
  files: readonly string[],
  options: { root?: string; from?: number } = {},
): string {
  const total = files.length;
  if (total === 0) return "no files";
  const from = options.from ?? 1;
  const start = Math.min(Math.max(from - 1, 0), total);
  const page = files.slice(start, start + LIST_FILE_LIMIT);
  if (page.length === 0) return `no files from ${from}; ${total} total`;

  const build = (kept: number): string => {
    const result: Record<string, unknown> = {
      root: options.root ?? ".",
      total,
      from: start + 1,
      returned: kept,
      files: page.slice(0, kept),
    };
    if (start + kept < total) result.next = start + kept + 1;
    return JSON.stringify(result, null, 2);
  };
  let kept = page.length;
  let text = build(kept);
  while (kept > 1 && text.length > LIST_PREVIEW_LIMIT) {
    kept -= 1;
    text = build(kept);
  }
  return text;
}

const PROBE_GROUPS: Record<Exclude<ProbeKind, "environment" | "material" | "all">, readonly EnvironmentGroup[]> = {
  packages: ["pkg"],
  interpreters: ["interpreters"],
  build: ["build", "compilers"],
  tests: ["test"],
  vcs: ["vcs"],
  tools: ["core", "crypto", "data", "archive", "net"],
};

function materialText(probe: SessionProbe): string {
  return probe.material !== undefined
    ? ["Workspace map", ...workspaceLines(probe.material)].join("\n")
    : "no material";
}

function environmentText(probe: SessionProbe, groups: readonly EnvironmentGroup[]): string {
  return probe.environment !== undefined
    ? environmentGroupsBrief(probe.environment, groups, { showRoot: true })
    : "no environment";
}

// A probe answer by kind. `environment` and `all` include the root, like the state briefs;
// `material` returns the workspace map; the rest select one group.
export function probeText(probe: SessionProbe | undefined, kind: ProbeKind = "environment"): string {
  if (probe === undefined) return "probe unavailable";
  if (kind === "material") return materialText(probe);
  if (kind === "all") {
    return [environmentText(probe, ALL_ENVIRONMENT_GROUPS), materialText(probe)].join("\n\n");
  }
  const groups = kind === "environment" ? ALL_ENVIRONMENT_GROUPS : PROBE_GROUPS[kind];
  const text = environmentText(probe, groups);
  return text === "" ? `no ${kind} facts` : text;
}
