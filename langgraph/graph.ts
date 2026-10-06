// Harbor LangGraph adapter for Skein.
//
// Harbor's built-in `langgraph` agent invokes this graph once with
// `{ messages: [{ role: "user", content: instruction }] }` from the task
// workspace (process.cwd()), and collects token/cache usage via the callbacks it
// passes in the invoke config. Here we run the Skein agent over the workspace and
// return the accumulated messages, logging per-turn context/token rows to stdout
// (Harbor tees the runner output into the trial's agent log).
import { AIMessage } from "@langchain/core/messages";

import {
  actionName,
  contextStats,
  graphCounts,
  sum,
  TurnMeter,
  type TurnRecord,
} from "../bench/metrics";
import { loadSettings, type Settings } from "../src/config/settings";
import type { Event } from "../src/ir/events";
import { checkHasUnder, childrenOf, fold, predicateOf } from "../src/ir/graph";
import type { Context } from "../src/ir/project";
import { createChatModel } from "../src/llm/client";
import type { Action, Proposal } from "../src/llm/schemas";
import { invokeTools } from "../src/llm/structured";
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
  const runTimeoutMs = Number(
    configurable.runTimeoutMs ?? process.env.SKEIN_RUN_TIMEOUT_MS ?? base.runTimeoutMs,
  );
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
    reasoningEffort:
      str(configurable.reasoningEffort) ??
      str(process.env.SKEIN_REASONING_EFFORT) ??
      base.reasoningEffort,
    maxTurns: Number.isFinite(maxTurns) && maxTurns > 0 ? maxTurns : base.maxTurns,
    runTimeoutMs:
      Number.isFinite(runTimeoutMs) && runTimeoutMs > 0 ? runTimeoutMs : base.runTimeoutMs,
  };
}

function answerFor(result: Awaited<ReturnType<typeof runAgent>>): string {
  return `Skein stopped (${result.stopReason ?? "unknown"}) after ${result.turns} turns.`;
}

// Diagnostic dump of the IR tree, so a Harbor run is analyzable after the fact
// (goals with why/done_when, commands, edits, checks, rejections).
function diagnostics(events: readonly Event[]): unknown {
  const state = fold(events);
  const payloadOf = (id: string): Record<string, unknown> | undefined =>
    state.nodes.get(id)?.payload as Record<string, unknown> | undefined;
  const nodes = [...state.nodes.values()];
  const edges = [...state.edges.values()];
  const hasPlanFrom = (planId: string): string | undefined =>
    edges.find((edge) => edge.kind === "has_plan" && edge.to === planId)?.from;
  const mutateRefs = new Set<string>();
  for (const event of events) {
    if (event.type === "mutate") mutateRefs.add(event.ref);
  }
  return {
    request: nodes
      .filter((node) => node.kind === "request")
      .map((node) => node.payload),
    goals: nodes
      .filter((node) => node.kind === "goal")
      .map((node) => ({
        id: node.id,
        label: node.label,
        predicate: predicateOf(state, node.id),
        payload: node.payload,
      })),
    actions: nodes
      .filter((node) => node.kind === "action")
      .map((node) => ({
        id: node.id,
        predicate: predicateOf(state, node.id),
        command: payloadOf(node.id)?.command ?? null,
      })),
    checks: nodes
      .filter((node) => node.kind === "check")
      .map((node) => {
        const payload = payloadOf(node.id) ?? {};
        return {
          id: node.id,
          command: payload.command,
          verdict: payload.verdict,
          actor: payload.actor,
          under: checkHasUnder(state, node.id),
        };
      }),
    observations: nodes
      .filter((node) => node.kind === "observation")
      .map((node) => {
        const payload = payloadOf(node.id) ?? {};
        return {
          id: node.id,
          label: node.label,
          command: payload.command ?? null,
          ref: payload.ref ?? null,
          verdict: payload.verdict ?? null,
        };
      }),
    completes: nodes
      .filter((node) => node.kind === "complete")
      .map((node) => ({ id: node.id, label: node.label })),
    plans: nodes
      .filter((node) => node.kind === "plan")
      .map((node) => ({
        id: node.id,
        for: hasPlanFrom(node.id) ?? null,
        items: childrenOf(state, node.id),
      })),
    alternatives: nodes
      .filter((node) => node.kind === "alternatives")
      .map((node) => ({ id: node.id, items: childrenOf(state, node.id) })),
    verifies: edges
      .filter((edge) => edge.kind === "verifies")
      .map((edge) => ({ from: edge.from, to: edge.to })),
    closes: edges
      .filter((edge) => edge.kind === "closes")
      .map((edge) => ({ from: edge.from, to: edge.to })),
    mutateEdges: edges
      .filter((edge) => edge.kind === "mutates")
      .map((edge) => ({ from: edge.from, to: edge.to })),
    mutateRefCount: mutateRefs.size,
    rejections: state.rejections.map((rejection) => ({
      tool: rejection.tool,
      target: rejection.target,
      reason: rejection.reason,
    })),
  };
}

export const skein = {
  async invoke(input: unknown, config?: HarborInvokeConfig): Promise<unknown> {
    const instruction = extractInstruction(input);
    const settings = buildSettings(config);
    const workspace = fsWorkspace(process.cwd(), { runTimeoutMs: settings.runTimeoutMs });
    const model = createChatModel(settings);
    const inherited = Array.isArray(config?.callbacks) ? (config.callbacks as unknown[]) : [];

    console.log(`SKEIN_CWD ${process.cwd()}`);
    console.log(
      `SKEIN_CONFIG cwd=${process.cwd()} model=${settings.model} baseURL=${settings.apiUrl} maxTurns=${settings.maxTurns} hasKey=${settings.apiKey !== ""}`,
    );

    const proposals: Action[] = [];
    const turns: Omit<TurnRecord, "accepted">[] = [];
    const propose = async (context: Context): Promise<Proposal> => {
      const rendered = renderContext(context);
      const contextChars = rendered.length;
      console.log(
        `SKEIN_CONTEXT ${JSON.stringify({ turn: turns.length, chars: contextChars, context })}`,
      );
      const meter = new TurnMeter();
      const started = Date.now();
      let proposal: Proposal;
      try {
        proposal = await invokeTools(model, buildMessages(context), {
          callbacks: [...inherited, meter],
          onError: (error, phase) => {
            console.log(
              `SKEIN_LLM_ERROR ${JSON.stringify({
                turn: turns.length,
                phase,
                message: error instanceof Error ? error.message : String(error),
              })}`,
            );
          },
        });
      } catch (error) {
        console.log(
          `SKEIN_LLM_ERROR ${JSON.stringify({
            turn: turns.length,
            phase: "final",
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          })}`,
        );
        throw error;
      }
      console.log(
        `SKEIN_PROPOSAL ${JSON.stringify({ turn: turns.length, thought: proposal.thought, action: proposal.action })}`,
      );
      proposals.push(proposal.action);
      turns.push({
        turn: turns.length,
        action: actionName(proposal.action),
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
      { request: { id: "r1", text: instruction } },
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
    console.log(`SKEIN_EVENTS ${JSON.stringify(diagnostics(result.events))}`);

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
