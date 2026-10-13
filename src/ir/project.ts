import {
  childrenOf,
  currentFocus,
  planOf,
  stopOf,
  unactionableOf,
  type State,
} from "./graph";
import { ISLANDS, isTerminalIsland, stateDescription, type IslandId } from "./islands";
import {
  applicable,
  currentMove,
  isMoveFinished,
  moveIsland,
  movePayload,
  type Applicable,
} from "./traversal";
import type { Node } from "./types";

// The context the model sees is a tape of messages, rebuilt from the tree every turn
// (docs/ir_semantics.md §7). The request is the user turn; each state is a `move` call and
// its result — while the state is open the result confirms the move and the plan's
// call/observation pairs follow; once the state is stopped its turns are elided and the
// `move` result carries the state's own closure, the `stop` reason read from the `move.stop`
// relation (docs/plans/goal_into_move_plan.md). There is no goal node: the state IS its goal.

export type Situation = "request" | "plan" | "working" | "transition" | "terminal";

// A native tool call the model made, carried so `buildMessages` can emit
// `assistant.tool_calls` / `tool` messages rather than a flat text tape (docs/ir_semantics §7).
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface TapeMessage {
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  // An assistant turn that is a single tool call (`[id] …` was the model's move this turn).
  call?: ToolCall;
  // An assistant turn that is a batch: the calls of one doxa move, in order. The following N
  // `tool` messages answer them by id (docs/ir_semantics §7).
  calls?: ToolCall[];
  // A tool result: the id of the assistant call it answers.
  callId?: string;
}

export interface Context {
  // The history tape (user / assistant / tool), rebuilt from the tree.
  history: TapeMessage[];
  // Which node instruction applies now: a fresh request, a state awaiting its first plan
  // item, a state being worked, a finished state awaiting the transition, or the terminal
  // state.
  situation: Situation;
  // The island of the focused state, when there is one (an authored label, §2.5).
  island?: IslandId;
  // The frontier: the moves admissible at the focus. The model surface is bound from it, so
  // the offered tools cannot include a move the engine would refuse (§2.6). Absent on a
  // hand-built context (tests), where the full surface is offered.
  applicable?: Applicable;
  constraints: { id: string; forbid: string[] }[];
  // A soft attractor: when the state has made no progress for `stall` turns, the projection
  // nudges the doxa to decide (an order is not dictated; §2.8, docs/testing.md).
  nudge?: string;
  // The observation instruction: shown right after a tool result while a state is being
  // worked — the doxa must read the result and decide (stop / next step / a different action).
  result?: string;
}

export interface ProjectOptions {
  // The current turn's `recall`/`search` result: these create no node, so the pair is
  // appended as a transient assistant/tool turn for this turn only.
  retrieval?: {
    call: string;
    name: string;
    args: Record<string, unknown>;
    output: string;
    error?: string;
  };
  // A structural move the engine refused: appended as a transient assistant call + `tool`
  // reason for this turn only (the refused move creates no node; §2.7).
  rejection?: { text: string; name: string; args: Record<string, unknown> };
  // The loop's stall counter (§2.8): after a turn with no progress it grows; the projection
  // turns it into the soft nudge.
  stall?: number;
}

function stripRef(ref: string): string {
  return ref.startsWith("file:") ? ref.slice("file:".length) : ref;
}

function nodePayload(node: Node | undefined): Record<string, unknown> | undefined {
  return node?.payload as Record<string, unknown> | undefined;
}

function payloadOf(state: State, id: string): Record<string, unknown> | undefined {
  return nodePayload(state.nodes.get(id));
}

// The newest result observation an action produced (`result` edge), if any.
function resultChild(state: State, actionId: string): Node | undefined {
  let best: Node | undefined;
  for (const edge of state.edges.values()) {
    if (edge.kind !== "result" || edge.from !== actionId) continue;
    const node = state.nodes.get(edge.to);
    if (node === undefined) continue;
    if (best === undefined || node.seq > best.seq) best = node;
  }
  return best;
}

function mutatedPaths(state: State, actionId: string): string[] {
  const paths: string[] = [];
  for (const edge of state.edges.values()) {
    if (edge.kind === "mutates" && edge.from === actionId) paths.push(stripRef(edge.to));
  }
  return paths;
}

