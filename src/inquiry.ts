import type { ModelMessage } from "ai";

import { isAborted } from "./abort";
import type { Event } from "./ir/events";
import {
  activeHypothesis,
  activeHypothesisPath,
  childrenOf,
  goalVerdictOf,
  hypothesisMode,
  fold,
  turnsOf,
  type State,
} from "./ir/graph";
import { actionResultText, type TapeMessage } from "./ir/project";
import { historyMessages } from "./loop/propose";
import { INQUIRY_WORK_TOOL_NAMES, type InquiryProposer } from "./llm/inquiry";
import type { Proposals } from "./llm/schemas";
import type { GoalVerdictPayload, HypothesisPayload, HypothesisVerdictPayload } from "./ir/types";
import { executeAction } from "./tools";
import type { Workspace } from "./tools/workspace";

export const INQUIRY_BASE_PROMPT = [
  "# Role",
  "You are a software engineering agent with access to the user's filesystem. You solve the user's tasks.",
  "Solve the user's request. You work under one hypothesis at a time: a claim that can be true or false. An action runs only under an open hypothesis: before it, state the claim the action tests; after the result, close the hypothesis.",
  "A hypothesis is either a work leaf or a formula, fixed by its first child: an action makes it a work leaf, a sub-hypothesis makes it a formula. Do not mix actions and sub-hypotheses under one hypothesis. A work leaf takes actions and is closed after them; a formula is closed after its sub-hypotheses are closed. A hypothesis with no child cannot be closed.",
  "The request is the goal. The engine keeps H, the conjunction of the hypotheses you open; you do not write H. Open a hypothesis for each distinct claim; a work leaf can take several actions, and a formula splits its claim into sub-hypotheses. Never open a hypothesis that is a restatement or reformulation of one already opened, whether it is still open or closed.",
  "The summaries of earlier hypotheses are real data: trust them and use them in the next claim.",
  "Close with what you actually observed, not with what you expected: `confirmed` when the work showed the claim held, `refuted` when it did not. A refuted hypothesis stays in the journal; open a corrected or different one. A hypothesis verdict is about its claim; the request's result is the goal's outcome.",
  "Every reply calls a tool. Work tools — the tools that inspect or change the workspace — can be used only while a hypothesis is open; opening a hypothesis makes them available. With a hypothesis open, act under it or close it. With no hypothesis open, open the next distinct claim; if the request's result is reached and no distinct claim remains, close the goal H with `close_goal` — the outcome and the final summary. That summary is the report.",
  "## General instructions for the work",
  "Follow the project. Mimic its style, structure, naming, typing and architectural patterns; make the change idiomatic to the surrounding code. Add comments sparingly (why, not what), and never use comments to talk to the user.",
  "Work only the active hypothesis: decide the next step, make small changes, and debug from evidence. Do not do work outside the active hypothesis or expand the scope.",
  "Prefer the dedicated inspection and editing tools for files; use the shell only for builds, tests, or other shell operations.",
  "Inspect narrowly: ask for the smallest result that decides the next step — a targeted search, or a small window around a known offset. Do not dump a whole file or binary region; a large output stays on the tape and costs context. When the hypothesis is settled, stop: do not re-run a check that already passed or widen the search for its own sake.",
  "Work from the material in this workspace. The result must come from that material or from the request's specification. Do not invent values or fabricate results to fit a count, a form, or an expected answer. Acceptance is decided by the material or the specification, not by your own output.",
  "Do not reconstruct an external or upstream version from memory. If a reference is available — on disk or fetched — treat it as a lead to verify, not as the oracle.",
  "Keep the source material intact: copy raw artifacts before any command that may checkpoint, delete, or rewrite them.",
  "The workspace root is the current directory; the context already shows the request. Inspect only what you need; the tree is not indexed, so look up what you need.",
  "Never expose or commit secrets or keys. The goal summary is the final report: complete enough to stand alone, without padding or a separate preamble.",
].join("\n\n");

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
  suppose: string;
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
  const formulaId = `${request.id}:H`;
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
      type: "add_node",
      node: {
        id: formulaId,
        space: "work",
        kind: "formula",
        label: "H",
        payload: { formulaId: "H" },
        seq: 2,
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
    {
      type: "add_edge",
      edge: {
        id: `${request.id}:formula:edge`,
        from: request.id,
        to: formulaId,
        kind: "formula",
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

function openingMessage(hypothesis: HypothesisPayload): string {
  return [
    `Opening hypothesis ${hypothesis.hypothesisId}: ${hypothesis.label}.`,
    `Suppose: ${hypothesis.suppose}`,
    ...(hypothesis.followsFrom !== undefined && hypothesis.followsFrom.length > 0
      ? [`Follows from: ${hypothesis.followsFrom.join(", ")}`]
      : []),
  ].join("\n");
}

function verdictWords(verdict: HypothesisVerdictPayload["verdict"]): string {
  switch (verdict) {
    case "confirmed":
      return "confirmed";
    case "refuted":
      return "refuted";
    case "dropped":
      return "dropped";
  }
}

function verdictSummary(verdict: HypothesisVerdictPayload): string {
  const summary = verdict.summary?.replace(/\s+/g, " ").trim();
  return summary !== undefined && summary !== "" ? summary : "(no summary recorded)";
}

function verdictObserved(verdict: HypothesisVerdictPayload): string {
  const observed = verdict.observed?.replace(/\s+/g, " ").trim();
  return observed !== undefined && observed !== "" ? observed : "(no observation recorded)";
}

function closingMessage(verdict: HypothesisVerdictPayload): string {
  return [
    `Closing hypothesis ${verdict.hypothesisId}: ${verdictWords(verdict.verdict)}.`,
    `Observed: ${verdictObserved(verdict)}`,
    `Summary: ${verdictSummary(verdict)}`,
  ].join("\n");
}

function goalClosingMessage(verdict: GoalVerdictPayload): string {
  return [
    `Closing formula H: ${verdict.outcome}.`,
    `Summary: ${verdict.summary?.replace(/\s+/g, " ").trim() || "(no summary recorded)"}`,
  ].join("\n");
}

// The tape is chronological: an Opening message, the work under that hypothesis, and a Closing
// message. Only the active path's work is selected; a closed hypothesis renders its
// Opening/Closing pair, and its work stays addressable in the journal (recall/search).
function inquiryTape(state: State, requestId: string): TapeMessage[] {
  const turns = turnsOf(state, requestId);
  if (turns === undefined) return [];
  const active = new Set(activeHypothesisPath(state).map((hypothesis) => hypothesis.hypothesisId));
  const tape: TapeMessage[] = [];
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
    const failed = (result?.payload as { failed?: unknown } | undefined)?.failed === true;
    const hypothesisId = typeof payload?.hypothesisId === "string" ? payload.hypothesisId : undefined;
    const isHypothesisTool =
      callName === "open_hypothesis" ||
      callName === "close_hypothesis" ||
      callName === "close_goal";

    if (callName === "open_hypothesis" && result?.kind === "hypothesis") {
      const hypothesis = result.payload as HypothesisPayload | undefined;
      if (hypothesis !== undefined) {
        tape.push({ role: "system", text: openingMessage(hypothesis) });
        continue;
      }
    }
    if (callName === "close_hypothesis" && result?.kind === "hypothesis_verdict") {
      const verdict = result.payload as HypothesisVerdictPayload | undefined;
      if (verdict !== undefined) {
        tape.push({ role: "system", text: closingMessage(verdict) });
        continue;
      }
    }
    if (callName === "close_goal" && result?.kind === "goal_verdict") {
      const verdict = result.payload as GoalVerdictPayload | undefined;
      if (verdict !== undefined) {
        tape.push({ role: "system", text: goalClosingMessage(verdict) });
        continue;
      }
    }

    // Only work on the active path is selected; a closed hypothesis keeps its Opening/Closing
    // pair in the view and its work in the journal. Refused hypothesis calls stay visible so
    // the model can correct them.
    if (!isHypothesisTool && hypothesisId !== undefined && !active.has(hypothesisId)) continue;

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
      tape.push({ role: "assistant", text: "", call, ...reasoning });
    } else {
      tape.push({ role: "assistant", text: action.label, ...reasoning });
    }
    const written = callName === "write" || callName === "edit" || callName === "apply_patch";
    const text = written && !failed ? action.label : actionResultText(state, actionId);
    const ref = resultId ?? actionId;
    tape.push({ role: "tool", text: `[${ref}] ${text}`, callId: actionId });
  }

  return tape;
}

export function inquiryMessages(
  state: State,
  request: { id: string; text: string },
  basePrompt: string = INQUIRY_BASE_PROMPT,
): ModelMessage[] {
  return [
    { role: "system", content: basePrompt },
    { role: "user", content: request.text },
    ...historyMessages(inquiryTape(state, request.id)),
  ];
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
    suppose: hypothesis.suppose,
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
        id: `e:stop:${seq}`,
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

  const stopWithError = (state: State, reason: string, text: string): void => {
    const stop = endInquiry(state, events, text, turn);
    events = stop.events;
    unresolved = stop.unresolved;
    final = "";
    done = false;
    stopReason = reason;
  };

  while (turn < maxTurns) {
    if (isAborted(input.signal)) {
      paused = true;
      break;
    }
    const state = fold(events);
    const active = activeHypothesis(state);
    // The surface follows the active node's mode. No open node: open the next claim or close
    // the goal. Undecided: act (making it a work leaf) or open a sub-hypothesis (making it a
    // formula), but not close it yet. Work leaf: act or close it. Formula: open another
    // sub-hypothesis or, once they are closed, close it. Every reply is a tool call.
    const allowedTools = (() => {
      if (active === undefined) return ["open_hypothesis", "close_goal"];
      const mode = hypothesisMode(state, active.hypothesisId);
      if (mode === "formula" || mode === "mixed") return ["open_hypothesis", "close_hypothesis"];
      if (mode === "undecided") {
        return [
          "open_hypothesis",
          ...INQUIRY_WORK_TOOL_NAMES.filter((name) => name !== "close_hypothesis"),
        ];
      }
      return [...INQUIRY_WORK_TOOL_NAMES];
    })();
    const messages: ModelMessage[] = inquiryMessages(state, input.request);
    let proposals: Proposals;
    try {
      proposals = await deps.propose(messages, {
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        allowedTools,
      });
    } catch (error) {
      if (isAborted(input.signal)) {
        paused = true;
        break;
      }
      // A malformed model call must not crash the unit: record it as an error and stop.
      const message = error instanceof Error ? error.message : String(error);
      stopWithError(state, "model_error", `(model error: ${message})`);
      turn += 1;
      break;
    }

    if (proposals.actions.length === 0) {
      // A reply always calls a tool: close the open hypothesis or act under it; with none
      // open, open the next hypothesis or close the goal.
      const text = proposals.thought.trim();
      stopWithError(state, active !== undefined ? "no_close" : "no_goal", text !== "" ? text : "(no tool calls)");
      turn += 1;
      break;
    }

    const hasHypothesisTool = proposals.actions.some(
      (action) =>
        action.operator === "open_hypothesis" ||
        action.operator === "close_hypothesis" ||
        action.operator === "close_goal",
    );
    const batchViolation =
      proposals.actions.length > 1 && hasHypothesisTool
        ? "hypothesis_tool_alone: open_hypothesis, close_hypothesis and close_goal must be the only tool call in a reply"
        : undefined;

    let ended = false;
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
        {
          hypothesisRules: true,
          ...(batchViolation !== undefined ? { batchViolation } : {}),
        },
      );
      events.push(...outcome.events);
      // Closing the goal H ends the work: its summary is the result.
      const after = fold(events);
      const goal = goalVerdictOf(after);
      if (goal !== undefined) {
        const payload = goal.payload as GoalVerdictPayload;
        final = payload.summary?.trim() ?? "";
        unresolved = [];
        done = true;
        stopReason = payload.outcome === "achieved" ? "achieved" : "not_achieved";
        ended = true;
        break;
      }
    }
    if (paused) break;
    turn += 1;
    if (ended) break;
  }

  if (!done && !paused && stopReason === null) {
    // The turn budget is a stand limit, not a result: the formula is not closed.
    const state = fold(events);
    stopWithError(state, "max_turns", "(turn budget exhausted)");
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
