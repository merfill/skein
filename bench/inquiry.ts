// Manual inquiry runner: a coding unit that works by hypotheses, bypassing the session.
//
// Usage:
//   npm run inquiry -- "<task>" [--dir <workspace>] [--max-turns N]
//                     [--model provider/model] [--provider id] [--base-url URL]
//                     [--dry] [--tree] [--save <dir>]
//
// `--dry` builds and prints the first prompt without calling a model. `--tree` prints the
// CLOSED/OPEN projection after the run. `--save` writes events.ndjson, result.json and
// tree.txt for later inspection. A live run uses the configured provider (`.env` / auth
// config) and prints the final text plus a short summary.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadSettings, type Settings } from "../src/config/settings";
import { emptyState, fold } from "../src/ir/graph";
import { inquiryMessages, runInquiryUnit, type InquiryResult } from "../src/inquiry";
import { createChatModel } from "../src/llm/client";
import { modelInquiryProposer } from "../src/llm/inquiry";
import type { ModelMessage } from "ai";
import { fsWorkspace } from "../src/tools/workspace";

interface Args {
  task: string;
  dir: string;
  maxTurns?: number;
  model?: string;
  provider?: string;
  baseURL?: string;
  dry: boolean;
  tree: boolean;
  save?: string;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { task: "", dir: process.cwd(), dry: false, tree: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--dir" && value !== undefined) {
      args.dir = value;
      index += 1;
    } else if (flag === "--max-turns" && value !== undefined) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) args.maxTurns = parsed;
      index += 1;
    } else if (flag === "--model" && value !== undefined) {
      args.model = value;
      index += 1;
    } else if (flag === "--provider" && value !== undefined) {
      args.provider = value;
      index += 1;
    } else if (flag === "--base-url" && value !== undefined) {
      args.baseURL = value;
      index += 1;
    } else if (flag === "--dry") {
      args.dry = true;
    } else if (flag === "--tree") {
      args.tree = true;
    } else if (flag === "--save" && value !== undefined) {
      args.save = value;
      index += 1;
    } else if (flag !== undefined && !flag.startsWith("--") && args.task === "") {
      args.task = flag;
    }
  }
  return args;
}

function taskText(task: string): string {
  if (!task.startsWith("@")) return task;
  const path = resolve(task.slice(1));
  return readFileSync(path, "utf8").trim();
}

function checkDir(dir: string): string {
  const full = resolve(dir);
  const stat = statSync(full);
  if (!stat.isDirectory()) throw new Error(`workspace is not a directory: ${full}`);
  return full;
}

function messageText(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => {
      if (part.type === "text" || part.type === "reasoning") return part.text;
      if (part.type === "tool-call") {
        return `-> call ${part.toolName}(${JSON.stringify(part.input)}) [${part.toolCallId}]`;
      }
      if (part.type === "tool-result") {
        const output = part.output as { value?: unknown } | undefined;
        return `(answers ${part.toolCallId}) ${typeof output?.value === "string" ? output.value : JSON.stringify(output?.value ?? "")}`;
      }
      return "";
    })
    .join("\n");
}

function printPrompt(messages: readonly ModelMessage[]): void {
  for (const message of messages) {
    console.log(`--- ${message.role} ---`);
    console.log(messageText(message));
  }
}

function treeText(result: InquiryResult, request: { id: string; text: string }): string {
  const messages = inquiryMessages(fold(result.events), request);
  return messages
    .filter((message) => message.role === "system")
    .map((message) => messageText(message))
    .filter((text) => text.startsWith("CLOSED") || text.startsWith("OPEN"))
    .join("\n\n");
}

function settingsFor(args: Args): Settings {
  const base = loadSettings();
  return {
    ...base,
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.provider !== undefined ? { providerId: args.provider } : {}),
    ...(args.baseURL !== undefined ? { apiUrl: args.baseURL } : {}),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.task === "") {
    console.error(
      'usage: npm run inquiry -- "<task>" [--dir <workspace>] [--max-turns N] [--model id] [--provider id] [--base-url URL] [--dry]',
    );
    process.exit(1);
  }
  const request = { id: "r1", text: taskText(args.task) };
  const dir = checkDir(args.dir);
  const settings = settingsFor(args);
  if (args.dry) {
    printPrompt(inquiryMessages(emptyState(), request));
    return;
  }
  if (settings.apiKey === "") {
    console.error("SKEIN_API_KEY is empty; set it in .env or use --dry");
    process.exit(1);
  }

  const workspace = fsWorkspace(dir);
  const chat = createChatModel(settings);
  const base = modelInquiryProposer(chat, { settings });
  const usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; cost: number } = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cost: 0,
  };
  const propose = async (messages: Parameters<typeof base>[0], options?: Parameters<typeof base>[1]) => {
    const proposals = await base(messages, options);
    const used = proposals.usage;
    usage.inputTokens += used?.inputTokens ?? 0;
    usage.outputTokens += used?.outputTokens ?? 0;
    usage.cachedInputTokens += used?.cachedInputTokens ?? 0;
    usage.cost += used?.cost ?? 0;
    return proposals;
  };

  const result = await runInquiryUnit(
    { propose, workspace, maxTurns: args.maxTurns ?? settings.maxTurns },
    { request },
  );

  console.log(result.final);
  console.log("");
  console.log(`stop=${result.stopReason ?? "none"} turns=${result.turns}`);
  if (result.unresolved.length > 0) {
    console.log("unresolved:");
    for (const claim of result.unresolved) console.log(`  ${claim.id} ${claim.kind}: ${claim.suppose}`);
  }
  console.log(
    `tokens in=${usage.inputTokens} out=${usage.outputTokens} cache=${usage.cachedInputTokens} cost=${usage.cost.toFixed(2)}`,
  );
  const tree = treeText(result, request);
  if (args.tree && tree !== "") {
    console.log("");
    console.log(tree);
    console.log("");
  }
  if (args.save !== undefined) {
    const dir = resolve(args.save);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "events.ndjson"), result.events.map((event) => JSON.stringify(event)).join("\n"));
    writeFileSync(
      join(dir, "result.json"),
      JSON.stringify(
        {
          final: result.final,
          stopReason: result.stopReason,
          turns: result.turns,
          unresolved: result.unresolved,
          usage,
        },
        null,
        2,
      ),
    );
    writeFileSync(join(dir, "tree.txt"), `${tree}\n`);
    writeFileSync(join(dir, "task.txt"), `${request.text}\n`);
    console.log(`saved=${dir}`);
  }
}

await main();
