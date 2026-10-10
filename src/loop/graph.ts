import { END, START, StateGraph } from "@langchain/langgraph";

import type { Event } from "../ir/events";
import { actionExecuted, childrenOf, currentVersion, fold, goalOf, hasStopped, lastChild, planOf, type State } from "../ir/graph";
import { knowledgeKey } from "../ir/progress";
import { project } from "../ir/project";
import { focusEvents } from "../ir/traversal";
import type { Action, Proposal } from "../llm/schemas";
import { commandOf, executeAction, resolveBody } from "../tools";
import type { Workspace } from "../tools/workspace";
import { classify } from "./classify";
import { reconcile, type VersionCache } from "./observe";
import type { Proposer } from "./propose";
import { LoopState, type HeldEntry, type LoopStateType } from "./state";

// How long a body stays in the working set after the model fetched it with `recall {id}`,
// and how many bodies it holds (docs §9). Retention is otherwise structural: the produced
// results of every level on the branch stay in view until the parent closes. A fresh recall
// refreshes the entry; eviction drops the least recently requested first. TTL 6 covers the
// observed cross-level gaps — see tests/workingset.test.ts.
//
// The working set is bounded by the number of bodies only: every tool result is already
// bounded per body by its own tool limit, so `MAX_HELD` times that is the ceiling. A total-character cap was removed: it silently dropped a body larger than
// the cap (a source window being edited), which trapped the model in a `recall` loop
// (docs/benches/bench_report.md §4.4).
const HELD_TURNS = 6;
const MAX_HELD = 5;

// Upsert the fetched ids into the working set, each held for `turns` turns and refreshed
// on every fetch. Level results do not go through here — they are kept structurally.
function pinHeld(
  held: readonly HeldEntry[],
  ids: readonly string[],
  turn: number,
  turns: number,
): HeldEntry[] {
  const nextHeld = new Map(held.map((entry) => [entry.id, entry]));
  for (const id of ids) nextHeld.set(id, { id, expiresAt: turn + turns, pinnedAt: turn });
  return [...nextHeld.values()];
}

// A held read whose file has since changed is stale: it must not be shown as active
// content (invariant). Run/check bodies carry no file ref, so they never go stale.
function isStale(state: State, id: string): boolean {
  const node = state.nodes.get(id);
  if (node === undefined) return true;
  const payload = node.payload as { ref?: unknown; version?: unknown } | undefined;
  if (typeof payload?.ref !== "string" || typeof payload.version !== "string") return false;
  return currentVersion(state, payload.ref) !== payload.version;
}

// Every goal on the branch (the roots) plus, for each, its plan items and their current
// action alternative. A stage's evidence (the diff that localized the bug) must stay in
// view while an ancestor on the branch is still open. A stopped sub-goal is no longer on
// the branch, so its evidence leaves with it (its current alternative is a goal, not an
// action, and is not followed) — the model re-fetches it with a `recall` call if needed.
function branchSubtree(state: State, roots: readonly string[]): Set<string> {
  const out = new Set<string>(roots);
  for (const id of roots) {
    const plan = planOf(state, id);
    if (plan === undefined) continue;
    out.add(plan);
    for (const item of childrenOf(state, plan)) {
      out.add(item);
      const alt = lastChild(state, item);
      const altNode = alt !== undefined ? state.nodes.get(alt) : undefined;
      if (altNode?.kind === "action") out.add(alt as string);
    }
  }
  return out;
}

// The result a run/read action produced (its newest `produces` child), so the current
// level's evidence can be recalled without the model re-requesting it.
function producedResultId(state: State, actionId: string): string | undefined {
  let best: { seq: number; id: string } | undefined;
  for (const edge of state.edges.values()) {
    if (edge.kind !== "result" || edge.from !== actionId) continue;
    const node = state.nodes.get(edge.to);
    if (node === undefined) continue;
    if (best === undefined || node.seq > best.seq) best = { seq: node.seq, id: edge.to };
  }
  return best?.id;
}

