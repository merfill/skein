import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { fsWorkspace } from "../src/tools/workspace";
import { createCheckpoint } from "./sandbox/checkpoint";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "skein-checkpoint-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("workspace checkpoint", () => {
  it("stores a turn-addressed tree, excludes .skein and secrets, and keeps symlinks", () => {
    const root = makeRoot();
    writeFileSync(join(root, "a.txt"), "one\n");
    mkdirSync(join(root, "nested"), { recursive: true });
    writeFileSync(join(root, "nested", "b.txt"), "two\n");
    symlinkSync("a.txt", join(root, "link"));
    writeFileSync(join(root, ".env"), "SECRET=1\n");
    mkdirSync(join(root, ".skein"), { recursive: true });
    writeFileSync(join(root, ".skein", "config"), "harness\n");

    const checkpoint = createCheckpoint(root);
    const first = checkpoint.snapshot("initial");

    expect(first.id).toBe(0);
    const tree = join(checkpoint.dir, first.tree);
    expect(readFileSync(join(tree, "a.txt"), "utf8")).toBe("one\n");
    expect(readFileSync(join(tree, "nested", "b.txt"), "utf8")).toBe("two\n");
    // The link is stored as a link, not as a copy of its target.
    expect(readFileSync(join(tree, "link"), "utf8")).toBe("one\n");
    expect(existsSync(join(tree, ".env"))).toBe(false);
    expect(existsSync(join(tree, ".skein"))).toBe(false);
  });

  it("keeps the old tree intact when the workspace changes, and dedupes an idle turn", () => {
    const root = makeRoot();
    writeFileSync(join(root, "a.txt"), "one\n");
    writeFileSync(join(root, "b.txt"), "two\n");
    const checkpoint = createCheckpoint(root);
    const first = checkpoint.snapshot("initial");

    writeFileSync(join(root, "a.txt"), "changed\n");
    unlinkSync(join(root, "b.txt"));
    writeFileSync(join(root, "c.txt"), "new\n");
    const second = checkpoint.snapshot("turn-1");

    expect(second.id).toBe(1);
    const old = join(checkpoint.dir, first.tree);
    const next = join(checkpoint.dir, second.tree);
    expect(readFileSync(join(old, "a.txt"), "utf8")).toBe("one\n");
    expect(readFileSync(join(next, "a.txt"), "utf8")).toBe("changed\n");
    expect(existsSync(join(old, "b.txt"))).toBe(true);
    expect(existsSync(join(next, "b.txt"))).toBe(false);
    expect(existsSync(join(next, "c.txt"))).toBe(true);

    // No change since the last snapshot: reuse it rather than growing the store.
    const idle = checkpoint.snapshot("turn-2");
    expect(idle.id).toBe(1);
    expect(checkpoint.snapshots).toHaveLength(2);
  });

  it("applies a delta without touching the base tree", () => {
    const root = makeRoot();
    writeFileSync(join(root, "a.txt"), "one\n", { mode: 0o644 });
    writeFileSync(join(root, "b.txt"), "two\n");
    mkdirSync(join(root, "dir"), { recursive: true });
    writeFileSync(join(root, "dir", "child.txt"), "child\n");
    symlinkSync("a.txt", join(root, "link"));

    const checkpoint = createCheckpoint(root);
    const first = checkpoint.snapshot("initial");

    chmodSync(join(root, "a.txt"), 0o755);
    rmSync(join(root, "dir"), { recursive: true });
    unlinkSync(join(root, "link"));
    symlinkSync("b.txt", join(root, "link"));
    writeFileSync(join(root, "new.txt"), "new\n");
    const second = checkpoint.snapshot("turn-1");

    const old = join(checkpoint.dir, first.tree);
    const next = join(checkpoint.dir, second.tree);
    expect(statSync(join(old, "a.txt")).mode & 0o777).toBe(0o644);
    expect(statSync(join(next, "a.txt")).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(old, "dir", "child.txt"), "utf8")).toBe("child\n");
    expect(existsSync(join(next, "dir"))).toBe(false);
    expect(readlinkSync(join(old, "link"))).toBe("a.txt");
    expect(readlinkSync(join(next, "link"))).toBe("b.txt");
    expect(readFileSync(join(next, "new.txt"), "utf8")).toBe("new\n");
  });

  it("skips a file the host cannot read instead of failing the run", () => {
    // Root can read a 000 file, so the fixture only exercises a non-root host (the harness).
    if (process.getuid?.() === 0) return;
    const root = makeRoot();
    writeFileSync(join(root, "readable.txt"), "ok\n");
    writeFileSync(join(root, "root-only.txt"), "nope\n", { mode: 0o000 });
    const checkpoint = createCheckpoint(root);
    const record = checkpoint.snapshot("initial");
    const tree = join(checkpoint.dir, record.tree);
    expect(readFileSync(join(tree, "readable.txt"), "utf8")).toBe("ok\n");
    expect(existsSync(join(tree, "root-only.txt"))).toBe(false);
  });

  it("restores a mutated path and removes one the change created; rejects a foreign token", () => {
    const root = makeRoot();
    writeFileSync(join(root, "keep.txt"), "original\n");
    writeFileSync(join(root, "deleted.txt"), "restore me\n");
    const checkpoint = createCheckpoint(root);
    const token = checkpoint.checkpoint("pre-patch");

    writeFileSync(join(root, "keep.txt"), "changed\n");
    rmSync(join(root, "deleted.txt"));
    writeFileSync(join(root, "created.txt"), "new\n");

    const restored = checkpoint.restore(token, ["keep.txt", "deleted.txt", "created.txt"]);
    expect(readFileSync(join(root, "keep.txt"), "utf8")).toBe("original\n");
    expect(readFileSync(join(root, "deleted.txt"), "utf8")).toBe("restore me\n");
    expect(existsSync(join(root, "created.txt"))).toBe(false);
    expect(restored).toEqual([
      { path: "keep.txt", version: expect.any(String) },
      { path: "deleted.txt", version: expect.any(String) },
      { path: "created.txt", version: "absent" },
    ]);
    // The versions must match the workspace's own (utf8-body sha1), so `reconcile` does not
    // report a spurious change on the next turn.
    const workspace = fsWorkspace(root);
    expect(restored[0]?.version).toBe(workspace.version("keep.txt"));
    expect(restored[1]?.version).toBe(workspace.version("deleted.txt"));

    // A token from another run (or an unknown id) must not restore a coincidentally named tree.
    expect(() => checkpoint.restore("another-run:0", ["keep.txt"])).toThrow(/unknown checkpoint/);
    expect(() => checkpoint.restore(`${checkpoint.runId}:99`, ["keep.txt"])).toThrow(/unknown checkpoint/);
  });

  it("restores a path through the read-only-surface script", () => {
    const root = makeRoot();
    writeFileSync(join(root, "main.db-wal"), "wal-bytes\n");
    writeFileSync(join(root, "recover.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
    const checkpoint = createCheckpoint(root);
    checkpoint.snapshot("initial");

    // The snapshot keeps the executable bit, so a restored script still runs.
    expect(statSync(join(checkpoint.dir, "trees", "0", "recover.sh")).mode & 0o777).toBe(0o755);

    // The model's accidental deletion.
    rmSync(join(root, "main.db-wal"));
    expect(existsSync(join(root, "main.db-wal"))).toBe(false);

    const restored = join(root, "restored.db-wal");
    const result = spawnSync(
      "sh",
      [join(checkpoint.dir, "restore.sh"), "0", "main.db-wal", restored],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(readFileSync(restored, "utf8")).toBe("wal-bytes\n");
    // The snapshot itself is untouched.
    expect(readFileSync(join(checkpoint.dir, "trees", "0", "main.db-wal"), "utf8")).toBe("wal-bytes\n");
  });
});
