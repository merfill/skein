import { END, START, StateGraph } from "@langchain/langgraph";

import { loadSettings } from "../config/settings";
import { isFailedVerificationMove, revertFailedPatch } from "../ir/attempts";
import type { Event } from "../ir/events";
import { actionExecuted, childrenOf, currentVersion, fold, lastChild, planOf, type State } from "../ir/graph";
import { isTerminalIsland } from "../ir/islands";
import { project } from "../ir/project";
import { SESSION_PROBE_ID, type SessionProbe } from "../ir/session";
import { currentMove, focusEvents, isMoveFinished, moveIsland } from "../ir/traversal";
import type { Action, Proposals } from "../llm/schemas";
import { modelCall } from "../llm/schemas";
import { applyReaction } from "../session/apply";
import { runRequestObserver, type ObserverDeps } from "../session/observer";
import {
  createSession,
  observerDepth,
  openUnit,
  popUnit,
  pushUnit,
  recordReaction,
  recordTrigger,
  sessionFocus,
  unitOf,
} from "../session/session";
import { detectTriggers } from "../session/triggers";
import type { SessionState } from "../session/types";
import { commandOf, executeAction, resolveBody } from "../tools";
import type { Workspace } from "../tools/workspace";
import { classify } from "./classify";
import { reconcile, type VersionCache } from "./observe";
import type { Proposer } from "./propose";
import { LoopState, type LoopStateType } from "./state";

// A move that changes the focus or ends the run: it must be the last call of a batch, so
// everything the model emitted after it is dropped (the state it reasoned from is gone).
const TERMINAL = new Set<Action["operator"]>(["move", "stop", "decline"]);

function describeTarget(action: Action): string {
  let target: string;
  switch (action.operator) {
    case "recall":
      target = action.id;
      break;
    case "search":
      target = `${action.id}:${action.pattern}`;
      break;
    case "move":
      target = `state:${action.state}`;
      break;
    case "stop":
      target = "stop";
      break;
    case "decline":
      target = "decline";
      break;
    case "apply":
      target = commandOf(action.action);
      break;
  }
  return target.replace(/\s+/g, " ").trim().slice(0, 120);
}

const NEAR_END_ISLANDS = new Set(["end", "patch", "recovery", "construction"]);

function isNearEnd(state: State): boolean {
  const move = currentMove(state);
  const island = move !== undefined ? moveIsland(state, move) : undefined;
  return island !== undefined && NEAR_END_ISLANDS.has(island);
}

export interface AgentDeps {
  propose: Proposer;
  workspace: Workspace;
  maxTurns: number;
  graceTurns?: number;
  // The session probe (`src/loop/probe.ts`): environment and material. The real entry points
  // pass it so the fact is journalled once at request start; a replay or a unit test omits it.
  probe?: (workspace: Workspace) => SessionProbe | undefined;
  // The request observer. Absent by default, so the task loop runs without one.
  observer?: ObserverDeps;
  // An external actor (a human or a program) may emit events before each turn — the seam
  // for future user intervention. Absent by default.
  arbiter?: (state: State, turn: number) => Event[];
}

export interface AgentInput {
  request: { id: string; text: string };
  constraints?: { id: string; label: string; forbid?: string[] }[];
  // Resume from a recorded journal instead of seeding a fresh request. Used by the tape
  // replay harnesses; the seed already carries the request node (and any constraints).
  seed?: Event[];
  // The turn number the resumed journal stopped at; `maxTurns` remains absolute.
  startTurn?: number;
  session?: SessionState;
  // Open and push the request unit even when a session is supplied (the session driver uses
  // this to start a new task). Defaults to `session === undefined`.
  open?: boolean;
}

export interface AgentResult {
  events: Event[];
  done: boolean;
  stopReason: string | null;
  turns: number;
  // The message behind a terminal stop (`llm_error` today), persisted by the caller so a
  // provider failure is diagnosable after the fact.
  stopText?: string | null;
  session?: SessionState;
}

