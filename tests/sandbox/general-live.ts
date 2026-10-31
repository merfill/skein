import { loadSettings } from "../../src/config/settings";
import type { Event } from "../../src/ir/events";
import { observationText } from "../../src/ir/project";
import { createChatModel } from "../../src/llm/client";
import { modelGeneralProposer } from "../../src/llm/general";
import { createSessionAgentDeps } from "../../src/llm/session_agent";
import type { Proposer } from "../../src/loop/propose";
import { runSessionTurn, type SessionTurnDeps } from "../../src/session/driver";
import { attentionOf, createSession } from "../../src/session/session";
import { sessionOutline } from "../../src/session/session_outline";
import { fsWorkspace } from "../../src/tools/workspace";
import { cleanupWorkspaces, makeWorkspace } from "../ops/helpers";

// A synthetic live analysis: a small non-code project, a request to explain how it works
// step by step, and the real model. The session agent must route to `general`, not `start`
// or `respond`; the general unit must use read-only tools and close with an answer. Run only
// with SKEIN_LIVE=true and the owner's go-ahead.

const FILES: Record<string, string> = {
  "README.md": [
    "# bench-demo",
    "",
    "A tiny benchmark runner. A task is loaded from `tasks/`, executed by `runner.py`,",
    "and its result is written by `reporter.py`.",
    "",
  ].join("\n"),
  "docs/pipeline.md": [
    "# Pipeline",
    "",
    "1. `loader.py` reads a task into a dict with `id`, `input` and `checks`.",
    "2. `runner.py` runs the task and returns a result dict.",
    "3. `reporter.py` formats the result as Markdown and appends it to `results.md`.",
    "",
  ].join("\n"),
  "src/loader.py": "def load(path):\n    return {'id': path.stem, 'input': path.read_text(), 'checks': []}\n",
  "src/runner.py": "def run(task):\n    return {'id': task['id'], 'ok': True, 'detail': 'ran ' + task['input'].strip()}\n",
  "src/reporter.py": [
    "def report(result):",
    "    return '## ' + result['id'] + '\\n\\nok: ' + str(result['ok']) + '\\n' + result['detail'] + '\\n'",
    "",
  ].join("\n"),
  "src/main.py": [
    "from .loader import load",
    "from .runner import run",
    "from .reporter import report",
    "",
    "",
    "def main(path):",
    "    task = load(path)",
    "    return report(run(task))",
    "",
  ].join("\n"),
};

const REQUEST =
  "Разбери по шагам, как в этом проекте устроен запуск задачи на бенчмарке: от загрузки до записи результата. Покажи этапы, функции и пути. Это анализ, файлы не меняй.";

function short(value: string, limit = 800): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

function printEvents(events: readonly Event[]): void {
  for (const event of events) {
    if (event.type !== "add_node") continue;
    const node = event.node;
    const payload = node.payload as Record<string, unknown> | undefined;
    if (node.kind === "request") continue;
    if (node.kind === "move") {
      console.info(`  general move: ${String(payload?.state)} — ${short(String(payload?.what ?? ""))}`);
    } else if (node.kind === "action") {
      console.info(`  general action: ${short(node.label)}`);
    } else if (node.kind === "observation") {
      console.info(`  general observation ${node.id}: ${short(observationText(node))}`);
    } else if (node.kind === "stop") {
      console.info(`  general stop: ${short(node.label)}`);
    }
  }
}

function answerOf(events: readonly Event[]): string | undefined {
  let answer: string | undefined;
  for (const event of events) {
    if (event.type === "add_node" && event.node.kind === "stop") {
      const payload = event.node.payload as { answer?: unknown } | undefined;
      answer = typeof payload?.answer === "string" ? payload.answer : event.node.label;
    }
  }
  return answer;
}

