import { loadSettings } from "../../src/config/settings";
import type { Event } from "../../src/ir/events";
import { observationText } from "../../src/ir/project";
import { createChatModel } from "../../src/llm/client";
import { modelGeneralProposer } from "../../src/llm/general";
import { createObserverDeps } from "../../src/llm/observer";
import { createSessionAgentDeps } from "../../src/llm/session_agent";
import { probeSession } from "../../src/loop/probe";
import { modelProposer, type Proposer } from "../../src/loop/propose";
import { runSessionTurn, type SessionTurnDeps } from "../../src/session/driver";
import { attentionOf, createSession, unitOf } from "../../src/session/session";
import { sessionOutline } from "../../src/session/session_outline";
import { fsWorkspace } from "../../src/tools/workspace";
import { cleanupWorkspaces, makeWorkspace } from "../ops/helpers";

// A synthetic live session: a small project, a dialogue that builds on earlier work, and the
// real model. Every session turn prints the interpreter's tool calls and reasoning; every task
// run prints its proposals, actions, results and final answer. Run only with SKEIN_LIVE=true
// and the owner's go-ahead.

const RULE = "RULE: run make test before every commit";

function short(value: string, limit = 600): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
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

function lastStop(events: readonly Event[]): string | undefined {
  let answer: string | undefined;
  for (const event of events) {
    if (event.type === "add_node" && event.node.kind === "stop") answer = event.node.label;
  }
  return answer;
}

