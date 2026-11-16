import type { ModelMessage } from "ai";

import { isAborted } from "./abort";
import type { Event } from "./ir/events";
import {
  activeHypothesisPath,
  childrenOf,
  hypothesisChildrenOf,
  hypothesisNodes,
  hypothesisVerdictOf,
  fold,
  turnsOf,
  type State,
} from "./ir/graph";
import { actionResultText, observationText, type TapeMessage } from "./ir/project";
import { historyMessages } from "./loop/propose";
import type { InquiryProposer } from "./llm/inquiry";
import type { HypothesisPayload, HypothesisVerdictPayload, Node } from "./ir/types";
import { executeAction } from "./tools";
import type { Workspace } from "./tools/workspace";

export const INQUIRY_BASE_PROMPT = [
  "# Role",
  "You are a software engineering agent with access to the user's filesystem. You solve the user's tasks.",
  "You work by hypotheses: you put a hypothesis forward and close it when its outcome is observed. This uses the `open_hypothesis` and `close_hypothesis` tools. A hypothesis is a claim together with what you expect to see if you are right and if you are wrong.",
  "At the start of the work, call `open_hypothesis` to formulate the user's request as the root hypothesis: the result that must hold when the work is done, with the observation that shows it. Work inside the root, and close it last, once the hypotheses you opened under it are closed.",
  "An expectation is an observation that holds when you close the hypothesis, after the work it describes.",
  "Develop the active hypothesis: run the checks and actions the work needs, and close it when the outcome is observed. Open a new hypothesis only when you consider it different from the hypotheses already shown in OPEN and CLOSED and justified as new work; if an open hypothesis already asks the question, develop that one. A text reply ends the work when the result is observed or you cannot continue.",
  "Each turn you reply with tool calls; the engine runs them in order and returns the results. Batch calls that do not depend on another call's result. The engine records a tool-free reply as the result and marks open hypotheses unresolved.",
  "Context markers: CLOSED — settled hypotheses with their verdicts; OPEN — the hypotheses currently open.",
  "## General instructions for the work",
  "Follow the project. Mimic its style, structure, naming, typing and architectural patterns; make the change idiomatic to the surrounding code. Add comments sparingly (why, not what), and never use comments to talk to the user.",
  "Work only the active hypothesis: plan the step, make small changes, and debug from evidence. Do not do work outside the active hypothesis or expand the scope.",
  "Prefer the dedicated tools: read, grep and list to inspect, edit, write and apply_patch to change files. Use bash only for work they cannot do — running builds, tests, or other shell operations.",
  "Inspect narrowly: ask for the smallest result that decides the next step — a targeted grep, or a small window around a known offset. Do not dump a whole file or binary region; a large output stays on the tape and costs context. When the hypothesis is settled, stop: do not re-run a check that already passed or widen the search for its own sake.",
  "Work from the material in this workspace. The result must come from that material or from the request's specification. Do not invent values or fabricate results to fit a count, a form, or an expected answer. Acceptance is decided by the material or the specification, not by your own output.",
  "Do not reconstruct an external or upstream version from memory. If a reference is available — on disk or fetched — treat it as a lead to verify, not as the oracle.",
  "Keep the source material intact: copy raw artifacts before any command that may checkpoint, delete, or rewrite them.",
  "The workspace root is the current directory; the context already shows the request. Inspect only what you need; the tree is not indexed, so list what you need.",
  "Never expose or commit secrets or keys. Report concisely and to the point: the shortest answer that serves the request, with extra detail only when the user asked for it. No preamble or summary unless asked.",
].join("\n\n");

const FINAL_INSTRUCTION =
  "The turn limit is reached. Write the final answer now as text only, from what you have established; do not call tools. The OPEN block lists the hypotheses still open: name them by id and say what is unresolved; do not present it as proven.";

export interface InquiryDeps {
  propose: InquiryProposer;
  workspace: Workspace;
  maxTurns: number;
}

export interface InquiryInput {
  request: { id: string; text: string };
  startTurn?: number;
  signal?: AbortSignal;
}

export interface UnresolvedHypothesis {
  id: string;
  kind: HypothesisPayload["kind"];
  suppose: string;
  ifTrue: string;
  ifFalse: string;
}

export interface InquiryResult {
  events: Event[];
  done: boolean;
  paused?: boolean;
  stopReason: string | null;
  turns: number;
  final: string;
  unresolved: UnresolvedHypothesis[];
}

