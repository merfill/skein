import { afterEach, describe, expect, it } from "vitest";

import type { Context } from "../src/ir/project";
import type { Proposals } from "../src/llm/schemas";
import type { Proposer } from "../src/loop/propose";
import { runSessionTurn, type SessionTurnDeps } from "../src/session/driver";
import { createSession } from "../src/session/session";
import type { SessionAgent } from "../src/session/session_agent";
import { renderTurn } from "../src/session/view";
import { cleanupWorkspaces, makeWorkspace, move } from "./ops/helpers";

afterEach(cleanupWorkspaces);


const proposer: Proposer = async (context: Context): Promise<Proposals> => {
  if (context.situation === "request") {
    return { thought: "", actions: [move("research", "finish")] };
  }
  if (context.situation === "transition") {
    return { thought: "", actions: [move("end", "finish")] };
  }
  return { thought: "", actions: [{ operator: "stop", why: context.island === "end" ? "done" : "nothing to do" }] };
};

function unreachable(): SessionTurnDeps["task"] {
  return {
    propose: async () => ({ thought: "", actions: [{ operator: "decline" }] }),
    workspace: makeWorkspace().ws,
    maxTurns: 1,
  };
}

describe("session view", () => {
  it("shows why a turn ended without a decision", async () => {
    const result = await runSessionTurn(
      { sessionAgent: { agent: async () => ({}) }, task: unreachable() },
      createSession(),
      "hi",
    );
    expect(result.noDecision).toBe("empty_reply");
    expect(renderTurn(result)).toContain("session: no decision (empty reply)");
  });

  it("shows the task work and End's report instead of the raw stop", async () => {
    const result = await runSessionTurn(
      {
        sessionAgent: {
          agent: async () => ({ operation: { kind: "task", text: "fix it" } }),
        },
        task: { propose: proposer, workspace: makeWorkspace().ws, maxTurns: 6 },
      },
      createSession(),
      "fix it",
    );
    const lines = renderTurn(result);
    const text = lines.join("\n");

    expect(text).toContain("task r1: request_addressed after 4 turns");
    expect(text).toContain("move: end");
    expect(text).toContain("stop: done");
    expect(lines).toContain("task answer: done");
  });
});
