import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";

import type { Context } from "../src/ir/project";
import type { Proposals } from "../src/llm/schemas";
import type { Proposer } from "../src/loop/propose";
import {
  executePlan,
  runSessionTurn,
  type SessionTurnDeps,
} from "../src/session/driver";
import {
  latestPlan,
  planFinished,
  planItemStatus,
  planModeOf,
  planOfSession,
  plansInOrder,
} from "../src/session/plan";
import type { PlannerAgent, PlannerDraft, PlannerReply } from "../src/session/planner";
import { runPlanner } from "../src/session/planner";
import { createSession, unitOf } from "../src/session/session";
import type { SessionAgent } from "../src/session/session_agent";
import { sessionOutline } from "../src/session/session_outline";
import { runRepl } from "../src/session/repl";
import type { SessionOperation } from "../src/session/types";
import { cleanupWorkspaces, makeWorkspace, move } from "./ops/helpers";

afterEach(cleanupWorkspaces);


const taskProposer: Proposer = async (context: Context): Promise<Proposals> => {
  if (context.situation === "request") {
    return { thought: "", actions: [move("research", "finish")] };
  }
  if (context.situation === "transition") {
    return { thought: "", actions: [move("end", "finish")] };
  }
  return {
    thought: "",
    actions: [
      { operator: "stop", why: context.island === "end" ? "done" : "nothing to do" },
    ],
  };
};

function operations(items: SessionOperation[]): SessionAgent {
  let index = 0;
  return async () => ({ operation: items[index++] });
}

function plannerFor(
  draft: PlannerDraft,
  before: { name: string; args: Record<string, unknown> }[] = [],
) {
  let index = 0;
  return {
    agent: async (): Promise<PlannerReply> => {
      const call = before[index];
      if (call !== undefined) {
        index += 1;
        return {
          calls: [{ ...call, callId: `planner:${index}` }],
          thought: "",
        };
      }
      return {
        calls: [
          {
            name: "submit_plan",
            args: { ...draft },
            callId: "planner:submit",
          },
        ],
        thought: "",
      };
    },
  };
}

