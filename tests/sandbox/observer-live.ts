import type { ModelMessage } from "ai";

import { loadSettings } from "../../src/config/settings";
import { createChatModel } from "../../src/llm/client";
import { modelRequestObserver } from "../../src/llm/observer";
import { fold } from "../../src/ir/graph";
import { project } from "../../src/ir/project";
import { applyReaction } from "../../src/session/apply";
import {
  buildObserverMessages,
  defaultObserverTools,
  projectObserver,
  runRequestObserver,
  type RequestObserver,
} from "../../src/session/observer";
import { createSession, openUnit, recordTrigger } from "../../src/session/session";
import { detectTriggers } from "../../src/session/triggers";
import { cleanupWorkspaces } from "../ops/helpers";
import { entryCycleScenario, longStateScenario } from "./observer-fixtures";

function textOf(message: ModelMessage): string {
  return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}

async function main(): Promise<void> {
  if (process.env.SKEIN_LIVE !== "true") {
    console.error("Set SKEIN_LIVE=true to run the live observer scenario.");
    process.exit(1);
  }

  const name = process.argv[2] === "long" ? "long" : "entry";
  const scenario = name === "long" ? longStateScenario() : entryCycleScenario();
  const session = createSession();
  openUnit(session, "r1", "task");
  const triggers = detectTriggers(
    { state: scenario.state, session, unitId: "r1", turn: scenario.turn },
    { maxTurns: 100 },
  );
  console.info(`scenario=${scenario.name} turn=${scenario.turn} triggers=${triggers.map((t) => t.kind).join(",")}`);
  const trigger = triggers[0];
  if (trigger === undefined) {
    console.error("no trigger fired");
    cleanupWorkspaces();
    process.exit(1);
  }
  recordTrigger(session, "r1", scenario.turn, trigger);

  const settings = loadSettings();
  const model = createChatModel(settings);
  const live = modelRequestObserver(model, { settings });
  const agent: RequestObserver = async (messages) => {
    console.info("\n=== observer messages ===");
    for (const message of messages) console.info(`[${message.role}] ${textOf(message)}`);
    const reply = await live(messages);
    console.info(`=== observer reply ===\n${JSON.stringify(reply, null, 2)}`);
    return reply;
  };

  const result = await runRequestObserver({
    trigger,
    state: scenario.state,
    tools: defaultObserverTools,
    agent,
    events: scenario.events,
  });
  console.info(`observer turns=${result.turns}`);
  console.info(`observer journal events=${result.journal.length}`);
  console.info(`observer decision=${JSON.stringify(result.decision)}`);

  if (result.decision === undefined) {
    console.error("observer returned no decision");
    cleanupWorkspaces();
    process.exit(1);
  }
  if (result.decision.kind === "halt") {
    console.info("halt: no task event to apply");
  } else {
    const applied = applyReaction({
      state: scenario.state,
      reaction: result.decision,
      sourceUnit: "observer:live",
    });
    console.info(`applied=${JSON.stringify(applied)}`);
    if (!applied.ok) {
      cleanupWorkspaces();
      process.exit(1);
    }
    const context = project(fold([...scenario.events, ...applied.events]));
    const advisories = context.history
      .filter((message) => message.role === "system" && message.text.startsWith("Tape-agent"))
      .map((message) => message.text);
    console.info(`tape advisories=${JSON.stringify(advisories)}`);
    if (advisories.length === 0) {
      cleanupWorkspaces();
      process.exit(1);
    }
  }

  const projected = projectObserver(trigger, result.journal);
  console.info(`observer seed messages=${buildObserverMessages(projected).length}`);
  cleanupWorkspaces();
}

await main();
