import { childrenOf, goalOf, planOf, stopOf, unactionableOf, type State } from "./graph";
import type { Node } from "./types";

// The context the model sees is a tape of messages, rebuilt from the tree every turn
// (docs/ir_revision.md §5). There are no separate blocks: the request is the user turn, a
// `create_goal` is an assistant turn for the goal plus the first command's call/observation,
// an `apply` is a call/observation pair, and `stop` / `decline` are assistant turns. A
// closed goal contributes only its closure message — its internal messages leave the tape.

export type Situation = "request" | "goal";

// A native tool call the model made, carried so `buildMessages` can emit
// `assistant.tool_calls` / `tool` messages rather than a flat text tape (docs/ir_semantics §7).
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface TapeMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  // An assistant turn that is a tool call (`[id] …` was the model's move this turn).
  call?: ToolCall;
  // A tool result: the id of the assistant call it answers.
  callId?: string;
}

export interface Context {
  // The history tape (user / assistant / tool), rebuilt from the tree.
  history: TapeMessage[];
  // Which node instruction applies now: a fresh request or an open goal.
  situation: Situation;
  constraints: { id: string; forbid: string[] }[];
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

// Every field is labelled explicitly, so the model can tell what apart and an
// absent optional field is visible as `(none)` rather than silently dropped.
function goalText(node: Node): string {
  const payload = nodePayload(node);
  const field = (name: string, fallback: string): string => {
    const value = payload?.[name];
    return typeof value === "string" && value !== "" ? value : fallback;
  };
  return [
    `[${node.id}] create_goal:`,
    `what: ${field("what", node.label)}`,
  ].join("\n");
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
// addressable by id via `recall`/`search`, docs/ir_revision.md §5.2).
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
  const node = state.nodes.get(altId);
  if (node?.kind === "goal") {
    return stopOf(state, altId) !== undefined ? "goal closed" : "goal open";
  }
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

// Render a goal: its create_goal native call and its result, then its plan items and their
// alternatives in order; a closed goal renders only its closure message (the non-monotone
// cut, §5). The seeded first command is a separate `run` call, so every tool the model's
// move implies has its own assistant/tool pair (docs/ir_semantics §7).
function renderGoal(state: State, goalId: string, out: TapeMessage[]): void {
  const stop = stopOf(state, goalId);
  if (stop !== undefined) {
    const why = payloadOf(state, stop)?.why;
    out.push({ role: "assistant", text: `stopped: ${typeof why === "string" && why !== "" ? why : "done"}` });
    return;
  }
  const goal = state.nodes.get(goalId);
  if (goal === undefined) return;
  const what = (payloadOf(state, goalId)?.what as string | undefined) ?? goal.label;
  const goalCall = asCall(goal);
  if (goalCall !== undefined) {
    out.push({ role: "assistant", text: "", call: { id: goalId, ...goalCall } });
    out.push({ role: "tool", text: `[${goalId}] goal created: ${what}`, callId: goalId });
  } else {
    out.push({ role: "assistant", text: goalText(goal) });
  }

  const plan = planOf(state, goalId);
  if (plan === undefined) return;
  childrenOf(state, plan).forEach((itemId) => {
    const alts = childrenOf(state, itemId);
    alts.forEach((altId, index) => {
      const alt = state.nodes.get(altId);
      if (alt === undefined) return;
      if (alt.kind === "action") {
        const resultId = resultChild(state, altId)?.id ?? altId;
        const call = asCall(alt);
        const marker = index > 0 ? `${altMarker(state, itemId, alts[index - 1] as string)}\n` : "";
        out.push({
          role: "assistant",
          // A native call keeps its content empty (the call is in `tool_calls`); only a
          // legacy node (no recorded call) carries the rendered label and marker.
          text: call !== undefined ? "" : `${marker}[${altId}] ${alt.label}`,
          ...(call !== undefined ? { call: { id: altId, ...call } } : {}),
        });
        out.push({
          role: "tool",
          text: `[${resultId}] ${actionResultText(state, altId)}`,
          ...(call !== undefined ? { callId: altId } : {}),
        });
      } else if (alt.kind === "goal") {
        if (index > 0 && asCall(alt) === undefined) {
          out.push({ role: "assistant", text: altMarker(state, itemId, alts[index - 1] as string) });
        }
        renderGoal(state, altId, out);
      }
    });
  });
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
  const interpreted = goalOf(state, state.rootId) !== undefined || unactionableOf(state, state.rootId) !== undefined;
  return interpreted ? "goal" : "request";
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
      const goal = goalOf(state, rootId);
      if (goal !== undefined) renderGoal(state, goal, history);
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
  return { history, situation: situationOf(state), constraints: constraintsOf(state) };
}
