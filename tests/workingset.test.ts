import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Context } from "../src/ir/project";
import type { Proposal } from "../src/llm/schemas";
import { runAgent } from "../src/loop/graph";
import { fsWorkspace } from "../src/tools/workspace";

// Under a long horizon the context is the tape: it grows with the tree (each command is an
// assistant/tool pair) and is monotone while a goal is open. The old bounded working set
// (cap/TTL) is gone — the only reduction is the cut when a goal closes (docs/ir_revision.md §5).

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

    const propose = async (context: Context): Promise<Proposal> => {
      lengths.push(context.history.length);
      call += 1;
      const n = call;
      if (n === 1) {
        return {
          thought: "",
          action: { operator: "create_goal", what: "green", command: "true" },
        };
      }
      return { thought: "", action: { operator: "apply", action: { tool: "run", command: `echo step${n}` } } };
    };

    await runAgent(
      { propose, workspace, maxTurns: 40, noProgress: 1000 },
      { request: { id: "r1", text: "grow" } },
    );

    expect(lengths.length).toBeGreaterThan(30);
    // Each command appends an assistant call and a tool result.
    for (let i = 2; i < lengths.length; i += 1) {
      expect(lengths[i]).toBe((lengths[i - 1] ?? 0) + 2);
    }
  }, 30_000);

  it("collapses a closed sub-goal to a single closure message", async () => {
    const workspace = tinyWorkspace();
    const contexts: Context[] = [];
    let call = 0;

    const propose = async (context: Context): Promise<Proposal> => {
      contexts.push(context);
      call += 1;
      if (call === 1) {
        // Interpret the request; the first command fails, leaving the item unfulfilled.
        return {
          thought: "",
          action: { operator: "create_goal", what: "A", command: "false" },
        };
      }
      if (call === 2) {
        // Decompose A's current item into a sub-goal G.
        return {
          thought: "",
          action: { operator: "create_goal", what: "G", command: "true" },
        };
      }
      if (call === 3) {
        return { thought: "", action: { operator: "stop", why: "G is done" } };
      }
      return { thought: "", action: { operator: "apply", action: { tool: "run", command: `echo step${call}` } } };
    };

    await runAgent(
      { propose, workspace, maxTurns: 6, noProgress: 1000 },
      { request: { id: "r1", text: "collapse" } },
    );

    // After G closes, its create_goal message leaves the tape; only the closure remains.
    const last = contexts.at(-1);
    const texts = last?.history.map((message) => message.text).join("\n") ?? "";
    expect(texts).toContain("stopped: G is done");
    expect(texts).not.toContain("what: G");
  }, 30_000);
});
