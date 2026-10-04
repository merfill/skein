import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Context } from "../src/ir/project";
import type { Proposal } from "../src/llm/schemas";
import { runAgent } from "../src/loop/graph";
import { fsWorkspace } from "../src/tools/workspace";
import { workingSetStats, type WorkingSetStats } from "./workset";

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
        const need = n >= 2 && resultOf[n - 1] !== undefined ? [resultOf[n - 1] as string] : [];
        requestsAt.push(need);
        return {
          thought: "",
          action: { operator: "apply", action: { tool: "read", path: `f${n - 1}.txt` } },
          ...(need.length > 0 ? { need } : {}),
        };
      }
      if (n === 9) {
        requestsAt.push(f0 !== undefined ? [f0] : []);
        return {
          thought: "",
          action: { operator: "apply", action: { tool: "run", command: "echo reaccess" } },
          ...(f0 !== undefined ? { need: [f0] } : {}),
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
        requestsAt.push(f0 !== undefined ? [f0] : []);
        return {
          thought: "",
          action: { operator: "apply", action: { tool: "run", command: "echo after-edit" } },
          ...(f0 !== undefined ? { need: [f0] } : {}),
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

  it("expires a cross-level needed result after the TTL (compression)", async () => {
    const workspace = workspaceWithFiles(3);
    const shownAt: string[][] = [];
    const requestsAt: string[][] = [];
    let f0: string | undefined;
    let call = 0;

    const propose = async (context: Context): Promise<Proposal> => {
      shownAt.push(ids(context));
      call += 1;
      const n = call;
      if (n === 1) {
        requestsAt.push([]);
        return { thought: "", action: { operator: "apply", action: { tool: "read", path: "f0.txt" } } };
      }
      if (n === 2) {
        f0 = context.lastResult?.id;
        requestsAt.push([]);
        // Descend a level: the read is no longer part of the current level.
        return {
          thought: "",
          action: {
            operator: "create_goal",
            what: "work",
            done_when: { kind: "subjective", text: "done" },
            plan: [{ kind: "goal", what: "stage", done_when: { kind: "subjective", text: "ok" } }],
          },
        };
      }
      if (n === 3) {
        requestsAt.push(f0 !== undefined ? [f0] : []);
        return {
          thought: "",
          action: { operator: "apply", action: { tool: "run", command: "echo one" } },
          ...(f0 !== undefined ? { need: [f0] } : {}),
        };
      }
      requestsAt.push([]);
      return { thought: "", action: { operator: "apply", action: { tool: "run", command: `echo step-${n}` } } };
    };

    await runAgent(
      { propose, workspace, maxTurns: 10, noProgress: 30, held: { turns: 2, max: 100, chars: 1_000_000 } },
      { request: { id: "r1", text: "ttl" } },
    );

    expect(f0).toBeDefined();
    const first = shownAt.findIndex((ids_) => f0 !== undefined && ids_.includes(f0));
    expect(first).toBeGreaterThan(0);
    expect(shownAt.at(-1)).not.toContain(f0); // TTL=2 expired
  });

  it("stays bounded over hundreds of turns of rotating access", async () => {
    const workspace = workspaceWithFiles(12);
    const resultOf: (string | undefined)[] = [];
    const shownViews: { id?: string | undefined; output?: string | undefined }[][] = [];
    let call = 0;

    const propose = async (context: Context): Promise<Proposal> => {
      resultOf[call] = context.lastResult?.id;
      shownViews.push(context.shown.map((view) => ({ id: view.id, output: view.output })));
      call += 1;
      const n = call;
      if (n <= 12) {
        const previous = resultOf[n - 1];
        return {
          thought: "",
          action: { operator: "apply", action: { tool: "read", path: `f${n - 1}.txt` } },
          ...(n >= 2 && previous !== undefined ? { need: [previous] } : {}),
        };
      }
      const readIds = resultOf.slice(1, 13).filter((value): value is string => value !== undefined);
      const a = readIds[n % readIds.length];
      const b = readIds[(n + 1) % readIds.length];
      const need = [a, b].filter((value): value is string => value !== undefined);
      return {
        thought: "",
        action: { operator: "apply", action: { tool: "run", command: `echo step-${n}` } },
        ...(need.length > 0 ? { need } : {}),
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

  async function runGapPattern(limits: Record<string, unknown>): Promise<WorkingSetStats> {
    const workspace = workspaceWithFiles(4);
    const resultOf: (string | undefined)[] = [];
    const shownViews: { id?: string | undefined; output?: string | undefined }[][] = [];
    const requests: string[][] = [];
    let call = 0;
    const propose = async (context: Context): Promise<Proposal> => {
      resultOf[call] = context.lastResult?.id;
      shownViews.push(context.shown.map((view) => ({ id: view.id, output: view.output })));
      call += 1;
      const n = call;
      if (n <= 4) {
        requests.push([]);
        return { thought: "", action: { operator: "apply", action: { tool: "read", path: `f${n - 1}.txt` } } };
      }
      if (n === 5) {
        // Move to a deeper level so the reads above are cross-level.
        requests.push([]);
        return {
          thought: "",
          action: {
            operator: "create_goal",
            what: "work",
            done_when: { kind: "subjective", text: "done" },
            plan: [{ kind: "goal", what: "stage", done_when: { kind: "subjective", text: "ok" } }],
          },
        };
      }
      const readIds = resultOf.slice(1, 5).filter((value): value is string => value !== undefined);
      const id = readIds[(n - 5) % readIds.length];
      const need = id !== undefined ? [id] : [];
      requests.push(need);
      return {
        thought: "",
        action: { operator: "apply", action: { tool: "run", command: `echo step-${n}` } },
        ...(need.length > 0 ? { need } : {}),
      };
    };
    await runAgent(
      { propose, workspace, maxTurns: 120, noProgress: 10_000, held: limits },
      { request: { id: "r1", text: "ab" } },
    );
    return workingSetStats(
      shownViews.map((shown, index) => ({ shown, requested: requests[index] ?? [] })),
    );
  }

  it("a TTL past the cross-level request gap removes churn without blowing the caps", async () => {
    const mid = await runGapPattern({ turns: 2 });
    const long = await runGapPattern({ turns: 8 });
    const adaptive = await runGapPattern({ turns: 2, adaptive: true, turnsMax: 12 });

    // A short TTL churns (the rotating request outlives it); a long TTL does not
    // (only the one-off recall of each cross-level id remains).
    expect(mid.reacquiredTotal).toBeGreaterThan(long.reacquiredTotal);
    expect(adaptive.reacquiredTotal).toBeLessThanOrEqual(mid.reacquiredTotal);

    for (const stats of [mid, long, adaptive]) {
      expect(stats.peakCount).toBeLessThanOrEqual(5);
      expect(stats.peakChars).toBeLessThanOrEqual(2 * 8000);
    }
  });
});
