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
// not another copy of the tree. The signature cache keeps an unchanged file from being read
// and hashed every turn.
//
// The tree is a plain directory of hardlinks/lists/symlinks, not a git repository: task images
// do not reliably carry git (db-wal has tar/cp but no git), while `cp -a` is everywhere. The
// agent's shell sees the store read-only at `.skein/checkpoints/trees/<n>/`.
//
// Scope: the task root, excluding `.skein` (harness/verifier/jobs) and `.env` files (secrets).
// A nested or root `.git` IS captured here (it is an ordinary directory to tar-like walking,
// unlike a shadow git index), so git-state tasks can be restored too.
//
// The algorithm is environment-independent: `CheckpointBackend` supplies the filesystem
// primitives. `HostBackend` runs them on the host; a container backend runs the same algorithm
// with `docker exec` (so `/app` need not be copied to the host).

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

export interface ScanEntry {
  // Workspace-relative path, `/`-separated.
  path: string;
  kind: "file" | "dir" | "symlink";
  mode?: number;
  mtimeMs?: number;
  ctimeMs?: number;
  size?: number;
  // A symlink's target.
  link?: string;
}

export interface CheckpointEntry extends ScanEntry {
  // A file's blob key (content + mode + mtime), a symlink's target, or "" for a directory.
  value: string;
}

// The filesystem primitives the checkpoint algorithm needs. A host implementation uses `fs`;
// a container implementation runs batched `docker exec` commands against the task namespace.
export interface CheckpointBackend {
  // Store root: a host path for HostBackend, a container path for the Docker backend.
  readonly dir: string;
  // One walk of the workspace, excluding `.skein` and secrets; no file contents are read.
  scan(): ScanEntry[];
  // Content hashes for the given workspace-relative files. Unreadable files are omitted.
  hash(paths: readonly string[]): Map<string, string>;
  // Create the object blobs (when new) and a hardlink tree for a snapshot.
  writeTree(tree: string, entries: readonly CheckpointEntry[]): void;
  // Put one path back from a snapshot tree; return the resulting workspace version, or
  // "absent" when the snapshot did not have the path.
  restore(tree: string, path: string): string;
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

function manifestHash(entries: readonly CheckpointEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) hash.update(`${entry.kind}\u0000${entry.value}\u0000${entry.path}\n`);
  return hash.digest("hex");
}

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// The host filesystem backend: the original checkpoint implementation, now behind the
// primitive interface. Tests and bwrap/virtual workspaces use it directly.
export class HostBackend implements CheckpointBackend {
  readonly root: string;
  readonly dir: string;

  constructor(root: string) {
    this.root = root;
    this.dir = join(root, ".skein", "checkpoints");
    this.ensureStore();
  }

  private ensureStore(): void {
    mkdirSync(join(this.dir, "objects"), { recursive: true });
    mkdirSync(join(this.dir, "trees"), { recursive: true });
    writeFileSync(join(this.dir, "README"), README);
    writeFileSync(join(this.dir, "restore.sh"), RESTORE);
    chmodSync(join(this.dir, "restore.sh"), 0o755);
    // A pointer one level up, so a plain `ls .skein` reveals the store.
    writeFileSync(join(this.dir, "..", "README"), "Workspace checkpoints (read-only): .skein/checkpoints/README\n");
  }

  scan(): ScanEntry[] {
    const out: ScanEntry[] = [];
    const walk = (dir: string): void => {
      let entries;
      try {
        entries = readdirSync(join(this.root, dir), { withFileTypes: true });
      } catch {
        // An unreadable directory (a container-run tool can create root-only paths) is skipped.
        return;
      }
      for (const entry of entries) {
        // `.skein` holds the harness's own files; `.env` carries secrets and never enters a snapshot.
        if (entry.name === ".skein" || entry.name === ".env" || entry.name.startsWith(".env.")) continue;
        const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
        const full = join(this.root, path);
        try {
          if (entry.isDirectory()) {
            out.push({ path, kind: "dir", mode: statSync(full).mode & 0o777 });
            walk(path);
          } else if (entry.isSymbolicLink()) {
            out.push({ path, kind: "symlink", link: readlinkSync(full) });
          } else if (entry.isFile()) {
            const stat = statSync(full);
            out.push({
              path,
              kind: "file",
              mode: stat.mode & 0o777,
              mtimeMs: stat.mtimeMs,
              ctimeMs: stat.ctimeMs,
              size: stat.size,
            });
          }
          // Sockets/FIFOs/devices are not workspace state; skip them rather than fail the run.
        } catch {
          // The host cannot read a root-owned file (e.g. `john/run/john.log` written inside the
          // task container) or it vanished mid-walk. The checkpoint is best-effort over what the
          // host can read; one such file must not abort the whole run.
        }
      }
    };
    walk("");
    return out;
  }

  hash(paths: readonly string[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const path of paths) {
      try {
        out.set(path, hashFile(join(this.root, path)));
      } catch {
        // Unreadable or vanished: the snapshot skips it, as the walk used to.
      }
    }
    return out;
  }

