import { afterEach, describe, expect, it } from "vitest";

import type { Proposals } from "../src/llm/schemas";
import { runAgent } from "../src/loop/graph";
import { cleanupWorkspaces, makeWorkspace, move, run } from "./ops/helpers";

afterEach(cleanupWorkspaces);

function proposer(island: "patch" | "verification") {
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
  it("extends the budget once in a near-end state, then pauses", async () => {
    const workspace = makeWorkspace().ws;
    const result = await runAgent(
      { propose: proposer("patch"), workspace, maxTurns: 1, graceTurns: 5 },
      { request: { id: "r1", text: "patch it" }, budgetPause: true },
    );
    expect(result.paused).toBe(true);
    expect(result.stopReason).toBe("budget");
    expect(result.turns).toBe(6);
  });

  it("pauses at the cap in a far-from-end state", async () => {
    const workspace = makeWorkspace().ws;
    const result = await runAgent(
      { propose: proposer("verification"), workspace, maxTurns: 1, graceTurns: 5 },
      { request: { id: "r1", text: "look" }, budgetPause: true },
    );
    expect(result.paused).toBe(true);
    expect(result.stopReason).toBe("budget");
    expect(result.turns).toBe(1);
  });
});
