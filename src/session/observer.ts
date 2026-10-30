import type { ModelMessage } from "ai";

import type { Event } from "../ir/events";
import type { State } from "../ir/graph";
import type { TapeMessage } from "../ir/project";
import type { Node } from "../ir/types";
import { historyMessages } from "../loop/propose";
import { outline, observationBody, renderedState, stateAttempt, stateOutline, stateTurns } from "./outline";
import type { Reaction, Trigger } from "./types";

export const OBSERVER_BASE_PROMPT = [
  "A coding agent is working on the user's request. Its work is recorded as an IR: the request, states, plans, actions and observations. Sometimes the agent gets stuck and cannot finish the request.",
  "You are the advisor. Read the agent's history and give it one short, concrete hint that helps it solve the request. You do not edit the work yourself.",
  "The engine has already shown you the request outline and the state where the problem was noticed. The engine brings you here when: the agent has entered the same state for the third time; the agent has spent more than 20 turns in one state; or the run is close to its turn limit.",
  "Start with the outline and the anchor state. If they are not enough, inspect the state's turns, a plan item's attempts, an observation body, or the rendered tape. Inspect at most three items; then decide.",
  "A hint is a delta, not a summary: name the problem and one concrete next step, cite 1–2 evidence ids, do not repeat the state's goal or the history, and do not prescribe commands that the evidence does not name. Keep it under about 60 words.",
  "When you know what to change, use a decision tool. The tool descriptions explain each choice. If you have inspected enough, decide instead of inspecting more.",
].join("\n\n");

export interface ObserverCall {
  origin: "engine" | "doxa";
  tool: string;
  args: Record<string, unknown>;
  callId: string;
}

export interface ObserverResult {
  origin: "engine" | "doxa";
  tool: string;
  callId: string;
  result: string;
}

export interface ObserverTools {
  outline(state: State, turn?: number): string;
  state(state: State, anchor: string, turn?: number): string;
  turns?(state: State, stateId: string, range?: { from?: number; to?: number }): string;
  attempt?(state: State, itemId: string): string;
  body?(state: State, obsId: string): string;
  rendered?(state: State, stateId: string, events?: readonly Event[]): string;
}

export const defaultObserverTools: ObserverTools = {
  outline: (state, turn) => outline(state, turn),
  state: (state, anchor, turn) => stateOutline(state, anchor, turn),
  turns: (state, stateId, range) => stateTurns(state, stateId, range),
  attempt: (state, itemId) => stateAttempt(state, itemId),
  body: (state, obsId) => observationBody(state, obsId),
  rendered: (state, stateId, events) => renderedState(state, stateId, events),
};

export interface ObserverToolCall {
  name: string;
  args: Record<string, unknown>;
  callId?: string;
}

export interface ObserverReply {
  toolCalls?: ObserverToolCall[];
  decision?: Reaction;
}

export type RequestObserver = (messages: ModelMessage[]) => Promise<ObserverReply>;

export interface ObserverDeps {
  agent: RequestObserver;
  tools: ObserverTools;
  maxTurns?: number;
  maxDepth?: number;
  surveyLimit?: number;
}

export interface ObserverRunInput {
  trigger: Trigger;
  state: State;
  tools: ObserverTools;
  agent: RequestObserver;
  journal?: readonly Event[];
  events?: readonly Event[];
  maxTurns?: number;
  surveyLimit?: number;
}

export interface ObserverRunResult {
  journal: Event[];
  decision?: Reaction;
  turns: number;
}

export interface ObserverContext {
  trigger: Trigger;
  history: TapeMessage[];
}

function callPayload(node: Node): ObserverCall | undefined {
  const payload = node.payload as Partial<ObserverCall> | undefined;
  if (payload?.origin !== "engine" && payload?.origin !== "doxa") return undefined;
  if (typeof payload.tool !== "string" || typeof payload.callId !== "string") return undefined;
  return {
    origin: payload.origin,
    tool: payload.tool,
    callId: payload.callId,
    args: payload.args ?? {},
  };
}

function resultPayload(node: Node): ObserverResult | undefined {
  const payload = node.payload as Partial<ObserverResult> | undefined;
  if (payload?.origin !== "engine" && payload?.origin !== "doxa") return undefined;
  if (
    typeof payload.tool !== "string" ||
    typeof payload.callId !== "string" ||
    typeof payload.result !== "string"
  ) {
    return undefined;
  }
  return {
    origin: payload.origin,
    tool: payload.tool,
    callId: payload.callId,
    result: payload.result,
  };
}

function triggerText(trigger: Trigger): string {
  const evidence = trigger.evidence.length > 0 ? trigger.evidence.join(", ") : "none";
  const situation = trigger.summary ?? trigger.kind;
  return [
    "The engine noticed a problem:",
    `- ${situation};`,
    `- state: ${trigger.anchor};`,
    `- evidence: ${evidence}.`,
  ].join("\n");
}

