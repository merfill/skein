import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";

import type { Event } from "../src/ir/events";
import type { Context } from "../src/ir/project";
import type { Proposals } from "../src/llm/schemas";
import type { Proposer } from "../src/loop/propose";
import { runRepl } from "../src/session/repl";
import { attentionOf, createSession } from "../src/session/session";
import { createSessionTools, type SessionAgent } from "../src/session/session_agent";
import { sessionOutline } from "../src/session/session_outline";
import type { SessionTurnDeps } from "../src/session/driver";
import type { ReadFile } from "../src/session/reading";
import { cleanupWorkspaces, makeWorkspace, move, read, write } from "./ops/helpers";

afterEach(cleanupWorkspaces);

const RULE = "RULE: run make test before every commit";

function textOf(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => {
      if (part.type === "text" || part.type === "reasoning") return part.text;
      if (part.type === "tool-result") {
        const output = part.output as { value?: unknown } | undefined;
        return typeof output?.value === "string" ? output.value : "";
      }
      return "";
    })
    .join("\n");
}

function firstObservationId(toolText: string): string | undefined {
  return /\[(obs:[^\]]+)\]/.exec(toolText)?.[1];
}

function ruleOf(text: string): string {
  return /RULE:[^\n]*/.exec(text)?.[0] ?? "RULE: not found";
}

// The scripted session agent reads the file with `read` (no task), then answers and reformulates
// task 1 from the reading unit's history.
const sessionAgent: SessionAgent = async (messages) => {
  const userIndex = messages.findIndex((message) => message.role === "user");
  const user = userIndex >= 0 ? textOf(messages[userIndex]!) : "";
  const after = userIndex >= 0 ? messages.slice(userIndex + 1) : messages;
  const toolTexts = after.filter((message) => message.role === "tool").map(textOf);
  const calls = after.filter((message) => message.role === "assistant").length;
  const lastTool = toolTexts.at(-1) ?? "";

  if (user.includes("Прочитай NOTES.md")) {
    if (calls === 0) {
      return { toolCalls: [{ name: "read", args: { path: "NOTES.md" }, callId: "read:1" }] };
    }
    return { operation: { kind: "respond", text: `Правило: ${ruleOf(lastTool)}` } };
  }

  if (user.includes("Какое там правило")) {
    if (calls === 0) {
      return {
        toolCalls: [{ name: "search", args: { unit: "reading:1", pattern: "RULE" }, callId: "s1" }],
      };
    }
    if (calls === 1) {
      const id = firstObservationId(lastTool);
      return id === undefined
        ? { operation: { kind: "respond", text: "Не нашёл правило" } }
        : { toolCalls: [{ name: "body", args: { unit: "reading:1", id }, callId: "b1" }] };
    }
    return { operation: { kind: "respond", text: `Правило: ${ruleOf(lastTool)}` } };
  }

  if (user.includes("Примени правило")) {
    if (calls === 0) {
      return {
        toolCalls: [{ name: "search", args: { unit: "reading:1", pattern: "RULE" }, callId: "s2" }],
      };
    }
    if (calls === 1) {
      const id = firstObservationId(lastTool);
      return id === undefined
        ? { operation: { kind: "respond", text: "Не нашёл правило" } }
        : { toolCalls: [{ name: "body", args: { unit: "reading:1", id }, callId: "b2" }] };
    }
    return {
      operation: { kind: "start", text: `In src/app.txt, apply the rule: ${ruleOf(lastTool)}` },
    };
  }

  if (user.includes("Добавь тест")) {
    return {
      operation: {
        kind: "respond",
        text: "Понял так: добавить тест для применённого правила. Начинаем?",
      },
    };
  }

  if (user.trim().toLowerCase() === "да") {
    return { operation: { kind: "start", text: "Add a test for the applied rule" } };
  }

  return { operation: { kind: "respond", text: "Не понял запрос." } };
};

