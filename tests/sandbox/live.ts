import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { TurnMeter } from "../../bench/metrics";
import { loadSettings } from "../../src/config/settings";
import type { Context } from "../../src/ir/project";
import { createChatModel } from "../../src/llm/client";
import type { Proposal } from "../../src/llm/schemas";
import { invokeTools } from "../../src/llm/structured";
import { buildMessages, promptText } from "../../src/loop/propose";
import { runTask } from "./harness";
import { delta, snapshot, summarize, type MetricsSummary, type TurnMetric } from "./metrics";
import type { SandboxTask } from "./task";

// One live run of a ported task with the real model, writing a trace dir and returning the
// metrics. Shared by the single-task CLI (`sandbox-run.ts`) and the parallel batch
// (`sandbox-smoke.ts`). Cost discipline: docs/testing.md §3.5–3.6.

export interface LiveTaskResult {
  task: string;
  reward: number;
  stopReason: string | null;
  turns: number;
  summary?: MetricsSummary;
  elapsedMs: number;
  dir: string;
  error?: string;
}

export interface LiveTaskOptions {
  maxTurns: number;
  dir?: string;
  quiet?: boolean;
}

export async function runLiveTask(task: SandboxTask, options: LiveTaskOptions): Promise<LiveTaskResult> {
  const settings = loadSettings();
  const model = createChatModel(settings);
  const rebuild = (maxTokens: number) => createChatModel({ ...settings, maxTokens });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = options.dir ?? join("bench", "runs", "sandbox-tasks", `${ts}-${task.id}`);
  mkdirSync(dir, { recursive: true });

  const meter = new TurnMeter();
  const turns: TurnMetric[] = [];
  let turn = 0;
  const propose = async (context: Context): Promise<Proposal> => {
    const chars = promptText(context).length;
    writeFileSync(join(dir, "contexts.ndjson"), `${JSON.stringify({ turn, chars, context })}\n`, { flag: "a" });
    const before = snapshot(meter);
    const proposal = await invokeTools(model, buildMessages(context), { settings, rebuild, callbacks: [meter] });
    const usage = delta(snapshot(meter), before);
    const action = proposal.action;
    const tool = action.operator === "apply" ? action.action.tool : action.operator;
    turns.push({ turn, operator: action.operator, tool, chars, refused: false, ...usage });
    if (options.quiet !== true) {
      console.info(`[${task.id}] t${turn} ${action.operator}/${tool} in=${usage.inputTokens} out=${usage.outputTokens} reason=${usage.reasoningTokens} chars=${chars}`);
    }
    turn += 1;
    return proposal;
  };

  const started = Date.now();
  const run = await runTask(task, propose, { maxTurns: options.maxTurns });
  const elapsedMs = Date.now() - started;
  const refused = new Set(
    run.result.events
      .filter((event) => event.type === "record_rejection")
      .map((event) => (event as { turn?: number }).turn ?? -1),
  );
  for (const record of turns) record.refused = refused.has(record.turn);

  const summary = summarize(turns);
  writeFileSync(join(dir, "reward.txt"), `${run.reward}\n`);
  writeFileSync(
    join(dir, "metrics.json"),
    JSON.stringify({ task: task.id, reward: run.reward, stopReason: run.result.stopReason, turns: turns.length, ...summary, perTurn: turns }, null, 2),
  );
  writeFileSync(
    join(dir, "result.json"),
    JSON.stringify({ stopReason: run.result.stopReason, reward: run.reward, check: run.check, events: run.result.events }, null, 2),
  );
  return { task: task.id, reward: run.reward, stopReason: run.result.stopReason, turns: turns.length, summary, elapsedMs, dir };
}
