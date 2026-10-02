import { execSync } from "node:child_process";
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

export interface CommandResult {
  code: number;
  output: string;
}

export interface Workspace {
  root: string;
  read(path: string): string;
  version(path: string): string;
  signature(path: string): string;
  write(path: string, content: string): void;
  exists(path: string): boolean;
  list(): string[];
  grep(pattern: string): GrepMatch[];
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
const TEXT_EXT = new Set([
  ".mjs",
  ".js",
  ".cjs",
  ".ts",
  ".tsx",
  ".json",
  ".md",
  ".txt",
  ".yml",
  ".yaml",
]);

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

  const grep = (pattern: string): GrepMatch[] => {
    const re = new RegExp(pattern);
    const matches: GrepMatch[] = [];
    for (const path of list()) {
      if (!TEXT_EXT.has(path.slice(path.lastIndexOf(".")))) continue;
      let lines: string[];
      try {
        lines = read(path).split("\n");
      } catch {
        continue;
      }
      lines.forEach((text, index) => {
        if (re.test(text)) matches.push({ path, line: index + 1, text });
      });
    }
    return matches;
  };

  const run = (command: string): CommandResult => {
    try {
      const output = execSync(command, {
        cwd: base,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      });
      return { code: 0, output };
    } catch (error) {
      const err = error as {
        status?: number | null;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      const output =
        `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || err.message || "command failed";
      return { code: err.status ?? 1, output };
    }
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
    run,
  };
}
