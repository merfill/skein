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

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "skein-tools-"));
  roots.push(root);
  return root;
}

function tempWorkspace() {
  return fsWorkspace(tempRoot());
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

  it("honours the configured run timeout", () => {
    const workspace = fsWorkspace(tempRoot(), { runTimeoutMs: 50 });
    const result = workspace.run("sleep 2");
    expect(result.timedOut).toBe(true);
  });

  it("reports the crash signal instead of a bare exit code", () => {
    const workspace = tempWorkspace();
    const result = workspace.run("kill -SEGV $$");
    expect(result.signal).toBe("SIGSEGV");
  });
});

describe("workspace background jobs", () => {
  async function waitDone(
    workspace: ReturnType<typeof fsWorkspace>,
    id: string,
    timeoutMs = 3000,
  ) {
    const started = Date.now();
    for (;;) {
      const job = workspace.pollJob(id);
      if (job === undefined) throw new Error("unknown job");
      if (job.state === "done") return job;
      if (Date.now() - started > timeoutMs) throw new Error("job did not finish");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it("starts a command and polls it to completion", async () => {
    const workspace = tempWorkspace();
    const handle = workspace.startJob("echo hello; echo boom 1>&2");
    expect(handle.id).toBe("job-1");
    const result = await waitDone(workspace, handle.id);
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain("hello");
    expect(result.stderr).toContain("boom");
  });

  it("reports a non-zero exit and rejects an unknown job", async () => {
    const workspace = tempWorkspace();
    const handle = workspace.startJob("exit 7");
    const result = await waitDone(workspace, handle.id);
    expect(result.exitCode).toBe(7);
    expect(workspace.pollJob("nope")).toBeUndefined();
  });

  // A short command finishes during `startJob`'s right to a grace period, so it costs the
  // start turn, not a poll (docs/tools.md §4.7).
  it("completes a short command in the start turn", () => {
    const workspace = fsWorkspace(tempRoot(), { jobGraceMs: 2000 });
    const handle = workspace.startJob("echo quick");
    const job = workspace.pollJob(handle.id, { waitMs: 0 });
    expect(job?.state).toBe("done");
    expect(job?.exitCode).toBe(0);
    expect(job?.stdout).toContain("quick");
  });

  // A poll waits for the job, so a backgrounded command is answered in one poll rather
  // than one turn per retry.
  it("waits on a poll until the job finishes", () => {
    const workspace = fsWorkspace(tempRoot(), { jobGraceMs: 0 });
    const handle = workspace.startJob("sleep 0.3; exit 7");
    expect(workspace.pollJob(handle.id, { waitMs: 0 })?.state).toBe("running");
    const done = workspace.pollJob(handle.id);
    expect(done?.state).toBe("done");
    expect(done?.exitCode).toBe(7);
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
    const proposal = { thought: "t", action: { operator: "query" as const, id: "o2" } };
    expect(classify(proposal, state).accept).toBe(true);
  });
});