function printSessionJournal(journal: readonly Event[]): void {
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

function printTaskEvents(events: readonly Event[]): void {
  for (const event of events) {
    if (event.type === "record_rejection") {
      console.info(`  task rejected: ${event.tool} ${event.target}: ${event.reason}`);
      continue;
    }
    if (event.type !== "add_node") continue;
    const node = event.node;
    const payload = node.payload as Record<string, unknown> | undefined;
    if (node.kind === "move") {
      console.info(`  task move: ${String(payload?.state)} — ${short(String(payload?.what ?? ""))}`);
    } else if (node.kind === "action") {
      console.info(`  task action: ${short(node.label)}`);
      if (typeof payload?.command === "string" && payload.command !== node.label) {
        console.info(`    command: ${short(payload.command)}`);
      }
      const reasoning = payload?.reasoning;
      if (typeof reasoning === "string" && reasoning.trim() !== "") {
        console.info(`    reasoning: ${short(reasoning)}`);
      }
    } else if (node.kind === "observation") {
      console.info(`  task observation ${node.id}: ${short(observationText(node))}`);
    } else if (node.kind === "stop") {
      console.info(`  task stop: ${short(node.label)}`);
    }
  }
}

async function main(): Promise<void> {
  if (process.env.SKEIN_LIVE !== "true") {
    console.error("Set SKEIN_LIVE=true to run the live session scenario.");
    process.exit(1);
  }

  const settings = loadSettings();
  const model = createChatModel(settings);
  const workspace = makeWorkspace({
    "NOTES.md": `${RULE}\n`,
    "src/app.txt": "TODO\n",
  });
  const root = fsWorkspace(workspace.root);

  let taskTurn = 0;
  const basePropose = modelProposer(model);
  const propose: Proposer = async (context) => {
    if (context.situation === "request") taskTurn = 0;
    taskTurn += 1;
    const proposal = await basePropose(context);
    console.info(`  [task t${taskTurn}] thought: ${short(proposal.thought)}`);
    if (proposal.reasoning !== undefined && proposal.reasoning !== "") {
      console.info(`  [task t${taskTurn}] reasoning: ${short(proposal.reasoning)}`);
    }
    console.info(
      `  [task t${taskTurn}] actions: ${proposal.actions.map((action) => JSON.stringify(action)).join("; ")}`,
    );
    return proposal;
  };


  const deps: SessionTurnDeps = {
    sessionAgent: createSessionAgentDeps(model, { settings }),
    task: {
      propose,
      workspace: root,
      maxTurns: settings.maxTurns,
      probe: probeSession,
      ...(settings.observer ? { observer: createObserverDeps(model, { settings }) } : {}),
    },
    general: {
      propose: modelGeneralProposer(model, { settings }),
      workspace: root,
      maxTurns: 8,
    },
  };

  const session = createSession();
  const dialogue = [
    "Прочитай NOTES.md и запомни правило.",
    "Какое там правило?",
    "Создай Makefile с целью test (python3 -m unittest discover -s tests) и tests/test_app.py с одним проходящим тестом. Правило из NOTES.md учитывай, но git-хуки не добавляй.",
  ];

  let tasks = 0;
  let replies = 0;
  let generals = 0;
  const routes: string[] = [];
  const failures: string[] = [];
  try {
    for (const [index, line] of dialogue.entries()) {
      console.info(`\n=== user: ${line}`);
      const result = await runSessionTurn(deps, session, line);
      console.info(`  session turns=${result.interpretation?.turns ?? 0}`);
      if (result.interpretation !== undefined) printSessionJournal(result.interpretation.journal);
      const route = result.operation?.kind ?? "none";
      routes.push(route);
      console.info(`  operation=${JSON.stringify(result.operation)}`);
      if (result.reasoning !== undefined) console.info(`  reasoning=${result.reasoning}`);
      console.info(`  applied=${JSON.stringify(result.applied)}`);
      if (result.reply !== undefined) {
        replies += 1;
        console.info(`  reply=${result.reply}`);
      }
      if (result.general !== undefined) {
        generals += 1;
        console.info(
          `  general ${result.general.unitId}: ${result.general.result.stopReason ?? "?"} after ${result.general.result.turns} turns`,
        );
        printTaskEvents(result.general.result.events);
        const answer = lastStop(result.general.result.events);
        if (answer !== undefined) console.info(`  general answer: ${short(answer)}`);
      }
      if (result.task !== undefined) {
        tasks += 1;
        const unit = unitOf(session, result.task.unitId);
        console.info(`  task request: ${requestText(unit.journal)}`);
        printTaskEvents(result.task.result.events);
        console.info(
          `  task ${result.task.unitId}: ${result.task.result.stopReason ?? "?"} after ${result.task.result.turns} turns`,
        );
        const answer = lastStop(result.task.result.events);
        if (answer !== undefined) console.info(`  task answer: ${short(answer)}`);
      }
      console.info(`  session outline:\n${sessionOutline(session)}`);

      if (index === 0 && route !== "general") failures.push("read was not routed to general");
      if (index === 0 && result.task !== undefined) failures.push("read opened a coding task");
      if (index === 0 && result.general === undefined) failures.push("read opened no general unit");
      if (index === 1 && route !== "respond") failures.push("follow-up was not routed to respond");
      if (index === 1 && result.reply === undefined) failures.push("follow-up produced no reply");
      if (index === 2 && route !== "start") failures.push("Makefile request was not routed to start");
      if (index === 2 && result.task === undefined) failures.push("Makefile request opened no coding task");
    }

    console.info(`\n=== applied file ===\n${workspace.ws.read("src/app.txt")}`);
    console.info(
      `\nroutes=${JSON.stringify(routes)} tasks=${tasks} general=${generals} replies=${replies} utteranceSeq=${session.utteranceSeq}`,
    );
    if (routes.join(",") !== "general,respond,start") {
      failures.push(`unexpected route order: ${routes.join(",")}`);
    }
    if (tasks !== 1) failures.push(`expected one coding task, got ${tasks}`);
    if (generals !== 1) failures.push(`expected one general unit, got ${generals}`);
    if (replies !== 1) failures.push(`expected one reply, got ${replies}`);
    if (attentionOf(session, "g1") !== "completed") failures.push("g1 is not completed");
    if (attentionOf(session, "r1") !== "completed") failures.push("r1 is not completed");
    if (failures.length > 0) {
      console.error(`\nFAIL:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
      process.exitCode = 1;
    } else {
      console.info("\nOK: general, respond and start routes all exercised.");
    }
  } finally {
    cleanupWorkspaces();
  }
}

await main();
