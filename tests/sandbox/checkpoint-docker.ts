import { dirname } from "node:path";

import type { CheckpointBackend, CheckpointEntry, ScanEntry } from "./checkpoint";
import type { DockerWorkspace } from "./docker";

// The same checkpoint algorithm as `HostBackend`, but the filesystem primitives run inside the
// task container through batched `docker exec` calls. `/app` never leaves the container: the
// host sends a `find` manifest, hashes only the changed files, and a small bash script performs
// the `cp`/`ln`/`mkdir` operations in the container's `/tmp/.skein` store. The store is visible
// to the agent through `/app/.skein/checkpoints -> /tmp/.skein`.

const README = `Skein workspace checkpoints (read-only).

trees/<n>/ is the workspace at snapshot <n>; tree 0 is the initial (post-setup) state.
Files there are hardlinks to immutable blobs, so do not modify them; copy a path out to restore.

  ls -a .skein/checkpoints/trees
  diff <path> .skein/checkpoints/trees/<n>/<path>
  cp -a .skein/checkpoints/trees/<n>/<path> <dest>
  .skein/checkpoints/restore.sh <n> <path> [dest]
`;

const RESTORE = `#!/bin/sh
# Restore one path from a workspace checkpoint.
#   restore.sh <snapshot> <path> [dest]
# The snapshot tree is read-only; this copies (cp -a) the stored inode's content out.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
if [ "$#" -lt 2 ]; then
  echo "usage: restore.sh <snapshot> <path> [dest]" >&2
  exit 2
fi
src="$here/trees/$1/$2"
if [ ! -e "$src" ] && [ ! -L "$src" ]; then
  echo "no such path in snapshot $1: $2" >&2
  exit 1
fi
cp -a "$src" "\${3:-$2}"
`;

const q = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

export class DockerBackend implements CheckpointBackend {
  readonly dir: string;
  private readonly workspace: DockerWorkspace;
  private readonly mount: string;

  constructor(workspace: DockerWorkspace, store = "/tmp/.skein", mount = workspace.displayRoot ?? "/app") {
    this.workspace = workspace;
    this.dir = store;
    this.mount = mount;
    this.ensureStore();
  }

  private ensureStore(): void {
    const result = this.workspace.exec(
      `mkdir -p ${q(`${this.dir}/objects`)} ${q(`${this.dir}/trees`)} ${q(`${this.mount}/.skein`)} && ` +
        `ln -sfn ${q(this.dir)} ${q(`${this.mount}/.skein/checkpoints`)}`,
    );
    if (result.code !== 0) throw new Error(`checkpoint store init failed: ${result.stderr.trim()}`);
    const script = [
      `cat > ${q(`${this.mount}/.skein/README`)} <<'EOF'`,
      README.trimEnd(),
      "EOF",
      `cat > ${q(`${this.dir}/restore.sh`)} <<'EOF'`,
      RESTORE.trimEnd(),
      "EOF",
      `chmod 755 ${q(`${this.dir}/restore.sh`)}`,
    ].join("\n");
    const written = this.workspace.execInput("bash -s", `${script}\n`);
    if (written.code !== 0) throw new Error(`checkpoint store files failed: ${written.stderr.trim()}`);
  }