function describeTarget(action: Action): string {
  let target: string;
  switch (action.operator) {
    case "recall":
      target = action.id;
      break;
    case "search":
      target = `${action.id}:${action.pattern}`;
      break;
    case "create_goal":
      target = `goal:${action.what}`;
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

export interface AgentDeps {
  propose: Proposer;
  workspace: Workspace;
  maxTurns: number;
  noProgress?: number;
  // Working-set limits (docs §9); overridable so tests can force eviction/expiry.
  held?: { turns?: number; max?: number };
  // An external actor (a human or a program) may emit events before each turn — the seam
  // for future user intervention. Absent by default.
  arbiter?: (state: State, turn: number) => Event[];
}

export interface AgentInput {
  request: { id: string; text: string };
  constraints?: { id: string; label: string; forbid?: string[] }[];
}

export interface AgentResult {
  events: Event[];
  done: boolean;
  stopReason: string | null;
  turns: number;
  // The message behind a terminal stop (`llm_error` today), persisted by the caller so a
  // provider failure is diagnosable after the fact.
  stopText?: string | null;
}

export function compileGraph(deps: AgentDeps) {
  const signatures: VersionCache = new Map();
  const noProgress = deps.noProgress ?? 10;
  const heldTurns = deps.held?.turns ?? HELD_TURNS;
  const maxHeld = deps.held?.max ?? MAX_HELD;

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
    // A `recall`/`search` result creates no node, so it is not in the tree: append it as a
    // transient assistant/tool pair for this turn only (docs/ir_revision.md §5.2). A
    // command's result is already a `tool` message in the tape, so it is not appended again.
    const lastToolTurn = [...state.recent].reverse().find((turn) => turn.kind === "tool");
    const retrieval =
      lastToolTurn !== undefined && lastToolTurn.nodeId === undefined && lastToolTurn.text !== ""
        ? {
            call: lastToolTurn.call ?? "retrieval",
            output: lastToolTurn.text,
            ...(lastToolTurn.error !== undefined ? { error: lastToolTurn.error } : {}),
          }
        : undefined;
    // A structural move (create_goal/stop/decline/recall/search) refused by `classify` creates no
    // node, so — like the retrieval result — its reason is appended as a transient `tool`
    // message for the next turn, so the doxa sees why its move was refused (§2.7).
    const rejection = state.rejection ?? undefined;
    return {
      events: [...external, ...drift, ...focusDrift],
      held: state.held.filter((entry) => entry.expiresAt >= state.turn),
      queried: state.queried.filter((entry) => entry.expiresAt >= state.turn),
      context: project(current, {
        ...(retrieval !== undefined ? { retrieval } : {}),
        ...(rejection !== undefined ? { rejection } : {}),
      }),
    };
  };

  const proposeNode = async (state: LoopStateType) => {
    const context = state.context ?? project(fold(state.events));
    let proposal: Proposal;
    try {
      proposal = await deps.propose(context);
    } catch (error) {
      // A persistent model failure (e.g. the provider keeps truncating) must not crash
      // the run: stop gracefully with `llm_error` so the partial work is kept. The message
      // is also carried on `stopText` so the trace can record it (not only a transient turn).
      const text = `llm_error: ${error instanceof Error ? error.message : String(error)}`;
      return {
        context,
        proposal: null,
        done: true,
        stopReason: "llm_error",
        stopText: text,
        recent: [{ seq: state.turn, kind: "proposal" as const, text }],
      };
    }
    return {
      context,
      proposal,
      recent: [{ seq: state.turn, kind: "proposal" as const, text: proposal.thought }],
    };
  };

  const classifyNode = (state: LoopStateType) => {
    if (!state.proposal) return { classification: null };
    // The working set is engine-owned: the projection keeps the branch levels' results,
    // and only `recall {id}` (execute) pins a body from elsewhere. The model does not
    // declare what to show.
    const classification = classify(
      state.proposal,
      fold(state.events),
      state.held.map((entry) => entry.id),
      state.queried.map((entry) => entry.id),
    );
    return { classification };
  };

  const executeNode = (state: LoopStateType) => {
    const classification = state.classification;
    const proposal = state.proposal;
    if (!proposal || !classification) {
      return {
        turn: state.turn + 1,
        recent: [
          { seq: state.turn, kind: "proposal" as const, text: "rejected: no proposal" },
        ],
      };
    }
    if (!classification.accept) {
      const reason = classification.reason ?? "rejected";
      const text = `rejected ${describeTarget(proposal.action)}: ${reason}`;
      return {
        events: [
          {
            type: "record_rejection" as const,
            tool: proposal.action.operator,
            target: describeTarget(proposal.action),
            reason,
            ...(classification.constraintId !== undefined
              ? { constraintId: classification.constraintId }
              : {}),
            turn: state.turn,
          },
        ],
        turn: state.turn + 1,
        recent: [{ seq: state.turn, kind: "proposal" as const, text }],
        rejection: text,
      };
    }
    const outcome = executeAction(
      proposal.action,
      fold(state.events),
      deps.workspace,
      state.turn,
    );
    // `recall {id}` pins the fetched body; a tool may also ask to pin a result it produced
    // (e.g. the materialized content of a failed edit), so the next move does not re-read.
    const recallId =
      proposal.action.operator === "recall" ? proposal.action.id : undefined;
    const pinIds = [...(recallId !== undefined ? [recallId] : []), ...(outcome.pin ?? [])];
    const held =
      pinIds.length > 0 ? pinHeld(state.held, pinIds, state.turn, heldTurns) : state.held;
    const queried =
      recallId !== undefined
        ? pinHeld(state.queried, [recallId], state.turn, heldTurns)
        : state.queried;
    // An accepted `recall`/`search` adds no node, so its signature is the only progress
    // signal (§2.8).
    const moveKey =
      proposal.action.operator === "recall"
        ? `recall:${proposal.action.id}:${proposal.action.start ?? ""}:${proposal.action.end ?? ""}`
        : proposal.action.operator === "search"
          ? `search:${proposal.action.id}:${proposal.action.pattern}`
          : "";
    return {
      events: outcome.events,
      recent: [outcome.turn],
      turn: state.turn + 1,
      done: outcome.done,
      stopReason: outcome.stopReason,
      held,
      queried,
      rejection: null,
      moveKey,
    };
  };

  const progressNode = (state: LoopStateType) => {
    if (state.done) return {};
    const current = fold(state.events);
    const rootId = current.rootId;
    if (rootId !== undefined) {
      const root = current.nodes.get(rootId);
      if (root?.kind === "request") {
        // The request ends when its goal is stopped (there is no `stop` on the request).
        const goal = goalOf(current, rootId);
        if (goal !== undefined && hasStopped(current, goal)) {
          return { done: true, stopReason: "request_addressed" };
        }
      }
    }
    // Closure wins over the budget: if the last allowed turn closed the request, that is
    // the honest verdict, not `max_turns`.
    if (state.turn >= deps.maxTurns) return { done: true, stopReason: "max_turns" };
    // A retrieved fragment (`recall`/`search`) is progress even though it adds no node (§2.8).
    const key = `${knowledgeKey(current)}|${state.moveKey}`;
    if (key === state.progressKey) {
      const stall = state.stall + 1;
      if (stall >= noProgress) return { stall, done: true, stopReason: "no_progress" };
      return { stall };
    }
    return { progressKey: key, stall: 0 };
  };

  const route = (state: LoopStateType): "project" | typeof END => {
    if (state.done) return END;
    if (state.turn >= deps.maxTurns) return END;
    return "project";
  };

  return new StateGraph(LoopState)
    .addNode("project", projectNode)
    .addNode("propose", proposeNode)
    .addNode("classify", classifyNode)
    .addNode("execute", executeNode)
    .addNode("progress", progressNode)
    .addEdge(START, "project")
    .addEdge("project", "propose")
    .addEdge("propose", "classify")
    .addEdge("classify", "execute")
    .addEdge("execute", "progress")
    .addConditionalEdges("progress", route)
    .compile();
}

export async function runAgent(deps: AgentDeps, input: AgentInput): Promise<AgentResult> {
  const graph = compileGraph(deps);
  const seed: Event[] = [
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

  const final = await graph.invoke(
    { events: seed, recent: [], turn: 0, done: false, stopReason: null, stopText: null, progressKey: "", stall: 0 },
    { recursionLimit: deps.maxTurns * 5 + 20 },
  );

  return {
    events: final.events,
    done: final.done,
    stopReason: final.stopReason,
    turns: final.turn,
    stopText: final.stopText,
  };
}