export function compileGraph(deps: AgentDeps) {
  const signatures: VersionCache = new Map();
  const graceTurns = deps.graceTurns ?? loadSettings().graceTurns;

  const projectNode = (state: LoopStateType) => {
    // The external actor (if any) may react before the turn; its events join the journal
    // like any other, with the same provenance discipline.
    const external = deps.arbiter ? deps.arbiter(fold(state.events), state.turn) : [];
    const seed = external.length > 0 ? [...state.events, ...external] : state.events;
    const base = fold(seed);
    const drift = reconcile(base, deps.workspace, signatures);
    let current = fold(drift, base);
    const focusDrift = focusEvents(current);
    if (focusDrift.length > 0) current = fold(focusDrift, current);
    // A structural move (stop/decline/move) refused by `classify` creates no node, so it is
    // appended as a transient assistant call + `tool` reason for the next turn, so the doxa
    // sees why its move was refused (§2.7). A `recall`/`search` result is a node now, so it is
    // on the tape like any observation — no transient pairing.
    const rejection = state.rejection ?? undefined;
    return {
      events: [...external, ...drift, ...focusDrift],
      context: project(current, {
        ...(rejection !== undefined ? { rejection } : {}),
      }),
    };
  };

  const proposeNode = async (state: LoopStateType) => {
    const context = state.context ?? project(fold(state.events));
    let proposals: Proposals;
    try {
      proposals = await deps.propose(context);
    } catch (error) {
      // A persistent model failure (e.g. the provider keeps truncating) must not crash
      // the run: stop gracefully with `llm_error` so the partial work is kept. The message
      // is also carried on `stopText` so the trace can record it (not only a transient turn).
      const text = `llm_error: ${error instanceof Error ? error.message : String(error)}`;
      return {
        context,
        proposals: null,
        done: true,
        stopReason: "llm_error",
        stopText: text,
        recent: [{ seq: state.turn, kind: "proposal" as const, text }],
      };
    }
    return {
      context,
      proposals,
      recent: [{ seq: state.turn, kind: "proposal" as const, text: proposals.thought }],
    };
  };

  const executeNode = (state: LoopStateType) => {
    const proposals = state.proposals;
    if (!proposals || proposals.actions.length === 0) {
      return {
        turn: state.turn + 1,
        recent: [
          { seq: state.turn, kind: "proposal" as const, text: "rejected: no proposal" },
        ],
      };
    }
    // The batch is a single doxa move: one thought, N calls. The engine decides and runs
    // each call in order against the state the previous calls left; a terminal move
    // (create_goal/stop/decline) ends the batch (the rest of the message is dropped).
    const events: Event[] = [];
    const recent: LoopStateType["recent"] = [];
    let rejection: LoopStateType["rejection"] = null;
    let done = false;
    let stopReason: string | null = null;
    for (const action of proposals.actions) {
      const current = fold([...state.events, ...events]);
      const classification = classify(action, current);
      if (!classification.accept) {
        const reason = classification.reason ?? "rejected";
        const text = `rejected ${describeTarget(action)}: ${reason}`;
        const call = modelCall(action);
        events.push({
          type: "record_rejection" as const,
          tool: action.operator,
          target: describeTarget(action),
          reason,
          ...(classification.constraintId !== undefined
            ? { constraintId: classification.constraintId }
            : {}),
          turn: state.turn,
        });
        recent.push({ seq: state.turn, kind: "proposal" as const, text });
        rejection = { text, name: call.name, args: call.args };
        if (TERMINAL.has(action.operator)) break;
        continue;
      }
      // A failed Verification leaves a patch that is known not to work. Before the move back
      // to Localization the engine restores the tree to its pre-patch state, so Localization
      // reasons about the original code and Patch cannot no-op on the rejected change. The
      // attempt itself stays on the tape (the revert is an engine event, not a tool call).
      let target = current;
      if (isFailedVerificationMove(current, action)) {
        const revert = revertFailedPatch(current, deps.workspace);
        if (revert.length > 0) {
          events.push(...revert);
          target = fold([...state.events, ...events]);
        }
      }
      const outcome = executeAction(action, target, deps.workspace, state.turn, proposals.reasoning);
      events.push(...outcome.events);
      recent.push(outcome.turn);
      done = outcome.done;
      if (outcome.stopReason !== null) stopReason = outcome.stopReason;
      if (done) break;
      if (TERMINAL.has(action.operator)) break;
    }
    return {
      events,
      recent,
      turn: state.turn + 1,
      done,
      stopReason,
      rejection,
    };
  };

  const progressNode = async (state: LoopStateType) => {
    if (state.done) return {};
    const current = fold(state.events);
    const rootId = current.rootId;
    if (rootId !== undefined) {
      // The request ends when its terminal state (`finish`) is stopped (there is no `stop`
      // on the request).
      const move = currentMove(current);
      const island = move !== undefined ? moveIsland(current, move) : undefined;
      if (
        move !== undefined &&
        island !== undefined &&
        isTerminalIsland(island) &&
        isMoveFinished(current, move)
      ) {
        return { done: true, stopReason: "request_addressed" };
      }
    }

    const session = state.session ?? undefined;
    const unitId = session !== undefined ? sessionFocus(session)?.unitId : undefined;
    let events: Event[] = [];
    let done = false;
    let stopReason: string | null = null;
    let stopText: string | null = null;

    if (session !== undefined && unitId !== undefined) {
      const unit = unitOf(session, unitId);
      if (state.events.length > unit.journal.length) {
        unit.journal.push(...state.events.slice(unit.journal.length));
      }
      unit.turn = state.turn;

      const move = currentMove(current);
      const island = move !== undefined ? moveIsland(current, move) : undefined;
      const nearClosure = island !== undefined && isTerminalIsland(island);
      const triggers = detectTriggers(
        { state: current, session, unitId, turn: state.turn, terminal: nearClosure },
        { maxTurns: deps.maxTurns },
      );
      const trigger =
        triggers.find((candidate) => candidate.kind === "budget") ?? triggers[0];

      if (
        trigger !== undefined &&
        deps.observer !== undefined &&
        observerDepth(session) < (deps.observer.maxDepth ?? 1)
      ) {
        recordTrigger(session, unitId, state.turn, trigger);
        const observerUnitId = `observer:${trigger.id}`;
        openUnit(session, observerUnitId, "observer", [], state.turn);
        pushUnit(session, observerUnitId, 0);
        const observer = await runRequestObserver({
          trigger,
          state: current,
          tools: deps.observer.tools,
          agent: deps.observer.agent,
          events: state.events,
          ...(deps.observer.maxTurns !== undefined ? { maxTurns: deps.observer.maxTurns } : {}),
          ...(deps.observer.surveyLimit !== undefined
            ? { surveyLimit: deps.observer.surveyLimit }
            : {}),
        });
        popUnit(session);
        unitOf(session, observerUnitId).journal.push(...observer.journal);

        if (observer.decision !== undefined) {
          recordReaction(session, unitId, observer.decision);
          if (observer.decision.kind === "halt") {
            done = true;
            stopReason = "observer_halt";
            stopText = observer.decision.reason;
          } else {
            const applied = applyReaction({
              state: current,
              reaction: observer.decision,
              sourceUnit: observerUnitId,
            });
            if (applied.ok) events = applied.events;
          }
        }
      }
    }

    if (done) return { events, done, stopReason, stopText, session };
    if (state.turn >= deps.maxTurns && state.grace !== true) {
      if (isNearEnd(current)) return { events, session, grace: true };
      return { events, done: true, stopReason: "max_turns", session };
    }
    if (state.turn >= deps.maxTurns + (state.grace ? graceTurns : 0)) {
      return { events, done: true, stopReason: "max_turns", session };
    }
    return { events, session };
  };

  const route = (state: LoopStateType): "project" | typeof END => {
    if (state.done) return END;
    if (state.turn >= deps.maxTurns + (state.grace ? graceTurns : 0)) return END;
    return "project";
  };

  return new StateGraph(LoopState)
    .addNode("project", projectNode)
    .addNode("propose", proposeNode)
    .addNode("execute", executeNode)
    .addNode("progress", progressNode)
    .addEdge(START, "project")
    .addEdge("project", "propose")
    .addEdge("propose", "execute")
    .addEdge("execute", "progress")
    .addConditionalEdges("progress", route)
    .compile();
}