  scan(): ScanEntry[] {
    const command =
      `find ${q(this.mount)} \\( -name .skein -o -name .env -o -name '.env.*' \\) -prune -o ` +
      `-printf '%y\\0%m\\0%s\\0%T@\\0%C@\\0%P\\0%l\\0'`;
    const result = this.workspace.exec(command);
    if (result.code !== 0) throw new Error(`checkpoint scan failed: ${result.stderr.trim()}`);
    const fields = result.stdout.split("\0");
    const out: ScanEntry[] = [];
    for (let index = 0; index + 6 < fields.length; index += 7) {
      const type = fields[index];
      const path = fields[index + 5];
      if (path === undefined || path === "") continue;
      const mode = Number.parseInt(fields[index + 1] ?? "0", 8);
      const size = Number.parseInt(fields[index + 2] ?? "0", 10);
      const mtimeMs = Math.round(Number.parseFloat(fields[index + 3] ?? "0") * 1000);
      const ctimeMs = Math.round(Number.parseFloat(fields[index + 4] ?? "0") * 1000);
      const link = fields[index + 6] ?? "";
      if (type === "d") out.push({ path, kind: "dir", mode });
      else if (type === "f") out.push({ path, kind: "file", mode, mtimeMs, ctimeMs, size });
      else if (type === "l") out.push({ path, kind: "symlink", link });
    }
    return out;
  }

  hash(paths: readonly string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (paths.length === 0) return out;
    const list = `${paths.map((path) => `${this.mount}/${path}`).join("\0")}\0`;
    const result = this.workspace.execInput("xargs -0 sha256sum -- 2>/dev/null || true", list);
    for (const line of result.stdout.split("\n")) {
      const match = /^([0-9a-f]{64})\s+\*?(.*)$/.exec(line);
      if (match === null) continue;
      const absolute = match[2] as string;
      const relative = absolute.startsWith(`${this.mount}/`) ? absolute.slice(this.mount.length + 1) : absolute;
      out.set(relative, match[1] as string);
    }
    return out;
  }

  writeTree(tree: string, entries: readonly CheckpointEntry[]): void {
    const treeDir = `${this.dir}/${tree}`;
    const objects = `${this.dir}/objects`;
    const lines = ["set -e", `mkdir -p ${q(objects)} ${q(treeDir)}`];
    for (const entry of entries) {
      const dest = `${treeDir}/${entry.path}`;
      if (entry.kind === "dir") {
        lines.push(`mkdir -p ${q(dest)}`);
        continue;
      }
      lines.push(`mkdir -p ${q(dirname(dest))}`);
      if (entry.kind === "symlink") {
        lines.push(`ln -sfn ${q(entry.value)} ${q(dest)}`);
        continue;
      }
      const object = `${objects}/${entry.value}`;
      const source = `${this.mount}/${entry.path}`;
      lines.push(`[ -e ${q(object)} ] || cp -p ${q(source)} ${q(object)}`);
      lines.push(`ln ${q(object)} ${q(dest)} 2>/dev/null || cp -p ${q(object)} ${q(dest)}`);
    }
    for (const entry of entries
      .filter((candidate) => candidate.kind === "dir" && candidate.mode !== undefined)
      .sort((a, b) => b.path.length - a.path.length)) {
      lines.push(`chmod ${(entry.mode as number).toString(8)} ${q(`${treeDir}/${entry.path}`)}`);
    }
    const result = this.workspace.execInput("bash -s", `${lines.join("\n")}\n`);
    if (result.code !== 0) throw new Error(`checkpoint writeTree failed: ${result.stderr.trim()}`);
  }

  restore(tree: string, path: string): string {
    const source = `${this.dir}/${tree}/${path}`;
    const target = `${this.mount}/${path}`;
    const script = [
      "set -e",
      `if [ -e ${q(source)} ] || [ -L ${q(source)} ]; then`,
      `  rm -rf ${q(target)}`,
      `  mkdir -p ${q(dirname(target))}`,
      `  cp -a ${q(source)} ${q(target)}`,
      `  if [ -f ${q(target)} ]; then sha1sum ${q(target)} | cut -d' ' -f1; else echo absent; fi`,
      "else",
      `  rm -rf ${q(target)}`,
      "  echo absent",
      "fi",
    ].join("\n");
    const result = this.workspace.execInput("bash -s", `${script}\n`);
    if (result.code !== 0) throw new Error(`checkpoint restore failed: ${result.stderr.trim()}`);
    const lines = result.stdout.trim().split("\n");
    return lines[lines.length - 1] ?? "absent";
  }
}
