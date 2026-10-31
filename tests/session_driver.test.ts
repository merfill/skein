import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";

import type { Context } from "../src/ir/project";
import type { Proposals } from "../src/llm/schemas";
import type { Proposer } from "../src/loop/propose";
import { runSessionTurn, type SessionTurnDeps } from "../src/session/driver";
import {
  attentionOf,
  createSession,
  sessionFocus,
} from "../src/session/session";
import type {
  SessionAgent,
  SessionReportInput,
  SessionTools,
} from "../src/session/session_agent";
import { sessionOutline } from "../src/session/session_outline";
import type { SessionOperation } from "../src/session/types";
import { cleanupWorkspaces, makeWorkspace, move } from "./ops/helpers";

afterEach(cleanupWorkspaces);

const tools: SessionTools = {
  unit: (_session, id) => `UNIT ${id}`,
};

// A task that moves straight to the terminal state and stops: enough to exercise the driver
// without touching the workspace.
const proposer: Proposer = async (context: Context): Promise<Proposals> => {
  if (context.situation === "request") {
    return { thought: "", actions: [move("end", "finish")] };
  }
  return { thought: "", actions: [{ operator: "stop", why: "done" }] };
};

function deps(operations: SessionOperation[]): SessionTurnDeps {
  return {
    sessionAgent: {
      agent: (() => {
        let index = 0;
        return async () => ({ operation: operations[index++] });
      })() as SessionAgent,
      tools,
    },
    task: { propose: proposer, workspace: makeWorkspace().ws, maxTurns: 6 },
  };
}

describe("session driver: one utterance turn", () => {
  it("starts a task, runs it, and keeps the final stop in the unit journal", async () => {
    const session = createSession();
    const result = await runSessionTurn(
      deps([{ kind: "start", text: "fix the build" }]),
      session,
      "fix the build",
    );

    expect(result.operation).toEqual({ kind: "start", text: "fix the build" });
    expect(result.task?.unitId).toBe("r1");
    expect(result.task?.result.done).toBe(true);
    expect(result.task?.result.stopReason).toBe("request_addressed");
    expect(session.utteranceSeq).toBe(1);
    expect(attentionOf(session, "r1")).toBe("completed");
    expect(
      session.units.get("r1")?.journal.some(
        (event) => event.type === "add_node" && event.node.kind === "stop",
      ),
    ).toBe(true);
  });

  it("starts a second task and leaves the first as a trace", async () => {
    const session = createSession();
    const turnDeps = deps([
      { kind: "start", text: "first task" },
      { kind: "start", text: "second task" },
    ]);
    await runSessionTurn(turnDeps, session, "first task");
    const second = await runSessionTurn(turnDeps, session, "second task");

    expect(second.task?.unitId).toBe("r2");
    expect(session.utteranceSeq).toBe(2);
    expect(attentionOf(session, "r1")).toBe("completed");
    expect(attentionOf(session, "r2")).toBe("completed");
    expect(sessionFocus(session)?.unitId).toBe("r2");
  });

  it("asks the session agent for a Markdown report after the task", async () => {
    const session = createSession();
    const inputs: SessionReportInput[] = [];
    const turnDeps: SessionTurnDeps = {
      sessionAgent: {
        agent: async () => ({ operation: { kind: "start", text: "fix the build" } }),
        tools,
        report: async (input) => {
          inputs.push(input);
          return "## Done\n\n- task `r1` finished.";
        },
      },
      task: { propose: proposer, workspace: makeWorkspace().ws, maxTurns: 6 },
    };

    const result = await runSessionTurn(turnDeps, session, "fix it");

    expect(result.report).toBe("## Done\n\n- task `r1` finished.");
    expect(inputs[0]?.utterance).toBe("fix it");
    expect(inputs[0]?.request).toBe("fix the build");
    expect(inputs[0]?.trace).toContain("outcome: request_addressed");
    expect(inputs[0]?.trace).toContain("unit r1 (task)");
    expect(
      session.journal.some((event) => event.type === "report" && event.text.includes("## Done")),
    ).toBe(true);
    expect(sessionOutline(session)).toContain('report: "## Done');
  });

  it("answers without starting a task", async () => {
    const session = createSession();
    const result = await runSessionTurn(
      deps([{ kind: "respond", text: "hello" }]),
      session,
      "hello",
    );

    expect(result.reply).toBe("hello");
    expect(result.task).toBeUndefined();
    expect(session.utteranceSeq).toBe(1);
    expect([...session.units.values()].some((unit) => unit.type === "task")).toBe(false);
  });

  it("carries a confirmation answer into the next L0 trace, then starts the task", async () => {
    const session = createSession();
    const seen: ModelMessage[][] = [];
    const agent: SessionAgent = async (messages) => {
      seen.push(messages);
      return seen.length === 1
        ? { operation: { kind: "respond", text: "I understood: fix the build. Start?" } }
        : { operation: { kind: "start", text: "fix the build" } };
    };
    const turnDeps: SessionTurnDeps = {
      sessionAgent: { agent, tools },
      task: { propose: proposer, workspace: makeWorkspace().ws, maxTurns: 6 },
    };

    await runSessionTurn(turnDeps, session, "fix the build");
    const second = await runSessionTurn(turnDeps, session, "yes");

    expect(second.task?.unitId).toBe("r1");
    const l0 = seen[1]?.find((message) => message.role === "system" && typeof message.content === "string" && message.content.startsWith("Earlier tasks:"));
    expect(l0).toBeDefined();
    if (l0 !== undefined && typeof l0.content === "string") {
      expect(l0.content).toContain("I understood: fix the build. Start?");
    }
  });

  it("keeps the task isolated: it sees only the reformulated request", async () => {
    const session = createSession();
    let taskContext: Context | undefined;
    const isolated: Proposer = async (context) => {
      taskContext = context;
      return proposer(context);
    };
    const turnDeps: SessionTurnDeps = {
      sessionAgent: {
        agent: async () => ({ operation: { kind: "start", text: "fix the parser in parser.c" } }),
        tools,
      },
      task: { propose: isolated, workspace: makeWorkspace().ws, maxTurns: 6 },
    };

    await runSessionTurn(turnDeps, session, "fix it");

    expect(JSON.stringify(taskContext)).not.toContain("Earlier tasks");
    const request = taskContext?.history[0];
    expect(request?.role).toBe("user");
    expect(request?.text).toContain("fix the parser in parser.c");
  });
});
