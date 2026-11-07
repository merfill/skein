import type { ModelMessage } from "ai";

import { isAborted } from "../abort";
import type { Event } from "../ir/events";
import {
  LOCAL_SESSION_ID,
  contextSnapshot,
  type TelemetrySink,
  type Usage,
} from "./telemetry";
import type { State } from "../ir/graph";
import type { TapeMessage } from "../ir/project";
import type { Node } from "../ir/types";
import { historyMessages } from "../loop/propose";
import { stateTape } from "./outline";
import type { ProgressSink } from "./progress";
import type { NoDecisionReason, Reaction, ReactionProposal, Trigger } from "./types";

export const OBSERVER_BASE_PROMPT = [
  "A coding agent is working on the user's request. Its work is recorded as an IR: the request, states, turns, actions and observations. Sometimes the agent gets stuck and cannot finish the request.",
  "You are the advisor. The state where the problem was noticed is in front of you: its request, its turns in order, what the agent was thinking before each action, the action itself and the observation it produced. You do not edit the work yourself.",
  "Read that state and give the agent one short, concrete hint that helps it finish the request.",
  "A hint is a delta, not a summary: name the problem and one concrete next step, cite 1–2 evidence ids, do not repeat the state's goal or the history, and do not prescribe commands that the evidence does not name. Keep it under about 60 words.",
  "What the request requires is read from the request itself; a fragment of it says nothing about the rest.",
  "The state the hint applies to is already known from the tape; you do not name it. When you know what to change, use a decision tool. If nothing useful can be said, say so with `halt` or stay silent.",
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

export interface ObserverReply {
  // The doxa proposes; the state the hint applies to is not its to name — the engine knows the
  // trigger's anchor and stamps it when the proposal becomes a reaction.
  decision?: ReactionProposal;
  // Side-channel telemetry.
  usage?: Usage;
  model?: string;
}

export type RequestObserver = (
  messages: ModelMessage[],
  options?: { signal?: AbortSignal },
) => Promise<ObserverReply>;

export interface ObserverDeps {
  agent: RequestObserver;
  onProgress?: ProgressSink;
}

export interface ObserverRunInput {
  trigger: Trigger;
  state: State;
  agent: RequestObserver;
  // A resumed observer continues from the journal it already committed.
  journal?: readonly Event[];
  startTurn?: number;
  // A user pause: the in-flight model call is aborted and the loop returns `paused`.
  signal?: AbortSignal;
  // The observer unit id and the telemetry sink (side channel, never rendered).
  unitId?: string;
  telemetry?: TelemetrySink;
  onProgress?: ProgressSink;
}

export interface ObserverRunResult {
  journal: Event[];
  decision?: Reaction;
  turns: number;
  // The observer ended without a reaction. `empty_reply` is the model calling no tool at all
  // (it declined to decide); `max_turns` is the step budget running out. Without this the two
  // are indistinguishable from the outside, and a silent observer looks like a healthy one.
  noDecision?: NoDecisionReason;
  // The loop stopped on a user pause; the journal is committed and the unit stays open.
  paused?: boolean;
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

// The observer's whole input is one engine-provided body — the current state's record — rendered
// into the unit journal as an ordinary action/observation pair. It is recorded, not recomputed,
// so a resumed observer sees exactly the tape it started with (the same journal, the same call).
export function seedObserverUnit(trigger: Trigger, state: State): Event[] {
  const callId = "observer:state:0";
  const body = stateTape(state, trigger.anchor);
  return [
    {
      type: "add_node",
      node: {
        id: callId,
        space: "work",
        kind: "action",
        label: "observer:state",
        payload: { origin: "engine", tool: "state", args: { id: trigger.anchor }, callId },
        seq: 0,
      },
    },
    {
      type: "add_node",
      node: {
        id: "observer:result:1",
        space: "work",
        kind: "observation",
        label: "observer:state",
        payload: { origin: "engine", tool: "state", callId, result: body },
        seq: 1,
      },
    },
  ];
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

export async function runRequestObserver(input: ObserverRunInput): Promise<ObserverRunResult> {
  // One call, one tape. The observer no longer surveys: everything it may read is already in the
  // seeded state body, so a second model turn could only restate it (measured on runs D–I: the
  // six-turn survey reproduced what one state's record already held).
  const journal = input.journal !== undefined ? [...input.journal] : seedObserverUnit(input.trigger, input.state);
  const turn = (input.startTurn ?? 0) + 1;
  const progressUnitId = input.unitId ?? "";

  if (isAborted(input.signal)) {
    input.onProgress?.({ type: "paused", agent: "observer", unitId: progressUnitId });
    return { journal, turns: turn - 1, paused: true };
  }

  const context = projectObserver(input.trigger, journal);
  const messages = buildObserverMessages(context);
  const startedAt = Date.now();
  input.onProgress?.({ type: "turn_started", agent: "observer", unitId: progressUnitId, turn });
  input.onProgress?.({ type: "model_call_started", agent: "observer", unitId: progressUnitId, turn });
  let reply: ObserverReply;
  try {
    reply = await input.agent(
      messages,
      input.signal !== undefined ? { signal: input.signal } : undefined,
    );
  } catch (error) {
    input.onProgress?.({
      type: "model_call_finished",
      agent: "observer",
      unitId: progressUnitId,
      turn,
      status: isAborted(input.signal) ? "aborted" : "error",
    });
    if (input.telemetry !== undefined) {
      input.telemetry.record({
        type: "model_call",
        sessionId: LOCAL_SESSION_ID,
        agent: "observer",
        unitId: input.unitId ?? "",
        turn,
        model: "",
        startedAt,
        endedAt: Date.now(),
        status: isAborted(input.signal) ? "aborted" : "error",
        context: contextSnapshot(messages),
      });
    }
    if (isAborted(input.signal)) {
      input.onProgress?.({ type: "paused", agent: "observer", unitId: progressUnitId });
      return { journal, turns: turn - 1, paused: true };
    }
    throw error;
  }
  input.onProgress?.({
    type: "model_call_finished",
    agent: "observer",
    unitId: progressUnitId,
    turn,
    model: reply.model,
    status: isAborted(input.signal) ? "aborted" : "ok",
    ...(reply.usage !== undefined ? { usage: reply.usage } : {}),
  });
  if (input.telemetry !== undefined) {
    input.telemetry.record({
      type: "model_call",
      sessionId: LOCAL_SESSION_ID,
      agent: "observer",
      unitId: input.unitId ?? "",
      turn,
      model: reply.model ?? "",
      startedAt,
      endedAt: Date.now(),
      status: isAborted(input.signal) ? "aborted" : "ok",
      ...(reply.usage !== undefined ? { usage: reply.usage } : {}),
      context: contextSnapshot(messages),
    });
  }
  if (isAborted(input.signal)) {
    input.onProgress?.({ type: "paused", agent: "observer", unitId: progressUnitId });
    return { journal, turns: turn - 1, paused: true };
  }
  if (reply.decision === undefined) return { journal, turns: turn, noDecision: "empty_reply" };

  // The trigger named the state; the observer's hint inherits it. `apply` still checks that the
  // anchor is a live move, so a bad anchor is refused there rather than trusted here.
  const decision: Reaction =
    reply.decision.kind === "hint"
      ? { ...reply.decision, state: input.trigger.anchor }
      : reply.decision;
  return { journal, turns: turn, decision };
}
