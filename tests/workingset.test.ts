import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Context } from "../src/ir/project";
import type { Proposal } from "../src/llm/schemas";
import { runAgent } from "../src/loop/graph";
import { fsWorkspace } from "../src/tools/workspace";
import { workingSetStats } from "./workset";

// Long-horizon policy simulation: a scripted proposer (no LLM) drives thousands of
// "turns" through the real loop, so the working-set machinery is exercised under
// growth, cap eviction, re-acquisition, staleness and compression — cheaply and
// deterministically. See docs/testing_ru.md §3.

const tempDirs: string[] = [];

function workspaceWithFiles(count: number): ReturnType<typeof fsWorkspace> {
  const root = mkdtempSync(join(tmpdir(), "skein-wset-"));
  tempDirs.push(root);
  for (let i = 0; i < count; i += 1) {
    writeFileSync(join(root, `f${i}.txt`), `body of file ${i}\n${"x".repeat(120)}\n`);
  }
  return fsWorkspace(root);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function ids(context: Context): string[] {
  return context.shown.map((view) => view.id).filter((value): value is string => value !== undefined);
}

function turnViews(shownAt: string[][], requestsAt: string[][]): { shown: { id: string }[]; requested: string[] }[] {
  return shownAt.map((shown, index) => ({
    shown: shown.map((id) => ({ id })),
    requested: requestsAt[index] ?? [],
  }));
}

describe("working set under a long synthetic horizon", () => {
  it("grows past the cap, evicts, re-acquires, and drops stale content", async () => {
    const workspace = workspaceWithFiles(8);
    const resultOf: (string | undefined)[] = [];
    const shownAt: string[][] = [];
    const requestsAt: string[][] = [];
    let call = 0;

    const propose = async (context: Context): Promise<Proposal> => {
      const shown = ids(context);
      resultOf[call] = context.lastResult?.id;
      shownAt.push(shown);
      call += 1;
      const n = call;
      const f0 = resultOf[1];

      if (n <= 8) {
        requestsAt.push([]);
        return {
          thought: "",
          action: { operator: "apply", action: { tool: "read", path: `f${n - 1}.txt` } },
        };
      }
      if (n === 9) {
        requestsAt.push(f0 !== undefined ? [f0] : []);
        // Re-acquire the evicted body by query (the only entry into the working set).
        return {
          thought: "",
          action: { operator: "query", id: f0 ?? "missing" },
        };
      }
      if (n === 10) {
        requestsAt.push([]);
        return {
          thought: "",
          action: {
            operator: "apply",
            action: { tool: "edit", path: "f0.txt", find: "body of file 0", replace: "BODY of file 0" },
          },
        };
      }
      if (n === 11) {
        requestsAt.push([]);
        return {
          thought: "",
          action: { operator: "apply", action: { tool: "run", command: "echo after-edit" } },
        };
      }
      requestsAt.push([]);
      return { thought: "", action: { operator: "apply", action: { tool: "run", command: `echo tail-${n}` } } };
    };

    await runAgent(
      { propose, workspace, maxTurns: 18, noProgress: 30, held: { turns: 100, max: 4 } },
      { request: { id: "r1", text: "grow" } },
    );

    const f0 = resultOf[1];
    expect(f0).toBeDefined();

    const peak = Math.max(...shownAt.map((set) => set.length));
    expect(peak).toBeLessThanOrEqual(4);
    // Evicted under the cap before the re-access...
    expect(shownAt[8]).not.toContain(f0);
    // ...re-acquired after asking again...
    expect(shownAt[9]).toContain(f0);
    // ...and gone after the file changed, even though re-requested (stale).
    expect(shownAt.at(-1)).not.toContain(f0);

    const stats = workingSetStats(turnViews(shownAt, requestsAt));
    expect(stats.peakCount).toBeLessThanOrEqual(4);
    expect(stats.reacquiredIds).toContain(f0);
  });

  it("expires an off-subtree query-pinned result after the TTL (compression)", async () => {
    const workspace = workspaceWithFiles(3);
    const shownAt: string[][] = [];
    let f0: string | undefined;
    let goalG: string | undefined;
    let call = 0;

    const propose = async (context: Context): Promise<Proposal> => {
      shownAt.push(ids(context));
      call += 1;
      const n = call;
      if (n === 1) {
        // The interpretation A; the traversal descends to it.
        return {
          thought: "",
          action: {
            operator: "create_goal",
            what: "A",
            done_when: "true",
            plan: "A: a sketch",
            step: { command: "true" },
          },
        };
      }
      if (n === 2) {
        // Decompose A's current step into a sub-goal G and descend into it.
        return {
          thought: "",
          action: {
            operator: "create_goal",
            what: "G",
            done_when: "true",
            plan: "G: a sketch",
            step: { command: "true" },
          },
        };
      }
      if (n === 3) {
        goalG = context.path.at(-1)?.id;
        return { thought: "", action: { operator: "apply", action: { tool: "read", path: "f0.txt" } } };
      }
      if (n === 4) {
        f0 = context.lastResult?.id;
        return { thought: "", action: { operator: "apply", action: { tool: "run", target: goalG } } };
      }
      if (n === 5) {
        // Stop G (its criterion passed): focus returns to A, so G's read is off A's
        // subtree and only a `query` (with its TTL) can bring the body back.
        return { thought: "", action: { operator: "stop", why: "G is done" } };
      }
      if (n === 6) {
        return { thought: "", action: { operator: "query", id: f0 ?? "missing" } };
      }
      return { thought: "", action: { operator: "apply", action: { tool: "run", command: `echo step-${n}` } } };
    };

    await runAgent(
      { propose, workspace, maxTurns: 12, noProgress: 30, held: { turns: 2, max: 100 } },
      { request: { id: "r1", text: "ttl" } },
    );

    expect(f0).toBeDefined();
    // Off-subtree after G is stopped: not shown in the context of the query call.
    expect(shownAt[5]).not.toContain(f0);
    // Pinned by the query, then expired after the TTL.
    const first = shownAt.findIndex((ids_) => f0 !== undefined && ids_.includes(f0));
    expect(first).toBeGreaterThan(0);
    expect(shownAt.at(-1)).not.toContain(f0); // TTL=2 expired
  });

  it("stays bounded over hundreds of turns of rotating access", async () => {
    const workspace = workspaceWithFiles(12);
    const shownViews: { id?: string | undefined; output?: string | undefined }[][] = [];
    let call = 0;

    const propose = async (context: Context): Promise<Proposal> => {
      shownViews.push(context.shown.map((view) => ({ id: view.id, output: view.output })));
      call += 1;
      const n = call;
      if (n <= 12) {
        return {
          thought: "",
          action: { operator: "apply", action: { tool: "read", path: `f${n - 1}.txt` } },
        };
      }
      return {
        thought: "",
        action: { operator: "apply", action: { tool: "run", command: `echo step-${n}` } },
      };
    };

    await runAgent(
      { propose, workspace, maxTurns: 120, noProgress: 1000, held: { turns: 3, max: 6 } },
      { request: { id: "r1", text: "rotate" } },
    );

    // Long and bounded: the working set is capped by the number of bodies, not the number
    // of turns (each body is bounded per tool by OUTPUT_LIMIT).
    expect(shownViews.length).toBeGreaterThan(100);
    const stats = workingSetStats(shownViews.map((shown) => ({ shown, requested: [] as string[] })));
    expect(stats.peakCount).toBeLessThanOrEqual(6);
  });

  // Regression: a total-character cap used to silently drop a body larger than the cap, so
  // the model lost the source window it was editing and looped on `query`
  // (docs/benches/bench_report.md §4.4). Several large bodies must now stay in view; only
  // the body-count cap evicts.
  it("keeps several large bodies in view (no total-character cap)", async () => {
    const root = mkdtempSync(join(tmpdir(), "skein-wset-big-"));
    tempDirs.push(root);
    for (let i = 0; i < 3; i += 1) writeFileSync(join(root, `big${i}.txt`), `${"x".repeat(20_000)}\n${i}\n`);
    const workspace = fsWorkspace(root);
    const shownCounts: number[] = [];
    let call = 0;

    const propose = async (context: Context): Promise<Proposal> => {
      call += 1;
      const n = call;
      if (n <= 3) {
        return { thought: "", action: { operator: "apply", action: { tool: "read", path: `big${n - 1}.txt` } } };
      }
      shownCounts.push(ids(context).length);
      return { thought: "", action: { operator: "apply", action: { tool: "run", command: `echo t${n}` } } };
    };

    // Each body is capped at OUTPUT_LIMIT (8000); three of them exceed the old 16,000 total.
    await runAgent({ propose, workspace, maxTurns: 6, noProgress: 30 }, { request: { id: "r1", text: "read all" } });
    expect(Math.max(...shownCounts)).toBeGreaterThanOrEqual(3);
  });
});
