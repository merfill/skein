import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { fold } from "../src/ir/graph";
import { classify } from "../src/loop/classify";
import { executeAction, resolveBody } from "../src/tools";
import { fsWorkspace } from "../src/tools/workspace";

// stdout and stderr are separate streams: a failed run's error must never be glued onto
// stdout nor dropped (docs/tools.md §4.3, docs/projection.md §3.1).

const roots: string[] = [];

function tempWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "skein-tools-"));
  roots.push(root);
  return fsWorkspace(root);
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe("workspace.run: separate streams", () => {
  it("captures stderr on success instead of dropping it", () => {
    const workspace = tempWorkspace();
    const result = workspace.run("echo out; echo err 1>&2");
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
  });

  it("keeps both streams and the exit code on failure", () => {
    const workspace = tempWorkspace();
    const result = workspace.run("echo partial; echo boom 1>&2; exit 2");
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("partial");
    expect(result.stderr).toContain("boom");
  });
});

describe("resolveBody", () => {
  const state = fold([
    {
      type: "add_node",
      node: {
        id: "o1",
        space: "work",
        kind: "observation",
        label: "run make",
        seq: 0,
        payload: {
          command: "make",
          verdict: "fail",
          output: "inline-out",
          outputRef: ".skein/observations/o1.out.txt",
          error: "inline-err",
          errorRef: ".skein/observations/o1.err.txt",
        },
      },
    },
  ]);

  it("returns the inline (bounded) body for the working set", () => {
    const workspace = tempWorkspace();
    workspace.write(".skein/observations/o1.out.txt", "FULL-STDOUT");
    workspace.write(".skein/observations/o1.err.txt", "FULL-STDERR");
    expect(resolveBody(state, "o1", workspace)).toEqual({ output: "inline-out", error: "inline-err" });
  });

  it("reads the full body behind the ref for query", () => {
    const workspace = tempWorkspace();
    workspace.write(".skein/observations/o1.out.txt", "FULL-STDOUT");
    workspace.write(".skein/observations/o1.err.txt", "FULL-STDERR");
    expect(resolveBody(state, "o1", workspace, true)).toEqual({
      output: "FULL-STDOUT",
      error: "FULL-STDERR",
    });
  });

  it("returns undefined for a node with no body", () => {
    const noBody = fold([
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "g", seq: 0 } },
    ]);
    expect(resolveBody(noBody, "g1", tempWorkspace())).toBeUndefined();
  });

  it("query returns stdout and stderr separately and reachable by id", () => {
    const workspace = tempWorkspace();
    workspace.write(".skein/observations/o1.out.txt", "STDOUT-BODY");
    workspace.write(".skein/observations/o1.err.txt", "STDERR-BODY");
    const outcome = executeAction({ operator: "query", id: "o1" }, state, workspace, 0);
    const json = JSON.parse(outcome.turn.text) as { output: string; error?: string };
    expect(json.output).toContain("STDOUT-BODY");
    expect(json.error).toContain("STDERR-BODY");
  });

  it("treats an error-only run result as a retrievable body", () => {
    const state = fold([
      {
        type: "add_node",
        node: {
          id: "o2",
          space: "work",
          kind: "observation",
          label: "run make",
          seq: 0,
          payload: { command: "make", verdict: "fail", error: "boom" },
        },
      },
    ]);
    const proposal = { thought: "t", action: { operator: "query" as const, id: "o2" }, need: ["o2"] };
    expect(classify(proposal, state).accept).toBe(true);
  });
});
