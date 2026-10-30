import { afterEach, describe, expect, it } from "vitest";

import type { Proposals } from "../src/llm/schemas";
import { runAgent } from "../src/loop/graph";
import { cleanupWorkspaces, makeWorkspace, move, run } from "./ops/helpers";

afterEach(cleanupWorkspaces);

function proposer(island: "orientation" | "patch") {
  let turn = 0;
  return async (): Promise<Proposals> => {
    turn += 1;
    return {
      thought: "",
      actions: [turn === 1 ? move(island, "work") : run("echo a")],
    };
  };
}

describe("budget grace", () => {
  it("extends the budget once in a near-end state", async () => {
    const workspace = makeWorkspace().ws;
    const result = await runAgent(
      { propose: proposer("patch"), workspace, maxTurns: 1, graceTurns: 5 },
      { request: { id: "r1", text: "patch it" } },
    );
    expect(result.stopReason).toBe("max_turns");
    expect(result.turns).toBe(6);
  });

  it("does not extend in a far-from-end state", async () => {
    const workspace = makeWorkspace().ws;
    const result = await runAgent(
      { propose: proposer("orientation"), workspace, maxTurns: 1, graceTurns: 5 },
      { request: { id: "r1", text: "look" } },
    );
    expect(result.stopReason).toBe("max_turns");
    expect(result.turns).toBe(1);
  });
});
