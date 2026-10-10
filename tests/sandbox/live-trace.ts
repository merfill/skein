import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { TurnMeter } from "../../bench/metrics";
import { loadSettings } from "../../src/config/settings";
import type { Context } from "../../src/ir/project";
import { createChatModel } from "../../src/llm/client";
import type { Proposal } from "../../src/llm/schemas";
import { invokeTools } from "../../src/llm/structured";
import { buildMessages, promptText } from "../../src/loop/propose";
import { delta, snapshot, summarize, type TurnMetric } from "./metrics";
import { runSandbox } from "./run";
import { FIX_OCAML_REQUEST, fixOcamlGc } from "./specs/fix-ocaml-gc";

// Runs the fix-ocaml-gc sandbox with the live model and dumps a detailed per-turn trace,
// for looking at model behaviour without Docker:
//   npx tsx tests/sandbox/live-trace.ts
// Cost discipline and the metric definitions are in docs/testing.md §3.5 (sandbox).

function brief(value: unknown, max = 240): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function main(): Promise<void> {
  const settings = loadSettings();
  const model = createChatModel(settings);
  const rebuild = (maxTokens: number, opts?: { reasoningOff?: boolean }) =>
    createChatModel({ ...settings, maxTokens, ...(opts?.reasoningOff === true ? { reasoningEffort: "none" } : {}) });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join("bench", "runs", `sandbox-live-${ts}-fix-ocaml-gc`);
  mkdirSync(dir, { recursive: true });

  const meter = new TurnMeter();
  const turns: TurnMetric[] = [];
  let turn = 0;
  const propose = async (context: Context): Promise<Proposal> => {
    // Log the full model-facing context content (rendered messages) alongside the raw inputs.
    const messages = buildMessages(context);
    const rendered = messages.map((message) => ({
      type: message.getType(),
      content: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    }));
    const chars = promptText(context).length;
    writeFileSync(
      join(dir, "contexts.ndjson"),
      `${JSON.stringify({ turn, chars, situation: context.situation, constraints: context.constraints, history: context.history, messages: rendered })}\n`,
      { flag: "a" },
    );
    mkdirSync(join(dir, "contexts"), { recursive: true });
    writeFileSync(
      join(dir, "contexts", `t${String(turn).padStart(3, "0")}.txt`),
      rendered.map((message) => `===== ${message.type} =====\n${message.content}`).join("\n\n"),
    );
    const before = snapshot(meter);
    const proposal = await invokeTools(model, messages, { settings, rebuild, callbacks: [meter] });
    const usage = delta(snapshot(meter), before);
    const action = proposal.action;
    const tool = action.operator === "apply" ? action.action.tool : action.operator;
    turns.push({ turn, operator: action.operator, tool, chars, refused: false, ...usage });
    const tools = context.history
      .filter((message) => message.role === "tool")
      .slice(-6)
      .map((message) => brief(message.text, 100));
    console.info(`\n=== turn ${turn} ===`);
    console.info(`thought: ${proposal.thought}`);
    console.info(`action:  ${JSON.stringify(proposal.action)}`);
    console.info(`tokens:  in=${usage.inputTokens} out=${usage.outputTokens} reason=${usage.reasoningTokens} cacheR=${usage.cacheRead} cacheW=${usage.cacheWrite} llm=${usage.llmCalls} chars=${chars}`);
    console.info(`history=${context.history.length} situation=${context.situation}`);
    console.info(`last tools:\n  ${tools.join("\n  ") || "(none)"}`);
    turn += 1;
    return proposal;
  };

  const { result, workspace } = await runSandbox(fixOcamlGc, FIX_OCAML_REQUEST, propose, { maxTurns: 16 });
  const source = workspace.read("ocaml/runtime/shared_heap.c") ?? "";
  const fixed = !source.includes("RLE-SWEEP-BUG");
  console.info(`\n=== result ===\nstop=${result.stopReason} turns=${result.turns} fixed=${fixed}`);

  // Mark refusals on their turn (a refusal is a proposed tool call the engine rejected).
  const refused = new Set(
    result.events
      .filter((event) => event.type === "record_rejection")
      .map((event) => (event as { turn?: number }).turn ?? -1),
  );
  for (const record of turns) record.refused = refused.has(record.turn);

  const summary = summarize(turns);
  const metrics = { stopReason: result.stopReason, turns: turns.length, fixed, ...summary, perTurn: turns };
  writeFileSync(join(dir, "metrics.json"), JSON.stringify(metrics, null, 2));

  const t = summary.totals;
  console.info(
    `\n=== tokens ===\n` +
      `llm=${t.llmCalls} toolcalls=${t.toolCalls} (ok ${t.accepted}/refused ${t.refused}) ` +
      `in=${t.inputTokens} (fresh ${t.freshInput} + cacheR ${t.cacheRead}, hit ${((t.cacheHitRatio ?? 0) * 100).toFixed(0)}%) ` +
      `out=${t.outputTokens} (visible ${t.visibleOutput} + reason ${t.reasoningTokens}) ` +
      `cost=${t.costRub?.toFixed(3) ?? "n/a"}₽ chars ${t.contextChars.first}→${t.contextChars.last} (peak ${t.contextChars.peak})`,
  );
  for (const [tool, b] of Object.entries(summary.byTool)) {
    console.info(`  ${tool.padEnd(12)} calls=${b.calls} in=${b.input} out=${b.output} reason=${b.reasoning}`);
  }

  writeFileSync(join(dir, "result.json"), JSON.stringify({ stopReason: result.stopReason, turns: result.turns, events: result.events }, null, 2));
  console.info(`trace: ${dir}`);
}

void main();
