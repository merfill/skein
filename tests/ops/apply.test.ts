import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Event } from "../../src/ir/events";
import { currentVersion } from "../../src/ir/graph";
import type { Action } from "../../src/llm/schemas";
import { READ_LIMIT } from "../../src/tools";
import type { Workspace } from "../../src/tools/workspace";
import {
  DEFAULT_FILES,
  applyTool,
  cleanupWorkspaces,
  edit,
  exec,
  fetchUrl,
  grep,
  makeWorkspace,
  patch,
  recall,
  read,
  request,
  run,
  write,
} from "./helpers";

afterEach(cleanupWorkspaces);

// A command's non-execution is now an observation with a reason (docs/ir_revision.md §3.3,
// §4): run it and return the reason, or undefined when it executed.
function refusalText(action: Action, events: readonly Event[], ws: Workspace): string | undefined {
  const { state, outcome } = exec(action, events, ws);
  const node = outcome.turn.nodeId ? state.nodes.get(outcome.turn.nodeId) : undefined;
  const payload = node?.payload as { failed?: boolean; output?: string } | undefined;
  return payload?.failed === true ? (payload.output ?? outcome.turn.text) : undefined;
}

describe("apply: read", () => {
  it("OP-AP-READ-1 reads a file into an observation and records the observed version", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { state, outcome } = exec(read("src/sum.mjs"), [request()], ws);
    expect(outcome.turn.nodeId).toMatch(/^obs:/);
    expect(state.observed.get("file:src/sum.mjs")).toBeDefined();
    expect([...state.edges.values()].some((e) => e.kind === "result")).toBe(true);
  });

  it("OP-AP-READ-2 a different window is a new action", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const first = exec(read("src/sum.mjs"), [request()], ws);
    const second = exec(read("src/sum.mjs", 1, 1), first.events, ws);
    expect(second.events.filter((e) => e.type === "add_node" && e.node.kind === "observation")).toHaveLength(2);
  });

  it("OP-AP-READ-7 a read window is shown whole inline, its middle never dropped", () => {
    const lines = Array.from({ length: 120 }, (_, i) => `line ${i + 1} ${"x".repeat(40)}`);
    const { ws } = makeWorkspace({ "src/big.txt": `${lines.join("\n")}\n` });
    const first = exec(read("src/big.txt"), [request()], ws);
    const id = first.outcome.turn.nodeId as string;
    const payload = first.state.nodes.get(id)?.payload as { output?: string } | undefined;
    const body = payload?.output ?? "";
    expect(body).toContain("line 1 "); // head
    expect(body).toContain("line 60 "); // middle — the part a head+tail excerpt dropped
    expect(body).toContain("line 120 "); // tail
    expect(body).not.toContain("chars omitted"); // no silent middle cut
    // The requested window is still addressable by id.
    const recalled = exec(recall(id), first.events, ws);
    const json = JSON.parse(recalled.outcome.turn.text) as { output: string };
    expect(json.output).toContain("line 60 ");
  });

  it("OP-AP-READ-8 a window over the byte budget is bounded and continues via the trailer", () => {
    // ~160 KB in 2000 lines, well over READ_LIMIT (64 KB).
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i + 1} ${"x".repeat(70)}`);
    const { ws } = makeWorkspace({ "src/huge.txt": `${lines.join("\n")}\n` });
    const first = exec(read("src/huge.txt"), [request()], ws);
    const id = first.outcome.turn.nodeId as string;
    const payload = first.state.nodes.get(id)?.payload as
      | { output?: string; end?: number; total?: number }
      | undefined;
    const body = payload?.output ?? "";
    expect(body.length).toBeLessThanOrEqual(READ_LIMIT); // the read budget holds
    expect(body).toContain("line 1 "); // head shown
    expect(body).not.toContain("line 2000 "); // the far tail is not inlined
    expect(body).toMatch(/continue from \d+/); // a paging trailer, not a flood
    // The trailer's cursor addresses a real window.
    const next = (payload?.end ?? 0) + 1;
    const resumed = exec(read("src/huge.txt", next, next + 20), first.events, ws);
    expect(resumed.outcome.turn.text).toContain(`line ${next} `);
  });

  it("OP-AP-READ-6 reads many different windows of one file (there is no per-file cap)", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    const { ws } = makeWorkspace({ "src/big.txt": `${lines.join("\n")}\n` });
    const first = exec(read("src/big.txt", 1, 5), [request()], ws);
    const second = exec(read("src/big.txt", 6, 10), first.events, ws);
    const third = exec(read("src/big.txt", 11, 15), second.events, ws);
    // Distinct windows are distinct knowledge (no edit in between required).
    expect(
      third.events.filter((e) => e.type === "add_node" && e.node.kind === "observation"),
    ).toHaveLength(3);
    // Only an identical window (an unchanged world) is refused.
    expect(refusalText(read("src/big.txt", 11, 15), third.events, ws)).toMatch(/repeated_action/);
  });

  it("OP-AP-READ-3 a missing file is a fail observation, not a crash", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { outcome, state } = exec(read("src/nope.mjs"), [request()], ws);
    const obs = outcome.turn.nodeId ? state.nodes.get(outcome.turn.nodeId) : undefined;
    expect((obs?.payload as { failed?: boolean } | undefined)?.failed).toBe(true);
  });

  it("OP-AP-READ-4 / REF-REPEAT refuses an identical read with an unchanged world", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const first = exec(read("src/sum.mjs"), [request()], ws);
    expect(refusalText(read("src/sum.mjs"), first.events, ws)).toMatch(/repeated_action/);
  });

  it("OP-AP-READ-5 a path outside the workspace is a fail observation, not a crash", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { outcome, state } = exec(read("../outside.mjs"), [request()], ws);
    const obs = outcome.turn.nodeId ? state.nodes.get(outcome.turn.nodeId) : undefined;
    expect((obs?.payload as { failed?: boolean } | undefined)?.failed).toBe(true);
    expect(outcome.turn.text).toMatch(/escapes workspace/);
  });
});

describe("apply: grep", () => {
  it("OP-AP-GREP-1 scoped grep returns matches as an observation", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { outcome } = exec(grep("sum", "src"), [request()], ws);
    expect(outcome.turn.text).toContain("sum");
  });

  it("OP-AP-GREP-2 paging with from/count is a new action", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const page = applyTool({ tool: "grep", pattern: "sum", path: "src", count: 1 });
    const first = exec(page, [request()], ws);
    const next = applyTool({ tool: "grep", pattern: "sum", path: "src", count: 1, from: 2 });
    expect(refusalText(next, first.events, ws)).toBeUndefined();
  });

  it("OP-AP-GREP-3 a bad scope is a fail observation", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { outcome, state } = exec(grep("sum", "nope"), [request()], ws);
    const obs = outcome.turn.nodeId ? state.nodes.get(outcome.turn.nodeId) : undefined;
    expect((obs?.payload as { failed?: boolean } | undefined)?.failed).toBe(true);
  });

  it("OP-AP-GREP-4 / REF-REPEAT refuses an identical grep", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const first = exec(grep("sum", "src"), [request()], ws);
    expect(refusalText(grep("sum", "src"), first.events, ws)).toMatch(/repeated_action/);
  });

  it("OP-AP-GREP-5 a match window over the byte budget drops whole trailing results", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `needle ${i + 1} ${"y".repeat(120)}`);
    const { ws } = makeWorkspace({ "src/noisy.txt": `${lines.join("\n")}\n` });
    const { outcome, state } = exec(grep("needle", "src/noisy.txt"), [request()], ws);
    const id = outcome.turn.nodeId as string;
    const body = (state.nodes.get(id)?.payload as { output?: string } | undefined)?.output ?? "";
    expect(body.length).toBeLessThanOrEqual(8192); // the grep budget holds (not the read budget)
    const json = JSON.parse(body) as { total: number; returned: number; next?: number };
    expect(json.total).toBe(400);
    expect(json.returned).toBeLessThan(50); // the byte cap cuts below even the default count
    expect(json.next).toBeDefined();
  });

  it("OP-AP-GREP-6 default count is 50; a larger count is capped at 100", () => {
    const lines = Array.from({ length: 150 }, (_, i) => `needle ${i + 1}`);
    const { ws } = makeWorkspace({ a: `${lines.join("\n")}\n` });
    const first = exec(
      applyTool({ tool: "grep", pattern: "needle", path: "a", before: 0, after: 0 }),
      [request()],
      ws,
    );
    const firstBody = JSON.parse(first.outcome.turn.text) as { total: number; returned: number; next?: number };
    expect(firstBody.returned).toBe(50); // GREP_COUNT_DEFAULT
    expect(firstBody.total).toBe(150);
    expect(firstBody.next).toBeDefined();
    const big = exec(
      applyTool({ tool: "grep", pattern: "needle", path: "a", before: 0, after: 0, count: 1000 }),
      first.events,
      ws,
    );
    const bigBody = JSON.parse(big.outcome.turn.text) as { returned: number };
    expect(bigBody.returned).toBeGreaterThan(50); // the window grew past the default
    expect(bigBody.returned).toBeLessThanOrEqual(100); // but never past MAX_GREP_MATCHES
  });
});

describe("apply: list", () => {
  it("OP-AP-LIST-1 lists files as an observation", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { outcome } = exec(applyTool({ tool: "list" }), [request()], ws);
    expect(outcome.turn.text).toContain("src/sum.mjs");
  });

  it("OP-AP-LIST-2 paging reports a next cursor", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { outcome } = exec(applyTool({ tool: "list", limit: 1 }), [request()], ws);
    const body = JSON.parse(outcome.turn.text);
    expect(body.total).toBeGreaterThan(1);
    expect(body.next).toBeDefined();
  });

  it("OP-AP-LIST-3 a page over the byte budget drops whole trailing files", () => {
    const files: Record<string, string> = {};
    const name = "n".repeat(100);
    for (let i = 0; i < 300; i += 1) files[`src/${name}-${i}.txt`] = "x";
    const { ws } = makeWorkspace(files);
    const { outcome, state } = exec(applyTool({ tool: "list", path: "src" }), [request()], ws);
    const id = outcome.turn.nodeId as string;
    const body = (state.nodes.get(id)?.payload as { output?: string } | undefined)?.output ?? "";
    expect(body.length).toBeLessThanOrEqual(8192); // the list budget holds
    const json = JSON.parse(body) as { total: number; returned: number; next?: number };
    expect(json.total).toBe(300);
    expect(json.returned).toBeLessThan(100); // the byte cap cuts below the default page
    expect(json.next).toBeDefined();
  });

  it("OP-AP-LIST-4 default limit is 100; a larger limit is capped at 200", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 250; i += 1) files[`f${i}`] = "x";
    const { ws } = makeWorkspace(files);
    const first = exec(applyTool({ tool: "list" }), [request()], ws);
    const firstBody = JSON.parse(first.outcome.turn.text) as { total: number; returned: number; next?: number };
    expect(firstBody.returned).toBe(100); // LIST_LIMIT_DEFAULT
    expect(firstBody.total).toBe(250);
    expect(firstBody.next).toBeDefined();
    const big = exec(applyTool({ tool: "list", limit: 1000 }), first.events, ws);
    const bigBody = JSON.parse(big.outcome.turn.text) as { returned: number };
    expect(bigBody.returned).toBe(200); // MAX_LIST_FILES
  });
});

describe("apply: edit", () => {
  it("OP-AP-EDIT-1 replaces text, records a mutate, and bumps the file version", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const first = exec(read("src/sum.mjs"), [request()], ws);
    const before = currentVersion(first.state, "file:src/sum.mjs");
    const { events, state } = exec(edit("src/sum.mjs", "a - b", "a + b"), first.events, ws);
    expect(events.some((e) => e.type === "mutate")).toBe(true);
    expect(ws.read("src/sum.mjs")).toContain("a + b");
    expect(currentVersion(state, "file:src/sum.mjs")).not.toBe(before);
  });

  it("OP-AP-EDIT-2 a missing find materializes the file and fails, recording the attempt", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { events, outcome, state } = exec(edit("src/sum.mjs", "NOT PRESENT", "x"), [request()], ws);
    const obs = outcome.turn.nodeId ? state.nodes.get(outcome.turn.nodeId) : undefined;
    expect((obs?.payload as { failed?: boolean } | undefined)?.failed).toBe(true);
    const action = [...state.nodes.values()].find((n) => n.kind === "action");
    expect((action?.payload as { find?: string } | undefined)?.find).toBe("NOT PRESENT");
    expect(events.some((e) => e.type === "add_node" && e.node.kind === "observation")).toBe(true);
  });

  it("OP-AP-EDIT-3 / REF-EDIT-CONSTRAINT refuses a forbidden path", () => {
    const constraint: Event = {
      type: "add_node",
      node: { id: "c1", space: "work", kind: "constraint", label: "no src", payload: { forbid: ["src/"] }, seq: 1 },
    };
    const { ws } = makeWorkspace(DEFAULT_FILES);
    expect(refusalText(edit("src/sum.mjs", "a", "b"), [request(), constraint], ws)).toMatch(
      /constraint_violation/,
    );
  });

  it("OP-AP-EDIT-4 / REF-EDIT-STALE refuses editing on a stale read", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const first = exec(read("src/sum.mjs"), [request()], ws);
    // A successful edit mutates the file; the read is now stale.
    const mutated = exec(edit("src/sum.mjs", "a - b", "a + b"), first.events, ws);
    expect(refusalText(edit("src/sum.mjs", "a + b", "a - b"), mutated.events, ws)).toBe("stale_base");
  });

  it("OP-AP-EDIT-5 a path outside the workspace is a fail observation, not a crash", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { outcome, state } = exec(edit("../outside.mjs", "a", "b"), [request()], ws);
    const obs = outcome.turn.nodeId ? state.nodes.get(outcome.turn.nodeId) : undefined;
    expect((obs?.payload as { failed?: boolean } | undefined)?.failed).toBe(true);
    expect(outcome.turn.text).toMatch(/escapes workspace/);
  });
});

describe("apply: write", () => {
  it("OP-AP-WRITE-1 creates a new file and records a mutate with a version", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { events, state } = exec(write("src/extra.mjs", "export const x = 1;\n"), [request()], ws);
    expect(events.some((e) => e.type === "mutate")).toBe(true);
    expect(state.nodes.has("file:src/extra.mjs")).toBe(true);
    expect(ws.read("src/extra.mjs")).toContain("export const x = 1;");
    expect(currentVersion(state, "file:src/extra.mjs")).toBeDefined();
  });

  it("OP-AP-WRITE-2 overwrites after a fresh read and bumps the version", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const first = exec(read("src/sum.mjs"), [request()], ws);
    const before = currentVersion(first.state, "file:src/sum.mjs");
    const { events, state } = exec(write("src/sum.mjs", "export const y = 2;\n"), first.events, ws);
    expect(events.some((e) => e.type === "mutate")).toBe(true);
    expect(ws.read("src/sum.mjs")).toContain("export const y = 2;");
    expect(currentVersion(state, "file:src/sum.mjs")).not.toBe(before);
  });

  it("OP-AP-WRITE-3 / REF-WRITE-CONSTRAINT refuses a forbidden path", () => {
    const constraint: Event = {
      type: "add_node",
      node: { id: "c1", space: "work", kind: "constraint", label: "no src", payload: { forbid: ["src/"] }, seq: 1 },
    };
    const { ws } = makeWorkspace(DEFAULT_FILES);
    expect(refusalText(write("src/new.mjs", "x"), [request(), constraint], ws)).toMatch(
      /constraint_violation/,
    );
  });

  it("OP-AP-WRITE-4 / REF-WRITE-STALE refuses overwriting on a stale read", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const first = exec(read("src/sum.mjs"), [request()], ws);
    const mutated = exec(edit("src/sum.mjs", "a - b", "a + b"), first.events, ws);
    expect(refusalText(write("src/sum.mjs", "x"), mutated.events, ws)).toBe("stale_base");
  });

  it("OP-AP-WRITE-5 fails to overwrite a file that was never read, leaving it intact", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { outcome, state } = exec(write("src/sum.mjs", "x"), [request()], ws);
    const obs = outcome.turn.nodeId ? state.nodes.get(outcome.turn.nodeId) : undefined;
    expect((obs?.payload as { failed?: boolean } | undefined)?.failed).toBe(true);
    expect(ws.read("src/sum.mjs")).toContain("a - b");
  });

  it("OP-AP-WRITE-6 a path outside the workspace is a fail observation, not a crash", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { outcome, state } = exec(write("../outside.mjs", "x"), [request()], ws);
    const obs = outcome.turn.nodeId ? state.nodes.get(outcome.turn.nodeId) : undefined;
    expect((obs?.payload as { failed?: boolean } | undefined)?.failed).toBe(true);
    expect(outcome.turn.text).toMatch(/escapes workspace/);
  });
});

describe("apply: fetch", () => {
  // Offline: curl supports file:// URLs, so the download path is exercised without a
  // network or an in-process server (a server would deadlock a synchronous spawnSync).
  function withSource(content: string): { url: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "skein-ref-"));
    const file = join(dir, "upstream.mjs");
    writeFileSync(file, content);
    return { url: `file://${file}`, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("OP-AP-FETCH-1 fetches a URL into the workspace and records a mutate", () => {
    const src = withSource("export const ref = 1;\n");
    try {
      const { ws } = makeWorkspace(DEFAULT_FILES);
      const { events, state, outcome } = exec(fetchUrl(src.url), [request()], ws);
      expect(events.some((e) => e.type === "mutate")).toBe(true);
      expect(outcome.turn.text).toMatch(/fetched/);
      expect([...state.nodes.values()].some((n) => n.kind === "file")).toBe(true);
    } finally {
      src.cleanup();
    }
  });

  it("OP-AP-FETCH-2 a failed download is a fail observation", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { outcome, state } = exec(fetchUrl("file:///nonexistent/does-not-exist.mjs"), [request()], ws);
    const obs = outcome.turn.nodeId ? state.nodes.get(outcome.turn.nodeId) : undefined;
    expect((obs?.payload as { failed?: boolean } | undefined)?.failed).toBe(true);
    expect(outcome.turn.text).toMatch(/fetch failed/);
  });

  it("OP-AP-FETCH-3 a path outside the workspace is a fail observation", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { outcome, state } = exec(fetchUrl("http://127.0.0.1:1/x", "../outside.mjs"), [request()], ws);
    const obs = outcome.turn.nodeId ? state.nodes.get(outcome.turn.nodeId) : undefined;
    expect((obs?.payload as { failed?: boolean } | undefined)?.failed).toBe(true);
    expect(outcome.turn.text).toMatch(/escapes workspace/);
  });

  it("OP-AP-FETCH-3 / REF-FETCH-CONSTRAINT refuses a forbidden explicit target", () => {
    const constraint: Event = {
      type: "add_node",
      node: { id: "c1", space: "work", kind: "constraint", label: "no src", payload: { forbid: ["src/"] }, seq: 1 },
    };
    const { ws } = makeWorkspace(DEFAULT_FILES);
    expect(refusalText(fetchUrl("http://x/y", "src/ref.mjs"), [request(), constraint], ws)).toMatch(
      /constraint_violation/,
    );
  });
});

