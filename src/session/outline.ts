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
import { observationText, project, clipRequestText, requestTextOf, actionResultText } from "../ir/project";
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
  // The whole request, not the 120-char display label: the observer must be able to read what
  // the request actually requires (bounded like every other outline body).
  const request = clipRequestText(requestTextOf(state) ?? labelOf(state, root));
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
  // A request's stored body is its full text, not the display label. The observer reaches body
  // with the request id when it needs what the request requires.
  if (node.kind === "request") {
    return clipRequestText(requestTextOf(state) ?? node.label);
  }
  if (node.kind === "observation") return clip(observationText(node));
  if (node.kind === "action") return clip(actionResultText(state, obsId));
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

// The tape handed to the observer: the current state's whole record in one body — the request, the
// move list, and every turn of the state in order. Each turn carries the doxa's reasoning, the
// action's full command and the observation body it produced, addressed by its node id so a hint's
// `evidence` can name it.
//
// Two deliberate choices, both measured on recorded runs. The state is the whole tape because a
// trigger fires inside one state and, in every recorded `state_long` run, 100% of the observation
// bodies sat in that state (none in the earlier ones). The reasoning is included because a stuck
// agent's problem is usually visible in what it was thinking, not only in what it ran — and the
// observer can no longer inspect anything it is not given here.
export function stateTape(state: State, anchor: string): string {
  const node = state.nodes.get(anchor);
  const moves: string[] = [];
  const root = state.rootId;
  if (root !== undefined) {
    for (const move of childrenOf(state, root)) {
      if (state.nodes.get(move)?.kind !== "move") continue;
      const payload = movePayload(state, move);
      const turnsId = turnsOf(state, move);
      const count = turnsId !== undefined ? childrenOf(state, turnsId).length : 0;
      const stop = stopOf(state, move);
      const closed = isMoveFinished(state, move);
      const outcome = closed ? `closed: ${stop !== undefined ? labelOf(state, stop) : ""}` : "open";
      moves.push(
        `- ${move} ${moveIsland(state, move) ?? "unknown"} what="${payload?.what ?? ""}" ${outcome} turns=${count}${
          move === anchor ? "  <- current" : ""
        }`,
      );
    }
  }
  const header = [
    root !== undefined
      ? `request ${root}: ${clipRequestText(requestTextOf(state) ?? "")}`
      : "request: (none)",
    "moves:",
    ...moves,
  ];
  if (node === undefined || node.kind !== "move") {
    // A trigger anchored on the request (no move yet): the moves are all there is to show.
    return header.join("\n");
  }
  const payload = movePayload(state, anchor);
  const turnsId = turnsOf(state, anchor);
  const actions = (turnsId !== undefined ? childrenOf(state, turnsId) : []).filter(
    (id) => state.nodes.get(id)?.kind === "action",
  );
  const lines = [
    ...header,
    "",
    `state ${anchor}: ${moveIsland(state, anchor) ?? "unknown"}`,
    `what: ${payload?.what ?? ""}`,
    ...(payload?.done !== undefined && payload.done !== "" ? [`done: ${payload.done}`] : []),
    `closure: ${isMoveFinished(state, anchor) ? "closed" : "open"}`,
    `turns: ${actions.length}`,
  ];
  for (const actionId of actions) {
    const action = state.nodes.get(actionId);
    if (action === undefined) continue;
    lines.push("");
    lines.push(`## ${actionId}`);
    // Chronology, as it happened: what the agent was thinking, what it then ran, what came back.
    // The reasoning comes first because it is the state's own account of why it is stuck.
    const reasoning = (action.payload as { reasoning?: unknown } | undefined)?.reasoning;
    if (typeof reasoning === "string" && reasoning !== "") lines.push(`thinking: ${reasoning}`);
    lines.push(`action: ${action.label}`);
    const resultId = resultOf(state, actionId);
    if (resultId !== undefined) {
      const observation = state.nodes.get(resultId);
      lines.push(`-> ${resultId}`);
      lines.push(observation !== undefined ? observationText(observation) : "");
      continue;
    }
    // `write`/`edit` attach a `mutates` edge, never a result node: rendering those as
    // "no result" would tell the observer a successful write failed.
    lines.push(`-> ${actionResultText(state, actionId)}`);
  }
  return lines.join("\n");
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
