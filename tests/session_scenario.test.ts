import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";

import type { Event } from "../src/ir/events";
import type { Context } from "../src/ir/project";
import type { Proposals } from "../src/llm/schemas";
import type { Proposer } from "../src/loop/propose";
import { runRepl } from "../src/session/repl";
import { attentionOf, createSession } from "../src/session/session";
import type { SessionAgent } from "../src/session/session_agent";
import { sessionOutline } from "../src/session/session_outline";
import type { SessionTurnDeps } from "../src/session/driver";
import type { GeneralProposer } from "../src/session/general";
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

function ruleOf(text: string): string {
  return /RULE:[^"\n]*/.exec(text)?.[0] ?? "RULE: not found";
}

// The session agent is an orchestrator: it routes and answers from the L0 trace of past units.
// It carries the rule from the general unit's trace into coding tasks.
const sessionAgent: SessionAgent = async (messages) => {
  const userIndex = messages.findIndex((message) => message.role === "user");
  const user = userIndex >= 0 ? textOf(messages[userIndex]!) : "";
  const rule = ruleOf(messages.map(textOf).join("\n"));

  if (user.includes("Прочитай NOTES.md")) {
    return { operation: { kind: "general", text: "Read NOTES.md and report the RULE" } };
  }

  if (user.includes("Какое там правило")) {
    return { operation: { kind: "respond", text: `Правило: ${rule}` } };
  }

  if (user.includes("Примени правило")) {
    return {
      operation: { kind: "task", text: `In src/app.txt, apply the rule: ${rule}` },
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
    return { operation: { kind: "task", text: "Add a test for the applied rule" } };
  }

  return { operation: { kind: "respond", text: "Не понял запрос." } };
};

function createTaskProposer(): Proposer {
  let phase = 0;
  return async (context: Context): Promise<Proposals> => {
    const request =
      context.history.find((message) => message.role === "user")?.text ?? "";

    if (context.situation === "request") {
      phase = 0;
      if (request.includes("src/app.txt")) {
        return { thought: "", actions: [move("construction", "apply the rule")] };
      }
      return { thought: "", actions: [move("research", "finish")] };
    }

    if (context.situation === "working") {
      if (!request.includes("src/app.txt")) {
        return { thought: "", actions: [{ operator: "stop", why: "nothing to do" }] };
      }
      if (phase === 0) {
        phase = 1;
        return { thought: "", actions: [read("src/app.txt")] };
      }
      if (phase === 1) {
        phase = 2;
        return { thought: "", actions: [write("src/app.txt", `${ruleOf(request)}\n`)] };
      }
      return { thought: "", actions: [{ operator: "stop", why: "rule applied" }] };
    }

    if (context.situation === "transition") {
      return { thought: "", actions: [move("end", "finish")] };
    }
    return { thought: "", actions: [{ operator: "stop", why: "done" }] };
  };
}

function createGeneralProposer(): GeneralProposer {
  let turn = 0;
  return async (): Promise<Proposals> => {
    turn += 1;
    if (turn === 1) {
      return { thought: "", actions: [read("NOTES.md")] };
    }
    return { thought: "", actions: [{ operator: "stop", why: RULE }] };
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

describe("synthetic session: general read, memory, reformulation, confirmation", () => {
  it("reads in a general unit, answers from its journal, then carries the rule into a task", async () => {
    const workspace = makeWorkspace({
      "NOTES.md": `${RULE}\n`,
      "src/app.txt": "TODO\n",
    });
    const deps: SessionTurnDeps = {
      sessionAgent: { agent: sessionAgent },
      task: { propose: createTaskProposer(), workspace: workspace.ws, maxTurns: 20 },
      general: { propose: createGeneralProposer(), workspace: workspace.ws, maxTurns: 4 },
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
    expect(attentionOf(session, "g1")).toBe("completed");
    expect(attentionOf(session, "r1")).toBe("completed");
    expect(attentionOf(session, "r2")).toBe("completed");

    const r1 = session.units.get("r1");
    expect(r1).toBeDefined();
    expect(requestText(r1?.journal ?? [])).toContain(RULE);
    expect(JSON.stringify(r1?.journal)).not.toContain("Earlier tasks");

    expect(output).toContain("answer:");
    expect(output).toContain(`Правило: ${RULE}`);
    expect(output.some((line) => line.includes('session: general("Read NOTES.md'))).toBe(true);
    expect(output.some((line) => line.includes('session: task("In src/app.txt, apply the rule:'))).toBe(true);
    expect(output.some((line) => line.includes("session: respond"))).toBe(true);
    expect(output.some((line) => line.includes('session: task("Add a test for the applied rule")'))).toBe(true);

    const outline = sessionOutline(session);
    expect(outline).toContain('general g1 "Read NOTES.md and report the RULE"');
    expect(outline).toContain('respond: "Правило:');
    expect(outline).toContain('task: "In src/app.txt, apply the rule:');
    expect(outline).toContain('task: "Add a test for the applied rule"');
  });
});
