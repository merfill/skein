// The real inquiry unit, one turn at a time, on a ported terminal-bench task.
//
// The unit and the projection run on the HOST; only the tool calls execute in the task's
// long-lived container. The process opens the task once and keeps the workspace and the
// container alive across turns; every pause is the next `propose` of the same journal.
//
//   npx tsx tests/sandbox/inquiry-step.ts <task-id> [--turn N] [--auto] [--net on|off]
//                                        [--dir <trace-dir>] [--signal <file>]
//
// Before each model call it writes the exact messages to `<dir>/contexts/tNNN.txt` and the
// allowed tools plus the provider's real wire tools to `<dir>/turns.ndjson`; after each turn
// it appends the engine's journal. Without `--auto` it waits for `<signal>` (default
// `<dir>/continue`) or `<dir>/quit`. `--turn N` stops after the Nth unit turn.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ModelMessage } from "ai";

import { loadSettings } from "../../src/config/settings";
import { fold } from "../../src/ir/graph";
import { inquiryMessages, runInquiryUnit, type InquiryResult } from "../../src/inquiry";
import { createChatModel } from "../../src/llm/client";
import { modelInquiryProposer, type InquiryProposer } from "../../src/llm/inquiry";
import type { Event } from "../../src/ir/events";
import { cleanupContainers, dockerAvailable, dockerImageAvailable } from "./docker";
import { openTaskWorkspace, taskAvailable, verifyOpenedTask } from "./harness";
import { parseNetworkMode } from "./network";
import { TASKS } from "./tasks/registry";
import { cleanupSandboxes } from "./workspace";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const taskId = process.argv[2]?.startsWith("--") === false ? (process.argv[2] as string) : "custom-memory-heap-crash";
const stopTurn = Number(arg("--turn", "0"));
const auto = process.argv.includes("--auto");
const net = parseNetworkMode(arg("--net", "off"));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = resolve(arg("--dir", join("bench", "runs", "inquiry-step", `${stamp}-${taskId}`)));
const signal = resolve(arg("--signal", join(dir, "continue")));
const quit = join(dir, "quit");
const maxTurns = Number(process.env.SKEIN_INQUIRY_MAX_TURNS ?? "0");
mkdirSync(join(dir, "contexts"), { recursive: true });
mkdirSync(join(dir, "journal"), { recursive: true });

const pad = (n: number): string => String(n).padStart(3, "0");

const render = (messages: readonly ModelMessage[]): string =>
  messages
    .map((message) => {
      const lines = [`===== ${message.role} =====`];
      if (typeof message.content === "string") {
        if (message.content !== "") lines.push(message.content);
      } else {
        for (const part of message.content) {
          if (part.type === "text" || part.type === "reasoning") {
            if (part.text !== "") lines.push(part.text);
          } else if (part.type === "tool-call") {
            lines.push(`-> call ${part.toolName}(${JSON.stringify(part.input)}) [id ${part.toolCallId}]`);
          } else if (part.type === "tool-result") {
            lines.push(`(answers ${part.toolCallId})`);
            const value = (part.output as { value?: unknown } | undefined)?.value;
            if (typeof value === "string" && value !== "") lines.push(value);
          }
        }
      }
      return lines.join("\n");
    })
    .join("\n\n");

function treeText(result: InquiryResult, request: { id: string; text: string }): string {
  return inquiryMessages(fold(result.events), request)
    .filter((message) => message.role === "system")
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .filter(
      (text) =>
        text.startsWith("Opening hypothesis") ||
        text.startsWith("Closing hypothesis") ||
        text.startsWith("Closing formula H"),
    )
    .join("\n\n");
}

function wireToolNames(body: Record<string, unknown>): string[] {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return tools
    .map((tool) => {
      const fn = (tool as { function?: { name?: unknown } } | undefined)?.function;
      return typeof fn?.name === "string" ? fn.name : "";
    })
    .filter((name) => name !== "");
}