describe("execution plan", () => {
  it("records the plan in its unit and executes the items as ordinary units", async () => {
    const { ws } = makeWorkspace();
    const draft: PlannerDraft = {
      summary: "Two-step plan",
      items: [
        { title: "Fix the bug", detail: "Fix the bug in the source." },
        { title: "Report", detail: "Report what was fixed." },
      ],
    };
    const deps: SessionTurnDeps = {
      sessionAgent: {
        agent: operations([
          { kind: "plan", text: "plan the work" },
          { kind: "task", text: "fix the bug" },
          { kind: "general", text: "report on the fix" },
        ]),
      },
      task: { propose: taskProposer, workspace: ws, maxTurns: 6 },
      general: {
        propose: async () => ({ thought: "All conditions hold.\nVERDICT: PASS", actions: [] }),
        workspace: ws,
        maxTurns: 4,
      },
      planner: { ...plannerFor(draft), workspace: ws, maxTurns: 4 },
    };
    const session = createSession();

    const planned = await runSessionTurn(deps, session, "do it in steps");
    expect(planned.plan?.unitId).toBe("p1");
    expect(planned.plan?.result.plan?.items).toHaveLength(2);
    expect(planOfSession(session, "p1")?.items.map((item) => item.title)).toEqual([
      "Fix the bug",
      "Report",
    ]);

    const run = await executePlan(deps, session, "p1");
    expect(run.status).toBe("done");
    expect(run.completed).toBe(2);
    expect(run.total).toBe(2);
    expect(run.units.map((unit) => unit.kind)).toEqual(["task", "general"]);
    expect(run.units[0]?.unitId).toBe("r1");
    expect(run.units[1]?.unitId).toBe("g1");
    expect(planItemStatus(session, "p1:plan:body:item:1")).toBe("completed");
    expect(planItemStatus(session, "p1:plan:body:item:2")).toBe("completed");
    expect(planFinished(session, "p1")).toEqual({ status: "done", completed: 2, total: 2 });
    expect(planModeOf(session)).toBeUndefined();
    expect(sessionOutline(session)).toContain("plan p1: done (2/2)");
  });

  it("stops the plan when an item's unit is abandoned", async () => {
    const { ws } = makeWorkspace();
    const draft: PlannerDraft = {
      items: [{ title: "Fix it", detail: "Fix it." }],
    };
    const deps: SessionTurnDeps = {
      sessionAgent: {
        agent: operations([
          { kind: "plan", text: "plan the work" },
          { kind: "task", text: "fix it" },
        ]),
      },
      // No proposal: the unit ends `no_decision`, which the driver records as abandoned.
      task: {
        propose: async () => ({ thought: "", actions: [] }),
        workspace: ws,
        maxTurns: 6,
      },
      planner: { ...plannerFor(draft), workspace: ws, maxTurns: 4 },
    };
    const session = createSession();
    await runSessionTurn(deps, session, "plan then fail");

    const run = await executePlan(deps, session, "p1");
    expect(run.status).toBe("aborted");
    expect(run.completed).toBe(0);
    expect(planItemStatus(session, "p1:plan:body:item:1")).toBe("abandoned");
    expect(planFinished(session, "p1")).toEqual({ status: "aborted", completed: 0, total: 1 });
    expect(planModeOf(session)).toBeUndefined();
  });

  it("offers the plan menu and executes it from the REPL", async () => {
    const { ws } = makeWorkspace();
    const draft: PlannerDraft = {
      items: [{ title: "Fix it", detail: "Fix it." }],
    };
    const deps: SessionTurnDeps = {
      sessionAgent: {
        agent: operations([
          { kind: "plan", text: "plan" },
          { kind: "task", text: "fix it" },
        ]),
      },
      task: { propose: taskProposer, workspace: ws, maxTurns: 6 },
      planner: { ...plannerFor(draft), workspace: ws, maxTurns: 4 },
    };
    async function* lines(...values: string[]): AsyncGenerator<string> {
      for (const value of values) yield value;
    }
    const output: string[] = [];
    const session = createSession();

    await runRepl(lines("plan it", "e", "exit"), deps, (line) => output.push(line), session);

    expect(output.join("\n")).toContain("plan ready: [e]xecute");
    expect(output.join("\n")).toContain("plan p1: done (1/1)");
    expect(output.join("\n")).toContain("item p1:plan:body:item:1: task r1");
  });

  it("keeps the first plan untouched when a rework opens a new plan unit", async () => {
    const { ws } = makeWorkspace();
    const firstDraft: PlannerDraft = {
      items: [{ title: "First plan item", detail: "Do the first thing." }],
    };
    const secondDraft: PlannerDraft = {
      items: [
        { title: "Revised A", detail: "Do A." },
        { title: "Revised B", detail: "Do B." },
      ],
    };
    const session = createSession();
    const base = {
      sessionAgent: {
        agent: operations([
          { kind: "plan", text: "plan it" },
          { kind: "plan", text: "rework the plan" },
        ]),
      },
      task: { propose: taskProposer, workspace: ws, maxTurns: 6 },
      general: {
        propose: async () => ({ thought: "ANSWER", actions: [] }),
        workspace: ws,
        maxTurns: 4,
      },
    } satisfies SessionTurnDeps;
    await runSessionTurn(
      { ...base, planner: { ...plannerFor(firstDraft), workspace: ws, maxTurns: 4 } },
      session,
      "plan it",
    );
    await runSessionTurn(
      { ...base, planner: { ...plannerFor(secondDraft), workspace: ws, maxTurns: 4 } },
      session,
      "rework the plan",
    );

    const plans = plansInOrder(session);
    expect(plans.map((plan) => plan.planUnitId)).toEqual(["p1", "p2"]);
    expect(plans[0]?.items.map((item) => item.title)).toEqual(["First plan item"]);
    expect(plans[1]?.items.map((item) => item.title)).toEqual(["Revised A", "Revised B"]);
    expect(latestPlan(session)?.planUnitId).toBe("p2");
  });

  it("shows the active plan to the session agent on each item interpretation", async () => {
    const { ws } = makeWorkspace();
    const draft: PlannerDraft = {
      items: [{ title: "Fix it", detail: "Fix it." }],
    };
    const seen: string[] = [];
    let first = true;
    const sessionAgent: SessionAgent = async (messages) => {
      if (first) {
        first = false;
        return { operation: { kind: "plan", text: "plan it" } };
      }
      for (const message of messages) {
        if (message.role === "system" && message.content.includes("Execution plan")) {
          seen.push(message.content);
        }
      }
      return { operation: { kind: "task", text: "fix it" } };
    };
    const deps: SessionTurnDeps = {
      sessionAgent: { agent: sessionAgent },
      task: { propose: taskProposer, workspace: ws, maxTurns: 6 },
      planner: { ...plannerFor(draft), workspace: ws, maxTurns: 4 },
    };
    const session = createSession();
    const planned = await runSessionTurn(deps, session, "plan it");
    expect(planned.plan?.unitId).toBeDefined();
    await executePlan(deps, session, planned.plan!.unitId);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.join("\n")).toContain("[ ] 1. Fix it");
    expect(seen.join("\n")).toContain("Next item: 1. Fix it");
  });

  it("forces a final submit_plan when the planner hits its turn cap", async () => {
    const { ws } = makeWorkspace({ "a.txt": "hello\n" });
    let calls = 0;
    const agent: PlannerAgent = async (_messages, options) => {
      if (options?.final === true) {
        return {
          calls: [
            {
              name: "submit_plan",
              args: { items: [{ title: "From the cap", detail: "Do it." }] },
              callId: "final",
            },
          ],
          thought: "",
        };
      }
      calls += 1;
      return { calls: [{ name: "list", args: {}, callId: `list:${calls}` }], thought: "" };
    };
    const deps: SessionTurnDeps = {
      sessionAgent: {
        agent: operations([{ kind: "plan", text: "plan it" }]),
      },
      task: { propose: taskProposer, workspace: ws, maxTurns: 6 },
      planner: { agent, workspace: ws, maxTurns: 2 },
    };
    const session = createSession();

    const result = await runSessionTurn(deps, session, "plan it");
    expect(calls).toBe(2);
    expect(result.plan?.result.plan?.items[0]?.title).toBe("From the cap");
    expect(result.plan?.result.stopReason).toBe("planned");
  });

  it("gives a plan item's general unit the larger plan budget", async () => {
    const { ws } = makeWorkspace({ "a.txt": "hello\n" });
    const draft: PlannerDraft = {
      items: [{ title: "Investigate", detail: "Investigate it." }],
    };
    let calls = 0;
    const generalPropose = async (): Promise<Proposals> => {
      calls += 1;
      if (calls >= 4) return { thought: "ANSWER", actions: [] };
      return {
        thought: "",
        actions: [{ operator: "apply", action: { tool: "list", from: calls } }],
      };
    };
    const deps: SessionTurnDeps = {
      sessionAgent: {
        agent: operations([
          { kind: "plan", text: "plan it" },
          { kind: "general", text: "investigate" },
        ]),
      },
      task: { propose: taskProposer, workspace: ws, maxTurns: 6 },
      // The base general budget would stop after one turn; the plan item must get more.
      general: { propose: generalPropose, workspace: ws, maxTurns: 1 },
      planGeneralMaxTurns: 4,
      planner: { ...plannerFor(draft), workspace: ws, maxTurns: 4 },
    };
    const session = createSession();
    const planned = await runSessionTurn(deps, session, "plan it");
    const run = await executePlan(deps, session, planned.plan!.unitId);

    expect(run.status).toBe("done");
    expect(run.units[0]?.kind).toBe("general");
    expect(run.units[0]?.result.turns).toBeGreaterThan(1);
    expect(calls).toBeGreaterThanOrEqual(4);
  });

  it("does not truncate a large read result in the planner history", async () => {
    const { ws } = makeWorkspace({ "big.txt": `${"x".repeat(5000)}\nEND-MARKER\n` });
    let captured: ModelMessage[] = [];
    const agent: PlannerAgent = async (messages) => {
      captured = messages;
      const hasTool = messages.some((message) => message.role === "tool");
      if (!hasTool) {
        return {
          calls: [{ name: "read", args: { filePath: "big.txt" }, callId: "read:1" }],
          thought: "",
        };
      }
      return {
        calls: [
          {
            name: "submit_plan",
            args: { items: [{ title: "T", detail: "D" }] },
            callId: "plan:1",
          },
        ],
        thought: "",
      };
    };

    const result = await runPlanner(
      { agent, workspace: ws, maxTurns: 4 },
      { request: { id: "p1", text: "plan it" } },
    );

    expect(result.plan?.items).toHaveLength(1);
    const tool = captured.find((message) => message.role === "tool");
    const text = JSON.stringify(tool);
    // The old 2k cap cut the body; the tool's own bound (~8K) keeps this one whole.
    expect(text).toContain("END-MARKER");
    expect(text).not.toContain("[truncated]");
  });

  it("closes the plan done when the last item completes, with no separate acceptance pass", async () => {
    const { ws } = makeWorkspace();
    const draft: PlannerDraft = {
      summary: "Add a solver",
      items: [
        { title: "Implement", detail: "Implement the solver.", done: "solver.py exists" },
      ],
    };
    const deps: SessionTurnDeps = {
      sessionAgent: {
        agent: operations([
          { kind: "plan", text: "plan it" },
          { kind: "task", text: "implement it" },
        ]),
      },
      task: { propose: taskProposer, workspace: ws, maxTurns: 6 },
      planner: { ...plannerFor(draft), workspace: ws, maxTurns: 4 },
    };
    const session = createSession();
    const planned = await runSessionTurn(deps, session, "plan it");

    const run = await executePlan(deps, session, planned.plan!.unitId);

    expect(run.status).toBe("done");
    expect(planFinished(session, "p1")).toEqual({ status: "done", completed: 1, total: 1 });
    // The plan closes on the last item's own result: no acceptance unit is opened.
    expect([...session.units.values()].filter((unit) => unit.type === "general")).toHaveLength(0);
  });

  it("refuses an off-surface call in the planner and never mutates the workspace", async () => {
    const { ws, root } = makeWorkspace({}, { checkpoints: true });
    const draft: PlannerDraft = {
      items: [{ title: "Build", detail: "Build it." }],
    };
    const deps: SessionTurnDeps = {
      sessionAgent: {
        agent: operations([{ kind: "plan", text: "plan" }]),
      },
      task: { propose: taskProposer, workspace: ws, maxTurns: 6 },
      planner: {
        // The planner's surface has no `shell`/`bash`/`edit`; the loop must not execute it.
        ...plannerFor(draft, [{ name: "shell", args: { command: "mkdir leaked" } }]),
        workspace: ws,
        maxTurns: 4,
      },
    };
    const session = createSession();

    const result = await runSessionTurn(deps, session, "plan only");
    expect(result.plan?.result.plan?.items).toHaveLength(1);
    expect(existsSync(join(root, "leaked"))).toBe(false);
  });
});
