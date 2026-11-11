import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelMessage } from "ai";

import { afterEach, describe, expect, it } from "vitest";

import type { Event } from "../src/ir/events";
import { childrenOf, fold, stopOf, turnsOf } from "../src/ir/graph";
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
  it("runs one general tape and closes with stop", async () => {
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
    const root = state.rootId ?? "";
    const turns = turnsOf(state, root);
    expect(turns).toBeDefined();
    expect(childrenOf(state, turns as string)).toHaveLength(1);
    expect(stopOf(state, root)).toBeDefined();

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

  it("closes on a text answer without a stop tool", async () => {
    const session = createSession();
    const ws = workspace();
    let calls = 0;
    const turnDeps: SessionTurnDeps = {
      sessionAgent: {
        agent: async () => ({ operation: { kind: "general", text: "analyse NOTES.md" } }),
        tools: {} as never,
      },
      task: { propose: async () => ({ thought: "", actions: [] }), workspace: ws, maxTurns: 2 },
      general: {
        propose: async (): Promise<Proposals> => {
          calls += 1;
          if (calls === 1) {
            return {
              thought: "",
              actions: [{ operator: "apply", action: { tool: "read", path: "NOTES.md" } }],
            };
          }
          return {
            thought: "## Answer\n\nNOTES.md contains alpha and beta.",
            actions: [],
          };
        },
        workspace: ws,
        maxTurns: 4,
      },
    };
    const result = await runSessionTurn(turnDeps, session, "analyse NOTES.md");

    expect(result.general?.result.done).toBe(true);
    expect(result.general?.result.stopReason).toBe("answered");
    expect(result.general?.result.turns).toBe(2);
    const stop = result.general?.result.events.find(
      (event) => event.type === "add_node" && event.node.kind === "stop",
    );
    expect(stop?.type === "add_node" ? stop.node.label : "").toBe(
      "## Answer\n\nNOTES.md contains alpha and beta.",
    );
  });

  it("writes a final report when the turn limit is reached", async () => {
    const session = createSession();
    const ws = workspace();
    let calls = 0;
    let finalMessages: ModelMessage[] = [];
    const turnDeps: SessionTurnDeps = {
      sessionAgent: {
        agent: async () => ({ operation: { kind: "general", text: "overview" } }),
        tools: {} as never,
      },
      task: { propose: async () => ({ thought: "", actions: [] }), workspace: ws, maxTurns: 2 },
      general: {
        propose: async (messages): Promise<Proposals> => {
          calls += 1;
          if (calls === 1) {
            return {
              thought: "",
              actions: [{ operator: "apply", action: { tool: "read", path: "NOTES.md" } }],
            };
          }
          if (calls === 2) {
            return {
              thought: "",
              actions: [{ operator: "apply", action: { tool: "bash", command: "ls" } }],
            };
          }
          finalMessages = messages;
          return { thought: "", actions: [{ operator: "stop", why: "## Final\n\nOverview." }] };
        },
        workspace: ws,
        maxTurns: 2,
      },
    };
    const result = await runSessionTurn(turnDeps, session, "overview");

    expect(result.general?.result.done).toBe(true);
    expect(result.general?.result.stopReason).toBe("answered");
    expect(result.general?.result.turns).toBe(3);
    const stop = result.general?.result.events.find(
      (event) => event.type === "add_node" && event.node.kind === "stop",
    );
    expect(stop?.type === "add_node" ? stop.node.label : "").toBe("## Final\n\nOverview.");
    expect(
      finalMessages.some(
        (message) =>
          message.role === "system" &&
          typeof message.content === "string" &&
          message.content.includes("turn limit is reached"),
      ),
    ).toBe(true);
  });

  it("keeps a read result whole in the rebuilt history", async () => {
    const session = createSession();
    const ws = workspace();
    ws.write("big.txt", `${"x".repeat(6000)}\nTAIL-MARKER\n`);
    let captured: ModelMessage[] = [];
    let calls = 0;
    const turnDeps: SessionTurnDeps = {
      sessionAgent: {
        agent: async () => ({ operation: { kind: "general", text: "read big" } }),
        tools: {} as never,
      },
      task: { propose: async () => ({ thought: "", actions: [] }), workspace: ws, maxTurns: 2 },
      general: {
        propose: async (messages): Promise<Proposals> => {
          calls += 1;
          if (calls === 1) {
            return {
              thought: "",
              actions: [{ operator: "apply", action: { tool: "read", path: "big.txt" } }],
            };
          }
          captured = messages;
          return { thought: "", actions: [{ operator: "stop", why: "done" }] };
        },
        workspace: ws,
        maxTurns: 3,
      },
    };
    await runSessionTurn(turnDeps, session, "read big");

    const toolMessage = captured.find((message) => message.role === "tool");
    const text = JSON.stringify(toolMessage);
    expect(text.length).toBeGreaterThan(6000);
    expect(text).not.toContain("recall obs:");
    expect(text).toContain("TAIL-MARKER");
  });

  it("keeps a command's tail and does not re-truncate the tool result", async () => {
    const session = createSession();
    const ws = workspace();
    // A command's output is bounded by its tail at the tool (INLINE_LIMIT); the general
    // history keeps that bounded body whole instead of capping it a second time.
    ws.write("big.txt", `${"x".repeat(20_000)}\nTAIL-MARKER\n`);
    let captured: ModelMessage[] = [];
    let calls = 0;
    const turnDeps: SessionTurnDeps = {
      sessionAgent: {
        agent: async () => ({ operation: { kind: "general", text: "cat big" } }),
        tools: {} as never,
      },
      task: { propose: async () => ({ thought: "", actions: [] }), workspace: ws, maxTurns: 2 },
      general: {
        propose: async (messages): Promise<Proposals> => {
          calls += 1;
          if (calls === 1) {
            return {
              thought: "",
              actions: [{ operator: "apply", action: { tool: "bash", command: "cat big.txt" } }],
            };
          }
          captured = messages;
          return { thought: "", actions: [{ operator: "stop", why: "done" }] };
        },
        workspace: ws,
        maxTurns: 3,
      },
    };
    await runSessionTurn(turnDeps, session, "cat big");

    const toolMessage = captured.find((message) => message.role === "tool");
    const text = JSON.stringify(toolMessage);
    // The old 2000-char cap would make this < 3000; the tool's own bound is ~8 KB.
    expect(text.length).toBeGreaterThan(3000);
    expect(text.length).toBeLessThan(9000);
    expect(text).toContain("full output:");
    expect(text).toContain("TAIL-MARKER");
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
    ];
    session.units.set("g9", { id: "g9", type: "general", journal, turn: 0 });
    expect(attentionOf(session, "g9")).toBe("suspended");
  });

  it("passes the deterministic project facts to the general agent", async () => {
    const session = createSession();
    const root = mkdtempSync(join(tmpdir(), "skein-general-"));
    dirs.push(root);
    const ws = fsWorkspace(root);
    writeFileSync(
      join(root, "AGENTS.md"),
      "# Project\n\ndocs/proofwriter.md — ProofWriter collection notes (eval harness).\n",
    );
    let messages: ModelMessage[] = [];
    const turnDeps: SessionTurnDeps = {
      sessionAgent: {
        agent: async () => ({ operation: { kind: "general", text: "look around" } }),
        tools: {} as never,
      },
      task: { propose: async () => ({ thought: "", actions: [] }), workspace: ws, maxTurns: 4 },
      general: {
        propose: async (input) => {
          messages = input;
          return { thought: "", actions: [{ operator: "stop", why: "## Done" }] };
        },
        workspace: ws,
        maxTurns: 4,
      },
      sessionProbe: () => ({
        material: {
          root,
          repos: [],
          entries: [{ name: "src", kind: "dir", files: 2 }],
          paths: [],
          files: 2,
        },
      }),
    };

    await runSessionTurn(turnDeps, session, "look around");

    const facts = String(messages[1]?.content);
    expect(facts).toContain("Project facts");
    expect(facts).toContain(`project directory: ${root}`);
    expect(facts).toContain("top-level entries: src/ (2 files)");
    expect(facts).toContain("Project instructions");
    expect(facts).toContain("ProofWriter collection notes (eval harness)");
  });

  it("restores a mutation made during the read-only general unit", async () => {
    const session = createSession();
    const root = mkdtempSync(join(tmpdir(), "skein-general-"));
    dirs.push(root);
    writeFileSync(join(root, "NOTES.md"), "alpha\n");
    const ws = fsWorkspace(root, { checkpoints: true });
    let turn = 0;
    const turnDeps: SessionTurnDeps = {
      sessionAgent: {
        agent: async () => ({ operation: { kind: "general", text: "inspect" } }),
        tools: {} as never,
      },
      task: { propose: async () => ({ thought: "", actions: [] }), workspace: ws, maxTurns: 4 },
      general: {
        propose: async () => {
          turn += 1;
          if (turn === 1) {
            return {
              thought: "",
              actions: [
                {
                  operator: "apply",
                  action: { tool: "bash", command: "printf hacked > NOTES.md" },
                },
              ],
            };
          }
          return { thought: "", actions: [{ operator: "stop", why: "## Done" }] };
        },
        workspace: ws,
        maxTurns: 4,
      },
    };

    await runSessionTurn(turnDeps, session, "inspect");

    expect(readFileSync(join(root, "NOTES.md"), "utf8")).toBe("alpha\n");
    const unit = session.units.get("g1");
    expect(unit?.journal.some((event) => event.type === "rollback")).toBe(true);
  });
});
