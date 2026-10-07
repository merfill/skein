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
      { propose, workspace, maxTurns: 18, noProgress: 30, held: { turns: 100, max: 4, chars: 1_000_000 } },
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
    let goalA: string | undefined;
    let call = 0;

    const propose = async (context: Context): Promise<Proposal> => {
      shownAt.push(ids(context));
      call += 1;
      const n = call;
      if (n === 1) {
        // An objective interpretation with no plan: the traversal descends to it.
        return {
          thought: "",
          action: { operator: "create_goal", what: "A", done_when: { kind: "objective", command: "false" } },
        };
      }
      if (n === 2) {
        goalA = context.path.at(-1)?.id;
        return { thought: "", action: { operator: "apply", action: { tool: "read", path: "f0.txt" } } };
      }
      if (n === 3) {
        f0 = context.lastResult?.id;
        // Refute A: its own criterion fails, so focus returns to the request.
        return { thought: "", action: { operator: "apply", action: { tool: "run", target: goalA } } };
      }
      if (n === 4) {
        // Choose a new interpretation; A (and its read) is now off the chosen subtree,
        // so only a `query` (with its TTL) can bring the body back.
        return {
          thought: "",
          action: {
            operator: "create_goal",
            what: "B",
            done_when: { kind: "arbiter", text: "B is accepted externally" },
            revises: [goalA!],
          },
        };
      }
      if (n === 5) {
        return { thought: "", action: { operator: "query", id: f0 ?? "missing" } };
      }
      return { thought: "", action: { operator: "apply", action: { tool: "run", command: `echo step-${n}` } } };
    };

    await runAgent(
      { propose, workspace, maxTurns: 10, noProgress: 30, held: { turns: 2, max: 100, chars: 1_000_000 } },
      { request: { id: "r1", text: "ttl" } },
    );

    expect(f0).toBeDefined();
    // Off-subtree: not shown before the query.
    expect(shownAt[3]).not.toContain(f0);
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

    const charCap = 300;
    await runAgent(
      { propose, workspace, maxTurns: 120, noProgress: 1000, held: { turns: 3, max: 6, chars: charCap } },
      { request: { id: "r1", text: "rotate" } },
    );

    // Long and bounded: context is set by the caps, not by the number of turns.
    expect(shownViews.length).toBeGreaterThan(100);
    const stats = workingSetStats(shownViews.map((shown) => ({ shown, requested: [] as string[] })));
    expect(stats.peakCount).toBeLessThanOrEqual(6);
    expect(stats.peakChars).toBeLessThanOrEqual(charCap);
  });
});