function countTools(events: readonly Event[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    if (event.type !== "add_node" || event.node.kind !== "action") continue;
    const payload = event.node.payload as
      | { tool?: unknown; command?: unknown; call?: { name?: unknown } }
      | undefined;
    const tool =
      typeof payload?.call?.name === "string"
        ? payload.call.name
        : typeof payload?.tool === "string"
          ? payload.tool
          : (typeof payload?.command === "string" ? payload.command : event.node.label).split(" ")[0] ?? "?";
    counts[tool] = (counts[tool] ?? 0) + 1;
  }
  return counts;
}

async function main(): Promise<void> {
  if (process.env.SKEIN_LIVE !== "true") {
    console.error("Set SKEIN_LIVE=true to run the live general scenario.");
    process.exit(1);
  }

  const settings = loadSettings();
  const model = createChatModel(settings);
  const workspace = makeWorkspace(FILES);
  const root = fsWorkspace(workspace.root);

  // A task means the session agent misrouted the analysis; make it visible immediately.
  const decline: Proposer = async () => ({
    thought: "This is a read-only analysis; a coding task is unexpected.",
    actions: [{ operator: "decline", why: "general-live: analysis must not start a task" }],
  });

  const deps: SessionTurnDeps = {
    sessionAgent: createSessionAgentDeps(model, { settings }),
    task: { propose: decline, workspace: root, maxTurns: 1 },
    general: {
      propose: modelGeneralProposer(model, { settings }),
      workspace: root,
      maxTurns: 8,
    },
  };

  const session = createSession();
  const failures: string[] = [];
  try {
    console.info(`\n=== user: ${REQUEST}`);
    const result = await runSessionTurn(deps, session, REQUEST);
    console.info(`  session turns=${result.interpretation?.turns ?? 0}`);
    console.info(`  operation=${JSON.stringify(result.operation)}`);
    if (result.reply !== undefined) console.info(`  reply:\n${result.reply}`);
    if (result.task !== undefined) console.error(`  unexpected task: ${result.task.unitId}`);
    if (result.general !== undefined) {
      console.info(`  general unit: ${result.general.unitId}, turns=${result.general.result.turns}, done=${result.general.result.done}, stop=${result.general.result.stopReason}`);
      printEvents(result.general.result.events);
    }
    console.info(`  session outline:\n${sessionOutline(session)}`);

    const answer = result.general !== undefined ? (answerOf(result.general.result.events) ?? "") : "";
    const tools = result.general !== undefined ? countTools(result.general.result.events) : {};
    console.info(`\ntasks=${result.task !== undefined ? 1 : 0} general=${result.general !== undefined ? 1 : 0} reply=${answer !== "" ? 1 : 0} tools=${JSON.stringify(tools)}`);

    if (result.operation?.kind !== "general") failures.push(`expected general, got ${result.operation?.kind ?? "none"}`);
    if (result.task !== undefined) failures.push("a coding task was started");
    if (result.general === undefined) failures.push("no general unit was opened");
    if (result.general !== undefined && !result.general.result.done) failures.push("general unit did not finish");
    if (result.general !== undefined) {
      const unit = session.units.get(result.general.unitId);
      if (unit?.type !== "general") failures.push("the opened unit is not general");
      if (attentionOf(session, result.general.unitId) !== "completed") failures.push("general unit is not completed");
    }
    if (answer === "") failures.push("the answer is empty");
    if (!/^##\s/m.test(answer)) failures.push("the answer is not Markdown (no '## ' heading)");
    if (!answer.includes("src/")) failures.push("the answer does not cite src/ paths");
    if ((tools.read ?? 0) + (tools.grep ?? 0) + (tools.list ?? 0) === 0) {
      failures.push("the general unit used no read/grep/list tool");
    }

    if (failures.length > 0) {
      console.error(`\nFAIL:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
      process.exitCode = 1;
    } else {
      console.info("\nOK: analysis routed to general, read-only tools used, answer completed.");
    }
  } finally {
    cleanupWorkspaces();
  }
}

await main();
