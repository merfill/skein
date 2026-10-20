import { basename, join } from "node:path";

import type { MaterialEntry, MaterialFact, MaterialRepo } from "../ir/material";
import type { CommandResult, Workspace } from "../tools/workspace";

// Bounds, not judgments: the map is an index, so it caps how much it stores and renders. A
// cap sets `truncated`; the agent continues with `list`/`grep`.
const MAX_ENTRIES = 2000;
const MAX_PATHS = 40;
const MAX_REPO_DIRS = 2000;
const MAX_COMMITS = 5;
const COMMAND_TIMEOUT_MS = 2000;

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function firstLine(value: string): string {
  return (value.split("\n")[0] ?? "").trim().slice(0, 160);
}

function run(workspace: Workspace, command: string): CommandResult | undefined {
  try {
    return workspace.run(command, { timeoutMs: COMMAND_TIMEOUT_MS });
  } catch {
    return undefined;
  }
}

function isSecret(path: string): boolean {
  const name = basename(path);
  return name === ".env" || name.startsWith(".env.");
}

// Top-level entries, with a file count for directories. No extension histogram and no
// configuration parsing: both are noise for Orientation.
function entriesOf(files: readonly string[], truncated: { value: boolean }): MaterialEntry[] {
  const kinds = new Map<string, "file" | "dir">();
  const counts = new Map<string, number>();
  for (const path of files) {
    const parts = path.split("/");
    const name = parts[0];
    if (name === undefined || name === "") continue;
    if (parts.length === 1) {
      kinds.set(name, "file");
      continue;
    }
    kinds.set(name, "dir");
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const entries = [...kinds]
    .map(([name, kind]) => (kind === "dir" ? { name, kind, files: counts.get(name) ?? 0 } : { name, kind }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (entries.length > MAX_ENTRIES) truncated.value = true;
  return entries.slice(0, MAX_ENTRIES);
}

// For small materials the full path list replaces the need for `ls`/`find`; for a large tree
// the top-level counts are the index.
function pathsOf(files: readonly string[]): string[] {
  return files.length <= MAX_PATHS ? [...files].sort() : [];
}

function repoFor(workspace: Workspace, dir: string, io: (path: string) => string): MaterialRepo | undefined {
  const marker = [".git", ".hg", ".svn"].find((name) => workspace.exists(io(join(dir, name))));
  if (marker === undefined) return undefined;
  if (marker === ".git") return gitRepo(workspace, dir, io);
  if (marker === ".hg") return hgRepo(workspace, dir, io);
  return svnRepo(workspace, dir, io);
}

function gitRepo(workspace: Workspace, dir: string, io: (path: string) => string): MaterialRepo {
  const cwd = io(dir) === "" ? "." : io(dir);
  const at = `git -C ${quote(cwd)}`;
  const root = run(workspace, `${at} rev-parse --show-toplevel`);
  if (root === undefined || root.code !== 0) {
    return { kind: "git", root: cwd, error: root === undefined ? "git unavailable" : firstLine(root.stderr) };
  }
  const canonical = root.stdout.trim() === "" ? cwd : root.stdout.trim();
  const branch = run(workspace, `${at} rev-parse --abbrev-ref HEAD`);
  const head = run(workspace, `${at} rev-parse --short HEAD`);
  const status = run(workspace, `${at} status --porcelain`);
  const log = run(workspace, `${at} log -n ${MAX_COMMITS} --format=%h%x09%s`);
  const commits: { hash: string; subject: string }[] = [];
  if (log !== undefined && log.code === 0) {
    for (const line of log.stdout.split("\n")) {
      if (line.trim() === "") continue;
      const tab = line.indexOf("\t");
      const hash = (tab < 0 ? line : line.slice(0, tab)).trim();
      const subject = (tab < 0 ? "" : line.slice(tab + 1)).trim().slice(0, 120);
      commits.push({ hash, subject });
    }
  }
  const repo: MaterialRepo = { kind: "git", root: canonical, commits };
  if (branch !== undefined && branch.code === 0 && branch.stdout.trim() !== "") repo.branch = branch.stdout.trim();
  if (head !== undefined && head.code === 0 && head.stdout.trim() !== "") repo.head = head.stdout.trim();
  if (status !== undefined && status.code === 0) {
    repo.dirty = status.stdout.split("\n").filter((line) => line.trim() !== "").length;
  }
  return repo;
}

function hgRepo(workspace: Workspace, dir: string, io: (path: string) => string): MaterialRepo {
  const cwd = io(dir) === "" ? "." : io(dir);
  const at = `hg -R ${quote(cwd)}`;
  const root = run(workspace, `${at} root`);
  if (root === undefined || root.code !== 0) {
    return { kind: "hg", root: cwd, error: root === undefined ? "hg unavailable" : firstLine(root.stderr) };
  }
  const branch = run(workspace, `${at} branch`);
  const head = run(workspace, `${at} id -i`);
  const status = run(workspace, `${at} status`);
  const repo: MaterialRepo = { kind: "hg", root: root.stdout.trim() === "" ? cwd : root.stdout.trim() };
  if (branch !== undefined && branch.code === 0 && branch.stdout.trim() !== "") repo.branch = branch.stdout.trim();
  if (head !== undefined && head.code === 0 && head.stdout.trim() !== "") repo.head = head.stdout.trim();
  if (status !== undefined && status.code === 0) {
    repo.dirty = status.stdout.split("\n").filter((line) => line.trim() !== "").length;
  }
  return repo;
}

function svnRepo(workspace: Workspace, dir: string, io: (path: string) => string): MaterialRepo {
  const cwd = io(dir) === "" ? "." : io(dir);
  const revision = run(workspace, `svn info --show-item revision ${quote(cwd)}`);
  if (revision === undefined || revision.code !== 0) {
    return { kind: "svn", root: cwd, error: revision === undefined ? "svn unavailable" : firstLine(revision.stderr) };
  }
  const url = run(workspace, `svn info --show-item relative-url ${quote(cwd)}`);
  const status = run(workspace, `svn status ${quote(cwd)}`);
  const repo: MaterialRepo = { kind: "svn", root: cwd, head: revision.stdout.trim() };
  if (url !== undefined && url.code === 0 && url.stdout.trim() !== "") repo.branch = url.stdout.trim();
  if (status !== undefined && status.code === 0) {
    repo.dirty = status.stdout.split("\n").filter((line) => line.trim() !== "").length;
  }
  return repo;
}

function repositoryRoots(
  workspace: Workspace,
  files: readonly string[],
  truncated: { value: boolean },
  io: (path: string) => string,
): MaterialRepo[] {
  const dirs = new Set<string>([""]);
  for (const path of files) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const dir = parts.slice(0, index).join("/");
      if (dir !== "") dirs.add(dir);
    }
  }
  if (dirs.size > MAX_REPO_DIRS) truncated.value = true;
  const repos: MaterialRepo[] = [];
  const seen = new Set<string>();
  for (const dir of [...dirs].slice(0, MAX_REPO_DIRS)) {
    const repo = repoFor(workspace, dir, io);
    if (repo === undefined) continue;
    if (seen.has(repo.root)) continue;
    seen.add(repo.root);
    repos.push(repo);
  }
  return repos.sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
}

// The map itself: one sorted walk (`workspace.list()`), no shell `find`, no file bodies,
// no configuration parsing. The environment probe is separate (`src/loop/probe.ts`).
export function probeMaterial(
  workspace: Workspace,
  root = workspace.displayRoot ?? workspace.root,
): MaterialFact | undefined {
  let files: string[];
  try {
    files = workspace.list().filter((path) => !isSecret(path));
  } catch {
    return undefined;
  }
  const truncated = { value: false };
  const base = root.replace(/\/+$/, "");
  // `workspace.list()` is relative to the material root; the file tools may be rooted at a
  // subdirectory (the container workdir). Prefix the material root for I/O so the map and
  // the VCS commands address the same tree regardless of the agent's workdir.
  const io = (path: string): string => (base.startsWith("/") ? (path === "" ? base : `${base}/${path}`) : path);
  const entries = entriesOf(files, truncated);
  const paths = pathsOf(files);
  const repos = repositoryRoots(workspace, files, truncated, io);
  const fact: MaterialFact = {
    root,
    repos,
    entries,
    paths,
    files: files.length,
  };
  if (truncated.value) fact.truncated = true;
  return fact;
}
