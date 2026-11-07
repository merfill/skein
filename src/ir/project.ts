import {
  childrenOf,
  currentFocus,
  stopOf,
  turnsOf,
  unactionableOf,
  type State,
} from "./graph";
import type { EnvironmentFact } from "./environment";
import { ISLANDS, isTerminalIsland, type IslandId } from "./islands";
import { briefFor, requestBrief } from "./briefs";
import { SESSION_PROBE_ID, type SessionProbe } from "./session";
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
// `Start state` / instruction markers and, while open, its turns' call/observation pairs. Once
// the state is stopped its turns are elided and the `Finish state` marker carries the stop
// reason read from the `move.stop` relation (docs/plans/archive/goal_into_move_plan.md). There
// is no goal node: the state IS its goal.

export type Situation = "request" | "working" | "transition" | "terminal";

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
  // Which node instruction applies now: a fresh request, an open state being worked, a
  // finished state awaiting the transition, or the terminal state.
  situation: Situation;
  // The island of the focused state, when there is one (an authored label, §2.5).
  island?: IslandId;
  // The doxa's `what` from the focused `move`: an unverified guess at the concrete subject,
  // not the state's goal. Rendered by the per-turn working prompt as advice.
  what?: string;
  // The focused state's stop condition, concretized by the doxa on the `move` (falls back to
  // the island's generic criterion in the renderer). Used by the per-turn working prompt.
  done?: string;
  // The frontier: the moves admissible at the focus. The model surface is bound from it, so
  // the offered tools cannot include a move the engine would refuse (§2.6). Absent on a
  // hand-built context (tests), where the full surface is offered.
  applicable?: Applicable;
  constraints: { id: string; forbid: string[] }[];
}

