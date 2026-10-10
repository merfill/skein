import { childrenOf, goalOf, planOf, stopOf, unactionableOf, type State } from "./graph";
import type { Node } from "./types";

// The context the model sees is a tape of messages, rebuilt from the tree every turn
// (docs/ir_revision.md §5). There are no separate blocks: the request is the user turn, a
// `create_goal` is an assistant turn for the goal plus the first command's call/observation,
// an `apply` is a call/observation pair, and `stop` / `decline` are assistant turns. A
// closed goal contributes only its closure message — its internal messages leave the tape.

export type Situation = "request" | "goal";

export interface TapeMessage {
  role: "user" | "assistant" | "tool";
  text: string;
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
  retrieval?: { call: string; output: string; error?: string };
  // The reason a structural move was just refused: appended as a transient `tool` message
  // for this turn only (the refused move creates no node; §2.7).
  rejection?: string;
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
    return typeof payload.output === "string" ? payload.output : result.label;
  }
  return "ok";
}

function altMarker(state: State, itemId: string, prevId: string): string {
  const label = state.nodes.get(itemId)?.label ?? "step";
  const prev = state.nodes.get(prevId);
  return `alternative to step "${label}" (previous attempt: "${prev?.label ?? "?"}" — ${attemptReason(state, prevId)})`;
}

// Render a goal: its create_goal assistant turn, then its plan items and their alternatives
// in order; a closed goal renders only its closure message (the non-monotone cut, §5).
function renderGoal(state: State, goalId: string, out: TapeMessage[]): void {
  const stop = stopOf(state, goalId);
  if (stop !== undefined) {
    const why = payloadOf(state, stop)?.why;
    out.push({ role: "assistant", text: `stopped: ${typeof why === "string" && why !== "" ? why : "done"}` });
    return;
  }
  const goal = state.nodes.get(goalId);
  if (goal === undefined) return;
  out.push({ role: "assistant", text: goalText(goal) });

  const plan = planOf(state, goalId);
  if (plan === undefined) return;
  for (const itemId of childrenOf(state, plan)) {
    const alts = childrenOf(state, itemId);
    alts.forEach((altId, index) => {
      const alt = state.nodes.get(altId);
      if (alt === undefined) return;
      if (alt.kind === "action") {
        const call =
          index > 0
            ? `${altMarker(state, itemId, alts[index - 1] as string)}\n[${altId}] ${alt.label}`
            : `[${altId}] ${alt.label}`;
        out.push({ role: "assistant", text: call });
        const resultId = resultChild(state, altId)?.id ?? altId;
        out.push({ role: "tool", text: `[${resultId}] ${actionResultText(state, altId)}` });
      } else if (alt.kind === "goal") {
        if (index > 0) out.push({ role: "assistant", text: altMarker(state, itemId, alts[index - 1] as string) });
        renderGoal(state, altId, out);
      }
    });
  }
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
    history.push({ role: "assistant", text: options.retrieval.call });
    const text =
      options.retrieval.error !== undefined && options.retrieval.error !== ""
        ? `${options.retrieval.output}\n[stderr]\n${options.retrieval.error}`
        : options.retrieval.output;
    history.push({ role: "tool", text });
  }
  if (options.rejection !== undefined) {
    history.push({ role: "tool", text: options.rejection });
  }
  return { history, situation: situationOf(state), constraints: constraintsOf(state) };
}
