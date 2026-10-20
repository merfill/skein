// The deterministic map of the material, recorded once at request start alongside the
// environment probe. It is an index, not content: the workspace root, the repository status
// and the entries/paths that exist. The projection renders it in Orientation and carries it
// into Localization/Research as the Orientation result; it never decides what is acceptance.

export interface MaterialRepo {
  kind: "git" | "hg" | "svn";
  root: string;
  branch?: string;
  head?: string;
  dirty?: number;
  commits?: { hash: string; subject: string }[];
  error?: string;
}

export interface MaterialEntry {
  name: string;
  kind: "file" | "dir";
  // For a directory: how many files sit under it (bounded by the walk).
  files?: number;
}

export interface MaterialFact {
  root: string;
  repos: MaterialRepo[];
  entries: MaterialEntry[];
  // The full path list for small materials; empty for large trees (entries carry counts).
  paths: string[];
  files: number;
  truncated?: boolean;
}

function code(value: string): string {
  return value.length > 160 ? `${value.slice(0, 157)}…` : value;
}

function repoLine(repo: MaterialRepo): string {
  const parts: string[] = [];
  if (repo.branch !== undefined && repo.branch !== "") parts.push(`branch ${repo.branch}`);
  if (repo.head !== undefined && repo.head !== "") parts.push(`head ${repo.head}`);
  if (repo.dirty !== undefined) parts.push(`${repo.dirty} changed`);
  const detail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  const error = repo.error !== undefined && repo.error !== "" ? ` — status unavailable: ${repo.error}` : "";
  return `repo: ${repo.kind} at ${code(repo.root)}${detail}${error}`;
}

// The workspace lines shared by every state that receives the material map.
export function workspaceLines(fact: MaterialFact): string[] {
  const lines: string[] = [];
  if (fact.root !== "") lines.push(`root: ${code(fact.root)}`);
  if (fact.repos.length === 0) {
    const scope = fact.root !== "" ? ` under ${fact.root}` : "";
    lines.push(`repo: none (no .git/.hg/.svn${scope})`);
  } else {
    for (const repo of fact.repos) lines.push(repoLine(repo));
  }
  if (fact.entries.length > 0) {
    const shown = fact.entries.slice(0, 16).map((entry) =>
      entry.kind === "dir" ? `${entry.name}/ (${entry.files ?? 0} files)` : entry.name,
    );
    const more = fact.entries.length > shown.length ? `, … (+${fact.entries.length - shown.length} more)` : "";
    lines.push(`entries: ${shown.map(code).join(", ")}${more}`);
  } else {
    lines.push("entries: (none)");
  }
  if (fact.paths.length > 0) {
    const shown = fact.paths.slice(0, 40);
    const more = fact.paths.length > shown.length ? `, … (+${fact.paths.length - shown.length} more)` : "";
    lines.push(`paths: ${shown.map(code).join(", ")}${more}`);
  }
  lines.push(
    fact.truncated === true
      ? `files: ${fact.files}; map truncated — use list/grep to continue`
      : `files: ${fact.files}`,
  );
  return lines;
}

// A titled workspace block. The title is the same for every state that receives the map.
export function workspaceBrief(fact: MaterialFact, title: string): string {
  const lines = workspaceLines(fact);
  return lines.length > 0 ? [title, ...lines].join("\n") : "";
}