// A tool result rendered for the tape, from the bounded inline body (the full body stays
// addressable by id via `recall`/`search`, docs/ir_semantics.md §7).
function observationText(node: Node): string {
  const payload = nodePayload(node) ?? {};
  const parts: string[] = [];
  if (typeof payload.ref === "string") {
    const start = typeof payload.start === "number" ? payload.start : undefined;
    const end = typeof payload.end === "number" ? payload.end : undefined;
    const total = typeof payload.total === "number" ? payload.total : undefined;
    let head = stripRef(payload.ref);
    if (start !== undefined && end !== undefined) {
      head += ` lines ${start}-${end}${total !== undefined ? ` of ${total}` : ""}`;
    }
    parts.push(head);
  }
  if (typeof payload.exitCode === "number") parts.push(`exit ${payload.exitCode}`);
  // A crash (a fatal signal, not a controlled exit) is a stronger fact than the exit code and
  // must reach the tape: the signal, the core (or why there is none) and the backtrace.
  if (typeof payload.signal === "string") {
    const core =
      typeof payload.core === "string"
        ? ` (core: ${payload.core})`
        : typeof payload.corePattern === "string"
          ? ` (no core: core_pattern ${payload.corePattern})`
          : "";
    parts.push(`killed by ${payload.signal}${core}`);
    if (typeof payload.backtrace === "string" && payload.backtrace !== "") parts.push(payload.backtrace);
  }
  if (typeof payload.output === "string" && payload.output !== "") parts.push(payload.output);
  if (typeof payload.error === "string" && payload.error !== "") parts.push(`[stderr]\n${payload.error}`);
  if (parts.length === 0) parts.push(node.label);
  return parts.join("\n");
}

function actionResultText(state: State, actionId: string): string {
  const result = resultChild(state, actionId);
  if (result !== undefined) return observationText(result);
  const mutated = mutatedPaths(state, actionId);
  if (mutated.length > 0) return `mutated ${mutated.join(", ")}`;
  return "no result";
}

// A one-line reason for the previous attempt at a step, for the alternative marker.
function attemptReason(state: State, altId: string): string {
  const result = resultChild(state, altId);
  if (result === undefined) {
    return mutatedPaths(state, altId).length > 0 ? "ok" : "no result";
  }
  const payload = payloadOf(state, result.id) ?? {};
  if (typeof payload.exitCode === "number") return payload.exitCode === 0 ? "ok" : `exit ${payload.exitCode}`;
  if (payload.failed === true || payload.refused === true) {
    // The reason stays a line: a failed edit's observation can carry a whole file body ("copy
    // `find` verbatim"), and the marker must not inline it — the body is already a `tool`
    // result in the tape and addressable by id. Inlining it here tripled the context (a run
    // spent ~47% of its input on duplicated `edit failed` bodies; docs/projection.md §5).
    const full = typeof payload.output === "string" && payload.output !== "" ? payload.output : result.label;
    const firstLine = full.split("\n", 1)[0] ?? full;
    const clipped = firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
    return `${clipped} (see [${result.id}])`;
  }
  return "ok";
}

function altMarker(state: State, itemId: string, prevId: string): string {
  const label = state.nodes.get(itemId)?.label ?? "step";
  const prev = state.nodes.get(prevId);
  return `alternative to step "${label}" (previous attempt: "${prev?.label ?? "?"}" — ${attemptReason(state, prevId)})`;
}

// The native tool call a node recorded at write time (`payload.call`), if any. Nodes written
// before the field existed fall back to text rendering.
function asCall(node: Node | undefined): { name: string; args: Record<string, unknown> } | undefined {
  const call = nodePayload(node)?.call as { name?: unknown; args?: unknown } | undefined;
  if (call === undefined || typeof call.name !== "string") return undefined;
  const args = typeof call.args === "object" && call.args !== null ? (call.args as Record<string, unknown>) : {};
  return { name: call.name, args };
}

// The closure line a finished state's `move` returns: the engine's mechanical reason (the
// `stop` payload) plus the optional model `note` (docs/plans/state_protocol_plan.md §4a). The
// note rides the `move` that leaves the state, so it is passed in by the caller. The changed
// files are deliberately NOT listed: a state that runs a build mutates thousands of artifacts.
function closureLine(state: State, moveId: string, note: string | undefined): string {
  const island = moveIsland(state, moveId);
  const label = island !== undefined ? ISLANDS[island].label : "State";
  const stop = stopOf(state, moveId);
  const why = stop !== undefined ? payloadOf(state, stop)?.why : undefined;
  let line = `State ${label}: finished — ${typeof why === "string" && why !== "" ? why : "done"}`;
  if (typeof note === "string" && note !== "") line += ` (note: ${note})`;
  return line;
}

