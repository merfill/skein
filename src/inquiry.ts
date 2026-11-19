import type { ModelMessage } from "ai";

import { isAborted } from "./abort";
import type { Event } from "./ir/events";
import {
  activeHypothesis,
  activeHypothesisPath,
  childrenOf,
  goalVerdictOf,
  hypothesisMode,
  hypothesisNodeOf,
  hypothesisParentOf,
  hypothesisVerdictOf,
  fold,
  turnsOf,
  type State,
} from "./ir/graph";
import { actionResultText, type TapeMessage } from "./ir/project";
import { historyMessages } from "./loop/propose";
import {
  CLOSE_JSON_FORMAT,
  INQUIRY_WORK_TOOL_NAMES,
  closeHypothesisDescription,
  parseCloseJson,
  type InquiryProposer,
} from "./llm/inquiry";
import type { Proposals } from "./llm/schemas";
import type { GoalVerdictPayload, HypothesisPayload, HypothesisVerdictPayload } from "./ir/types";
import { executeAction, hypothesisCloseProblem, hypothesisVerdictEvents } from "./tools";
import type { Workspace } from "./tools/workspace";

export const INQUIRY_BASE_PROMPT = [
  "# Role",
  "You are a software engineering agent with access to the user's filesystem. You solve the user's tasks.",
  "The agent works on the given request. The work is a sequence of hypotheses.",
  "A hypothesis is a claim. You open it before working on it and close it when everything necessary for this hypothesis is done; it closes as confirmed (it worked), refuted (it did not), or dropped (abandoned). The engine records the opening and the closing; the work of a closed hypothesis is an artifact you can read when you need it.",
  "A hypothesis's scope is what it names: work outside it belongs to another hypothesis. The request is why the work exists and the criterion for the final outcome; it is not the goal of a hypothesis.",
  "## General instructions for the work",
  "Follow the project. Mimic its style, structure, naming, typing and architectural patterns; make the change idiomatic to the surrounding code. Add comments sparingly (why, not what), and never use comments to talk to the user.",
  "Work only the active hypothesis: decide the next step, make small changes, and debug from evidence. Its scope is its claim: anything outside the claim belongs to the next hypothesis — close this one, then open that claim.",
  "Read and edit files with the dedicated tools, not the shell; use the shell only for builds, tests, or other shell operations.",
  "Get the smallest result that decides the next step — a targeted lookup, or a small window around a known offset. Do not dump a whole file or binary region; a large output stays on the tape and costs context. When everything necessary for this hypothesis is done, close it: do not re-run a check that already passed or widen the lookup for its own sake.",
  "Work from the material in this workspace. The result must come from that material or from the request's specification. Do not invent values or fabricate results to fit a count, a form, or an expected answer. Acceptance is decided by the material or the specification, not by your own output.",
  "Do not reconstruct an external or upstream version from memory. If a reference is available — on disk or fetched — treat it as a lead to verify, not as the oracle.",
  "Keep the source material intact: copy raw artifacts before any command that may checkpoint, delete, or rewrite them.",
  "The workspace root is the current directory; the context already shows the request. Read only what you need; the tree is not indexed, so look up what you need.",
  "Never expose or commit secrets or keys. The summary you write when you finish the investigation is the final report: complete enough to stand alone, without padding or a separate preamble.",
].join("\n\n");

export interface InquiryDeps {
  propose: InquiryProposer;
  workspace: Workspace;
  maxTurns: number;
  // Optional per-turn journal hook: called after each completed turn with the events so far.
  // The step driver uses it to write the journal between pauses; the unit itself ignores it.
  onTurn?: (events: readonly Event[], turn: number) => void;
}

export interface InquiryInput {
  request: { id: string; text: string };
  // Resume from a recorded journal instead of seeding a fresh request (the step driver's H2
  // continuation). The request is still the projection's head.
  events?: Event[];
  startTurn?: number;
  signal?: AbortSignal;
}

export interface UnresolvedHypothesis {
  id: string;
  claim: string;
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
    `Opening hypothesis ${hypothesis.hypothesisId}.`,
    ...(hypothesis.followsFrom !== undefined && hypothesis.followsFrom.length > 0
      ? [`Follows from: ${hypothesis.followsFrom.join(", ")}`]
      : []),
  ].join("\n");
}

function claimMessage(hypothesis: HypothesisPayload): string {
  return `Claim: ${hypothesis.claim}`;
}