describe("apply: apply_patch", () => {
  const diff = [
    "--- a/src/sum.mjs",
    "+++ b/src/sum.mjs",
    "@@ -1,3 +1,3 @@",
    " export function sum(a, b) {",
    "-  return a - b;",
    "+  return a + b;",
    " }",
    "",
  ].join("\n");

  it("OP-AP-PATCH-1 applies a unified diff and records the changed file", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const before = ws.read("src/sum.mjs");
    const { events, state, outcome } = exec(patch(diff), [request()], ws);
    expect(events.some((e) => e.type === "mutate")).toBe(true);
    expect(outcome.turn.text).toMatch(/applied patch/);
    expect(ws.read("src/sum.mjs")).toContain("a + b");
    expect(ws.read("src/sum.mjs")).not.toBe(before);
    expect(state.nodes.has("file:src/sum.mjs")).toBe(true);
  });

  it("OP-AP-PATCH-2 a patch that does not apply is a fail observation", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const bad = ["--- a/src/sum.mjs", "+++ b/src/sum.mjs", "@@ -1 +1 @@", "-NOT PRESENT", "+x", ""].join("\n");
    const { outcome, state } = exec(patch(bad), [request()], ws);
    const obs = outcome.turn.nodeId ? state.nodes.get(outcome.turn.nodeId) : undefined;
    expect((obs?.payload as { failed?: boolean } | undefined)?.failed).toBe(true);
    expect(ws.read("src/sum.mjs")).toContain("a - b");
  });

  it("OP-AP-PATCH-2 / REF-PATCH-CONSTRAINT refuses a patch touching a forbidden path", () => {
    const constraint: Event = {
      type: "add_node",
      node: { id: "c1", space: "work", kind: "constraint", label: "no src", payload: { forbid: ["src/"] }, seq: 1 },
    };
    const { ws } = makeWorkspace(DEFAULT_FILES);
    expect(refusalText(patch(diff), [request(), constraint], ws)).toMatch(/constraint_violation/);
  });
});

