import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelMessage } from "ai";

import { afterEach, describe, expect, it } from "vitest";

import { fold, stopOf, turnsOf } from "../src/ir/graph";
import { REVISION_BASE_PROMPT } from "../src/llm/revision";
import type { Proposals } from "../src/llm/schemas";
import { runSessionTurn, type SessionTurnDeps } from "../src/session/driver";
import { attentionOf, createSession } from "../src/session/session";
import { sessionOutline, unitOutline } from "../src/session/session_outline";
import { memoryTelemetry } from "../src/session/telemetry";
import { buildTuiView } from "../src/tui/view_model";
import { fsWorkspace } from "../src/tools/workspace";

const dirs: string[] = [];

function workspace(): ReturnType<typeof fsWorkspace> {
  const root = mkdtempSync(join(tmpdir(), "skein-revision-"));
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

function depsWith(
  propose: (messages: ModelMessage[]) => Promise<Proposals>,
  ws: ReturnType<typeof fsWorkspace>,
  telemetry?: SessionTurnDeps["telemetry"],
): SessionTurnDeps {
  return {
    sessionAgent: {
      agent: async () => ({ operation: { kind: "revision", text: "apply the described change" } }),
    },
    task: { propose: async () => ({ thought: "", actions: [] }), workspace: ws, maxTurns: 2 },
    revision: { propose, workspace: ws, maxTurns: 4, ...(telemetry !== undefined ? { telemetry } : {}) },
    telemetry,
  } as unknown as SessionTurnDeps;
}

describe("revision unit", () => {
  it("edits an existing file and closes with a text reply", async () => {
    const session = createSession();
    const ws = workspace();
    const telemetry = memoryTelemetry();
    let index = 0;
    let firstMessages: ModelMessage[] = [];
    const result = await runSessionTurn(
      depsWith(
        async (messages) => {
          index += 1;
          if (index === 1) {
            firstMessages = messages;
            return {
              thought: "",
              actions: [
                {
                  operator: "apply",
                  action: { tool: "edit", path: "NOTES.md", find: "alpha", replace: "gamma" },
                },
              ],
              usage: { inputTokens: 100, outputTokens: 10 },
              model: "m",
            };
          }
          return {
            thought: "changed alpha to gamma in NOTES.md",
            actions: [],
            usage: { inputTokens: 40, outputTokens: 8 },
            model: "m",
          };
        },
        ws,
        telemetry.sink,
      ),
      session,
      "align NOTES.md",
    );

    expect(result.revision?.unitId).toBe("v1");
    expect(result.revision?.result.done).toBe(true);
    expect(result.revision?.result.stopReason).toBe("answered");
    expect(attentionOf(session, "v1")).toBe("completed");
    expect(readFileSync(join(ws.root, "NOTES.md"), "utf8")).toBe("gamma\nbeta\n");

    // The unit is request-anchored and has no `move`.
    const unit = session.units.get("v1");
    expect(unit?.type).toBe("revision");
    const state = fold(unit?.journal ?? []);
    const root = state.rootId ?? "";
    expect(turnsOf(state, root)).toBeDefined();
    expect(stopOf(state, root)).toBeDefined();

    expect(firstMessages[0]?.role).toBe("system");
    expect(String(firstMessages[0]?.content)).toBe(REVISION_BASE_PROMPT);

    const outline = sessionOutline(session);
    expect(outline).toContain('revision v1 "apply the described change"');
    expect(outline).toContain("actions: edit");
    expect(outline).toContain('answer: "changed alpha to gamma');

    const unitStates = unitOutline(session, "v1");
    expect(unitStates).toContain("v1 revision");
    expect(unitStates).toContain("closed:");

    const view = buildTuiView(session, telemetry.events);
    expect(view.current?.unitId).toBe("v1");
    expect(view.current?.states).toHaveLength(1);
    expect(view.current?.states[0]?.island).toBe("revision");
    expect(view.header.totalTasks).toBe(1);
    expect(view.header.tokensIn).toBe(140);
  });

  it("runs the commands the change needs (side-effecting write)", async () => {
    const session = createSession();
    const ws = workspace();
    let index = 0;
    const result = await runSessionTurn(
      depsWith(async () => {
        index += 1;
        if (index === 1) {
          return {
            thought: "",
            actions: [
              { operator: "apply", action: { tool: "write", path: "extra.txt", content: "v\n" } },
            ],
          };
        }
        return { thought: "wrote extra.txt", actions: [] };
      }, ws),
      session,
      "add extra.txt",
    );

    expect(result.revision?.result.done).toBe(true);
    expect(existsSync(join(ws.root, "extra.txt"))).toBe(true);
    expect(readFileSync(join(ws.root, "extra.txt"), "utf8")).toBe("v\n");
  });
});