  writeTree(tree: string, entries: readonly CheckpointEntry[]): void {
    const treeDir = join(this.dir, tree);
    mkdirSync(treeDir, { recursive: true });
    for (const entry of entries) {
      const dest = join(treeDir, entry.path);
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
      const mtime = entry.mtimeMs ?? Date.now();
      try {
        this.ensureBlob(entry.value, join(this.root, entry.path), mode, mtime);
      } catch {
        // The host cannot read this file (root-owned, or it vanished after the walk).
        continue;
      }
      const blob = join(this.dir, "objects", entry.value);
      try {
        linkSync(blob, dest);
      } catch {
        // A filesystem without hardlinks still gets a correct (if larger) snapshot.
        copyFileSync(blob, dest);
        chmodSync(dest, mode);
        const seconds = mtime / 1000;
        utimesSync(dest, seconds, seconds);
      }
    }
    // Directory modes are applied after the children exist (a read-only source dir must not
    // block creating its own entries).
    for (const entry of entries
      .filter((candidate) => candidate.kind === "dir" && candidate.mode !== undefined)
      .sort((a, b) => b.path.length - a.path.length)) {
      chmodSync(join(treeDir, entry.path), entry.mode as number);
    }
  }

  restore(tree: string, path: string): string {
    const source = join(this.dir, tree, path);
    const dest = join(this.root, path);
    if (!present(source)) {
      // The Patch created this path; the pre-patch tree did not have it.
      rmSync(dest, { recursive: true, force: true });
      return "absent";
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
    return this.versionOf(path);
  }

  private ensureBlob(key: string, source: string, mode: number, mtimeMs: number): void {
    const target = join(this.dir, "objects", key);
    if (existsSync(target)) return;
    const staging = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    copyFileSync(source, staging);
    chmodSync(staging, mode);
    const seconds = mtimeMs / 1000;
    utimesSync(staging, seconds, seconds);
    try {
      renameSync(staging, target);
    } catch (error) {
      // Another writer won the race: the object is already there, which is all we need.
      if (existsSync(target)) unlinkSync(staging);
      else throw error;
    }
  }

  private versionOf(path: string): string {
    try {
      // Match `fsWorkspace.version` exactly: it hashes the utf8-decoded body, not raw bytes.
      return createHash("sha1").update(readFileSync(join(this.root, path), "utf8")).digest("hex");
    } catch {
      return "absent";
    }
  }
}

interface CachedFile {
  // mtimeMs:ctimeMs:size:mode — cheap to obtain and enough to know the content can be reused.
  signature: string;
  value: string;
}

export function createCheckpointWithBackend(backend: CheckpointBackend): Checkpoint {
  const dir = backend.dir;
  const runId = randomUUID();
  const snapshots: SnapshotRecord[] = [];
  let lastHash: string | undefined;
  const signatureCache = new Map<string, CachedFile>();

  const snapshot = (label?: string): SnapshotRecord => {
    const scan = backend.scan();
    const missing: string[] = [];
    const signatures = new Map<string, string>();
    for (const entry of scan) {
      if (entry.kind !== "file") continue;
      const signature = `${entry.mtimeMs}:${entry.ctimeMs}:${entry.size}:${entry.mode}`;
      signatures.set(entry.path, signature);
      const cached = signatureCache.get(entry.path);
      if (cached === undefined || cached.signature !== signature) missing.push(entry.path);
    }
    const hashes = backend.hash(missing);
    const entries: CheckpointEntry[] = [];
    for (const entry of scan) {
      if (entry.kind !== "file") {
        entries.push({ ...entry, value: entry.kind === "symlink" ? entry.link ?? "" : "" });
        continue;
      }
      const signature = signatures.get(entry.path) as string;
      const cached = signatureCache.get(entry.path);
      if (cached !== undefined && cached.signature === signature) {
        entries.push({ ...entry, value: cached.value });
        continue;
      }
      const hash = hashes.get(entry.path);
      if (hash === undefined) continue; // unreadable; skip like the old walk
      const mode = entry.mode ?? 0o644;
      const mtime = Math.floor(entry.mtimeMs ?? Date.now());
      const value = `${hash}-${mode.toString(8)}-${mtime}`;
      signatureCache.set(entry.path, { signature, value });
      entries.push({ ...entry, value });
    }

    const hash = manifestHash(entries);
    const previous = snapshots.at(-1);
    if (lastHash === hash && previous !== undefined) return previous;

    const id = snapshots.length;
    const relativeTree = `trees/${id}`;
    backend.writeTree(relativeTree, entries);

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
    const tree = `trees/${id}`;
    const restored: { path: string; version: string }[] = [];
    for (const path of paths) {
      if (path === "" || path.startsWith("/") || path.split("/").includes("..")) {
        throw new Error(`checkpoint restore path escapes the workspace: ${path}`);
      }
      // The restored content invalidates the signature of that path for the next snapshot.
      signatureCache.delete(path);
      restored.push({ path, version: backend.restore(tree, path) });
    }
    return restored;
  };

  return { dir, runId, snapshots, snapshot, checkpoint, restore };
}

export function createCheckpoint(root: string): Checkpoint {
  return createCheckpointWithBackend(new HostBackend(root));
}
