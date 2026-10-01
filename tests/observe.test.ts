import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Event } from "../src/ir/events";
import { fold } from "../src/ir/graph";
import { reconcile, type VersionCache } from "../src/loop/observe";
import { fsWorkspace, type Workspace } from "../src/tools/workspace";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "bugfix");

const tempDirs: string[] = [];

function setup(fixture: string): string {
  const root = mkdtempSync(join(tmpdir(), `skein-observe-${fixture}-`));
  cpSync(join(FIXTURES, fixture), root, { recursive: true });
  tempDirs.push(root);
  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function readFact(version: string): Event[] {
  return [
    {
      type: "add_node",
      node: {
        id: "file:src/sum.mjs",
        space: "artifact",
        kind: "file",
        label: "src/sum.mjs",
        seq: 0,
      },
    },
    {
      type: "add_node",
      node: {
        id: "o1",
        space: "work",
        kind: "observation",
        label: "read src/sum.mjs",
        seq: 1,
      },
    },
    {
      type: "add_edge",
      edge: {
        id: "e1",
        from: "file:src/sum.mjs",
        to: "o1",
        kind: "locates",
        provenance: { kind: "read", ref: "file:src/sum.mjs", version },
        status: "believed",
      },
    },
  ];
}

describe("reconcile", () => {
  it("records a mutate when an active file changed outside the engine", () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    const base = readFact(workspace.version("src/sum.mjs"));
    const state = fold(base);

    expect(reconcile(state, workspace)).toEqual([]);

    workspace.write("src/sum.mjs", "export function sumTo() { return 0; }\n");
    const events = reconcile(state, workspace);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "mutate", ref: "file:src/sum.mjs" });

    const after = fold([...base, ...events]);
    expect(after.edgeStatuses.get("e1")).toBe("stale");
  });

  it("ignores files not involved in current activity", () => {
    const workspace = fsWorkspace(setup("off-by-one"));
    const state = fold(readFact(workspace.version("src/sum.mjs")));

    workspace.write("test/sum.test.mjs", "// changed externally\n");
    expect(reconcile(state, workspace)).toEqual([]);
  });

  it("hashes an active file once and reuses the cache while it is unchanged", () => {
    const root = setup("off-by-one");
    const base = fsWorkspace(root);
    let hashes = 0;
    const workspace: Workspace = {
      ...base,
      version: (path) => {
        hashes += 1;
        return base.version(path);
      },
    };
    const state = fold(readFact(base.version("src/sum.mjs")));
    const cache: VersionCache = new Map();

    expect(reconcile(state, workspace, cache)).toEqual([]);
    expect(hashes).toBe(1);

    expect(reconcile(state, workspace, cache)).toEqual([]);
    expect(hashes).toBe(1);

    base.write("src/sum.mjs", "export function sumTo() { return 0; }\n");
    const events = reconcile(state, workspace, cache);
    expect(hashes).toBe(2);
    expect(events).toHaveLength(1);
  });
});
