import { describe, expect, it } from "vitest";

import type { Event } from "../src/ir/events";
import type { EdgeKind, NodeKind } from "../src/ir/types";
import { createSession, openUnit } from "../src/session/session";
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
    node("p1", "plan", "plan"),
    edge("m1", "p1", "plan"),
    node("i1", "item", "item"),
    edge("p1", "i1", "items"),
    node("a1", "action", "read src/driver.ts", { command: "read src/driver.ts", turn: 0 }),
    edge("i1", "a1", "alts"),
    node("o1", "observation", "ok", { output: "ok" }),
    edge("a1", "o1", "result"),
    node("s1", "stop", "target named"),
    edge("m1", "s1", "stop"),
    node("m2", "move", "fix", { state: "patch", what: "apply the change", turn: 3 }),
    edge("r1", "m2", "move"),
    node("p2", "plan", "plan 2"),
    edge("m2", "p2", "plan"),
    node("i2", "item", "item 2"),
    edge("p2", "i2", "items"),
    node("a2", "action", "edit src/driver.ts", { command: "edit src/driver.ts", turn: 3 }),
    edge("i2", "a2", "alts"),
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
      usage: { inputTokens: 100, outputTokens: 10, reasoningTokens: 3 },
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
      usage: { inputTokens: 200, outputTokens: 20 },
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
      closed: false,
      current: true,
    });
    expect(patch?.actions.map((action) => action.label)).toEqual(["edit src/driver.ts"]);
    expect(view.current?.outcome).toBe("open at patch");
    expect(view.current?.elapsedMs).toBe(6_000);
    expect(view.history[0]?.unitId).toBe("r1");
  });

  it("keeps tasks out of the history when they are not task units", () => {
    const session = createSession();
    openUnit(session, "reading:1", "reading", [node("reading:1", "request", "README.md")], 0);
    const view = buildTuiView(session, []);
    expect(view.header.totalTasks).toBe(0);
    expect(view.history).toHaveLength(0);
    expect(view.current).toBeUndefined();
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
