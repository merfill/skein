import { afterEach, describe, expect, it } from "vitest";

import type { Context } from "../src/ir/project";
import type { Proposals } from "../src/llm/schemas";
import type { Proposer } from "../src/loop/propose";
import { runSessionTurn, type SessionTurnDeps } from "../src/session/driver";
import { createSession } from "../src/session/session";
import type { SessionAgent, SessionTools } from "../src/session/session_agent";
import { renderTurn } from "../src/session/view";
import { cleanupWorkspaces, makeWorkspace, move } from "./ops/helpers";

afterEach(cleanupWorkspaces);

const tools: SessionTools = { unit: (_session, id) => `UNIT ${id}` };

const proposer: Proposer = async (context: Context): Promise<Proposals> =>
  context.situation === "request"
    ? { thought: "", actions: [move("end", "finish")] }
    : { thought: "", actions: [{ operator: "stop", why: "done" }] };

function unreachable(): SessionTurnDeps["task"] {
  return {
    propose: async () => ({ thought: "", actions: [{ operator: "decline" }] }),
    workspace: makeWorkspace().ws,
    maxTurns: 1,
  };
}

describe("session view", () => {
  it("shows tool calls and results, then the Markdown answer", async () => {
    const session = createSession();
    let calls = 0;
    const agent: SessionAgent = async () => {
      calls += 1;
      return calls === 1
        ? {
            toolCalls: [{ name: "unit", args: { id: "r1" }, callId: "c1" }],
            reasoning: "look at r1",
          }
        : { operation: { kind: "respond", text: "## Answer\n\ntext" } };
    };

    const result = await runSessionTurn(
      { sessionAgent: { agent, tools }, task: unreachable() },
      session,
      "hi",
    );
    const lines = renderTurn(result);

    expect(lines).toContain('  call: unit({"id":"r1"})');
    expect(lines).toContain("  result: UNIT r1");
    expect(lines).toContain("session: respond");
    expect(lines).toContain("answer:");
    expect(lines).toContain("## Answer\n\ntext");
    expect(lines.join("\n")).not.toContain("Thought:");

    const verbose = renderTurn(result, { verbose: true });
    expect(verbose).toContain("  Thought:");
    expect(verbose.join("\n")).toContain("look at r1");
  });

  it("previews a long tool result and expands it only with --verbose", async () => {
    const long = "x".repeat(700);
    const session = createSession();
    let calls = 0;
    const agent: SessionAgent = async () => {
      calls += 1;
      return calls === 1
        ? { toolCalls: [{ name: "unit", args: { id: "r1" }, callId: "c1" }] }
        : { operation: { kind: "respond", text: "ok" } };
    };
    const longTools: SessionTools = { unit: () => long };

    const result = await runSessionTurn(
      { sessionAgent: { agent, tools: longTools }, task: unreachable() },
      session,
      "hi",
    );
    const preview = renderTurn(result).join("\n");
    expect(preview).toContain("[truncated; use --verbose]");
    expect(preview).not.toContain(long);

    expect(renderTurn(result, { verbose: true }).join("\n")).toContain(long);
  });

  it("shows why a turn ended without a decision", async () => {
    const result = await runSessionTurn(
      { sessionAgent: { agent: async () => ({}), tools }, task: unreachable() },
      createSession(),
      "hi",
    );
    expect(result.noDecision).toBe("empty_reply");
    expect(renderTurn(result)).toContain("session: no decision (empty reply)");
  });

  it("shows the task work and the post-task report instead of the raw stop", async () => {
    const result = await runSessionTurn(
      {
        sessionAgent: {
          agent: async () => ({ operation: { kind: "start", text: "fix it" } }),
          tools,
          report: async () => "## Report\n\n- done",
        },
        task: { propose: proposer, workspace: makeWorkspace().ws, maxTurns: 6 },
      },
      createSession(),
      "fix it",
    );
    const lines = renderTurn(result);
    const text = lines.join("\n");

    expect(text).toContain("task r1: request_addressed after 2 turns");
    expect(text).toContain("move: end");
    expect(text).toContain("stop: done");
    expect(lines).toContain("report:");
    expect(lines).toContain("## Report\n\n- done");
    expect(text).not.toContain("task answer:");
  });
});
