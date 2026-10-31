import { loadSettings } from "../../src/config/settings";
import type { Event } from "../../src/ir/events";
import { createChatModel } from "../../src/llm/client";
import { createSessionAgentDeps } from "../../src/llm/session_agent";
import type { Proposer } from "../../src/loop/propose";
import { runSessionTurn, type SessionTurnDeps } from "../../src/session/driver";
import { createSession } from "../../src/session/session";
import { createSessionWorkspace } from "../../src/session/session_workspace";
import { sessionOutline } from "../../src/session/session_outline";
import type { SessionState } from "../../src/session/types";
import { fsWorkspace } from "../../src/tools/workspace";
import { cleanupWorkspaces, makeWorkspace } from "../ops/helpers";

// A synthetic live session for the read-only workspace tools: `list`, `grep` and `probe`.
// The dialogue asks orientation questions only, so a real model must use the tools and must
// never start a task. Run only with SKEIN_LIVE=true and the owner's go-ahead.

const FILES: Record<string, string> = {
  Makefile: "test:\n\tpython3 -m unittest discover -s tests\n",
  "src/calc.py": "def add(a, b):\n    return a + b\n\n\ndef mul(a, b):\n    return a * b\n",
  "tests/test_calc.py":
    "import unittest\n\nfrom calc import add\n\n\nclass CalcTest(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n",
  "README.md": "calc — small arithmetic helpers\n",
  "NOTES.md": "RULE: run make test before every commit\n",
};

const DIALOGUE = [
  "Что лежит в этом проекте? Перечисли файлы.",
  "Где в коде используется add?",
  "Какие интерпретаторы доступны для Python?",
  "Есть ли в проекте тест на add? Ничего не запускай.",
];

interface ToolResult {
  tool: string;
  result: string;
}

function short(value: string, limit = 600): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

function printJournal(journal: readonly Event[]): void {
  for (const event of journal) {
    if (event.type !== "add_node") continue;
    const node = event.node;
    const payload = node.payload as Record<string, unknown> | undefined;
    if (node.kind === "request") continue;
    if (node.kind === "action") {
      console.info(`  session call: ${String(payload?.tool)}(${JSON.stringify(payload?.args ?? {})})`);
      const reasoning = payload?.reasoning;
      if (typeof reasoning === "string" && reasoning.trim() !== "") {
        console.info(`    reasoning: ${short(reasoning)}`);
      }
    } else if (node.kind === "observation") {
      console.info(`  session result: ${short(String(payload?.result ?? node.label))}`);
    }
  }
}

function collectResults(session: SessionState): ToolResult[] {
  const results: ToolResult[] = [];
  for (const unit of session.units.values()) {
    if (unit.type !== "session") continue;
    for (const event of unit.journal) {
      if (event.type !== "add_node" || event.node.kind !== "observation") continue;
      const payload = event.node.payload as { tool?: unknown; result?: unknown };
      if (typeof payload.tool === "string" && typeof payload.result === "string") {
        results.push({ tool: payload.tool, result: payload.result });
      }
    }
  }
  return results;
}

async function main(): Promise<void> {
  if (process.env.SKEIN_LIVE !== "true") {
    console.error("Set SKEIN_LIVE=true to run the live session-tools scenario.");
    process.exit(1);
  }

  const settings = loadSettings();
  const model = createChatModel(settings);
  const workspace = makeWorkspace(FILES);
  const root = fsWorkspace(workspace.root);
  const sessionWorkspace = createSessionWorkspace(root);

  // A task is a failure of this scenario. If the model starts one anyway, decline it in one
  // turn instead of running a real task.
  const decline: Proposer = async () => ({
    thought: "This is a read-only orientation scenario; a task is unexpected.",
    actions: [{ operator: "decline", why: "tools-only scenario" }],
  });

  const deps: SessionTurnDeps = {
    sessionAgent: createSessionAgentDeps(model, { settings, workspace: sessionWorkspace }),
    task: { propose: decline, workspace: root, maxTurns: 1 },
  };

  const session = createSession();
  const failures: string[] = [];
  let replies = 0;
  let tasks = 0;

  try {
    for (const line of DIALOGUE) {
      console.info(`\n=== user: ${line}`);
      const result = await runSessionTurn(deps, session, line);
      console.info(`  session turns=${result.interpretation?.turns ?? 0}`);
      if (result.interpretation !== undefined) printJournal(result.interpretation.journal);
      console.info(`  operation=${JSON.stringify(result.operation)}`);
      if (result.reasoning !== undefined) console.info(`  reasoning=${short(result.reasoning)}`);
      if (result.reply !== undefined) {
        replies += 1;
        console.info(`  reply:\n${result.reply}`);
      }
      if (result.task !== undefined) {
        tasks += 1;
        console.error(`  unexpected task: ${result.task.unitId}`);
      }
      if (result.operation?.kind !== "respond") {
        failures.push(`turn "${line}": expected respond, got ${JSON.stringify(result.operation)}`);
      }
      console.info(`  session outline:\n${sessionOutline(session)}`);
    }

    const results = collectResults(session);
    const count = (tool: string): number => results.filter((item) => item.tool === tool).length;
    const text = (tool: string): string =>
      results
        .filter((item) => item.tool === tool)
        .map((item) => item.result)
        .join("\n");

    console.info(
      `\ntasks=${tasks} replies=${replies} tools={list:${count("list")},grep:${count("grep")},probe:${count("probe")}}`,
    );

    if (tasks !== 0) failures.push(`expected no task, got ${tasks}`);
    if (replies !== DIALOGUE.length) failures.push(`expected ${DIALOGUE.length} replies, got ${replies}`);
    if (count("list") === 0) failures.push("list was never called");
    if (count("grep") === 0) failures.push("grep was never called");
    if (count("probe") === 0) failures.push("probe was never called");

    if (!text("list").includes("src/calc.py") || !text("list").includes("tests/test_calc.py")) {
      failures.push("list did not show src/calc.py and tests/test_calc.py");
    }
    if (!text("grep").includes("src/calc.py:")) {
      failures.push("grep did not report a match in src/calc.py");
    }
    if (!text("probe").includes("Environment") && !text("probe").includes("Workspace map")) {
      failures.push("probe returned no environment/material fact");
    }

    if (failures.length > 0) {
      console.error(`\nFAIL:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
      process.exitCode = 1;
    } else {
      console.info("\nOK: list, grep and probe were used; no task was started.");
    }
  } finally {
    cleanupWorkspaces();
  }
}

await main();