describe("apply: run", () => {
  it("OP-AP-RUN-1 runs a plain foreground command and records its output", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { outcome } = exec(run("echo hello"), [request()], ws);
    expect(outcome.turn.text).toContain("hello");
  });

  it("OP-AP-RUN-1 / REF-REPEAT refuses an identical run", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const first = exec(run("echo hello"), [request()], ws);
    expect(refusalText(run("echo hello"), first.events, ws)).toMatch(/repeated_action/);
  });

  it("OP-AP-RUN-2 a large output keeps the tail inline and the full stream behind outputRef", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const first = exec(run("printf '%s\\n' {1..20000}"), [request()], ws);
    const id = first.outcome.turn.nodeId as string;
    const payload = first.state.nodes.get(id)?.payload as
      | { output?: string; outputRef?: string }
      | undefined;
    expect(payload?.outputRef).toBe(`.skein/observations/${id}.out.txt`);
    const body = payload?.output ?? "";
    expect(body).toContain("20000"); // the end of the output survives
    expect(body).not.toContain("1\n2\n3\n"); // the start is dropped
    expect(body).toContain("chars omitted; full output:"); // the omission note
    // `recall {id}` reads the full stream, head included.
    const recalled = exec(recall(id), first.events, ws);
    const json = JSON.parse(recalled.outcome.turn.text) as { output: string };
    expect(json.output.startsWith("1\n2\n3\n")).toBe(true);
  });

  it("REF-RUN-EMPTY rejects a run with no command", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    expect(refusalText(applyTool({ tool: "run" }), [request()], ws)).toMatch(/needs a command/);
  });
});