// Render a state: its `move` native call and the result of that call. While the state is open
// the result confirms the move and the plan follows; once the state is stopped its turns are
// elided and the result is the state's own closure line (the `stop` reason, read from the
// `move.stop` relation — the state IS its goal, docs/plans/goal_into_move_plan.md).
function renderState(
  state: State,
  moveId: string,
  note: string | undefined,
  out: TapeMessage[],
): void {
  const move = state.nodes.get(moveId);
  const island = moveIsland(state, moveId);
  const label = island !== undefined ? ISLANDS[island].label : move?.label ?? "state";
  const call = asCall(move);
  if (call !== undefined) {
    out.push({ role: "assistant", text: "", call: { id: moveId, ...call } });
  } else {
    out.push({ role: "assistant", text: `[${moveId}] move: ${label}` });
  }
  if (stopOf(state, moveId) !== undefined) {
    out.push({ role: "tool", text: `[${moveId}] ${closureLine(state, moveId, note)}`, callId: moveId });
    return;
  }
  out.push({ role: "tool", text: `[${moveId}] moved to ${label}`, callId: moveId });
  // The state description is shown ONCE, when the state is entered, and stays on the tape while
  // the state is open (a finished state's turns are elided into its closure).
  if (island !== undefined) out.push({ role: "system", text: stateDescription(ISLANDS[island]) });
  renderPlan(state, moveId, out);
}

// Render a state's plan: its items and their current alternatives in order (the plan hangs
// directly off the `move` — there is no goal node, docs/plans/goal_into_move_plan.md). Calls
// a single doxa move made together (`payload.turn`) render as ONE assistant `tool_calls`
// message followed by their results, in order; a lone call keeps the plain `call` shape
// (docs/ir_semantics §7).
function renderPlan(state: State, moveId: string, out: TapeMessage[]): void {
  const plan = planOf(state, moveId);
  if (plan === undefined) return;
  let pending: { id: string; name: string; args: Record<string, unknown>; text: string }[] = [];
  let pendingTurn: number | undefined;
  const flush = (): void => {
    if (pending.length === 0) return;
    if (pending.length === 1) {
      const only = pending[0] as (typeof pending)[number];
      out.push({ role: "assistant", text: "", call: { id: only.id, name: only.name, args: only.args } });
      out.push({ role: "tool", text: only.text, callId: only.id });
    } else {
      out.push({
        role: "assistant",
        text: "",
        calls: pending.map((call) => ({ id: call.id, name: call.name, args: call.args })),
      });
      for (const call of pending) out.push({ role: "tool", text: call.text, callId: call.id });
    }
    pending = [];
    pendingTurn = undefined;
  };
  childrenOf(state, plan).forEach((itemId) => {
    const alts = childrenOf(state, itemId);
    alts.forEach((altId, index) => {
      const alt = state.nodes.get(altId);
      if (alt === undefined) return;
      if (alt.kind === "action") {
        const resultId = resultChild(state, altId)?.id ?? altId;
        const call = asCall(alt);
        const text = `[${resultId}] ${actionResultText(state, altId)}`;
        const marker = index > 0 ? `${altMarker(state, itemId, alts[index - 1] as string)}\n` : "";
        if (call === undefined) {
          // A legacy node (no recorded call) carries the rendered label and marker as text.
          flush();
          out.push({ role: "assistant", text: `${marker}[${altId}] ${alt.label}` });
          out.push({ role: "tool", text });
          return;
        }
        const turn = nodePayload(alt)?.turn;
        if (typeof turn !== "number") {
          // No turn stamp: render as its own single call (the pre-batch shape).
          flush();
          out.push({ role: "assistant", text: "", call: { id: altId, ...call } });
          out.push({ role: "tool", text, callId: altId });
          return;
        }
        if (pending.length > 0 && pendingTurn !== turn) flush();
        pendingTurn = turn;
        pending.push({ id: altId, name: call.name, args: call.args, text });
      }
    });
  });
  flush();
}

function constraintsOf(state: State): { id: string; forbid: string[] }[] {
  const constraints: { id: string; forbid: string[] }[] = [];
  for (const node of state.nodes.values()) {
    if (node.kind !== "constraint") continue;
    const forbid = payloadOf(state, node.id)?.forbid;
    constraints.push({
      id: node.id,
      forbid: Array.isArray(forbid) ? forbid.filter((item): item is string => typeof item === "string") : [],
    });
  }
  return constraints;
}

