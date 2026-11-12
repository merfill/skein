import type { ModelMessage } from "ai";

import { isAborted } from "../abort";
import type { Event } from "../ir/events";
import { childrenOf, fold, turnsOf, type State } from "../ir/graph";
import { GENERAL_STATE } from "../ir/islands";
import { observationText, type TapeMessage } from "../ir/project";
import type { Action, Proposals } from "../llm/schemas";
import { commandOf, executeAction } from "../tools";
import type { Workspace } from "../tools/workspace";
import { historyMessages } from "../loop/propose";
import { openUnit, pushUnit, unitOf } from "./session";
import type { ProgressSink } from "./progress";
import { LOCAL_SESSION_ID, contextSnapshot, type TelemetrySink } from "./telemetry";
import type { SessionState } from "./types";

export const GENERAL_BASE_PROMPT = [
  "You are a general-purpose agent working in a workspace. You answer the user's question from the workspace.",
  "Address only the specific question and use as few output tokens as accuracy allows: answer in 1-3 sentences or a short paragraph when that is enough, and do not add preamble, postamble, introductions, conclusions, or explanations the user did not ask for. A detailed request deserves structure, not padding. Before inspecting, decide what the answer must establish; inspect only what that requires, and answer as soon as the question is covered. Answer in GitHub-flavored Markdown; your final message is shown to the user as-is.",
  "When you have enough information to answer the user, respond with plain text only. Do not call any tools. Your message will be treated as the final answer.",
].join("\n\n");

