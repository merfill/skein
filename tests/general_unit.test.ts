import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Event } from "../src/ir/events";
import { childrenOf, fold, planOf, stopOf } from "../src/ir/graph";
import { runSessionTurn, type SessionTurnDeps } from "../src/session/driver";
import { attentionOf, createSession } from "../src/session/session";
import { sessionOutline } from "../src/session/session_outline";
import { memoryTelemetry } from "../src/session/telemetry";
import type { Proposals } from "../src/llm/schemas";
import { buildTuiView } from "../src/tui/view_model";
import { fsWorkspace } from "../src/tools/workspace";

const dirs: string[] = [];

function workspace(): ReturnType<typeof fsWorkspace> {
  const root = mkdtempSync(join(tmpdir(), "skein-general-"));
  dirs.push(root);
  writeFileSync(join(root, "NOTES.md"), "alpha\nbeta\n");
  return fsWorkspace(root);
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function generalProposer() {
  let index = 0;
  return async (): Promise<Proposals> => {
    index += 1;
    if (index === 1) {
      return {
        thought: "",
        actions: [{ operator: "apply", action: { tool: "read", path: "NOTES.md" } }],
        usage: { inputTokens: 100, outputTokens: 10 },
        model: "m",
      };
    }
    return {
      thought: "",
      actions: [{ operator: "stop", why: "## Answer\n\nNOTES.md contains alpha and beta." }],
      usage: { inputTokens: 50, outputTokens: 20 },
      model: "m",
    };
  };
}

function deps(): SessionTurnDeps {
  return {
    sessionAgent: {
      agent: async () => ({ operation: { kind: "general", text: "analyse NOTES.md" } }),
      tools: {} as never,
    },
    task: {
      propose: async () => ({ actions: [] }),
      workspace: {} as never,
      maxTurns: 4,
    },
    general: {
      propose: generalProposer(),
      workspace: workspace(),
      maxTurns: 4,
    },
    telemetry: undefined,
  } as unknown as SessionTurnDeps;
}

describe("general unit", () => {
  it("runs one general state, records the plan and closes with stop", async () => {
    const session = createSession();
    const telemetry = memoryTelemetry();
    const source = deps();
    const runDeps: SessionTurnDeps = {
      ...source,
      general: {
        ...source.general!,
        telemetry: telemetry.sink,
      },
      telemetry: telemetry.sink,
    };
    const result = await runSessionTurn(runDeps, session, "analyse NOTES.md");

    expect(result.general?.unitId).toBe("g1");
    expect(result.general?.result.done).toBe(true);
    expect(result.general?.result.stopReason).toBe("answered");
    expect(attentionOf(session, "g1")).toBe("completed");

    const unit = session.units.get("g1");
    expect(unit?.type).toBe("general");
    const state = fold(unit?.journal ?? []);
    const move = childrenOf(state, state.rootId ?? "").find(
      (id) => state.nodes.get(id)?.kind === "move",
    );
    expect(move).toBeDefined();
    const plan = planOf(state, move as string);
    expect(plan).toBeDefined();
    expect(childrenOf(state, plan as string)).toHaveLength(1);
    expect(stopOf(state, move as string)).toBeDefined();

    const outline = sessionOutline(session);
    expect(outline).toContain('general g1 "analyse NOTES.md"');
    expect(outline).toContain('actions: read NOTES.md');
    expect(outline).toContain('answer: "## Answer');

    const view = buildTuiView(session, telemetry.events);
    expect(view.current?.unitId).toBe("g1");
    expect(view.current?.states).toHaveLength(1);
    expect(view.current?.states[0]?.island).toBe("general");
    expect(view.current?.states[0]?.turns).toBe(2);
    expect(view.header.totalTasks).toBe(1);
    expect(view.header.tokensIn).toBe(150);
  });

  it("keeps the general unit out of coding-task-specific helpers", async () => {
    const session = createSession();
    const journal: Event[] = [
      {
        type: "add_node",
        node: {
          id: "g9",
          space: "work",
          kind: "request",
          label: "q",
          payload: { text: "q" },
          seq: 0,
        },
      },
      {
        type: "add_node",
        node: {
          id: "g9:general",
          space: "work",
          kind: "move",
          label: "General",
          payload: { state: "general", what: "q", turn: 0 },
          seq: 1,
        },
      },
      {
        type: "add_edge",
        edge: {
          id: "e:g9",
          from: "g9",
          to: "g9:general",
          kind: "move",
          provenance: { kind: "llm" },
        },
      },
    ];
    session.units.set("g9", { id: "g9", type: "general", journal, turn: 0 });
    expect(attentionOf(session, "g9")).toBe("suspended");
  });
});
