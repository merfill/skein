import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
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

export function fsWorkspace(root: string): Workspace {
  const base = resolve(root);

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
    const result = spawnSync("/bin/bash", ["-c", `set -o pipefail; ${command}`], {
      cwd: base,
      encoding: "utf8",
      timeout: 120_000,
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
    };
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
  };
}