export interface ProjectOptions {
  // A structural move the engine refused: appended as a transient assistant call + `tool`
  // reason for this turn only (the refused move creates no node; §2.7).
  rejection?: { text: string; name: string; args: Record<string, unknown> };
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

// The request's own text. `payload.text` is the whole request; `label` is the same text cut to
// 120 chars for one-line display, so it is only a fallback for nodes written before the payload
// existed. Anything that reads the request's content must go through here, not through the
// label — a truncated request silently loses constraints (the acceptance clause among them).
export function requestTextOf(state: State): string | undefined {
  const root = state.rootId;
  if (root === undefined) return undefined;
  const node = state.nodes.get(root);
  if (node?.kind !== "request") return undefined;
  const text = payloadOf(state, root)?.text;
  return typeof text === "string" ? text : node.label;
}

// The bound on a rendered request body. Every reader of the request (the observer's outline and
// `body`, the session agent's L1 and `body`) shows the same text, so the bound lives here once.
export const MAX_REQUEST_TEXT = 8000;

export function clipRequestText(text: string): string {
  return text.length > MAX_REQUEST_TEXT
    ? `${text.slice(0, MAX_REQUEST_TEXT)}\n… (${text.length - MAX_REQUEST_TEXT} chars omitted)`
    : text;
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
export function observationText(node: Node): string {
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

// What an action produced, for any reader that renders a turn: the result observation if the
// action has one, else the paths it mutated (`write`/`edit` attach `mutates`, never a `result`
// node — rendering those as "no result" would tell the reader the write failed).
export function actionResultText(state: State, actionId: string): string {
  const result = resultChild(state, actionId);
  if (result !== undefined) return observationText(result);
  const mutated = mutatedPaths(state, actionId);
  if (mutated.length > 0) return `mutated ${mutated.join(", ")}`;
  return "no result";
}

// The native tool call a node recorded at write time (`payload.call`), if any. Nodes written
// before the field existed fall back to text rendering.
export function asCall(node: Node | undefined): { name: string; args: Record<string, unknown> } | undefined {
  const call = nodePayload(node)?.call as { name?: unknown; args?: unknown } | undefined;
  if (call === undefined || typeof call.name !== "string") return undefined;
  const args = typeof call.args === "object" && call.args !== null ? (call.args as Record<string, unknown>) : {};
  return { name: call.name, args };
}

// The files the state wrote with an explicit file tool (`write`/`edit`), not the files a build
// mutates: those are the task's artifacts, and the next state needs to know they exist. Shell
// mutations are deliberately excluded — a build can touch thousands of files.
function artifactsOfMove(state: State, moveId: string): string[] {
  const seen = new Set<string>();
  for (const id of actionsOfMove(state, moveId)) {
    const call = asCall(state.nodes.get(id));
    if (call === undefined || (call.name !== "write" && call.name !== "edit")) continue;
    const path = call.args.filePath;
    if (typeof path === "string" && path !== "") seen.add(path);
  }
  return [...seen];
}

// The closure line a finished state's `move` returns: the engine's mechanical reason (the `stop`
// payload), plus the explicit artifacts the state wrote.
function closureLine(state: State, moveId: string): string {
  const island = moveIsland(state, moveId);
  const label = island !== undefined ? ISLANDS[island].label : "State";
  const stop = stopOf(state, moveId);
  const why = stop !== undefined ? payloadOf(state, stop)?.why : undefined;
  const line = `Finish state ${label} — ${typeof why === "string" && why !== "" ? why : "done"}`;
  const artifacts = artifactsOfMove(state, moveId);
  if (artifacts.length === 0) return line;
  const shown = artifacts.slice(0, 8);
  const more = artifacts.length > shown.length ? `, … (+${artifacts.length - shown.length} more)` : "";
  return `${line}\nArtifacts: ${shown.join(", ")}${more}`;
}

// The state's action nodes, in turn order (docs/ir_semantics §2.3).
export function actionsOfMove(state: State, moveId: string): string[] {
  const turns = turnsOf(state, moveId);
  if (turns === undefined) return [];
  return childrenOf(state, turns).filter(
    (id) => state.nodes.get(id)?.kind === "action",
  );
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

// The engine-owned facts for the focused state, rendered by the state's own brief
// (`src/ir/briefs.ts`). The working states get the coordinates plus their environment subset;
// Verification gets the environment alone; End gets nothing.
function stateBrief(state: State, island: IslandId): string {
  const probe = probeOf(state);
  if (probe === undefined) return "";
  return briefFor(island, probe);
}

// Render a state: its boundaries. A state is a decision, not a tool call, so it is two markers:
// `Start state <label>` and — once closed — `Finish state <label>` (the `stop` reason). A closed
// state is exactly that pair: no brief or turns. An open state carries the focused brief and
// its turns; the goal, criterion and plan are restated in the per-turn working prompt that
// `buildMessages` appends after the turns (docs/ir_semantics §7).
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
  renderTurns(state, moveId, out);
}

// Render a state's turns: its actions in append order (the turns container hangs directly off
// the `move` — there is no goal node, docs/plans/archive/goal_into_move_plan.md). Calls a
// single doxa move made together (`payload.turn`) render as ONE assistant `tool_calls` message
// followed by their results, in order; a lone call keeps the plain `call` shape
// (docs/ir_semantics §7).
function renderTurns(state: State, moveId: string, out: TapeMessage[]): void {
  const turns = turnsOf(state, moveId);
  if (turns === undefined) return;
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
  for (const actionId of childrenOf(state, turns)) {
    const action = state.nodes.get(actionId);
    if (action === undefined || action.kind !== "action") continue;
    const resultId = resultChild(state, actionId)?.id ?? actionId;
    const call = asCall(action);
    const text = `[${resultId}] ${actionResultText(state, actionId)}`;
    const rawReasoning = nodePayload(action)?.reasoning;
    const reasoning = typeof rawReasoning === "string" && rawReasoning !== "" ? rawReasoning : undefined;
    if (call === undefined) {
      // A legacy node (no recorded call) carries its rendered label as text.
      flush();
      out.push({ role: "assistant", text: `[${actionId}] ${action.label}` });
      out.push({ role: "tool", text });
      continue;
    }
    const turn = nodePayload(action)?.turn;
    if (typeof turn !== "number") {
      // No turn stamp: render as its own single call (the pre-batch shape).
      flush();
      out.push({
        role: "assistant",
        text: "",
        call: { id: actionId, ...call },
        ...(reasoning !== undefined ? { reasoning } : {}),
      });
      out.push({ role: "tool", text, callId: actionId });
      continue;
    }
    if (pending.length > 0 && pendingTurn !== turn) flush();
    pendingTurn = turn;
    if (reasoning !== undefined) pendingReasoning = reasoning;
    pending.push({ id: actionId, name: call.name, args: call.args, text });
  }
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
  return "working";
}

// The observation step: right after a tool result inside an open state, the doxa must read the
// result and decide. The instruction is ACTIVE (an imperative, not a passive description): a
// passive form did not change behaviour in the replay experiment, while this directive produced
// the edit (docs/plans/prompt_stall_investigation_ru.md §6). It is island-aware: a state whose
// surface has no write tool is told to reply with its result, never to edit.
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

function advisoriesOf(state: State, moveId: string | undefined): TapeMessage[] {
  const nodes = [...state.nodes.values()]
    .filter((node) => {
      if (node.kind === "memo") return true;
      if (node.kind !== "hint") return false;
      const payload = node.payload as { state?: unknown } | undefined;
      return (
        moveId !== undefined &&
        payload?.state === moveId &&
        !isMoveFinished(state, moveId)
      );
    })
    .sort((left, right) => left.seq - right.seq);

  return nodes.map((node) => {
    const payload = node.payload as
      | { text?: unknown; evidence?: unknown }
      | undefined;
    const text = typeof payload?.text === "string" ? payload.text : node.label;
    const evidence = Array.isArray(payload?.evidence)
      ? payload.evidence.filter((id): id is string => typeof id === "string")
      : [];
    const suffix = evidence.length > 0 ? ` (evidence: ${evidence.join(", ")})` : "";
    return {
      role: "system",
      text: `${node.kind === "hint" ? "Tape-agent hint" : "Tape-agent memo"}: ${text}${suffix}`,
    };
  });
}

export function project(state: State, options: ProjectOptions = {}): Context {
  const history: TapeMessage[] = [];
  const island = islandOf(state);
  const rootId = state.rootId;
  if (rootId !== undefined) {
    const request = state.nodes.get(rootId);
    if (request?.kind === "request") {
      const requestText = requestTextOf(state) ?? request.label;
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
        // A fresh request has no state to carry the probe: show the workspace coordinates
        // before the `move`. The state that opens gets its own brief (coordinates + environment).
        if (childrenOf(state, rootId).length === 0) {
          const probe = probeOf(state);
          const brief = probe !== undefined ? requestBrief(probe) : "";
          if (brief !== "") history.push({ role: "system", text: brief });
        }
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
  const what = focusedPayload?.what;
  const done = focusedPayload?.done;
  const situation = situationOf(state);
  const frontier = applicable(state, currentFocus(state));
  history.push(...advisoriesOf(state, focusedMove));
  return {
    history,
    situation,
    island,
    ...(what !== undefined && what !== "" ? { what } : {}),
    ...(done !== undefined && done !== "" ? { done } : {}),
    applicable: frontier,
    constraints: constraintsOf(state),
  };
}
