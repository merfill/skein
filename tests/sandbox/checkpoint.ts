import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

// A read-only checkpoint of the task root, taken by the harness (never the engine) before the
// agent and at each turn. The store is content-addressed: an unchanged file is stored once and
// every snapshot tree hardlinks the same immutable blob, so per-turn snapshots cost metadata,
// not another copy of the tree.
//
// The tree is a plain directory of hardlinks/lists/symlinks, not a git repository: task images
// do not reliably carry git (db-wal has tar/cp but no git), while `cp -a` is everywhere. The
// agent's shell sees the store read-only at `.skein/checkpoints/trees/<n>/`.
//
// Scope: the task root, excluding `.skein` (harness/verifier/jobs) and `.env` files (secrets).
// A nested or root `.git` IS captured here (it is an ordinary directory to tar-like walking,
// unlike a shadow git index), so git-state tasks can be restored too.

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

interface Entry {
  // Workspace-relative path, `/`-separated.
  path: string;
  kind: "file" | "dir" | "symlink";
  // A file's blob key (content + mode + mtime), a symlink's target, or "" for a directory.
  value: string;
  // The source permission bits, so a restored path keeps its executable/read-only state.
  mode?: number;
  // The source modification time (ms), preserved so a build's `make` sees the same order.
  mtime?: number;
}

export interface SnapshotRecord {
  id: number;
  label: string;
  at: string;
  files: number;
  // Workspace-relative path of the tree, read-only to the agent.
  tree: string;
}

export interface Checkpoint {
  // The host directory to expose read-only at `<workdir>/.skein/checkpoints`.
  readonly dir: string;
  // Identifies this store. A token from another run is rejected instead of restoring from a
  // coincidentally numbered tree (a replayed journal carries the old run's token).
  readonly runId: string;
  readonly snapshots: readonly SnapshotRecord[];
  // Capture the current root. A tree identical to the previous one is not written again (the
  // previous record is returned), so an idle turn does not grow the store.
  snapshot(label?: string): SnapshotRecord;
  // Capture and return the opaque id the engine stores on a Patch move.
  checkpoint(label?: string): string;
  // Put the named workspace paths back as they were at `token` (a file created since is
  // removed, a deleted one restored). Returns the resulting versions. Throws on a foreign id.
  restore(token: string, paths: readonly string[]): { path: string; version: string }[];
}

