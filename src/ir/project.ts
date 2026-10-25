import {
  childrenOf,
  currentFocus,
  planOf,
  stopOf,
  unactionableOf,
  type State,
} from "./graph";
import type { EnvironmentFact } from "./environment";
import { ISLANDS, isTerminalIsland, stateDescription, type IslandId } from "./islands";
import { workspaceBrief } from "./material";
import { SESSION_PROBE_ID, probeBrief, type SessionProbe } from "./session";
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
// (docs/ir_semantics.md §7). The request is the only `user` turn; a state renders as
// `Start state` / instruction markers and, while open, its plan's call/observation pairs. Once
// the state is stopped its turns are elided and the `Finish state` marker carries the stop
// reason read from the `move.stop` relation (docs/plans/archive/goal_into_move_plan.md). There
// is no goal node: the state IS its goal.

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
  // The doxa's hidden reasoning for the turn this assistant message carries (the batch's
  // action nodes' `payload.reasoning`). Rendered as the assistant turn's `reasoning` part
  // (`src/loop/propose.ts`); never a user-visible answer.
  reasoning?: string;
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
  // The focused state's stop condition, concretized by the doxa on the `move` (falls back to
  // the island's generic criterion in the renderer). Used by the per-turn nudge.
  done?: string;
  // The focused state's goal, concretized by the doxa on the `move` (falls back to the island's
  // generic goal in the renderer). Used by the per-turn nudge.
  what?: string;
  // The frontier: the moves admissible at the focus. The model surface is bound from it, so
  // the offered tools cannot include a move the engine would refuse (§2.6). Absent on a
  // hand-built context (tests), where the full surface is offered.
  applicable?: Applicable;
  constraints: { id: string; forbid: string[] }[];
  // A soft attractor: when the state has made no progress for `stall` turns, the projection
  // nudges the doxa to decide (an order is not dictated; §2.8, docs/testing.md).
  nudge?: string;
}

