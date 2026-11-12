import { describe, expect, it } from "vitest";

import type { Event } from "../src/ir/events";
import type { EdgeKind, NodeKind } from "../src/ir/types";
import { createSession, openUnit, pushUnit, recordPlanStarted } from "../src/session/session";
import type { MetricEvent } from "../src/session/telemetry";
import { buildTuiView } from "../src/tui/view_model";

function node(
  id: string,
  kind: NodeKind,
  label: string,
  payload?: unknown,
): Event {
  return {
    type: "add_node",
    node: { id, space: kind === "file" ? "artifact" : "work", kind, label, payload, seq: 0 },
  };
}

function edge(from: string, to: string, kind: EdgeKind): Event {
  return {
    type: "add_edge",
    edge: { id: `e:${from}:${kind}:${to}`, from, to, kind, provenance: { kind: "llm" } },
  };
}

function taskJournal(): Event[] {
  return [
    node("r1", "request", "fix the report", { text: "fix the report" }),
    node("m1", "move", "find", { state: "localization", what: "find the target", turn: 0 }),
    edge("r1", "m1", "move"),
    node("p1", "turns", "turns"),
    edge("m1", "p1", "turns"),
    node("a1", "action", "read src/driver.ts", { command: "read src/driver.ts", turn: 0 }),
    edge("p1", "a1", "turn"),
    node("o1", "observation", "ok", { output: "ok" }),
    edge("a1", "o1", "result"),
    node("s1", "stop", "target named"),
    edge("m1", "s1", "stop"),
    node("m2", "move", "fix", { state: "patch", what: "apply the change", turn: 3 }),
    edge("r1", "m2", "move"),
    node("p2", "turns", "turns 2"),
    edge("m2", "p2", "turns"),
    node("a2", "action", "edit src/driver.ts", { command: "edit src/driver.ts", turn: 3 }),
    edge("p2", "a2", "turn"),
    node("o2", "observation", "written", { output: "written" }),
    edge("a2", "o2", "result"),
  ];
}

function telemetry(): MetricEvent[] {
  return [
    {
      type: "model_call",
      sessionId: "local",
      agent: "task",
      unitId: "r1",
      turn: 0,
      model: "m",
      startedAt: 0,
      endedAt: 1,
      status: "ok",
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        reasoningTokens: 3,
        cachedInputTokens: 40,
      },
    },
    {
      type: "model_call",
      sessionId: "local",
      agent: "task",
      unitId: "r1",
      turn: 3,
      model: "m",
      startedAt: 2,
      endedAt: 3,
      status: "ok",
      usage: { inputTokens: 200, outputTokens: 20, cachedInputTokens: 150 },
    },
    {
      type: "tool_call",
      sessionId: "local",
      agent: "task",
      unitId: "r1",
      turn: 0,
      tool: "read src/driver.ts",
      startedAt: 0,
      endedAt: 1,
      status: "ok",
    },
  ];
}

describe("TUI view model", () => {
  it("builds states, turns, tokens and the current task", () => {
    const session = createSession();
    openUnit(session, "r1", "task", taskJournal(), 6);
    const view = buildTuiView(session, telemetry(), {
      now: 10_000,
      timings: new Map([["r1", { startedAt: 1_000, endedAt: 7_000 }]]),
    });

    expect(view.header.totalTasks).toBe(1);
    expect(view.header.totalTurns).toBe(6);
    expect(view.header.tokensIn).toBe(300);
    expect(view.header.tokensOut).toBe(30);
    expect(view.header.reasoningTokens).toBe(3);
    expect(view.header.cachedInputTokens).toBe(190);
    expect(view.header.sessionContextTokens).toBe(0);
    expect(view.current?.unitId).toBe("r1");
    expect(view.current?.request).toBe("fix the report");
    expect(view.current?.states).toHaveLength(2);

    const [localization, patch] = view.current?.states ?? [];
    expect(localization).toMatchObject({
      island: "localization",
      startTurn: 0,
      endTurn: 2,
      turns: 3,
      tokensIn: 100,
      tokensOut: 10,
      reasoningTokens: 3,
      cachedInputTokens: 40,
      contextTokens: 100,
      toolCalls: 1,
      closed: true,
      stopWhy: "target named",
    });
    expect(patch).toMatchObject({
      island: "patch",
      startTurn: 3,
      endTurn: 5,
      turns: 3,
      tokensIn: 200,
      tokensOut: 20,
      reasoningTokens: 0,
      cachedInputTokens: 150,
      contextTokens: 200,
      closed: false,
      current: true,
    });
    expect(patch?.actions.map((action) => action.label)).toEqual(["edit src/driver.ts"]);
    expect(localization?.turnDetails).toEqual([
      { turn: 0, tokensIn: 100, tokensOut: 10, durationMs: 1 },
      { turn: 1, tokensIn: 0, tokensOut: 0, durationMs: 0 },
      { turn: 2, tokensIn: 0, tokensOut: 0, durationMs: 0 },
    ]);
    expect(localization?.durationMs).toBe(1);
    expect(patch?.turnDetails[0]).toEqual({
      turn: 3,
      tokensIn: 200,
      tokensOut: 20,
      durationMs: 1,
    });
    expect(view.current?.contextTokens).toBe(200);
    expect((view.current?.tokensOut ?? 0) + (view.current?.reasoningTokens ?? 0)).toBe(33);
    expect(patch?.durationMs).toBe(1);
    expect(view.current?.outcome).toBe("open at patch");
    expect(view.current?.elapsedMs).toBe(6_000);
    expect(view.history[0]?.unitId).toBe("r1");
  });

  it("keeps tasks out of the history when they are not task units", () => {
    const session = createSession();
    openUnit(session, "m1", "session", [node("m1", "request", "README.md")], 0);
    const view = buildTuiView(session, []);
    expect(view.header.totalTasks).toBe(0);
    expect(view.history).toHaveLength(0);
    expect(view.current).toBeUndefined();
  });
});

