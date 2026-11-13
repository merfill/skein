import { afterEach, describe, expect, it } from "vitest";

import type { Context } from "../src/ir/project";
import type { Proposals } from "../src/llm/schemas";
import type { Proposer } from "../src/loop/propose";
import {
  executePlan,
  resumeTurn,
  runSessionTurn,
  type SessionTurnDeps,
} from "../src/session/driver";
import type { PlannerReply } from "../src/session/planner";
import { runRepl } from "../src/session/repl";
import { attentionOf, createSession } from "../src/session/session";
import type { SessionAgent } from "../src/session/session_agent";
import { cleanupWorkspaces, makeWorkspace, move, run } from "./ops/helpers";

afterEach(cleanupWorkspaces);


const sessionAgent: SessionAgent = async () => ({
  operation: { kind: "task", text: "do the work" },
});

// A far-from-end state, so the cap is reached without the near-end grace window.
function busy(): Proposer {
  let turn = 0;
  return async (context: Context): Promise<Proposals> => {
    if (context.situation === "terminal") {
      return { thought: "# Report\n\nStopped at the turn budget.", actions: [] };
    }
    turn += 1;
    return {
      thought: "",
      actions: [turn === 1 ? move("verification", "work") : run("echo a")],
    };
  };
}

function deps(propose: Proposer, maxTurns: number): SessionTurnDeps {
  return {
    sessionAgent: { agent: sessionAgent },
    task: { propose, workspace: makeWorkspace().ws, maxTurns },
    budgetExtend: 3,
  };
}

describe("budget pause", () => {
  it("pauses at the task's turn cap instead of ending it", async () => {
    const session = createSession();
    const d = deps(busy(), 2);

    const result = await runSessionTurn(d, session, "work");

    expect(result.paused?.budget).toBe(2);
    expect(result.task?.result.paused).toBe(true);
    expect(result.task?.result.stopReason).toBe("budget");
    expect(attentionOf(session, "r1")).not.toBe("abandoned");
  });

  it("continues with more turns and pauses again at the new cap", async () => {
    const session = createSession();
    const d = deps(busy(), 2);
    const first = await runSessionTurn(d, session, "work");
    expect(first.paused?.budget).toBe(2);

    const second = await resumeTurn(d, session, first.paused!, { budgetAction: "continue" });

    expect(second.paused?.budget).toBe(5);
  });

  it("finishes with a report instead of abandoning the unit", async () => {
    const session = createSession();
    const d = deps(busy(), 2);
    const first = await runSessionTurn(d, session, "work");

    const finished = await resumeTurn(d, session, first.paused!, { budgetAction: "finish" });

    expect(finished.paused).toBeUndefined();
    expect(finished.task?.result.done).toBe(true);
    expect(finished.task?.result.stopReason).toBe("max_turns");
    expect(attentionOf(session, "r1")).toBe("completed");
    const stops = finished.task!.result.events.filter(
      (event) => event.type === "add_node" && event.node.kind === "stop",
    );
    expect(stops.some((event) => event.type === "add_node" && event.node.label.includes("Stopped at the turn budget"))).toBe(true);
  });

  it("offers the budget menu in the REPL and continues, then finishes", async () => {
    const session = createSession();
    const d = deps(busy(), 2);
    async function* lines(...values: string[]): AsyncGenerator<string> {
      for (const value of values) yield value;
    }
    const output: string[] = [];

    await runRepl(lines("work", "c", "f"), d, (line) => output.push(line), session);

    expect(output.join("\n")).toContain("turn limit (2) reached");
    expect(output.join("\n")).toContain("[c]ontinue +3");
    expect(output.join("\n")).toContain("turn limit (5) reached");
  });

  it("keeps a plan resumable after its item hits the cap", async () => {
    const { ws } = makeWorkspace();
    let first = true;
    const agent: SessionAgent = async () => {
      if (first) {
        first = false;
        return { operation: { kind: "plan", text: "plan it" } };
      }
      return { operation: { kind: "task", text: "do it" } };
    };
    const planner = {
      agent: async (): Promise<PlannerReply> => ({
        calls: [
          {
            name: "submit_plan",
            args: { items: [{ title: "Do it", detail: "Do it." }] },
            callId: "planner:submit",
          },
        ],
        thought: "",
      }),
      workspace: ws,
      maxTurns: 4,
    };
    const d: SessionTurnDeps = {
      sessionAgent: { agent },
      task: { propose: busy(), workspace: ws, maxTurns: 2 },
      planner,
      budgetExtend: 3,
    };
    const session = createSession();
    const planned = await runSessionTurn(d, session, "plan it");
    expect(planned.plan?.unitId).toBe("p1");

    const paused = await executePlan(d, session, "p1");
    expect(paused.status).toBe("paused");
    expect(paused.paused?.budget).toBe(2);
    expect(paused.paused?.planUnitId).toBe("p1");

    const finished = await resumeTurn(d, session, paused.paused!, { budgetAction: "finish" });
    expect(finished.paused).toBeUndefined();

    const done = await executePlan(d, session, "p1");
    expect(done.status).toBe("done");
    expect(done.completed).toBe(1);
  });
});