export function seedInquiry(request: { id: string; text: string }): Event[] {
  const turnsId = `${request.id}:turns`;
  return [
    {
      type: "add_node",
      node: {
        id: request.id,
        space: "work",
        kind: "request",
        label: request.text,
        payload: { text: request.text },
        seq: 0,
      },
    },
    {
      type: "add_node",
      node: {
        id: turnsId,
        space: "work",
        kind: "turns",
        label: `inquiry for ${request.id}`,
        seq: 1,
      },
    },
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

// A ground is an observation; the summary is what it showed. The engine does not track the
// files a change touched — a change is closed by the observation that shows its effect.
function groundSummary(state: State, ref: string): string {
  const node = state.nodes.get(ref);
  if (node?.kind !== "observation") return ref;
  const lines = observationText(node)
    .split("\n")
    .filter((part) => part.trim() !== "");
  const joined = lines.slice(0, 2).join(": ");
  return joined.length > 160 ? `${joined.slice(0, 160)}…` : joined;
}

function closedLine(state: State, hypothesis: HypothesisPayload): string {
  const verdict = hypothesisVerdictOf(state, hypothesis.hypothesisId);
  if (verdict === undefined) return `${hypothesis.hypothesisId} ${hypothesis.kind}: ${hypothesis.suppose}`;
  const seen = new Set<string>();
  const summaries: string[] = [];
  for (const ref of verdict.grounds) {
    const text = groundSummary(state, ref);
    if (seen.has(text)) continue;
    seen.add(text);
    summaries.push(text);
    if (summaries.length === 2) break;
  }
  const grounds = verdict.grounds.length > 0 ? ` (${verdict.grounds.join(", ")})` : "";
  return `${hypothesis.hypothesisId} ${hypothesis.kind} «${hypothesis.suppose}» — ${verdict.verdict}: ${summaries.join("; ")}${grounds}`;
}

function closedTree(state: State): string {
  const roots = hypothesisNodes(state)
    .map((node) => node.payload as HypothesisPayload | undefined)
    .filter(
      (hypothesis): hypothesis is HypothesisPayload =>
        hypothesis !== undefined && hypothesis.parentId === undefined && hypothesisVerdictOf(state, hypothesis.hypothesisId) !== undefined,
    );
  if (roots.length === 0) return "";
  const lines: string[] = ["CLOSED"];
  const render = (hypothesis: HypothesisPayload, depth: number): void => {
    lines.push(`${"  ".repeat(depth)}${closedLine(state, hypothesis)}`);
    for (const child of hypothesisChildrenOf(state, hypothesis.hypothesisId)) {
      if (hypothesisVerdictOf(state, child.hypothesisId) !== undefined) render(child, depth + 1);
    }
  };
  for (const root of roots) render(root, 1);
  return lines.join("\n");
}

function openPath(state: State): string {
  const path = activeHypothesisPath(state);
  if (path.length === 0) return "OPEN: none";
  const lines: string[] = ["OPEN"];
  const activeId = path[path.length - 1]?.hypothesisId;
  for (const hypothesis of path) {
    const marker = hypothesis.hypothesisId === activeId ? " [ACTIVE]" : "";
    lines.push(`${hypothesis.hypothesisId} ${hypothesis.kind}: ${hypothesis.suppose}${marker}`);
    lines.push(`  if true: ${hypothesis.ifTrue}`);
    lines.push(`  if false: ${hypothesis.ifFalse}`);
    for (const child of hypothesisChildrenOf(state, hypothesis.hypothesisId)) {
      if (hypothesisVerdictOf(state, child.hypothesisId) !== undefined) {
        lines.push(`  closed ${closedLine(state, child)}`);
      }
    }
  }
  return lines.join("\n");
}

function hypothesisResultText(callName: string | undefined, result: Node | undefined): string | undefined {
  if (callName === "close_hypothesis" && result?.kind === "hypothesis_verdict") {
    const verdict = result.payload as HypothesisVerdictPayload | undefined;
    if (verdict !== undefined) {
      const grounds = verdict.grounds.length > 0 ? ` (${verdict.grounds.join(", ")})` : "";
      return `${verdict.hypothesisId} ${verdict.verdict}${grounds}`;
    }
  }
  if (callName === "open_hypothesis" && result?.kind === "hypothesis") {
    const hypothesis = result.payload as HypothesisPayload | undefined;
    if (hypothesis !== undefined) {
      return `${hypothesis.hypothesisId} opened ${hypothesis.kind}: ${hypothesis.label}`;
    }
  }
  return undefined;
}

function activeHistory(state: State, requestId: string): TapeMessage[] {
  const turns = turnsOf(state, requestId);
  if (turns === undefined) return [];
  const active = new Set(activeHypothesisPath(state).map((hypothesis) => hypothesis.hypothesisId));
  const history: TapeMessage[] = [];
  for (const actionId of childrenOf(state, turns)) {
    const action = state.nodes.get(actionId);
    if (action === undefined || action.kind !== "action") continue;
    const payload = action.payload as
      | {
          call?: { name?: unknown; args?: unknown };
          reasoning?: unknown;
          hypothesisId?: unknown;
        }
      | undefined;
    const callName = typeof payload?.call?.name === "string" ? payload.call.name : undefined;
    const resultId = resultOf(state, actionId);
    const result = resultId !== undefined ? state.nodes.get(resultId) : undefined;
    const refused =
      (result?.payload as { refused?: unknown } | undefined)?.refused === true;
    const hypothesisId = typeof payload?.hypothesisId === "string" ? payload.hypothesisId : undefined;
    const isHypothesisTool = callName === "open_hypothesis" || callName === "close_hypothesis";
    if (!isHypothesisTool && !refused && (hypothesisId === undefined || !active.has(hypothesisId))) {
      continue;
    }
    const reasoning =
      typeof payload?.reasoning === "string" && payload.reasoning !== ""
        ? { reasoning: payload.reasoning }
        : {};
    const call =
      callName !== undefined
        ? {
            id: actionId,
            name: callName,
            args:
              payload?.call?.args !== null && typeof payload?.call?.args === "object"
                ? (payload.call.args as Record<string, unknown>)
                : {},
          }
        : undefined;
    if (call !== undefined) {
      history.push({ role: "assistant", text: "", call, ...reasoning });
    } else {
      history.push({ role: "assistant", text: action.label, ...reasoning });
    }
    const written = callName === "write" || callName === "edit" || callName === "apply_patch";
    const text =
      hypothesisResultText(callName, result) ??
      (written ? action.label : actionResultText(state, actionId));
    const ref = resultId ?? actionId;
    history.push({ role: "tool", text: `[${ref}] ${text}`, callId: actionId });
  }
  return history;
}

export function inquiryMessages(
  state: State,
  request: { id: string; text: string },
  basePrompt: string = INQUIRY_BASE_PROMPT,
): ModelMessage[] {
  const messages: ModelMessage[] = [
    { role: "system", content: basePrompt },
    { role: "user", content: request.text },
  ];
  const closed = closedTree(state);
  if (closed !== "") messages.push({ role: "system", content: closed });
  messages.push({ role: "system", content: openPath(state) });
  messages.push(...historyMessages(activeHistory(state, request.id)));
  return messages;
}

function nextNodeSeq(state: State): number {
  let max = 0;
  for (const node of state.nodes.values()) max = Math.max(max, node.seq);
  return max + 1;
}

function endInquiry(
  state: State,
  events: readonly Event[],
  text: string,
  turn: number,
): { events: Event[]; unresolved: UnresolvedHypothesis[] } {
  const path = activeHypothesisPath(state);
  const unresolved: UnresolvedHypothesis[] = path.map((hypothesis) => ({
    id: hypothesis.hypothesisId,
    kind: hypothesis.kind,
    suppose: hypothesis.suppose,
    ifTrue: hypothesis.ifTrue,
    ifFalse: hypothesis.ifFalse,
  }));
  const seq = nextNodeSeq(state);
  const stopId = `w:stop:${seq}`;
  const out: Event[] = [
    ...events,
    {
      type: "add_node",
      node: {
        id: stopId,
        space: "work",
        kind: "stop",
        label: text,
        payload: { why: text, unresolved, turn },
        seq,
      },
    },
  ];
  const root = state.rootId;
  if (root !== undefined) {
    out.push({
      type: "add_edge",
      edge: {
        id: `e:${seq + 1}`,
        from: root,
        to: stopId,
        kind: "stop",
        provenance: { kind: "llm" },
      },
    });
  }
  return { events: out, unresolved };
}

export async function runInquiryUnit(
  deps: InquiryDeps,
  input: InquiryInput,
): Promise<InquiryResult> {
  const startTurn = input.startTurn ?? 0;
  let events: Event[] = seedInquiry(input.request);
  let turn = startTurn;
  let done = false;
  let paused = false;
  let stopReason: string | null = null;
  let final = "";
  let unresolved: UnresolvedHypothesis[] = [];
  const maxTurns = deps.maxTurns;

  while (turn < maxTurns) {
    if (isAborted(input.signal)) {
      paused = true;
      break;
    }
    const state = fold(events);
    const messages = inquiryMessages(state, input.request);
    const proposals = await deps.propose(
      messages,
      input.signal !== undefined ? { signal: input.signal } : undefined,
    );

    if (proposals.actions.length === 0) {
      final = proposals.thought.trim();
      const stop = endInquiry(state, events, final !== "" ? final : "(no decision)", turn);
      events = stop.events;
      unresolved = stop.unresolved;
      done = true;
      stopReason = final !== "" ? "answered" : "no_decision";
      turn += 1;
      break;
    }

    for (const action of proposals.actions) {
      if (isAborted(input.signal)) {
        paused = true;
        break;
      }
      const current = fold(events);
      const outcome = executeAction(
        action,
        current,
        deps.workspace,
        turn,
        proposals.reasoning,
        { hypothesisRules: true },
      );
      events.push(...outcome.events);
    }
    if (paused) break;
    turn += 1;
  }

  if (!done && !paused) {
    const state = fold(events);
    const messages: ModelMessage[] = [
      ...inquiryMessages(state, input.request),
      { role: "system", content: FINAL_INSTRUCTION },
    ];
    try {
      const proposals = await deps.propose(messages, {
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        final: true,
      });
      final = proposals.thought.trim();
    } catch (error) {
      if (!isAborted(input.signal)) throw error;
      paused = true;
    }
    if (!paused) {
      const stop = endInquiry(state, events, final !== "" ? final : "(turn budget exhausted)", turn);
      events = stop.events;
      unresolved = stop.unresolved;
      done = true;
      stopReason = "max_turns";
    }
  }

  return {
    events,
    done,
    ...(paused ? { paused: true } : {}),
    stopReason,
    turns: turn,
    final,
    unresolved,
  };
}