export interface ProjectOptions {
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
export function asCall(node: Node | undefined): { name: string; args: Record<string, unknown> } | undefined {
  const call = nodePayload(node)?.call as { name?: unknown; args?: unknown } | undefined;
  if (call === undefined || typeof call.name !== "string") return undefined;
  const args = typeof call.args === "object" && call.args !== null ? (call.args as Record<string, unknown>) : {};
  return { name: call.name, args };
}

// The closure line a finished state's `move` returns: the engine's mechanical reason (the `stop`
// payload). The changed files are deliberately NOT listed: a state that runs a build mutates
// thousands of artifacts.
function closureLine(state: State, moveId: string): string {
  const island = moveIsland(state, moveId);
  const label = island !== undefined ? ISLANDS[island].label : "State";
  const stop = stopOf(state, moveId);
  const why = stop !== undefined ? payloadOf(state, stop)?.why : undefined;
  return `Finish state ${label} — ${typeof why === "string" && why !== "" ? why : "done"}`;
}

// The plan's action nodes, in plan order (docs/ir_semantics §2.3).
export function actionsOfMove(state: State, moveId: string): string[] {
  const plan = planOf(state, moveId);
  if (plan === undefined) return [];
  const actions: string[] = [];
  for (const itemId of childrenOf(state, plan)) {
    for (const altId of childrenOf(state, itemId)) {
      if (state.nodes.get(altId)?.kind === "action") actions.push(altId);
    }
  }
  return actions;
}

// The last failing run of a state: the `bash` observation with the newest non-zero exit code.
export function lastFailingRun(state: State, moveId: string): { command: string; exitCode: number; tail: string } | undefined {
  let best: { seq: number; run: { command: string; exitCode: number; tail: string } } | undefined;
  for (const actionId of actionsOfMove(state, moveId)) {
    const result = resultChild(state, actionId);
    if (result === undefined) continue;
    const payload = payloadOf(state, result.id) ?? {};
    if (typeof payload.exitCode !== "number" || payload.exitCode === 0) continue;
    const call = asCall(state.nodes.get(actionId));
    const fromArgs = call?.args.command;
    const command =
      typeof payload.command === "string"
        ? payload.command
        : typeof fromArgs === "string"
          ? fromArgs
          : (call?.name ?? "command");
    const body =
      typeof payload.error === "string" && payload.error !== ""
        ? payload.error
        : typeof payload.output === "string"
          ? payload.output
          : "";
    const run = { command, exitCode: payload.exitCode, tail: tailLines(body) };
    if (best === undefined || result.seq > best.seq) best = { seq: result.seq, run };
  }
  return best?.run;
}

function tailLines(text: string): string {
  const lines = text.trimEnd().split("\n").filter((line) => line !== "");
  const tail = lines.slice(Math.max(0, lines.length - 8)).join("\n");
  return tail.length > 700 ? `…${tail.slice(tail.length - 700)}` : tail;
}

// The engine-owned facts for the focused state. Orientation gets the workspace map; L/R get
// the same map as the Orientation result and, where the state needs tools, the environment
// probe under its own heading; other states get the probe as reference.
function stateBrief(state: State, island: IslandId): string {
  const probe = probeOf(state);
  if (probe === undefined) return "";
  const blocks: string[] = [];
  if (island === "orientation") {
    if (probe.material !== undefined) blocks.push(workspaceBrief(probe.material, "Workspace map"));
  } else if (island === "localization" || island === "research") {
    if (probe.material !== undefined) blocks.push(workspaceBrief(probe.material, "Workspace map"));
    const environment = probeBrief(probe, island);
    if (environment !== "") blocks.push(environment);
  } else if (island === "patch") {
    // Patch needs the material map, not the toolchain: the repository status (no git when
    // `none`) and the entries resolve the located coordinates without re-listing.
    if (probe.material !== undefined) blocks.push(workspaceBrief(probe.material, "Workspace map"));
  } else {
    const environment = probeBrief(probe, island);
    if (environment !== "") blocks.push(environment);
  }
  return blocks.join("\n\n");
}

// Render a state: its boundaries. A state is a decision, not a tool call, so it is two markers:
// `Start state <label>` and — once closed — `Finish state <label>` (the `stop` reason). A closed
// state is exactly that pair: no brief, instruction, goal, or plan. An open state carries the
// focused brief, the instruction, its goal as a `user` turn, and its plan; `buildMessages`
// appends the per-turn tail (docs/ir_semantics §7).
function renderState(state: State, moveId: string, out: TapeMessage[]): void {
  const move = state.nodes.get(moveId);
  const island = moveIsland(state, moveId);
  const label = island !== undefined ? ISLANDS[island].label : move?.label ?? "state";
  out.push({ role: "system", text: `Start state ${label}` });
  if (stopOf(state, moveId) !== undefined) {
    out.push({ role: "system", text: closureLine(state, moveId) });
    return;
  }

  // The session probe rides the FOCUSED open state only.
  const focused = moveId === currentMove(state);
  const brief = focused && island !== undefined ? stateBrief(state, island) : "";
  if (brief !== "") out.push({ role: "system", text: brief });
  if (island !== undefined) out.push({ role: "system", text: ISLANDS[island].instruction });

  const payload = movePayload(state, moveId);
  const what = island !== undefined ? ISLANDS[island].what : (payload?.what ?? "");
  if (what !== "") out.push({ role: "user", text: `what: ${what}` });
  renderPlan(state, moveId, out);
}

// Render a state's plan: its items and their current alternatives in order (the plan hangs
// directly off the `move` — there is no goal node, docs/plans/archive/goal_into_move_plan.md). Calls
// a single doxa move made together (`payload.turn`) render as ONE assistant `tool_calls`
// message followed by their results, in order; a lone call keeps the plain `call` shape
// (docs/ir_semantics §7).
function renderPlan(state: State, moveId: string, out: TapeMessage[]): void {
  const plan = planOf(state, moveId);
  if (plan === undefined) return;
  let pending: { id: string; name: string; args: Record<string, unknown>; text: string }[] = [];
  let pendingTurn: number | undefined;
  // The reasoning of the batch being assembled (one per turn); shown on its assistant message.
  let pendingReasoning: string | undefined;
  const flush = (): void => {
    if (pending.length === 0) return;
    const reasoning = pendingReasoning !== undefined ? { reasoning: pendingReasoning } : {};
    if (pending.length === 1) {
      const only = pending[0] as (typeof pending)[number];
      out.push({ role: "assistant", text: "", call: { id: only.id, name: only.name, args: only.args }, ...reasoning });
      out.push({ role: "tool", text: only.text, callId: only.id });
    } else {
      out.push({
        role: "assistant",
        text: "",
        calls: pending.map((call) => ({ id: call.id, name: call.name, args: call.args })),
        ...reasoning,
      });
      for (const call of pending) out.push({ role: "tool", text: call.text, callId: call.id });
    }
    pending = [];
    pendingTurn = undefined;
    pendingReasoning = undefined;
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
        const rawReasoning = nodePayload(alt)?.reasoning;
        const reasoning = typeof rawReasoning === "string" && rawReasoning !== "" ? rawReasoning : undefined;
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
          out.push({
            role: "assistant",
            text: "",
            call: { id: altId, ...call },
            ...(reasoning !== undefined ? { reasoning } : {}),
          });
          out.push({ role: "tool", text, callId: altId });
          return;
        }
        if (pending.length > 0 && pendingTurn !== turn) flush();
        pendingTurn = turn;
        if (reasoning !== undefined) pendingReasoning = reasoning;
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
// result and decide. The instruction is ACTIVE (an imperative, not a passive description): a
// passive form did not change behaviour in the replay experiment, while this directive produced
// the edit (docs/plans/prompt_stall_investigation_ru.md §6). It is island-aware: a state whose
// surface has no write tool (Localization) is told to `stop`, never to edit. The state's `Now:`
// directive rides the state description on the tape.
// The island of the focused state (the current `move`), when it has one. An authored label
// (docs/ir_semantics.md §2.5), never a gate.
export function islandOf(state: State): IslandId | undefined {
  const move = currentMove(state);
  if (move === undefined) return undefined;
  return moveIsland(state, move);
}

// The session probe, recorded once at request start (`src/loop/probe.ts`). It is not a child
// of the request and is never copied into a state; the projection renders its subset at the
// entry of the focused state.
function probeOf(state: State): SessionProbe | undefined {
  // `fact:env` is the id recorded by the previous probe version; replaying an older journal
  // keeps its environment fact rather than silently dropping it.
  const node = state.nodes.get(SESSION_PROBE_ID) ?? state.nodes.get("fact:env");
  if (node?.kind !== "fact") return undefined;
  const payload = node.payload as SessionProbe | EnvironmentFact | undefined;
  if (payload === undefined) return undefined;
  return "environment" in payload || "material" in payload
    ? (payload as SessionProbe)
    : { environment: payload as EnvironmentFact };
}

export function project(state: State, options: ProjectOptions = {}): Context {
  const history: TapeMessage[] = [];
  const island = islandOf(state);
  const rootId = state.rootId;
  if (rootId !== undefined) {
    const request = state.nodes.get(rootId);
    if (request?.kind === "request") {
      const text = payloadOf(state, rootId)?.text;
      const requestText = typeof text === "string" ? text : request.label;
      // The request leads the tape (right after the base prompt), once, on every turn.
      history.push({ role: "user", text: requestText });
      const unactionable = unactionableOf(state, rootId);
      if (unactionable !== undefined) {
        const why = payloadOf(state, unactionable)?.why;
        history.push({
          role: "assistant",
          text: `declined: ${typeof why === "string" && why !== "" ? why : "not actionable"}`,
        });
      } else {
        // The probe lives in the state entry, not in a preamble after the request: each
        // state gets the facts it needs, at the point where it works.
        for (const moveId of childrenOf(state, rootId)) renderState(state, moveId, history);
      }
    }
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
  const focusedMove = currentMove(state);
  const focusedPayload = focusedMove !== undefined ? movePayload(state, focusedMove) : undefined;
  const done = focusedPayload?.done;
  const what = focusedPayload?.what;
  const situation = situationOf(state);
  const frontier = applicable(state, currentFocus(state));
  const nudge =
    options.stall !== undefined && options.stall > 0 && island !== undefined
      ? `You have made no progress for ${options.stall} turn(s) in ${ISLANDS[island].label}. Act, or call \`stop\` when the \`done\` criterion holds.`
      : undefined;
  return {
    history,
    situation,
    island,
    ...(done !== undefined && done !== "" ? { done } : {}),
    ...(what !== undefined && what !== "" ? { what } : {}),
    applicable: frontier,
    constraints: constraintsOf(state),
    ...(nudge !== undefined ? { nudge } : {}),
  };
}
