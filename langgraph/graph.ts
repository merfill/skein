// Harbor LangGraph adapter for Skein.
//
// Harbor's built-in `langgraph` agent invokes this graph once with
// `{ messages: [{ role: "user", content: instruction }] }` from the task
// workspace (process.cwd()), and collects token/cache usage via the callbacks it
// passes in the invoke config. Here we run the Skein agent over the workspace and
// return the accumulated messages, logging per-turn context/token rows to stdout
// (Harbor tees the runner output into the trial's agent log).
import { AIMessage } from "@langchain/core/messages";

import { contextStats, graphCounts, sum, TurnMeter, type TurnRecord } from "../bench/metrics";
import { loadSettings, type Settings } from "../src/config/settings";
import type { Context } from "../src/ir/project";
import { createChatModel } from "../src/llm/client";
import { proposalSchema, type Action, type Proposal } from "../src/llm/schemas";
import { runAgent } from "../src/loop/graph";
import { buildMessages, renderContext } from "../src/loop/propose";
import { fsWorkspace } from "../src/tools/workspace";

interface HarborInvokeConfig {
  configurable?: Record<string, unknown>;
  callbacks?: unknown;
}

interface ChatMessage {
  role?: string;
  content?: unknown;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function extractInstruction(input: unknown): string {
  const messages = (input as { messages?: ChatMessage[] } | undefined)?.messages;
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (message.content !== undefined) return JSON.stringify(message.content);
  }
  return "";
}

function buildSettings(config: HarborInvokeConfig | undefined): Settings {
  const base = loadSettings();
  const configurable = config?.configurable ?? {};
  const modelKwargs = (configurable.model_kwargs ?? {}) as Record<string, unknown>;
  const configuration = (modelKwargs.configuration ?? {}) as Record<string, unknown>;
  const maxTurns = Number(configurable.maxTurns ?? process.env.SKEIN_MAX_TURNS ?? 60);
  return {
    ...base,
    apiUrl:
      str(configuration.baseURL) ?? str(process.env.SKEIN_API_URL) ?? base.apiUrl,
    apiKey:
      str(modelKwargs.apiKey) ??
      str(process.env.SKEIN_API_KEY) ??
      str(process.env.OPENAI_API_KEY) ??
      base.apiKey,
    model: str(modelKwargs.model) ?? str(process.env.SKEIN_MODEL) ?? base.model,
    maxTurns: Number.isFinite(maxTurns) && maxTurns > 0 ? maxTurns : base.maxTurns,
  };
}

function answerFor(result: Awaited<ReturnType<typeof runAgent>>): string {
  for (const event of result.events) {
    if (
      event.type === "add_node" &&
      event.node.kind === "action" &&
      event.node.label.startsWith("finish:")
    ) {
      return event.node.label.replace(/^finish:\s*/, "");
    }
  }
  return `Skein stopped (${result.stopReason ?? "unknown"}) after ${result.turns} turns.`;
}

export const skein = {
  async invoke(input: unknown, config?: HarborInvokeConfig): Promise<unknown> {
    const instruction = extractInstruction(input);
    const settings = buildSettings(config);
    const workspace = fsWorkspace(process.cwd());
    const structured = createChatModel(settings).withStructuredOutput(proposalSchema);
    const inherited = Array.isArray(config?.callbacks) ? (config.callbacks as unknown[]) : [];

    console.log(`SKEIN_CWD ${process.cwd()}`);
    console.log(
      `SKEIN_CONFIG cwd=${process.cwd()} model=${settings.model} baseURL=${settings.apiUrl} maxTurns=${settings.maxTurns} hasKey=${settings.apiKey !== ""}`,
    );

    const proposals: Action[] = [];
    const turns: Omit<TurnRecord, "accepted">[] = [];
    const propose = async (context: Context): Promise<Proposal> => {
      const contextChars = renderContext(context).length;
      const meter = new TurnMeter();
      const started = Date.now();
      const result = await structured.invoke(buildMessages(context), {
        callbacks: [...inherited, meter],
      });
      const proposal = proposalSchema.parse(result);
      proposals.push(proposal.action);
      turns.push({
        turn: turns.length,
        action: proposal.action.tool,
        contextChars,
        inputTokens: meter.inputTokens,
        outputTokens: meter.outputTokens,
        cacheRead: meter.cacheRead,
        cacheWrite: meter.cacheWrite,
        cacheHitRatio: meter.inputTokens === 0 ? null : meter.cacheRead / meter.inputTokens,
        llmCalls: meter.calls,
        elapsedMs: Date.now() - started,
        cost: meter.costCalls > 0 ? meter.costRub : null,
        usage: [],
      });
      return proposal;
    };

    const result = await runAgent(
      { propose, workspace, maxTurns: settings.maxTurns },
      { goal: { id: "g1", label: instruction } },
    );

    const rejectedTurns = new Set(
      result.events
        .filter((event) => event.type === "record_rejection")
        .map((event) => event.turn),
    );
    const turnRecords: TurnRecord[] = turns.map((turn) => ({
      ...turn,
      accepted: !rejectedTurns.has(turn.turn),
    }));

    for (const turn of turnRecords) {
      const { usage: _usage, ...compact } = turn;
      console.log(`SKEIN_TURN ${JSON.stringify(compact)}`);
    }

    const inputTokens = sum(turnRecords.map((turn) => turn.inputTokens));
    const outputTokens = sum(turnRecords.map((turn) => turn.outputTokens));
    const cacheRead = sum(turnRecords.map((turn) => turn.cacheRead));
    const metrics = {
      instructionChars: instruction.length,
      steps: result.turns,
      toolCalls: proposals.length,
      llmCalls: sum(turnRecords.map((turn) => turn.llmCalls)),
      inputTokens,
      outputTokens,
      cacheRead,
      cacheHitRatio: inputTokens === 0 ? null : cacheRead / inputTokens,
      context: contextStats(turnRecords),
      graph: graphCounts(proposals, result.events),
      done: result.done,
      stopReason: result.stopReason,
    };
    console.log(`SKEIN_METRICS ${JSON.stringify(metrics)}`);

    const messages = (input as { messages?: ChatMessage[] } | undefined)?.messages ?? [];
    return { messages: [...messages, new AIMessage(answerFor(result))] };
  },
};