function planJournal(): Event[] {
  return [
    node("rp", "request", "plan z3", { text: "plan z3" }),
    node("mp", "move", "Plan", { state: "plan", what: "plan z3", turn: 0 }),
    edge("rp", "mp", "move"),
    node("body", "plan", "Add Z3", { summary: "Add Z3" }),
    edge("mp", "body", "plan"),
    node("i1", "plan_item", "Deps", {
      title: "Deps",
      detail: "Add z3-solver",
      order: 1,
      done: "z3 imports",
    }),
    edge("body", "i1", "plan_item"),
    node("i2", "plan_item", "Adapter", {
      title: "Adapter",
      detail: "Wrap z3",
      order: 2,
    }),
    edge("body", "i2", "plan_item"),
    node("sp", "stop", "plan submitted", { why: "plan submitted", turn: 0 }),
    edge("mp", "sp", "stop"),
  ];
}

describe("TUI plan view", () => {
  it("shows a ready plan and hides the stale task", () => {
    const session = createSession();
    openUnit(session, "g1", "task", taskJournal(), 6);
    openUnit(session, "p1", "plan", planJournal(), 0);

    const view = buildTuiView(session, [], { planUnitId: "p1" });

    expect(view.plan).toMatchObject({
      unitId: "p1",
      status: "ready",
      completed: 0,
      total: 2,
      activeItemId: "i1",
    });
    expect(view.plan?.summary).toBe("Add Z3");
    expect(view.plan?.items.map((item) => item.title)).toEqual(["Deps", "Adapter"]);
    // The plan owns the panel: no unit belongs to it yet, so the old task is not "current".
    expect(view.current).toBeUndefined();
  });

  it("shows the building plan before submit_plan", () => {
    const session = createSession();
    openUnit(
      session,
      "p1",
      "plan",
      [
        node("rp", "request", "plan z3", { text: "plan z3" }),
        node("mp", "move", "Plan", { state: "plan", what: "plan z3", turn: 0 }),
        edge("rp", "mp", "move"),
      ],
      0,
    );
    pushUnit(session, "p1", 0);

    const view = buildTuiView(session, []);

    expect(view.plan?.status).toBe("building");
    expect(view.current).toBeUndefined();
  });

  it("tracks the executing item and shows its task", () => {
    const session = createSession();
    openUnit(session, "p1", "plan", planJournal(), 0);
    openUnit(session, "r1", "task", taskJournal(), 6, "i1");
    recordPlanStarted(session, "p1", 0);

    const view = buildTuiView(session, [], { planUnitId: "p1" });

    expect(view.plan).toMatchObject({
      status: "executing",
      activeItemId: "i1",
      completed: 0,
      total: 2,
    });
    expect(view.plan?.items[0]?.status).toBe("suspended");
    expect(view.current?.unitId).toBe("r1");
  });
});

describe("TUI header usage", () => {
  it("counts session-agent usage even when no task has run", () => {
    const session = createSession();
    const view = buildTuiView(session, [
      {
        type: "model_call",
        sessionId: "local",
        agent: "session",
        unitId: "session:1",
        turn: 0,
        model: "m",
        startedAt: 0,
        endedAt: 1,
        status: "ok",
        usage: { inputTokens: 1200, outputTokens: 300 },
      },
    ]);
    expect(view.header.totalTasks).toBe(0);
    expect(view.header.modelCalls).toBe(1);
    expect(view.header.sessionContextTokens).toBe(1200);
    expect(view.header.tokensIn).toBe(1200);
    expect(view.header.tokensOut).toBe(300);
  });
});