function createProposer(): Proposer {
  let phase = 0;
  return async (context: Context): Promise<Proposals> => {
    const request =
      context.history.find((message) => message.role === "user")?.text ?? "";

    if (context.situation === "request") {
      phase = 0;
      if (request.includes("src/app.txt")) {
        return { thought: "", actions: [move("construction", "apply the rule")] };
      }
      return { thought: "", actions: [move("end", "finish")] };
    }

    if (context.situation === "plan") {
      if (request.includes("src/app.txt")) {
        phase = 1;
        return { thought: "", actions: [read("src/app.txt")] };
      }
      return { thought: "", actions: [{ operator: "stop", why: "nothing to do" }] };
    }

    if (context.situation === "working") {
      if (request.includes("src/app.txt")) {
        if (phase === 1) {
          phase = 2;
          return { thought: "", actions: [write("src/app.txt", `${ruleOf(request)}\n`)] };
        }
        return { thought: "", actions: [{ operator: "stop", why: "rule applied" }] };
      }
      return { thought: "", actions: [{ operator: "stop", why: "done" }] };
    }

    if (context.situation === "transition") {
      return { thought: "", actions: [move("end", "finish")] };
    }
    return { thought: "", actions: [{ operator: "stop", why: "done" }] };
  };
}

async function* lines(...values: string[]): AsyncGenerator<string> {
  for (const value of values) yield value;
}

function requestText(journal: readonly Event[]): string {
  for (const event of journal) {
    if (event.type === "add_node" && event.node.kind === "request") {
      const payload = event.node.payload as { text?: unknown } | undefined;
      return typeof payload?.text === "string" ? payload.text : event.node.label;
    }
  }
  return "";
}

function taskUnitIds(session: ReturnType<typeof createSession>): string[] {
  return [...session.units.values()]
    .filter((unit) => unit.type === "task")
    .map((unit) => unit.id);
}

describe("synthetic session: read, memory, reformulation, confirmation", () => {
  it("reads in one action, answers from the reading unit, then carries the rule into a task", async () => {
    const workspace = makeWorkspace({
      "NOTES.md": `${RULE}\n`,
      "src/app.txt": "TODO\n",
    });
    const readFile: ReadFile = (path) => {
      const text = workspace.ws.read(path);
      return {
        text,
        version: workspace.ws.version(path),
        bytes: text.length,
        lines: text.split("\n").length,
      };
    };
    const deps: SessionTurnDeps = {
      sessionAgent: {
        agent: sessionAgent,
        tools: createSessionTools(readFile),
        readFile,
      },
      task: { propose: createProposer(), workspace: workspace.ws, maxTurns: 20 },
    };
    const session = createSession();
    const output: string[] = [];

    await runRepl(
      lines(
        "Прочитай NOTES.md и запомни правило",
        "Какое там правило?",
        "Примени правило к src/app.txt",
        "Добавь тест",
        "да",
        "exit",
      ),
      deps,
      (line) => output.push(line),
      session,
    );

    expect(workspace.ws.read("src/app.txt")).toContain(RULE);
    expect(taskUnitIds(session)).toEqual(["r1", "r2"]);
    expect(attentionOf(session, "reading:1")).toBe("completed");
    expect(attentionOf(session, "r1")).toBe("completed");
    expect(attentionOf(session, "r2")).toBe("completed");

    const r1 = session.units.get("r1");
    expect(r1).toBeDefined();
    expect(requestText(r1?.journal ?? [])).toContain(RULE);
    expect(JSON.stringify(r1?.journal)).not.toContain("Earlier tasks");

    expect(output).toContain(`answer: Правило: ${RULE}`);
    expect(output.some((line) => line.includes('session: start("In src/app.txt, apply the rule:'))).toBe(true);
    expect(output.some((line) => line.includes("session: respond"))).toBe(true);
    expect(output.some((line) => line.includes('session: start("Add a test for the applied rule")'))).toBe(true);

    const outline = sessionOutline(session);
    expect(outline).toContain('reading reading:1 "NOTES.md" completed; read');
    expect(outline).toContain('respond: "Правило:');
    expect(outline).toContain('start: "In src/app.txt, apply the rule:');
    expect(outline).toContain('start: "Add a test for the applied rule"');
  });
});
