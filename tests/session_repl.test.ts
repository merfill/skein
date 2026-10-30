import { afterEach, describe, expect, it } from "vitest";

import type { Context } from "../src/ir/project";
import type { Proposals } from "../src/llm/schemas";
import type { Proposer } from "../src/loop/propose";
import type { SessionTurnDeps } from "../src/session/driver";
import { runRepl } from "../src/session/repl";
import { createSession } from "../src/session/session";
import type { SessionAgent, SessionTools } from "../src/session/session_agent";
import type { SessionOperation } from "../src/session/types";
import { cleanupWorkspaces, makeWorkspace, move } from "./ops/helpers";

afterEach(cleanupWorkspaces);

const tools: SessionTools = { unit: (_session, id) => `UNIT ${id}` };

const proposer: Proposer = async (context: Context): Promise<Proposals> => {
  if (context.situation === "request") {
    return { thought: "", actions: [move("end", "finish")] };
  }
  return { thought: "", actions: [{ operator: "stop", why: "done" }] };
};

function agentFor(operations: SessionOperation[]): SessionAgent {
  let index = 0;
  return async () => ({ operation: operations[index++] });
}

function deps(operations: SessionOperation[]): SessionTurnDeps {
  return {
    sessionAgent: { agent: agentFor(operations), tools },
    task: { propose: proposer, workspace: makeWorkspace().ws, maxTurns: 6 },
  };
}

async function* lines(...values: string[]): AsyncGenerator<string> {
  for (const value of values) yield value;
}

describe("session REPL", () => {
  it("answers, starts a task, and stops on exit", async () => {
    const session = createSession();
    const output: string[] = [];
    await runRepl(
      lines("hello", "fix it", "exit"),
      deps([
        { kind: "respond", text: "hi" },
        { kind: "start", text: "fix it" },
      ]),
      (line) => output.push(line),
      session,
    );

    expect(output).toContain("session: respond");
    expect(output).toContain("answer: hi");
    expect(output).toContain('session: start("fix it")');
    expect(output).toContain("task r1: request_addressed after 2 turns");
    expect(session.utteranceSeq).toBe(2);
    expect(session.units.has("r1")).toBe(true);
  });
});