export function situationOf(state: State): Situation {
  if (state.rootId === undefined) return "request";
  const focus = currentFocus(state);
  const node = focus !== undefined ? state.nodes.get(focus) : undefined;
  if (node?.kind !== "move") return "request";
  const island = moveIsland(state, focus as string);
  if (island !== undefined && isTerminalIsland(island)) return "terminal";
  if (isMoveFinished(state, focus as string)) return "transition";
  // An open state: "plan" until the first `apply` seeds the plan, then "working".
  return planOf(state, focus as string) !== undefined ? "working" : "plan";
}

// The observation step: right after a tool result inside an open state, the doxa must read the
// result and decide. The state's work / criterion already sit on the tape (shown once at entry),
// so only the decision is restated here (docs/ir_semantics.md §7).
function observationInstruction(): string {
  return [
    "Tool result above. Stay in this state — work only its goal.",
    "Decide exactly one, and answer this first: does the state's `Done when` already hold? Yes → `stop`. No → the next action for this state if the step worked, or a DIFFERENT action if it failed or was the wrong step (never repeat it).",
  ].join("\n");
}

// The island of the focused state (the current `move`), when it has one. An authored label
// (docs/ir_semantics.md §2.5), never a gate.
export function islandOf(state: State): IslandId | undefined {
  const move = currentMove(state);
  if (move === undefined) return undefined;
  return moveIsland(state, move);
}

export function project(state: State, options: ProjectOptions = {}): Context {
  const history: TapeMessage[] = [];
  const rootId = state.rootId;
  if (rootId !== undefined) {
    const request = state.nodes.get(rootId);
    if (request?.kind === "request") {
      const text = payloadOf(state, rootId)?.text;
      history.push({ role: "user", text: typeof text === "string" ? text : request.label });
    }
    const unactionable = unactionableOf(state, rootId);
    if (unactionable !== undefined) {
      const why = payloadOf(state, unactionable)?.why;
      history.push({
        role: "assistant",
        text: `declined: ${typeof why === "string" && why !== "" ? why : "not actionable"}`,
      });
    } else {
      const moves = childrenOf(state, rootId);
      moves.forEach((moveId, index) => {
        // The model's `note` on a move summarizes the state it leaves, so it belongs on the
        // closure line of the previous state (the previous move's result).
        const nextNote = index + 1 < moves.length ? movePayload(state, moves[index + 1] as string)?.note : undefined;
        renderState(state, moveId, nextNote, history);
      });
    }
  }
  if (options.retrieval !== undefined) {
    const callId = "call:retrieval";
    history.push({
      role: "assistant",
      text: options.retrieval.call,
      call: { id: callId, name: options.retrieval.name, args: options.retrieval.args },
    });
    const text =
      options.retrieval.error !== undefined && options.retrieval.error !== ""
        ? `${options.retrieval.output}\n[stderr]\n${options.retrieval.error}`
        : options.retrieval.output;
    history.push({ role: "tool", text, callId });
  }
  if (options.rejection !== undefined) {
    const callId = "call:rejected";
    history.push({
      role: "assistant",
      text: "",
      call: { id: callId, name: options.rejection.name, args: options.rejection.args },
    });
    history.push({ role: "tool", text: options.rejection.text, callId });
  }
  const island = islandOf(state);
  const situation = situationOf(state);
  const frontier = applicable(state, currentFocus(state));
  const nudge =
    options.stall !== undefined && options.stall > 0 && island !== undefined
      ? `You have made no progress for ${options.stall} turn(s) in ${ISLANDS[island].label}. Decide now: name the exact change and edit; \`stop\` this state and \`move\` to the next; or \`stop\` at the terminal state.`
      : undefined;
  // Right after a tool result inside an open state, tell the doxa to read it and decide — the
  // state's rule and criterion restated at the highest recency (the observation step).
  const last = history[history.length - 1];
  const result =
    situation === "working" && last?.role === "tool" && island !== undefined
      ? observationInstruction()
      : undefined;
  return {
    history,
    situation,
    island,
    applicable: frontier,
    constraints: constraintsOf(state),
    ...(nudge !== undefined ? { nudge } : {}),
    ...(result !== undefined ? { result } : {}),
  };
}