async function main(): Promise<void> {
  const task = TASKS[taskId];
  if (task === undefined) throw new Error(`unknown task ${taskId}; known: ${Object.keys(TASKS).join(", ")}`);
  const image = task.image ?? "";
  if (!dockerAvailable()) throw new Error("Docker is not available");
  if (!dockerImageAvailable(image)) throw new Error(`Docker image is not available: ${image}`);
  if (!taskAvailable(taskId)) throw new Error(`the ${taskId} task cache is not available`);

  const settings = loadSettings();
  if (settings.apiKey === "") throw new Error("SKEIN_API_KEY is empty; set it in .env");

  console.info(`[inquiry-step] opening ${task.id} (network ${net})…`);
  const opened = openTaskWorkspace(task, { network: net });
  const { workspace, request } = opened;
  console.info(`[inquiry-step] ready: root=${opened.root} container=${(workspace as { name?: string }).name ?? "(none)"}`);
  console.info(`[inquiry-step] trace: ${dir}`);

  const controller = new AbortController();
  const wireByCall = new Map<number, string[][]>();
  let call = 0;
  let activeCall = 0;
  const chat = createChatModel(settings, {
    onWire: (body) => {
      const list = wireByCall.get(activeCall) ?? [];
      list.push(wireToolNames(body));
      wireByCall.set(activeCall, list);
    },
  });
  const base = modelInquiryProposer(chat, { settings });
  const usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cost: 0 };

  const propose: InquiryProposer = async (messages, options) => {
    const index = call;
    call += 1;
    activeCall = index;
    const turn = options?.turn ?? 0;
    const contextFile = join(dir, "contexts", `t${pad(turn)}.txt`);
    const file = existsSync(contextFile)
      ? join(dir, "contexts", `t${pad(turn)}.repair.txt`)
      : contextFile;
    writeFileSync(file, `${render(messages)}\n`);
    console.info(
      `[inquiry-step] t${turn} call ${index} proposing: ` +
        `${(options?.allowedTools ?? []).join(", ")}`,
    );
    if (!auto) {
      console.info(`[inquiry-step] waiting: touch ${signal} for the next call, or ${quit} to stop`);
      while (!existsSync(signal) && !existsSync(quit)) await sleep(250);
      rmSync(signal, { force: true });
      if (existsSync(quit)) {
        controller.abort();
        throw new Error("quit");
      }
    }
    if (controller.signal.aborted) throw new Error("quit");
    const started = Date.now();
    const proposals = await base(messages, options);
    const ms = Date.now() - started;
    usage.inputTokens += proposals.usage?.inputTokens ?? 0;
    usage.outputTokens += proposals.usage?.outputTokens ?? 0;
    usage.cachedInputTokens += proposals.usage?.cachedInputTokens ?? 0;
    usage.cost += proposals.usage?.cost ?? 0;
    writeFileSync(
      join(dir, "turns.ndjson"),
      `${JSON.stringify({
        call: index,
        turn,
        allowedTools: [...(options?.allowedTools ?? [])],
        wireTools: wireByCall.get(index) ?? [],
        ms,
        actions: proposals.actions,
        thought: proposals.thought,
        reasoning: proposals.reasoning,
        usage: proposals.usage,
      })}\n`,
      { flag: "a" },
    );
    if (proposals.reasoning !== undefined && proposals.reasoning !== "") {
      writeFileSync(
        join(dir, "reasoning.ndjson"),
        `${JSON.stringify({ call: index, turn, reasoning: proposals.reasoning })}\n`,
        { flag: "a" },
      );
    }
    return proposals;
  };

  let written = 0;
  const onTurn = (events: readonly Event[], turn: number): void => {
    const fresh = events.slice(written);
    written = events.length;
    writeFileSync(join(dir, "journal", `t${pad(turn)}.json`), `${JSON.stringify(events, null, 2)}\n`);
    writeFileSync(
      join(dir, "journal.ndjson"),
      `${JSON.stringify({ turn, events: fresh })}\n`,
      { flag: "a" },
    );
    console.info(`[inquiry-step] t${turn} done (${fresh.length} new events)`);
    if (stopTurn > 0 && turn >= stopTurn) controller.abort();
  };

  let result: InquiryResult | undefined;
  try {
    result = await runInquiryUnit(
      {
        propose,
        workspace,
        maxTurns: maxTurns > 0 ? maxTurns : (task.maxTurns ?? 60),
        onTurn,
      },
      { request: { id: "r1", text: request }, signal: controller.signal },
    );

    const verification = verifyOpenedTask(task, opened);
    const tree = treeText(result, { id: "r1", text: request });
    writeFileSync(join(dir, "events.ndjson"), result.events.map((event) => JSON.stringify(event)).join("\n"));
    writeFileSync(
      join(dir, "result.json"),
      JSON.stringify(
        {
          task: taskId,
          reward: verification.reward,
          rewardSource: verification.rewardSource,
          acceptance: verification.acceptance,
          stopReason: result.stopReason,
          paused: result.paused ?? false,
          turns: result.turns,
          unresolved: result.unresolved,
          final: result.final,
          usage,
        },
        null,
        2,
      ),
    );
    writeFileSync(join(dir, "tree.txt"), `${tree}\n`);
    writeFileSync(join(dir, "task.txt"), `${request}\n`);
    writeFileSync(join(dir, "check.out.txt"), `${verification.check.stdout}${verification.check.stderr}`);
    writeFileSync(join(dir, "reward.txt"), `${verification.reward}\n`);
    console.info(
      `[inquiry-step] stop=${result.stopReason ?? (result.paused ? "paused" : "?")} ` +
        `turns=${result.turns} open=${result.unresolved.length} reward=${verification.reward} ` +
        `cost=${usage.cost.toFixed(2)}`,
    );
    console.info(`[inquiry-step] contexts: ${join(dir, "contexts")}; turns: ${join(dir, "turns.ndjson")}`);
  } finally {
    cleanupContainers();
    cleanupSandboxes();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