function doneWhenMessage(hypothesis?: HypothesisPayload): string {
  const done = hypothesis?.done?.trim();
  if (done !== undefined && done !== "") {
    return [
      `Done when: ${done.replace(/\.\s*$/, "")}.`,
      "When the criterion holds, reply with text only, no tool call, as a single JSON object (no markdown fences):",
      CLOSE_JSON_FORMAT,
    ].join("\n");
  }
  return [
    "Done when: the claim is decided — confirmed if it holds, refuted if it does not, dropped if you abandon it.",
    "When the claim is decided, reply with text only, no tool call, as a single JSON object (no markdown fences):",
    CLOSE_JSON_FORMAT,
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

// The tape is non-monotone: an open hypothesis renders its Opening, its Claim and Done when, and
// its turns; a closed hypothesis is wiped to its Opening and the engine-written Closing (verdict,
// observed, summary). Its turns stay in the journal (recall/search), not in the view.
function inquiryTape(state: State, requestId: string): TapeMessage[] {
  const turns = turnsOf(state, requestId);
  if (turns === undefined) return [];
  const active = new Set(activeHypothesisPath(state).map((hypothesis) => hypothesis.hypothesisId));
  const hypotheses: HypothesisPayload[] = [];
  const closed = new Set<string>();
  for (const node of state.nodes.values()) {
    if (node.kind !== "hypothesis") continue;
    const hypothesis = node.payload as HypothesisPayload | undefined;
    if (hypothesis === undefined) continue;
    hypotheses.push(hypothesis);
    if (hypothesisVerdictOf(state, hypothesis.hypothesisId) !== undefined) {
      closed.add(hypothesis.hypothesisId);
    }
  }
  // A hypothesis is visible when its parent is the formula/request or an open parent: the wipe
  // of a closed parent also hides its whole subtree.
  const visible = new Set<string>();
  for (const hypothesis of hypotheses) {
    const parent = hypothesisParentOf(state, hypothesis.hypothesisId);
    const parentId =
      parent?.kind === "hypothesis"
        ? (parent.payload as HypothesisPayload | undefined)?.hypothesisId
        : undefined;
    if (parentId === undefined || active.has(parentId)) visible.add(hypothesis.hypothesisId);
  }
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
      if (hypothesis !== undefined && visible.has(hypothesis.hypothesisId)) {
        tape.push({ role: "system", text: openingMessage(hypothesis) });
        if (closed.has(hypothesis.hypothesisId)) {
          const verdict = hypothesisVerdictOf(state, hypothesis.hypothesisId);
          if (verdict !== undefined) tape.push({ role: "system", text: closingMessage(verdict) });
        } else {
          tape.push({ role: "user", text: claimMessage(hypothesis) });
          tape.push({ role: "system", text: doneWhenMessage(hypothesis) });
        }
        continue;
      }
    }
    if (callName === "close_hypothesis") {
      // The Closing is rendered at the Opening (the work between the two is wiped).
      continue;
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
    claim: hypothesis.claim,
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
  let events: Event[] = input.events !== undefined ? [...input.events] : seedInquiry(input.request);
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

  const advance = (): void => {
    turn += 1;
    deps.onTurn?.(events, turn);
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
    // formula). Work leaf: act, or reply with the close JSON (text, no tool call) to close it.
    // Formula: open another sub-hypothesis, or reply with the close JSON once its children are
    // closed.
    const allowedTools = (() => {
      if (active === undefined) {
        const anyHypothesis = [...state.nodes.values()].some((node) => node.kind === "hypothesis");
        return anyHypothesis ? ["open_hypothesis", "close_goal"] : ["open_hypothesis"];
      }
      const mode = hypothesisMode(state, active.hypothesisId);
      if (mode === "formula" || mode === "mixed") return ["open_hypothesis"];
      if (mode === "undecided") return ["open_hypothesis", ...INQUIRY_WORK_TOOL_NAMES];
      return [...INQUIRY_WORK_TOOL_NAMES];
    })();
    const messages: ModelMessage[] = inquiryMessages(state, input.request);
    const toolDescriptions =
      active !== undefined
        ? { close_hypothesis: closeHypothesisDescription(active.hypothesisId) }
        : undefined;
    let proposals: Proposals;
    try {
      proposals = await deps.propose(messages, {
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        allowedTools,
        turn,
        ...(toolDescriptions !== undefined ? { toolDescriptions } : {}),
      });
    } catch (error) {
      if (isAborted(input.signal)) {
        paused = true;
        break;
      }
      // A malformed model call must not crash the unit: record it as an error and stop.
      const message = error instanceof Error ? error.message : String(error);
      stopWithError(state, "model_error", `(model error: ${message})`);
      advance();
      break;
    }

    if (proposals.actions.length === 0) {
      const text = proposals.thought.trim();
      if (active === undefined) {
        // With no hypothesis open the model must open the next one or close the goal.
        stopWithError(state, "no_goal", text !== "" ? text : "(no tool calls)");
        advance();
        break;
      }
      // A text-only reply closes the hypothesis: it carries the verdict, observed and summary
      // as JSON, and the engine records the same verdict node a close call would.
      const attempt = (reply: string): string | undefined => {
        const close = parseCloseJson(reply);
        if (close === undefined) return "the reply is not the required JSON object";
        const problem = hypothesisCloseProblem(state, active.hypothesisId);
        if (problem !== undefined) return problem;
        const seq = nextNodeSeq(state);
        const built = hypothesisVerdictEvents(
          active.hypothesisId,
          hypothesisNodeOf(state, active.hypothesisId)?.id,
          close,
          turn,
          seq,
        );
        events.push(...built.events);
        return undefined;
      };
      const problem = attempt(text);
      if (problem === undefined) {
        advance();
        continue;
      }
      const repair = [
        `The last reply did not close hypothesis ${active.hypothesisId}: ${problem}.`,
        "Reply with text only, no tool call, as a single JSON object (no markdown fences):",
        CLOSE_JSON_FORMAT,
      ].join("\n");
      let retry: Proposals;
      try {
        retry = await deps.propose([...messages, { role: "user", content: repair }], {
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
          allowedTools,
          turn,
          ...(toolDescriptions !== undefined ? { toolDescriptions } : {}),
        });
      } catch (error) {
        if (isAborted(input.signal)) {
          paused = true;
          break;
        }
        const message = error instanceof Error ? error.message : String(error);
        stopWithError(state, "model_error", `(model error: ${message})`);
        advance();
        break;
      }
      if (retry.actions.length === 0) {
        const retryProblem = attempt(retry.thought.trim());
        if (retryProblem !== undefined) {
          stopWithError(state, "bad_close", retry.thought.trim() !== "" ? retry.thought.trim() : text);
          advance();
          break;
        }
        advance();
        continue;
      }
      proposals = retry;
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
    advance();
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
