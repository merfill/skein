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

// A synthetic live research question: a small project whose code answers "how does the
// post-task report work?" The session agent must read/grep it, answer in Markdown, and must
// not start a task. Run only with SKEIN_LIVE=true and the owner's go-ahead.

const FILES: Record<string, string> = {
  "README.md": "mini-session — a tiny session engine\n",
  "docs/architecture.md": [
    "# Session flow",
    "",
    "A session turn interprets the user's utterance. When a task finishes, the driver calls",
    "the reporter, then `record_report` appends the text to the session journal as a `report`;",
    "`render_turn` prints it.",
    "",
  ].join("\n"),
  "src/session.py": [
    "def record_report(session, unit_id, text):",
    "    session['journal'].append({'type': 'report', 'unit_id': unit_id, 'text': text})",
    "",
  ].join("\n"),
  "src/driver.py": [
    "from .session import record_report",
    "",
    "",
    "def run_turn(session, utterance, reporter):",
    "    text = reporter(utterance)",
    "    record_report(session, 'session:1', text)",
    "    return text",
    "",
  ].join("\n"),
  "src/view.py": [
    "def render_turn(result):",
    "    if result.get('report'):",
    "        return ['report:', result['report']]",
    "    return []",
    "",
  ].join("\n"),
  "tests/test_session.py": [
    "from src.session import record_report",
    "",
    "",
    "def test_record_report():",
    "    session = {'journal': []}",
    "    record_report(session, 'session:1', '## Done')",
    "    assert session['journal'][0]['type'] == 'report'",
    "",
  ].join("\n"),
};

const QUESTION =
  "Как в этом проекте устроен post-task report: где он создаётся, как записывается в журнал и где рендерится? Ответь по коду, с путями.";

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
      console.info(`  call: ${String(payload?.tool)}(${JSON.stringify(payload?.args ?? {})})`);
    } else if (node.kind === "observation") {
      console.info(`  result: ${short(String(payload?.result ?? node.label))}`);
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
    console.error("Set SKEIN_LIVE=true to run the live session-research scenario.");
    process.exit(1);
  }

  const settings = loadSettings();
  const model = createChatModel(settings);
  const workspace = makeWorkspace(FILES);
  const root = fsWorkspace(workspace.root);
  const sessionWorkspace = createSessionWorkspace(root);

  // A task is a failure of this scenario; decline it in one turn if the model starts one.
  const decline: Proposer = async () => ({
    thought: "This is a read-only research question; a task is unexpected.",
    actions: [{ operator: "decline", why: "research-only scenario" }],
  });

  const deps: SessionTurnDeps = {
    sessionAgent: createSessionAgentDeps(model, { settings, workspace: sessionWorkspace }),
    task: { propose: decline, workspace: root, maxTurns: 1 },
  };

  const session = createSession();
  const failures: string[] = [];
  try {
    console.info(`\n=== user: ${QUESTION}`);
    const result = await runSessionTurn(deps, session, QUESTION);
    console.info(`  session turns=${result.interpretation.turns}`);
    printJournal(result.interpretation.journal);
    console.info(`  operation=${JSON.stringify(result.operation)}`);
    if (result.reply !== undefined) console.info(`  reply:\n${result.reply}`);
    if (result.task !== undefined) console.error(`  unexpected task: ${result.task.unitId}`);
    console.info(`  session outline:\n${sessionOutline(session)}`);

    const results = collectResults(session);
    const count = (tool: string): number => results.filter((item) => item.tool === tool).length;
    const answer = result.reply ?? "";

    console.info(
      `\ntasks=${result.task !== undefined ? 1 : 0} replies=${answer !== "" ? 1 : 0} tools={grep:${count("grep")},read:${count("read")},list:${count("list")}}`,
    );

    if (result.task !== undefined) failures.push("a task was started");
    if (result.operation?.kind !== "respond") failures.push("expected a respond operation");
    if (answer === "") failures.push("the answer is empty");
    if (!/^##\s/m.test(answer)) failures.push("the answer is not Markdown (no '## ' heading)");
    if (!answer.includes("src/driver.py")) failures.push("the answer does not cite src/driver.py");
    if (!answer.includes("record_report")) failures.push("the answer does not cite record_report");
    if (!answer.includes("src/view.py")) failures.push("the answer does not cite src/view.py");
    if (count("grep") + count("read") === 0) failures.push("no grep/read was used");

    if (failures.length > 0) {
      console.error(`\nFAIL:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
      process.exitCode = 1;
    } else {
      console.info("\nOK: a Markdown research answer from the code; no task was started.");
    }
  } finally {
    cleanupWorkspaces();
  }
}

await main();
