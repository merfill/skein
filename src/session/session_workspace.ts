import type { SessionProbe } from "../ir/session";
import type { Workspace } from "../tools/workspace";

// The general unit's orientation: the deterministic project facts only (directory, version
// control and the top-level structure). No commits, paths or toolchain — the general agent
// inspects those itself.
export function generalFactsText(probe: SessionProbe | undefined, root: string): string {
  const lines = ["Project facts (engine-recorded; already read)"];
  const material = probe?.material;
  if (material === undefined) {
    lines.push(`project directory: ${root}`);
    return lines.join("\n");
  }
  lines.push(`project directory: ${material.root !== "" ? material.root : root}`);
  if (material.cwd !== undefined && material.cwd !== "" && material.cwd !== material.root) {
    lines.push(`working directory: ${material.cwd}`);
  }
  if (material.repos.length === 0) {
    lines.push("version control: none");
  } else {
    for (const repo of material.repos) {
      const details: string[] = [];
      if (repo.branch !== undefined && repo.branch !== "") details.push(`branch ${repo.branch}`);
      if (repo.head !== undefined && repo.head !== "") details.push(`head ${repo.head}`);
      if (repo.dirty !== undefined) details.push(`${repo.dirty} changed`);
      lines.push(`version control: ${repo.kind}${details.length > 0 ? ` (${details.join(", ")})` : ""}`);
    }
  }
  const entries = material.entries
    .slice(0, 16)
    .map((entry) => (entry.kind === "dir" ? `${entry.name}/ (${entry.files ?? 0} files)` : entry.name));
  if (entries.length > 0) {
    const more =
      material.entries.length > entries.length
        ? `, … (+${material.entries.length - entries.length} more)`
        : "";
    lines.push(`top-level entries: ${entries.join(", ")}${more}`);
  }
  lines.push(`files: ${material.files}${material.truncated === true ? " (map truncated)" : ""}`);
  return lines.join("\n");
}

// The project's agent-facing instruction file. Unlike the material map, it is a glossary and
// index the worker should have before choosing a directory (opencode injects AGENTS.md the same
// way). README/ARCHITECTURE stay readable on demand.
const PROJECT_INSTRUCTIONS_LIMIT = 12_000;

export function projectInstructionsText(workspace: Workspace): string {
  let content: string;
  try {
    if (!workspace.exists("AGENTS.md")) return "";
    content = workspace.read("AGENTS.md");
  } catch {
    return "";
  }
  const text = content.trim();
  if (text === "") return "";
  const bounded =
    text.length > PROJECT_INSTRUCTIONS_LIMIT
      ? `${text.slice(0, PROJECT_INSTRUCTIONS_LIMIT)}\n…[truncated; read AGENTS.md for the rest]`
      : text;
  return `Project instructions (engine-recorded; already read)\n\n${bounded}`;
}
