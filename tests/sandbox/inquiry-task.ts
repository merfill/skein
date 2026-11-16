// Manual Docker run of the inquiry unit on a real terminal-bench task.
//
// Usage:
//   npm run inquiry:docker
//
// Runs `fix-git` K=3 in parallel (cells, not a shell loop), network off, maxTurns 60, and
// saves events/result/tree/check per run under SKEIN_INQUIRY_SAVE. This is a live, heavy run:
// Docker image + task cache + provider key are required.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ModelMessage } from "ai";

import { loadSettings } from "../../src/config/settings";
import { fold } from "../../src/ir/graph";
import { inquiryMessages, type InquiryResult } from "../../src/inquiry";
import { createChatModel } from "../../src/llm/client";
import { modelInquiryProposer, type InquiryProposer } from "../../src/llm/inquiry";
import { cleanupContainers, dockerAvailable, dockerImageAvailable } from "./docker";
import { runInquiryTask, taskAvailable } from "./harness";
import { fixGit } from "./tasks/fix-git";
import { cleanupSandboxes } from "./workspace";

const SAVE = resolve(process.env.SKEIN_INQUIRY_SAVE ?? "/tmp/skein-inquiry-docker-k3");
const REPEAT = Number(process.env.SKEIN_INQUIRY_REPEAT ?? 3);
const MAX_TURNS = Number(process.env.SKEIN_INQUIRY_MAX_TURNS ?? 60);

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cost: number;
}

function messageText(message: ModelMessage): string {
  return typeof message.content === "string" ? message.content : "";
}

function treeText(result: InquiryResult, request: { id: string; text: string }): string {
  const messages = inquiryMessages(fold(result.events), request);
  return messages
    .filter((message) => message.role === "system")
    .map(messageText)
    .filter((text) => text.startsWith("CLOSED") || text.startsWith("OPEN"))
    .join("\n\n");
}

async function runOne(
  index: number,
  chat: ReturnType<typeof createChatModel>,
  settings: ReturnType<typeof loadSettings>,
): Promise<{
  reward: number;
  turns: number;
  open: number;
  usage: UsageTotals;
  final: string;
}> {
  const base = modelInquiryProposer(chat, { settings });
  const usage: UsageTotals = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cost: 0 };
  const propose: InquiryProposer = async (messages, options) => {
    const proposals = await base(messages, options);
    usage.inputTokens += proposals.usage?.inputTokens ?? 0;
    usage.outputTokens += proposals.usage?.outputTokens ?? 0;
    usage.cachedInputTokens += proposals.usage?.cachedInputTokens ?? 0;
    usage.cost += proposals.usage?.cost ?? 0;
    return proposals;
  };

  const run = await runInquiryTask(fixGit, propose, { maxTurns: MAX_TURNS, network: "off" });
  const dir = join(SAVE, `r${index + 1}`);
  mkdirSync(dir, { recursive: true });
  const tree = treeText(run.result, { id: "r1", text: run.request });
  writeFileSync(join(dir, "events.ndjson"), run.result.events.map((event) => JSON.stringify(event)).join("\n"));
  writeFileSync(
    join(dir, "result.json"),
    JSON.stringify(
      {
        reward: run.reward,
        rewardSource: run.rewardSource,
        acceptance: run.acceptance,
        final: run.result.final,
        stopReason: run.result.stopReason,
        turns: run.result.turns,
        unresolved: run.result.unresolved,
        usage,
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, "tree.txt"), `${tree}\n`);
  writeFileSync(join(dir, "task.txt"), `${run.request}\n`);
  writeFileSync(join(dir, "check.out.txt"), `${run.check.stdout}${run.check.stderr}`);
  writeFileSync(join(dir, "reward.txt"), `${run.reward}\n`);

  console.log(
    `run ${index + 1}: reward=${run.reward} turns=${run.result.turns} open=${run.result.unresolved.length} in=${usage.inputTokens} out=${usage.outputTokens} cache=${usage.cachedInputTokens} cost=${usage.cost.toFixed(2)}`,
  );
  return {
    reward: run.reward,
    turns: run.result.turns,
    open: run.result.unresolved.length,
    usage,
    final: run.result.final,
  };
}

async function main(): Promise<void> {
  const image = fixGit.image ?? "";
  if (!dockerAvailable()) throw new Error("Docker is not available");
  if (!dockerImageAvailable(image)) throw new Error(`Docker image is not available: ${image}`);
  if (!taskAvailable("fix-git")) throw new Error("the fix-git task cache is not available");
  const settings = loadSettings();
  if (settings.apiKey === "") throw new Error("SKEIN_API_KEY is empty");

  mkdirSync(SAVE, { recursive: true });
  const chat = createChatModel(settings);
  try {
    const results = await Promise.all(
      Array.from({ length: REPEAT }, (_, index) => runOne(index, chat, settings)),
    );
    const solved = results.filter((run) => run.reward === 1).length;
    const turns = results.reduce((sum, run) => sum + run.turns, 0);
    const input = results.reduce((sum, run) => sum + run.usage.inputTokens, 0);
    const output = results.reduce((sum, run) => sum + run.usage.outputTokens, 0);
    const cache = results.reduce((sum, run) => sum + run.usage.cachedInputTokens, 0);
    const cost = results.reduce((sum, run) => sum + run.usage.cost, 0);
    const open = results.reduce((sum, run) => sum + run.open, 0);
    console.log("");
    console.log(
      `K=${REPEAT} solved=${solved}/${REPEAT} turns=${turns} open=${open} in=${input} out=${output} cache=${cache} cost=${cost.toFixed(2)}`,
    );
    console.log(`saved=${SAVE}`);
  } finally {
    cleanupContainers();
    cleanupSandboxes();
  }
}

await main();