export async function runAgent(deps: AgentDeps, input: AgentInput): Promise<AgentResult> {
  const graph = compileGraph(deps);
  const graceTurns = deps.graceTurns ?? loadSettings().graceTurns;
  const seed: Event[] = input.seed !== undefined ? [...input.seed] : [
    {
      type: "add_node",
      node: {
        id: input.request.id,
        space: "work",
        kind: "request",
        label: input.request.text.replace(/\s+/g, " ").trim().slice(0, 120),
        payload: { text: input.request.text },
        seq: 0,
      },
    },
  ];
  if (input.seed === undefined) {
    for (const [index, constraint] of (input.constraints ?? []).entries()) {
      seed.push({
        type: "add_node",
        node: {
          id: constraint.id,
          space: "work",
          kind: "constraint",
          label: constraint.label,
          payload: { forbid: constraint.forbid ?? [] },
          seq: index + 1,
        },
      });
    }
    // The probe is a session fact: one deterministic observation of the environment and the
    // material at request start, journalled so a replay reads it instead of probing again.
    const probe = deps.probe?.(deps.workspace);
    if (probe !== undefined) {
      seed.push({
        type: "add_node",
        node: {
          id: SESSION_PROBE_ID,
          space: "work",
          kind: "fact",
          label: "session",
          payload: probe,
          seq: seed.length,
        },
      });
    }
  }

  const session = input.session ?? createSession();
  const opens = input.open ?? input.session === undefined;
  if (opens) {
    openUnit(session, input.request.id, "task", seed, input.startTurn ?? 0);
    pushUnit(session, input.request.id, input.startTurn ?? 0);
  }

  const final = await graph.invoke(
    {
      events: seed,
      recent: [],
      turn: input.startTurn ?? 0,
      done: false,
      stopReason: null,
      stopText: null,
      session,
      grace: false,
    },
    { recursionLimit: (deps.maxTurns + graceTurns) * 5 + 20 },
  );

  return {
    events: final.events,
    done: final.done,
    stopReason: final.stopReason,
    turns: final.turn,
    stopText: final.stopText,
    session: final.session ?? session,
  };
}
