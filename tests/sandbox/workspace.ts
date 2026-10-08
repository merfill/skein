import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { fsWorkspace, type CommandResult, type Workspace } from "../../src/tools/workspace";

// A hybrid sandbox workspace: the spec's files are materialized into a real temp dir, so
// `run` executes a REAL shell (`ls`, `cat`, `grep`, `pwd`, `cd …` all work) and
// `read`/`list`/`grep`/`edit`/`write` are the engine's real `fsWorkspace`. Only the
// task's heavy commands (a build, a testsuite) are intercepted by rules and return canned
// results, so the whole loop runs locally, fast and without Docker — and the model sees a
// faithful shell instead of "command not found".
//
// Deterministic tests use a scripted proposer; live tests use the real model.

export interface CommandContext {
  read: (path: string) => string;
  command: string;
}

export interface CommandRule {
  match: RegExp;
  // A fixed result, or a function over the current files (so a build can reflect an edit:
  // it fails until the fix lands, then passes).
  result: CommandResult | ((context: CommandContext) => CommandResult);
}

export interface SandboxSpec {
  files: Record<string, string>;
  commands?: CommandRule[];
}

const roots: string[] = [];

// A temp root registered for `cleanupSandboxes`; shared by the virtual spec workspace and
// the real container task harness (`harness.ts`).
export function newSandboxRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

export function sandboxWorkspace(spec: SandboxSpec): Workspace {
  const root = newSandboxRoot("skein-sandbox-");
  for (const [path, content] of Object.entries(spec.files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  const base = fsWorkspace(root);
  const commands = spec.commands ?? [];
  const run = (command: string): CommandResult => {
    for (const rule of commands) {
      rule.match.lastIndex = 0;
      if (!rule.match.test(command)) continue;
      return typeof rule.result === "function"
        ? rule.result({ read: (path) => base.read(path), command })
        : rule.result;
    }
    return base.run(command);
  };

  return { ...base, run };
}

export function cleanupSandboxes(): void {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
}
