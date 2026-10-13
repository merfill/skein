import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Context } from "../src/ir/project";
import type { Proposals } from "../src/llm/schemas";
import { runAgent } from "../src/loop/graph";
import { fsWorkspace } from "../src/tools/workspace";

// Under a long horizon the context is the tape: it grows with the tree (each command is an
// assistant/tool pair) and is monotone while a state is open. The old bounded working set
// (cap/TTL) is gone — the only reduction is the cut when a state closes (docs/ir_revision.md §5).

const tempDirs: string[] = [];

function tinyWorkspace(): ReturnType<typeof fsWorkspace> {
  const root = mkdtempSync(join(tmpdir(), "skein-tape-"));
  tempDirs.push(root);
  for (let i = 0; i < 3; i += 1) writeFileSync(join(root, `f${i}.txt`), `body ${i}\n`);
  return fsWorkspace(root);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("the message tape under a long horizon", () => {
  it("grows by one assistant/tool pair per command and stays monotone", async () => {
    const workspace = tinyWorkspace();
    const lengths: number[] = [];
    let call = 0;

    const propose = async (context: Context): Promise<Proposals> => {
      lengths.push(context.history.length);
      call += 1;
      const n = call;
      if (n === 1) {
        return { thought: "", actions: [{ operator: "move", state: "reconnaissance", what: "grow" }] };
      }
      if (n === 2) {
        return { thought: "", actions: [{ operator: "apply", action: { tool: "bash", command: "true" } }] };
      }
      return { thought: "", actions: [{ operator: "apply", action: { tool: "bash", command: `echo step${n}` } }] };
    };

    await runAgent(
      { propose, workspace, maxTurns: 40, noProgress: 1000 },
      { request: { id: "r1", text: "grow" } },
    );

    expect(lengths.length).toBeGreaterThan(30);
    // Once the state is declared, each command appends an assistant call and a tool result.
    for (let i = 1; i < lengths.length; i += 1) {
      expect(lengths[i]).toBe((lengths[i - 1] ?? 0) + 2);
    }
  }, 30_000);

  it("collapses a finished state to one compaction line", async () => {
    const workspace = tinyWorkspace();
    const contexts: Context[] = [];
    let call = 0;

    const propose = async (context: Context): Promise<Proposals> => {
      contexts.push(context);
      call += 1;
      if (call === 1) return { thought: "", actions: [{ operator: "move", state: "reconnaissance", what: "A" }] };
      if (call === 2) {
        // The first command fails, leaving the item unfulfilled; the criterion is declared met
        // anyway and the state is stopped by the doxa (no criterion gate).
        return { thought: "", actions: [{ operator: "apply", action: { tool: "bash", command: "echo FIRSTCMD" } }] };
      }
      if (call === 3) return { thought: "", actions: [{ operator: "stop", why: "A is done" }] };
      if (call === 4) return { thought: "", actions: [{ operator: "move", state: "localization", what: "B" }] };
      if (call === 5) return { thought: "", actions: [{ operator: "apply", action: { tool: "bash", command: "true" } }] };
      if (call === 6) return { thought: "", actions: [{ operator: "stop", why: "B is done" }] };
      if (call === 7) return { thought: "", actions: [{ operator: "move", state: "handoff", what: "" }] };
      return { thought: "", actions: [{ operator: "stop", why: "done" }] };
    };

    await runAgent(
      { propose, workspace, maxTurns: 10, noProgress: 1000 },
      { request: { id: "r1", text: "collapse" } },
    );

    // After the state closes, its plan turns leave the tape; only its compaction
    // line, carried by the move that left it, remains.
    const last = contexts.at(-1);
    const texts = last?.history.map((message) => message.text).join("\n") ?? "";
    expect(texts).toContain("State Reconnaissance: finished — A is done");
    expect(texts).not.toContain("FIRSTCMD");
  }, 30_000);
});
