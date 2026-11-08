// The deterministic map of the material, recorded once at request start alongside the
// environment probe. It is an index, not content: the workspace root, the repository status
// and the entries/paths that exist. A state's brief takes the coordinates only
// (`Workspace root`, `Workspace repository`); the listing serves the `probe` tool. The map
// never decides what is acceptance.

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
  // Where the agent's shell starts when it differs from `root` (a task WORKDIR such as
  // `/app/personal-site`); relative shell paths resolve against it, not against `root`.
  cwd?: string;
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
  return `Workspace repository: ${repo.kind} at ${code(repo.root)}${detail}${error}`;
}

// The workspace lines shared by every state that receives the coordinates. `index: false` drops
// the listing (entries, paths, file count): a state's brief states where the work happens, not
// what the tree contains — a state that needs the files lists them itself.
export function workspaceLines(fact: MaterialFact, options: { index?: boolean } = {}): string[] {
  const lines: string[] = [];
  if (fact.root !== "") lines.push(`Workspace root: ${code(fact.root)}`);
  if (fact.cwd !== undefined && fact.cwd !== "" && fact.cwd !== fact.root) {
    lines.push(`Working directory: ${code(fact.cwd)}`);
  }
  if (fact.repos.length === 0) {
    const scope = fact.root !== "" ? ` under ${fact.root}` : "";
    lines.push(`Workspace repository: none (no .git/.hg/.svn${scope})`);
  } else {
    for (const repo of fact.repos) lines.push(repoLine(repo));
  }
  if (options.index === false) return lines;
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
