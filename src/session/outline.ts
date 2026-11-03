import type { Event } from "../ir/events";
import {
  actionExecuted,
  actionSucceeded,
  childrenOf,
  fold,
  stopOf,
  turnsOf,
  type State,
} from "../ir/graph";
import { ISLANDS } from "../ir/islands";
import { observationText, project } from "../ir/project";
import { currentMove, isMoveFinished, moveIsland, movePayload } from "../ir/traversal";

const MAX_TOOL_TEXT = 8000;

function clip(text: string): string {
  return text.length > MAX_TOOL_TEXT
    ? `${text.slice(0, MAX_TOOL_TEXT)}\n… (${text.length - MAX_TOOL_TEXT} chars omitted)`
    : text;
}

function labelOf(state: State, id: string): string {
  return state.nodes.get(id)?.label ?? id;
}

function resultOf(state: State, actionId: string): string | undefined {
  for (const edge of state.edges.values()) {
    if (edge.kind === "result" && edge.from === actionId) return edge.to;
  }
  return undefined;
}

export function outline(state: State, turn?: number): string {
  const root = state.rootId;
  if (root === undefined) return "no request";
  const request = labelOf(state, root);
  const moves = childrenOf(state, root).filter(
    (id) => state.nodes.get(id)?.kind === "move",
  );
  const current = currentMove(state);
  const lines = [`request ${root}: ${request}`];
  for (const move of moves) {
    const island = moveIsland(state, move) ?? "unknown";
    const payload = movePayload(state, move);
    const turnsId = turnsOf(state, move);
    const turnsCount = turnsId !== undefined ? childrenOf(state, turnsId).length : 0;
    const closed = isMoveFinished(state, move);
    const stop = stopOf(state, move);
    const outcome = closed ? `closed: ${stop !== undefined ? labelOf(state, stop) : ""}` : "open";
    const entries = state.stateEntries.get(island) ?? 0;
    const liveTurns =
      move === current && turn !== undefined && payload?.turn !== undefined
        ? ` turns=${turn - payload.turn}`
        : "";
    lines.push(
      `${move} ${island} what="${payload?.what ?? ""}" ${outcome} turns=${turnsCount} entries=${entries}${liveTurns}`,
    );
  }
  return lines.join("\n");
}

function resultSummary(state: State, actionId: string): string {
  const id = resultOf(state, actionId);
  if (id === undefined) return "";
  const node = state.nodes.get(id);
  if (node === undefined) return ` -> ${id}`;
  const first = observationText(node).split("\n", 1)[0] ?? "";
  return ` -> ${id}: ${first}`;
}

export function stateTurns(
  state: State,
  anchor: string,
  range?: { from?: number; to?: number },
): string {
  const node = state.nodes.get(anchor);
  if (node === undefined || node.kind !== "move") return `unknown state: ${anchor}`;
  const turns = turnsOf(state, anchor);
  const actions = turns !== undefined ? childrenOf(state, turns) : [];
  const lines: string[] = [];
  for (const actionId of actions) {
    const action = state.nodes.get(actionId);
    if (action === undefined || action.kind !== "action") continue;
    const status = actionSucceeded(state, actionId)
      ? "succeeded"
      : actionExecuted(state, actionId)
        ? "executed"
        : "not executed";
    lines.push(`- ${actionId}: ${action.label} [${status}]${resultSummary(state, actionId)}`);
  }
  if (lines.length === 0) return "no turns";
  const from = Math.max(0, range?.from ?? 0);
  const to = range?.to !== undefined ? Math.max(from, range.to) + 1 : lines.length;
  return lines.slice(from, to).join("\n");
}

export function observationBody(state: State, obsId: string): string {
  const node = state.nodes.get(obsId);
  if (node === undefined) return `unknown observation: ${obsId}`;
  if (node.kind === "observation") return clip(observationText(node));
  if (node.kind === "action") {
    const resultId = resultOf(state, obsId);
    return resultId !== undefined
      ? clip(observationText(state.nodes.get(resultId)!))
      : "no result";
  }
  return clip(node.label);
}

function tapeText(state: State): string {
  return project(state)
    .history.map((message) => {
      const calls = message.calls ?? (message.call !== undefined ? [message.call] : []);
      if (calls.length > 0) {
        return `assistant: ${calls
          .map((call) => `${call.name}(${JSON.stringify(call.args)})`)
          .join(", ")}`;
      }
      return `${message.role}: ${message.text}`;
    })
    .join("\n");
}

export function renderedState(
  state: State,
  stateId: string,
  events?: readonly Event[],
): string {
  const stop = stopOf(state, stateId);
  if (stop !== undefined && events !== undefined) {
    const index = events.findIndex(
      (event) => event.type === "add_node" && event.node.id === stop,
    );
    if (index > 0) return clip(tapeText(fold(events.slice(0, index))));
  }
  return clip(tapeText(state));
}

export function stateOutline(state: State, anchor: string, turn?: number): string {
  const node = state.nodes.get(anchor);
  if (node === undefined || node.kind !== "move") return `unknown state: ${anchor}`;
  const island = moveIsland(state, anchor) ?? "unknown";
  const payload = movePayload(state, anchor);
  const turnsId = turnsOf(state, anchor);
  const actions = turnsId !== undefined ? childrenOf(state, turnsId) : [];
  const closed = isMoveFinished(state, anchor);
  const stop = stopOf(state, anchor);
  const entries = state.stateEntries.get(island) ?? 0;
  const liveTurns =
    !closed && turn !== undefined && payload?.turn !== undefined
      ? [`turns: ${turn - payload.turn}`]
      : [];
  const lines = [
    `state ${anchor}: ${island}`,
    `what: ${payload?.what ?? ""}`,
    ...(payload?.done !== undefined && payload.done !== "" ? [`done: ${payload.done}`] : []),
    `entries: ${entries}`,
    ...liveTurns,
    `closure: ${closed ? `closed (${stop !== undefined ? labelOf(state, stop) : ""})` : "open"}`,
    `next: ${ISLANDS[island as keyof typeof ISLANDS]?.next.map((edge) => edge.to).join(", ") ?? ""}`,
    "turns:",
  ];
  if (actions.length === 0) {
    lines.push(closed ? "- (empty)" : "- (empty — the first apply seeds it)");
    return lines.join("\n");
  }
  for (const action of actions) {
    const node = state.nodes.get(action);
    if (node === undefined || node.kind !== "action") continue;
    lines.push(`- ${action}: ${node.label}`);
  }
  return lines.join("\n");
}
