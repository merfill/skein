import type { ModelMessage } from "ai";

import { isAborted } from "../abort";
import type { Event } from "../ir/events";
import { childrenOf, currentFocus, fold, planOf, type State } from "../ir/graph";
import { GENERAL_STATE } from "../ir/islands";
import { observationText, type TapeMessage } from "../ir/project";
import type { Action, Proposals } from "../llm/schemas";
import { commandOf, executeAction } from "../tools";
import type { Workspace } from "../tools/workspace";
import { historyMessages } from "../loop/propose";
import { openUnit, pushUnit } from "./session";
import type { ProgressSink } from "./progress";
import { LOCAL_SESSION_ID, contextSnapshot, type TelemetrySink } from "./telemetry";
import type { SessionState } from "./types";

export const GENERAL_BASE_PROMPT = [
  "You are a general analysis agent. You work in one state, General.",
  "State: General — answer the request from the material.",
  "Done: the answer is complete and supported by what you read.",
  "This state only reads: do not change files and do not run mutating commands.",
  "Answer in GitHub-flavored Markdown. When the answer is complete, close the state with `stop`; put the final answer in `why`.",
].join("\n\n");

export type GeneralProposer = (
  messages: ModelMessage[],
  options?: { signal?: AbortSignal },
) => Promise<Proposals>;

export interface GeneralDeps {
  propose: GeneralProposer;
  workspace: Workspace;
  maxTurns: number;
  telemetry?: TelemetrySink;
  onProgress?: ProgressSink;
}

export interface GeneralInput {
  request: { id: string; text: string };
  seed?: Event[];
  startTurn?: number;
  session?: SessionState;
  open?: boolean;
  signal?: AbortSignal;
}

export interface GeneralResult {
  events: Event[];
  done: boolean;
  paused?: boolean;
  stopReason: string | null;
  turns: number;
  session?: SessionState;
}

function node(id: string, kind: "request" | "move", label: string, payload: unknown, seq: number): Event {
  return {
    type: "add_node",
    node: { id, space: "work", kind, label, payload, seq },
  };
}

function seedGeneral(request: { id: string; text: string }, turn: number): Event[] {
  const moveId = `${request.id}:general`;
  return [
    node(request.id, "request", request.text, { text: request.text }, 0),
    node(moveId, "move", "General", { state: GENERAL_STATE, what: request.text, turn }, 1),
    {
      type: "add_edge",
      edge: {
        id: `${request.id}:move`,
        from: request.id,
        to: moveId,
        kind: "move",
        provenance: { kind: "llm" },
      },
    },
    { type: "descend", node: moveId },
  ];
}

function moveOf(events: readonly Event[], requestId: string): string | undefined {
  const root = fold(events).rootId ?? requestId;
  return childrenOf(fold(events), root).find(
    (id) => fold(events).nodes.get(id)?.kind === "move",
  );
}

function resultOf(state: State, actionId: string): string | undefined {
  for (const edge of state.edges.values()) {
    if (edge.kind === "result" && edge.from === actionId) return edge.to;
  }
  return undefined;
}

function requestOf(state: State): string {
  const root = state.rootId;
  if (root === undefined) return "";
  const payload = state.nodes.get(root)?.payload as { text?: unknown } | undefined;
  return typeof payload?.text === "string" ? payload.text : (state.nodes.get(root)?.label ?? "");
}

function historyOf(state: State, moveId: string): TapeMessage[] {
  const history: TapeMessage[] = [{ role: "user", text: requestOf(state) }];
  const plan = planOf(state, moveId);
  if (plan === undefined) return history;
  for (const itemId of childrenOf(state, plan)) {
    for (const actionId of childrenOf(state, itemId)) {
      const action = state.nodes.get(actionId);
      if (action === undefined || action.kind !== "action") continue;
      const payload = action.payload as { call?: { name?: unknown; args?: unknown } } | undefined;
      const call =
        typeof payload?.call?.name === "string"
          ? {
              id: actionId,
              name: payload.call.name,
              args:
                payload.call.args !== null && typeof payload.call.args === "object"
                  ? (payload.call.args as Record<string, unknown>)
                  : {},
            }
          : undefined;
      if (call !== undefined) {
        history.push({ role: "assistant", text: "", call });
      } else {
        history.push({ role: "assistant", text: action.label });
      }
      const resultId = resultOf(state, actionId);
      const result = resultId !== undefined ? state.nodes.get(resultId) : undefined;
      history.push({
        role: "tool",
        text: result !== undefined ? observationText(result) : action.label,
        callId: actionId,
      });
    }
  }
  return history;
}

function messagesOf(state: State, moveId: string): ModelMessage[] {
  return [
    { role: "system", content: GENERAL_BASE_PROMPT },
    ...historyMessages(historyOf(state, moveId)),
  ];
}

function targetOf(action: Action): { tool: string; target: string } {
  if (action.operator === "apply") {
    return { tool: action.action.tool, target: commandOf(action.action) };
  }
  return { tool: action.operator, target: action.operator };
}

