import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { TurnMeter } from "../../bench/metrics";
import { loadSettings } from "../../src/config/settings";
import type { Context } from "../../src/ir/project";
import { createChatModel } from "../../src/llm/client";
import type { Proposals } from "../../src/llm/schemas";
import { buildMessages, promptText, propose as proposeModel } from "../../src/loop/propose";
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
  // Recorded in `metrics.json` for traceability: "off" means the host-side tools (`fetch`,
  // background `run`) were denied the internet by the CLI's allowlist proxy.
  network?: "on" | "off";
}

export async function runLiveTask(task: SandboxTask, options: LiveTaskOptions): Promise<LiveTaskResult> {
  const settings = loadSettings();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = options.dir ?? join("bench", "runs", "sandbox-tasks", `${ts}-${task.id}`);
  mkdirSync(dir, { recursive: true });

  // The provider's hidden reasoning text (`choices[0].message.reasoning`) is dropped by the
  // parsed message; capture it turn by turn so a run stays debuggable.
  let currentTurn = 0;
  const captureReasoning = (body: unknown): void => {
    const message = (body as { choices?: { message?: { reasoning?: unknown } }[] }).choices?.[0]?.message;
    const reasoning = message?.reasoning;
    if (typeof reasoning === "string" && reasoning !== "") {
      writeFileSync(join(dir, "reasoning.ndjson"), `${JSON.stringify({ turn: currentTurn, reasoning })}\n`, { flag: "a" });
    }
  };
  const model = createChatModel(settings, { onResponseBody: captureReasoning });
  const rebuild = (maxTokens: number, opts?: { reasoningOff?: boolean }) =>
    createChatModel(
      { ...settings, maxTokens, ...(opts?.reasoningOff === true ? { reasoningEffort: "none" } : {}) },
      { onResponseBody: captureReasoning },
    );

  const meter = new TurnMeter();
  const turns: TurnMetric[] = [];
  let turn = 0;
  const propose = async (context: Context): Promise<Proposals> => {
    currentTurn = turn;
    // Log the full model-facing context: the rendered messages (system base + node
    // instruction + constraints + the tape), plus the raw projection inputs.
    const messages = buildMessages(context);
    // A native move is an `assistant.tool_calls` message with an EMPTY content, so the call
    // must be logged explicitly or the trace shows a blank `ai` turn (the command lives in
    // `tool_calls`, the result in the following `tool` turn).
    const rendered = messages.map((message) => {
      const call = (message as { tool_calls?: { name: string; args: unknown; id: string }[] }).tool_calls;
      const callId = (message as { tool_call_id?: string }).tool_call_id;
      return {
        type: message.getType(),
        content: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
        ...(call !== undefined ? { tool_calls: call } : {}),
        ...(callId !== undefined ? { tool_call_id: callId } : {}),
      };
    });
    const chars = promptText(context).length;
    writeFileSync(
      join(dir, "contexts.ndjson"),
      `${JSON.stringify({ turn, chars, situation: context.situation, constraints: context.constraints, history: context.history, messages: rendered })}\n`,
      { flag: "a" },
    );
    mkdirSync(join(dir, "contexts"), { recursive: true });
    writeFileSync(
      join(dir, "contexts", `t${String(turn).padStart(3, "0")}.txt`),
      rendered
        .map((message) => {
          const lines = [`===== ${message.type} =====`];
          if (message.content !== "") lines.push(message.content);
          for (const call of message.tool_calls ?? []) {
            lines.push(`-> call ${call.name}(${JSON.stringify(call.args)}) [id ${call.id}]`);
          }
          if (message.tool_call_id !== undefined) lines.push(`(answers call ${message.tool_call_id})`);
          return lines.join("\n");
        })
        .join("\n\n"),
    );
    const before = snapshot(meter);
    const proposal = await proposeModel(model, context, {
      settings,
      rebuild,
      callbacks: [meter],
      // Surface every thrown call (including ones a retry recovers from) so provider
      // instability is visible in the run log instead of only on the final give-up.
      onError: (error) => {
        console.error(`[${task.id}] llm call failed: ${error instanceof Error ? error.message : String(error)}`);
      },
    });
    const usage = delta(snapshot(meter), before);
    const action = proposal.actions[0]!;
    const tools = proposal.actions.map((a) => (a.operator === "apply" ? a.action.tool : a.operator));
    const tool = tools[0] ?? (action.operator === "apply" ? action.action.tool : action.operator);
    turns.push({ turn, operator: action.operator, tool, tools, chars, refused: false, ...usage });
    if (options.quiet !== true) {
      console.info(`[${task.id}] t${turn} ${action.operator}/${tools.join("+")} in=${usage.inputTokens} out=${usage.outputTokens} reason=${usage.reasoningTokens} chars=${chars}`);
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
    JSON.stringify({ task: task.id, network: options.network ?? "on", reward: run.reward, stopReason: run.result.stopReason, stopText: run.result.stopText ?? null, turns: turns.length, ...summary, perTurn: turns }, null, 2),
  );
  writeFileSync(
    join(dir, "result.json"),
    JSON.stringify({ stopReason: run.result.stopReason, stopText: run.result.stopText ?? null, reward: run.reward, check: run.check, events: run.result.events }, null, 2),
  );
  return {
    task: task.id,
    reward: run.reward,
    stopReason: run.result.stopReason,
    turns: turns.length,
    summary,
    elapsedMs,
    dir,
    ...(run.result.stopText != null ? { error: run.result.stopText } : {}),
  };
}