export function seedObserverUnit(
  trigger: Trigger,
  state: State,
  tools: ObserverTools,
): Event[] {
  const events: Event[] = [];
  let seq = 0;

  const call = (tool: string, args: Record<string, unknown>): string => {
    const callId = `observer:${tool}:${seq}`;
    events.push({
      type: "add_node",
      node: {
        id: callId,
        space: "work",
        kind: "action",
        label: `observer:${tool}`,
        payload: { origin: "engine", tool, args, callId },
        seq,
      },
    });
    seq += 1;
    return callId;
  };

  const result = (tool: string, callId: string, text: string): void => {
    events.push({
      type: "add_node",
      node: {
        id: `observer:result:${seq}`,
        space: "work",
        kind: "observation",
        label: `observer:${tool}`,
        payload: { origin: "engine", tool, callId, result: text },
        seq,
      },
    });
    seq += 1;
  };

  result("outline", call("outline", {}), tools.outline(state, trigger.turn));
  result("state", call("state", { id: trigger.anchor }), tools.state(state, trigger.anchor, trigger.turn));

  return events;
}

export function projectObserver(trigger: Trigger, journal: readonly Event[]): ObserverContext {
  const history: TapeMessage[] = [];
  for (const event of journal) {
    if (event.type !== "add_node") continue;
    if (event.node.kind === "action") {
      const call = callPayload(event.node);
      if (call !== undefined) {
        history.push({
          role: "assistant",
          text: "",
          call: { id: call.callId, name: call.tool, args: call.args },
        });
      }
    } else if (event.node.kind === "observation") {
      const result = resultPayload(event.node);
      if (result !== undefined) {
        history.push({ role: "tool", text: result.result, callId: result.callId });
      }
    }
  }
  return { trigger, history };
}

export function buildObserverMessages(context: ObserverContext): ModelMessage[] {
  return [
    { role: "system", content: OBSERVER_BASE_PROMPT },
    { role: "system", content: triggerText(context.trigger) },
    ...historyMessages(context.history),
  ];
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function executeTool(
  tools: ObserverTools,
  state: State,
  name: string,
  args: Record<string, unknown>,
  events?: readonly Event[],
  turn?: number,
): string {
  switch (name) {
    case "outline":
      return tools.outline(state, turn);
    case "state": {
      const id = stringArg(args, "id");
      return id === undefined ? "missing argument: id" : tools.state(state, id, turn);
    }
    case "turns": {
      const id = stringArg(args, "id") ?? stringArg(args, "state");
      if (id === undefined) return "missing argument: id";
      return tools.turns !== undefined
        ? tools.turns(state, id, {
            ...(typeof args.from === "number" ? { from: args.from } : {}),
            ...(typeof args.to === "number" ? { to: args.to } : {}),
          })
        : "tool unavailable: turns";
    }
    case "attempt": {
      const id = stringArg(args, "id") ?? stringArg(args, "item");
      return id === undefined
        ? "missing argument: id"
        : tools.attempt !== undefined
          ? tools.attempt(state, id)
          : "tool unavailable: attempt";
    }
    case "body": {
      const id = stringArg(args, "id");
      return id === undefined
        ? "missing argument: id"
        : tools.body !== undefined
          ? tools.body(state, id)
          : "tool unavailable: body";
    }
    case "rendered": {
      const id = stringArg(args, "id") ?? stringArg(args, "state");
      return id === undefined
        ? "missing argument: id"
        : tools.rendered !== undefined
          ? tools.rendered(state, id, events)
          : "tool unavailable: rendered";
    }
    default:
      return `unknown tool: ${name}`;
  }
}

export async function runRequestObserver(input: ObserverRunInput): Promise<ObserverRunResult> {
  const journal = [
    ...(input.journal !== undefined
      ? input.journal
      : seedObserverUnit(input.trigger, input.state, input.tools)),
  ];
  const maxTurns = input.maxTurns ?? 6;
  const surveyLimit = input.surveyLimit ?? 3;
  let surveys = 0;

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const context = projectObserver(input.trigger, journal);
    const messages = buildObserverMessages(context);
    if (surveys >= surveyLimit) {
      messages.push({
        role: "system",
        content:
          "You have inspected enough. Decide now: call `hint`, `memo`, or `halt`.",
      });
    }
    const reply = await input.agent(messages);
    if (reply.decision !== undefined) {
      return { journal, decision: reply.decision, turns: turn };
    }
    if (reply.toolCalls === undefined || reply.toolCalls.length === 0) {
      return { journal, turns: turn };
    }
    for (const call of reply.toolCalls) {
      const callId = call.callId ?? `observer:call:${journal.length}`;
      journal.push({
        type: "add_node",
        node: {
          id: callId,
          space: "work",
          kind: "action",
          label: `observer:${call.name}`,
          payload: { origin: "doxa", tool: call.name, args: call.args, callId },
          seq: journal.length,
        },
      });
      journal.push({
        type: "add_node",
        node: {
          id: `observer:result:${journal.length}`,
          space: "work",
          kind: "observation",
          label: `observer:${call.name}`,
          payload: {
            origin: "engine",
            tool: call.name,
            callId,
            result: executeTool(
              input.tools,
              input.state,
              call.name,
              call.args,
              input.events,
              input.trigger.turn,
            ),
          },
          seq: journal.length,
        },
      });
      surveys += 1;
    }
  }

  return { journal, turns: maxTurns };
}