export async function runGeneralAgent(
  deps: GeneralDeps,
  input: GeneralInput,
): Promise<GeneralResult> {
  const session = input.session;
  const startTurn = input.startTurn ?? 0;
  let events: Event[] = input.seed !== undefined ? [...input.seed] : seedGeneral(input.request, startTurn);
  const moveId = moveOf(events, input.request.id);
  if (moveId === undefined) {
    return { events, done: true, stopReason: "no_state", turns: startTurn };
  }

  if (input.open === true && session !== undefined) {
    openUnit(session, input.request.id, "general", events, startTurn);
    pushUnit(session, input.request.id, startTurn);
  }

  const unitId = input.request.id;
  const emit = deps.onProgress;
  emit?.({
    type: "state_changed",
    unitId,
    turn: startTurn,
    state: GENERAL_STATE,
    what: input.request.text,
    closed: false,
  });

  let turn = startTurn;
  let done = false;
  let paused = false;
  let stopReason: string | null = null;

  while (turn < deps.maxTurns) {
    if (isAborted(input.signal)) {
      paused = true;
      emit?.({ type: "paused", agent: "general", unitId });
      break;
    }
    const state = fold(events);
    const messages = messagesOf(state, moveId);
    const startedAt = Date.now();
    emit?.({ type: "turn_started", agent: "general", unitId, turn });
    emit?.({ type: "model_call_started", agent: "general", unitId, turn });
    let proposals: Proposals;
    try {
      proposals = await deps.propose(
        messages,
        input.signal !== undefined ? { signal: input.signal } : undefined,
      );
    } catch (error) {
      deps.telemetry?.record({
        type: "model_call",
        sessionId: LOCAL_SESSION_ID,
        agent: "general",
        unitId,
        turn,
        model: "",
        startedAt,
        endedAt: Date.now(),
        status: isAborted(input.signal) ? "aborted" : "error",
        context: contextSnapshot(messages),
      });
      if (isAborted(input.signal)) {
        paused = true;
        emit?.({ type: "paused", agent: "general", unitId });
        break;
      }
      throw error;
    }
    deps.telemetry?.record({
      type: "model_call",
      sessionId: LOCAL_SESSION_ID,
      agent: "general",
      unitId,
      turn,
      model: proposals.model ?? "",
      startedAt,
      endedAt: Date.now(),
      status: "ok",
      ...(proposals.usage !== undefined ? { usage: proposals.usage } : {}),
      context: contextSnapshot(messages),
    });
    emit?.({
      type: "model_call_finished",
      agent: "general",
      unitId,
      turn,
      model: proposals.model,
      status: "ok",
      ...(proposals.usage !== undefined ? { usage: proposals.usage } : {}),
    });

    if (proposals.actions.length === 0) {
      stopReason = "no_decision";
      done = true;
      emit?.({ type: "turn_finished", agent: "general", unitId, turn, stopReason });
      break;
    }

    for (const action of proposals.actions) {
      if (isAborted(input.signal)) {
        paused = true;
        break;
      }
      const current = fold(events);
      const { tool, target } = targetOf(action);
      emit?.({ type: "tool_started", agent: "general", unitId, turn, tool, target });
      const before = events.length;
      const outcome = executeAction(action, current, deps.workspace, turn, proposals.reasoning);
      events.push(...outcome.events);
      emit?.({ type: "events_added", unitId, events: events.slice(before) });
      const failed = outcome.events.some(
        (event) =>
          event.type === "add_node" &&
          event.node.kind === "observation" &&
          (event.node.payload as { failed?: unknown } | undefined)?.failed === true,
      );
      emit?.({
        type: "tool_finished",
        agent: "general",
        unitId,
        turn,
        tool,
        target,
        status: failed ? "error" : "ok",
        preview: outcome.turn.text,
      });
      deps.telemetry?.record({
        type: "tool_call",
        sessionId: LOCAL_SESSION_ID,
        agent: "general",
        unitId,
        turn,
        tool: target,
        startedAt: Date.now(),
        endedAt: Date.now(),
        status: failed ? "error" : "ok",
      });
      if (action.operator === "stop") {
        done = true;
        stopReason = "answered";
        emit?.({
          type: "state_changed",
          unitId,
          turn,
          state: GENERAL_STATE,
          closed: true,
        });
        break;
      }
    }

    turn += 1;
    emit?.({ type: "turn_finished", agent: "general", unitId, turn: turn - 1, stopReason });
    if (paused) {
      emit?.({ type: "paused", agent: "general", unitId });
      break;
    }
    if (done) break;
  }

  if (!done && !paused) {
    done = true;
    stopReason = "max_turns";
  }

  return {
    events,
    done,
    ...(paused ? { paused: true } : {}),
    stopReason,
    turns: turn,
    ...(session !== undefined ? { session } : {}),
  };
}