export type GeneralProposer = (
  messages: ModelMessage[],
  options?: { signal?: AbortSignal; final?: boolean },
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
  // The unit type opened on the session; the revision unit reuses this runner.
  unitType?: "general" | "revision";
  // The progress/telemetry agent label.
  agent?: "general" | "revision";
  // The base prompt (a revision unit supplies its own).
  basePrompt?: string;
  // The `state_changed.state` label.
  stateLabel?: string;
  // The final no-tools instruction used at the turn cap.
  finalInstruction?: string;
  // Engine-recorded workspace facts (project directory and top-level structure).
  workspace?: string;
  // The entry checkpoint id; the read-only unit restores any mutation when it ends.
  snapshot?: string;
  // The execution-plan item this unit executes (plan mode).
  planItem?: string;
  // A per-run cap override (a plan item gets `planGeneralMaxTurns`).
  maxTurns?: number;
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

function node(id: string, kind: "request" | "turns", label: string, payload: unknown, seq: number): Event {
  return {
    type: "add_node",
    node: { id, space: "work", kind, label, payload, seq },
  };
}

// One goal, no state transitions: the tape hangs off the request, like the document unit.
function seedGeneral(request: { id: string; text: string }): Event[] {
  const turnsId = `${request.id}:turns`;
  return [
    node(request.id, "request", request.text, { text: request.text }, 0),
    node(turnsId, "turns", `general for ${request.id}`, undefined, 1),
    {
      type: "add_edge",
      edge: {
        id: `${request.id}:turns:edge`,
        from: request.id,
        to: turnsId,
        kind: "turns",
        provenance: { kind: "llm" },
      },
    },
  ];
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

// The general history is rebuilt every turn, so a full tool result is resent each time. The
// tool already bounded the inline body (`INLINE_LIMIT`); it is kept whole here, never
// truncated a second time (a smaller cap made the model re-read the same file in slices).
function historyOf(state: State, requestId: string): TapeMessage[] {
  const history: TapeMessage[] = [{ role: "user", text: requestOf(state) }];
  const turns = turnsOf(state, requestId);
  if (turns === undefined) return history;
  for (const actionId of childrenOf(state, turns)) {
    const action = state.nodes.get(actionId);
    if (action === undefined || action.kind !== "action") continue;
    const payload = action.payload as
      | { call?: { name?: unknown; args?: unknown }; reasoning?: unknown }
      | undefined;
    const reasoning =
      typeof payload?.reasoning === "string" && payload.reasoning !== ""
        ? { reasoning: payload.reasoning }
        : {};
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
      history.push({ role: "assistant", text: "", call, ...reasoning });
    } else {
      history.push({ role: "assistant", text: action.label, ...reasoning });
    }
    const resultId = resultOf(state, actionId);
    const result = resultId !== undefined ? state.nodes.get(resultId) : undefined;
    const text = result !== undefined ? observationText(result) : action.label;
    history.push({ role: "tool", text, callId: actionId });
  }
  return history;
}

const DEFAULT_FINAL_INSTRUCTION =
  "The turn limit is reached. Write the final answer now as text from what you have already read. Use only that material: do not invent or extrapolate collection names, datasets, results, paths, or numbers. If something is not established by what you read, say so explicitly instead of guessing. Do not inspect anything else; the engine records your text as the answer.";

function messagesOf(
  state: State,
  requestId: string,
  workspace: string | undefined,
  basePrompt: string,
): ModelMessage[] {
  return [
    { role: "system", content: basePrompt },
    ...(workspace !== undefined ? [{ role: "system" as const, content: workspace }] : []),
    ...historyMessages(historyOf(state, requestId)),
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
  let events: Event[] = input.seed !== undefined ? [...input.seed] : seedGeneral(input.request);
  const requestId = input.request.id;
  const unitType = input.unitType ?? "general";
  const agent = input.agent ?? "general";
  const basePrompt = input.basePrompt ?? GENERAL_BASE_PROMPT;
  const stateLabel = input.stateLabel ?? GENERAL_STATE;
  const finalInstruction = input.finalInstruction ?? DEFAULT_FINAL_INSTRUCTION;
  if (turnsOf(fold(events), requestId) === undefined) {
    return { events, done: true, stopReason: "no_state", turns: startTurn };
  }

  if (input.open === true && session !== undefined) {
    openUnit(session, input.request.id, unitType, events, startTurn, input.planItem);
    pushUnit(session, input.request.id, startTurn);
    if (input.snapshot !== undefined) {
      unitOf(session, input.request.id).checkpoint = input.snapshot;
    }
  }

  const unitId = requestId;
  const emit = deps.onProgress;
  emit?.({
    type: "state_changed",
    unitId,
    turn: startTurn,
    state: stateLabel,
    what: input.request.text,
    closed: false,
  });

  let turn = startTurn;
  let done = false;
  let paused = false;
  let stopReason: string | null = null;
  const maxTurns = input.maxTurns ?? deps.maxTurns;

  while (turn < maxTurns) {
    if (isAborted(input.signal)) {
      paused = true;
      emit?.({ type: "paused", agent, unitId });
      break;
    }
    const state = fold(events);
    const messages = messagesOf(state, requestId, input.workspace, basePrompt);
    const startedAt = Date.now();
    emit?.({ type: "turn_started", agent, unitId, turn });
    emit?.({ type: "model_call_started", agent, unitId, turn });
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
        agent,
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
        emit?.({ type: "paused", agent, unitId });
        break;
      }
      throw error;
    }
    deps.telemetry?.record({
      type: "model_call",
      sessionId: LOCAL_SESSION_ID,
      agent,
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
      agent,
      unitId,
      turn,
      model: proposals.model,
      status: "ok",
      ...(proposals.usage !== undefined ? { usage: proposals.usage } : {}),
      ...(proposals.reasoning !== undefined ? { reasoning: proposals.reasoning } : {}),
    });

    const actions: Action[] =
      proposals.actions.length === 0 && proposals.thought.trim() !== ""
        ? [{ operator: "stop", why: proposals.thought.trim() }]
        : proposals.actions;
    if (actions.length === 0) {
      stopReason = "no_decision";
      done = true;
      emit?.({ type: "turn_finished", agent, unitId, turn, stopReason });
      break;
    }

    for (const action of actions) {
      if (isAborted(input.signal)) {
        paused = true;
        break;
      }
      const current = fold(events);
      const { tool, target } = targetOf(action);
      const edit =
        action.operator === "apply" && action.action.tool === "edit"
          ? {
              path: action.action.path,
              find: action.action.find,
              replace: action.action.replace,
            }
          : undefined;
      emit?.({
        type: "tool_started",
        agent,
        unitId,
        turn,
        tool,
        target,
        ...(edit !== undefined ? { edit } : {}),
      });
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
        agent,
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
        agent,
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
          state: stateLabel,
          closed: true,
        });
        break;
      }
    }

    turn += 1;
    emit?.({ type: "turn_finished", agent, unitId, turn: turn - 1, stopReason });
    if (paused) {
      emit?.({ type: "paused", agent, unitId });
      break;
    }
    if (done) break;
  }

  // The turn limit is a safety cap, not a deliverable: make one final no-tools call so the
  // work already read still produces a report instead of an empty `max_turns` result.
  if (!done && !paused) {
    const messages: ModelMessage[] = [
      ...messagesOf(fold(events), requestId, input.workspace, basePrompt),
      { role: "system", content: finalInstruction },
    ];
    const startedAt = Date.now();
    emit?.({ type: "turn_started", agent, unitId, turn });
    emit?.({ type: "model_call_started", agent, unitId, turn });
    let proposals: Proposals | undefined;
    try {
      proposals = await deps.propose(messages, {
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        final: true,
      });
      const usage = proposals.usage;
      deps.telemetry?.record({
        type: "model_call",
        sessionId: LOCAL_SESSION_ID,
        agent,
        unitId,
        turn,
        model: proposals.model ?? "",
        startedAt,
        endedAt: Date.now(),
        status: "ok",
        ...(usage !== undefined ? { usage } : {}),
        context: contextSnapshot(messages),
      });
      emit?.({
        type: "model_call_finished",
        agent,
        unitId,
        turn,
        model: proposals.model,
        status: "ok",
        ...(usage !== undefined ? { usage } : {}),
        ...(proposals.reasoning !== undefined ? { reasoning: proposals.reasoning } : {}),
      });
    } catch (error) {
      deps.telemetry?.record({
        type: "model_call",
        sessionId: LOCAL_SESSION_ID,
        agent,
        unitId,
        turn,
        model: "",
        startedAt,
        endedAt: Date.now(),
        status: isAborted(input.signal) ? "aborted" : "error",
        context: contextSnapshot(messages),
      });
      emit?.({
        type: "model_call_finished",
        agent,
        unitId,
        turn,
        status: isAborted(input.signal) ? "aborted" : "error",
      });
      if (isAborted(input.signal)) {
        paused = true;
        emit?.({ type: "paused", agent, unitId });
      }
    }

    if (proposals !== undefined && !paused) {
      const stop = proposals.actions.find((action) => action.operator === "stop");
      const report =
        stop !== undefined && stop.operator === "stop"
          ? (stop.why ?? "").trim()
          : proposals.thought.trim();
      if (report !== "") {
        emit?.({ type: "tool_started", agent, unitId, turn, tool: "stop", target: "stop" });
        const before = events.length;
        const outcome = executeAction(
          { operator: "stop", why: report },
          fold(events),
          deps.workspace,
          turn,
          proposals.reasoning,
        );
        events.push(...outcome.events);
        emit?.({ type: "events_added", unitId, events: events.slice(before) });
        emit?.({
          type: "tool_finished",
          agent,
          unitId,
          turn,
          tool: "stop",
          target: "stop",
          status: "ok",
          preview: report.slice(0, 600),
        });
        deps.telemetry?.record({
          type: "tool_call",
          sessionId: LOCAL_SESSION_ID,
          agent,
          unitId,
          turn,
          tool: "stop",
          startedAt: Date.now(),
          endedAt: Date.now(),
          status: "ok",
        });
        done = true;
        stopReason = "answered";
        emit?.({ type: "state_changed", unitId, turn, state: stateLabel, closed: true });
      }
    }
    turn += 1;
    emit?.({
      type: "turn_finished",
      agent,
      unitId,
      turn: turn - 1,
      stopReason: stopReason ?? "max_turns",
    });
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