function hashFile(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1 << 20);
  try {
    let read = readSync(fd, buffer, 0, buffer.length, null);
    while (read > 0) {
      hash.update(buffer.subarray(0, read));
      read = readSync(fd, buffer, 0, buffer.length, null);
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function walk(root: string, dir: string, out: Entry[]): void {
  let entries;
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    // An unreadable directory (a container-run tool can create root-only paths) is skipped.
    return;
  }
  for (const entry of entries) {
    // `.skein` holds the harness's own files; `.env` carries secrets and never enters a snapshot.
    if (entry.name === ".skein" || entry.name === ".env" || entry.name.startsWith(".env.")) continue;
    const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
    const full = join(root, path);
    try {
      if (entry.isDirectory()) {
        out.push({ path, kind: "dir", value: "", mode: statSync(full).mode & 0o777 });
        walk(root, path, out);
      } else if (entry.isSymbolicLink()) {
        out.push({ path, kind: "symlink", value: readlinkSync(full) });
      } else if (entry.isFile()) {
        // Mode and mtime are part of the key: two snapshots of a file with the same bytes but a
        // different executable bit or build-relevant mtime must not share one blob.
        const stat = statSync(full);
        const mode = stat.mode & 0o777;
        const mtime = Math.floor(stat.mtimeMs);
        out.push({ path, kind: "file", value: `${hashFile(full)}-${mode.toString(8)}-${mtime}`, mode, mtime });
      }
      // Sockets/FIFOs/devices are not workspace state; skip them rather than fail the run.
    } catch {
      // The host cannot read a root-owned file (e.g. `john/run/john.log` written inside the
      // task container) or it vanished mid-walk. The checkpoint is best-effort over what the
      // host can read; one such file must not abort the whole run.
    }
  }
}

function manifestHash(entries: readonly Entry[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) hash.update(`${entry.kind}\u0000${entry.value}\u0000${entry.path}\n`);
  return hash.digest("hex");
}

export function createCheckpoint(root: string): Checkpoint {
  const dir = join(root, ".skein", "checkpoints");
  const objects = join(dir, "objects");
  const trees = join(dir, "trees");
  mkdirSync(objects, { recursive: true });
  mkdirSync(trees, { recursive: true });
  writeFileSync(join(dir, "README"), README);
  writeFileSync(join(dir, "restore.sh"), RESTORE);
  chmodSync(join(dir, "restore.sh"), 0o755);
  // A pointer one level up, so a plain `ls .skein` reveals the store.
  writeFileSync(join(dir, "..", "README"), "Workspace checkpoints (read-only): .skein/checkpoints/README\n");

  const runId = randomUUID();
  const snapshots: SnapshotRecord[] = [];
  let lastHash: string | undefined;
  let temp = 0;

  // `lstat` so a dangling symlink still counts as present.
  const present = (path: string): boolean => {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  };
  // Match `fsWorkspace.version` (sha1 of the body); a missing file is `absent`, the same
  // marker the engine records for a deletion.
  const versionOf = (path: string): string => {
    try {
      // Match `fsWorkspace.version` exactly: it hashes the utf8-decoded body, not raw bytes.
      return createHash("sha1").update(readFileSync(join(root, path), "utf8")).digest("hex");
    } catch {
      return "absent";
    }
  };

  // Copy a blob into the store only when its content is new. The temporary name is unique per
  // process so parallel snapshots of the same content cannot leave a half-written object.
  const ensureBlob = (key: string, source: string, mode: number, mtime: number): void => {
    const target = join(objects, key);
    if (existsSync(target)) return;
    temp += 1;
    const staging = `${target}.tmp-${process.pid}-${temp}`;
    copyFileSync(source, staging);
    chmodSync(staging, mode);
    const seconds = mtime / 1000;
    utimesSync(staging, seconds, seconds);
    try {
      renameSync(staging, target);
    } catch (error) {
      // Another writer won the race: the object is already there, which is all we need.
      if (existsSync(target)) unlinkSync(staging);
      else throw error;
    }
  };

  const snapshot = (label?: string): SnapshotRecord => {
    const entries: Entry[] = [];
    walk(root, "", entries);
    const hash = manifestHash(entries);
    const previous = snapshots.at(-1);
    if (lastHash === hash && previous !== undefined) return previous;

    const id = snapshots.length;
    const relativeTree = `trees/${id}`;
    const tree = join(dir, relativeTree);
    mkdirSync(tree, { recursive: true });
    for (const entry of entries) {
      const dest = join(tree, entry.path);
      if (entry.kind === "dir") {
        mkdirSync(dest, { recursive: true });
        continue;
      }
      mkdirSync(dirname(dest), { recursive: true });
      if (entry.kind === "symlink") {
        try {
          symlinkSync(entry.value, dest);
        } catch {
          // A vanished/unreadable link is skipped like any other best-effort entry.
        }
        continue;
      }
      const mode = entry.mode ?? 0o644;
      try {
        ensureBlob(entry.value, join(root, entry.path), mode, entry.mtime ?? Date.now());
      } catch {
        // The host cannot read this file (root-owned, or it vanished after the walk).
        continue;
      }
      const blob = join(objects, entry.value);
      try {
        linkSync(blob, dest);
      } catch {
        // A filesystem without hardlinks still gets a correct (if larger) snapshot.
        copyFileSync(blob, dest);
        chmodSync(dest, mode);
        const seconds = (entry.mtime ?? Date.now()) / 1000;
        utimesSync(dest, seconds, seconds);
      }
    }
    // Directory modes are applied after the children exist (a read-only source dir must not
    // block creating its own entries).
    for (const entry of entries
      .filter((candidate) => candidate.kind === "dir" && candidate.mode !== undefined)
      .sort((a, b) => b.path.length - a.path.length)) {
      chmodSync(join(tree, entry.path), entry.mode as number);
    }

    const record: SnapshotRecord = {
      id,
      label: label ?? `turn-${id}`,
      at: new Date().toISOString(),
      files: entries.filter((entry) => entry.kind !== "dir").length,
      tree: relativeTree,
    };
    snapshots.push(record);
    lastHash = hash;
    return record;
  };

  const checkpoint = (label?: string): string => `${runId}:${snapshot(label).id}`;

  const restore = (token: string, paths: readonly string[]): { path: string; version: string }[] => {
    const split = token.indexOf(":");
    const run = split >= 0 ? token.slice(0, split) : "";
    const id = Number(split >= 0 ? token.slice(split + 1) : token);
    if (run !== runId || !Number.isInteger(id) || id < 0 || id >= snapshots.length) {
      throw new Error(`unknown checkpoint ${token}`);
    }
    const tree = join(dir, "trees", String(id));
    const restored: { path: string; version: string }[] = [];
    for (const path of paths) {
      if (path === "" || path.startsWith("/") || path.split("/").includes("..")) {
        throw new Error(`checkpoint restore path escapes the workspace: ${path}`);
      }
      const source = join(tree, path);
      const dest = join(root, path);
      if (!present(source)) {
        // The Patch created this path; the pre-patch tree did not have it.
        rmSync(dest, { recursive: true, force: true });
        restored.push({ path, version: "absent" });
        continue;
      }
      const stat = lstatSync(source);
      if (present(dest)) rmSync(dest, { recursive: true, force: true });
      mkdirSync(dirname(dest), { recursive: true });
      if (stat.isSymbolicLink()) {
        symlinkSync(readlinkSync(source), dest);
      } else if (stat.isDirectory()) {
        mkdirSync(dest, { recursive: true });
      } else {
        copyFileSync(source, dest);
        chmodSync(dest, stat.mode & 0o777);
        utimesSync(dest, stat.atimeMs / 1000, stat.mtimeMs / 1000);
      }
      restored.push({ path, version: versionOf(path) });
    }
    return restored;
  };

  return { dir, runId, snapshots, snapshot, checkpoint, restore };
}
