import { END, START, StateGraph } from "@langchain/langgraph";

import type { Event } from "../ir/events";
import { currentVersion, fold, predicateOf, type State } from "../ir/graph";
import { knowledgeKey } from "../ir/progress";
import { project } from "../ir/project";
import { focusEvents } from "../ir/traversal";
import type { Action, Proposal } from "../llm/schemas";
import { MAX_NEED } from "../llm/schemas";
import { OUTPUT_LIMIT, commandOf, executeAction, resolveBody } from "../tools";
import type { Workspace } from "../tools/workspace";
import { classify } from "./classify";
import { reconcile, type VersionCache } from "./observe";
import type { Proposer } from "./propose";
import { LoopState, type HeldEntry, type LoopStateType } from "./state";

// How long a result stays in the working set after the model explicitly asked for it
// (via `need` or `query {id}`), and the two caps that keep it light (docs §9). The caps
// are anchored to existing instrument limits, not tuned by feel: the model may request
// MAX_NEED results at once, and a working set must hold the motivating "a code window
// AND a build error" pair of full outputs. A fresh request refreshes the entry; eviction
// drops the least recently requested first. TTL 6 covers the observed request gaps
// (live p90 = 7, synthetic: 3 churns, 6 stops) — see tests/workingset.test.ts.
const HELD_TURNS = 6;
const MAX_HELD = MAX_NEED;
const HELD_CHARS = 2 * OUTPUT_LIMIT;

interface HeldLimits {
  turns: number;
  adaptive: boolean;
  turnsMax: number;
}

// Upsert the requested ids into the working set. `adaptive` (off by default) scales the
// TTL by how many distinct times the id was (re-)acquired, capped by `turnsMax`.
function pinHeld(
  held: readonly HeldEntry[],
  counts: Readonly<Record<string, number>>,
  ids: readonly string[],
  turn: number,
  limits: HeldLimits,
): { held: HeldEntry[]; counts: Record<string, number> } {
  const nextHeld = new Map(held.map((entry) => [entry.id, entry]));
  const nextCounts: Record<string, number> = { ...counts };
  for (const id of ids) {
    const acquired = !nextHeld.has(id);
    const count = acquired ? (nextCounts[id] ?? 0) + 1 : (nextCounts[id] ?? 1);
    nextCounts[id] = count;
    const ttl = limits.adaptive ? Math.min(limits.turns * count, limits.turnsMax) : limits.turns;
    nextHeld.set(id, { id, expiresAt: turn + ttl, pinnedAt: turn });
  }
  return { held: [...nextHeld.values()], counts: nextCounts };
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

// The result a run/read action produced (its newest `produces` child), so the current
// level's evidence can be recalled without the model re-requesting it.
function producedResultId(state: State, actionId: string): string | undefined {
  let best: { seq: number; id: string } | undefined;
  for (const edge of state.edges.values()) {
    if (edge.kind !== "produces" || edge.from !== actionId) continue;
    const node = state.nodes.get(edge.to);
    if (node === undefined) continue;
    if (best === undefined || node.seq > best.seq) best = { seq: node.seq, id: edge.to };
  }
  return best?.id;
}

function describeTarget(action: Action): string {
  let target: string;
  switch (action.operator) {
    case "query":
      target = action.id ?? action.kind ?? action.predicate ?? action.edgesOf ?? "query";
      break;
    case "create_goal":
      target = `goal:${action.what}`;
      break;
    case "complete":
      target = `complete:${action.goal ?? ""}`;
      break;
    case "apply":
      target =
        action.action.tool === "run" && action.action.command === undefined && action.action.target !== undefined
          ? `check ${action.action.target}`
          : commandOf(action.action);
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
  // `adaptive` scales the TTL with how often a result is re-acquired, up to `turnsMax`.
  held?: { turns?: number; max?: number; chars?: number; adaptive?: boolean; turnsMax?: number };
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
}

export function compileGraph(deps: AgentDeps) {
  const signatures: VersionCache = new Map();
  const noProgress = deps.noProgress ?? 10;
  const heldTurns = deps.held?.turns ?? HELD_TURNS;
  const maxHeld = deps.held?.max ?? MAX_HELD;
  const heldCharCap = deps.held?.chars ?? HELD_CHARS;
  const held: HeldLimits = {
    turns: heldTurns,
    adaptive: deps.held?.adaptive ?? false,
    turnsMax: deps.held?.turnsMax ?? heldTurns * 3,
  };

  const projectNode = (state: LoopStateType) => {
    const base = fold(state.events);
    const drift = reconcile(base, deps.workspace, signatures);
    let current = fold(drift, base);
    const focusDrift = focusEvents(current);
    if (focusDrift.length > 0) current = fold(focusDrift, current);
    const lastToolTurn = [...state.recent].reverse().find((turn) => turn.kind === "tool");
    // Two sources feed `shown`, kept together by recency under the shared caps:
    // - current level: every result the focus goal's own actions produced. These do NOT
    //   expire by TTL — the level's attempts stay in view until the focus leaves it.
    // - explicit: results pinned by `need`/`query` from other levels, held for HELD_TURNS.
    const explicit = state.held
      .filter((entry) => entry.expiresAt >= state.turn)
      .sort((a, b) => b.pinnedAt - a.pinnedAt);
    const explicitIds = new Set(explicit.map((entry) => entry.id));
    const levelId = current.branch[current.branch.length - 1] ?? current.rootId;
    const level: HeldEntry[] = [];
    if (levelId !== undefined) {
      for (const node of current.nodes.values()) {
        if (node.kind !== "action" || current.focusOf.get(node.id) !== levelId) continue;
        if (predicateOf(current, node.id) !== "executed") continue;
        const childId = producedResultId(current, node.id);
        if (childId !== undefined) {
          level.push({ id: childId, expiresAt: Number.MAX_SAFE_INTEGER, pinnedAt: node.seq });
        }
      }
      level.sort((a, b) => b.pinnedAt - a.pinnedAt);
    }
    // Explicit requests come first (the model asked for them); the current level's
    // results fill the rest, kept by recency under the shared caps.
    const candidates = [...explicit, ...level];
    const recalled: { id: string; output: string; error: string }[] = [];
    const kept: HeldEntry[] = [];
    const seen = new Set<string>();
    let shownCount = 0;
    let heldChars = 0;
    for (const entry of candidates) {
      if (seen.has(entry.id) || isStale(current, entry.id)) continue;
      const body = resolveBody(current, entry.id, deps.workspace);
      if (body === undefined) continue;
      const chars = body.output.length + body.error.length;
      if (shownCount >= maxHeld || heldChars + chars > heldCharCap) continue;
      seen.add(entry.id);
      recalled.push({ id: entry.id, output: body.output, error: body.error });
      shownCount += 1;
      heldChars += chars;
      if (explicitIds.has(entry.id)) kept.push(entry);
    }
    return {
      events: [...drift, ...focusDrift],
      held: kept,
      queried: state.queried.filter((entry) => entry.expiresAt >= state.turn),
      context: project(current, {
        budget: { turn: state.turn, maxTurns: deps.maxTurns },
        ...(lastToolTurn !== undefined
          ? {
              lastOutput: lastToolTurn.text,
              ...(lastToolTurn.nodeId !== undefined ? { lastOutputId: lastToolTurn.nodeId } : {}),
              ...(lastToolTurn.error !== undefined ? { lastError: lastToolTurn.error } : {}),
            }
          : {}),
        ...(recalled.length > 0 ? { recalled } : {}),
      }),
    };
  };

  const proposeNode = async (state: LoopStateType) => {
    const context =
      state.context ??
      project(fold(state.events), {
        budget: { turn: state.turn, maxTurns: deps.maxTurns },
      });
    let proposal: Proposal;
    try {
      proposal = await deps.propose(context);
    } catch (error) {
      // A persistent model failure (e.g. the provider keeps truncating) must not crash
      // the run: stop gracefully with `llm_error` so the partial work is kept.
      return {
        context,
        done: true,
        stopReason: "llm_error",
        recent: [
          {
            seq: state.turn,
            kind: "proposal" as const,
            text: `llm_error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
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
    // Classify against the working set as it was BEFORE this proposal's `need`: an id the
    // proposal itself asks to pin (need) must not make its own `query {id}` look like a
    // repeat — the query guard only refuses what a previous turn already showed. `need` is
    // still pinned regardless of accept/reject, so a rejected proposal can re-show context.
    const classification = classify(
      state.proposal,
      fold(state.events),
      state.held.map((entry) => entry.id),
      state.queried.map((entry) => entry.id),
    );
    const pinned = pinHeld(state.held, state.heldRequests, state.proposal.need ?? [], state.turn, held);
    return { classification, held: pinned.held, heldRequests: pinned.counts };
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
        recent: [{ seq: state.turn, kind: "proposal" as const, text: `rejected: ${reason}` }],
      };
    }
    const outcome = executeAction(
      proposal.action,
      fold(state.events),
      deps.workspace,
      state.turn,
    );
    // `query {id}` pins the fetched body; a tool may also ask to pin a result it produced
    // (e.g. the materialized content of a failed edit), so the next move does not re-read.
    const pinIds = [
      ...(proposal.action.operator === "query" && proposal.action.id !== undefined
        ? [proposal.action.id]
        : []),
      ...(outcome.pin ?? []),
    ];
    const pinned =
      pinIds.length > 0
        ? pinHeld(state.held, state.heldRequests, pinIds, state.turn, held)
        : { held: state.held, counts: state.heldRequests };
    const queried =
      proposal.action.operator === "query" && proposal.action.id !== undefined
        ? pinHeld(state.queried, {}, [proposal.action.id], state.turn, held).held
        : state.queried;
    return {
      events: outcome.events,
      recent: [outcome.turn],
      turn: state.turn + 1,
      done: outcome.done,
      stopReason: outcome.stopReason,
      held: pinned.held,
      heldRequests: pinned.counts,
      queried,
    };
  };

  const progressNode = (state: LoopStateType) => {
    if (state.done) return {};
    const current = fold(state.events);
    const rootId = current.rootId;
    if (rootId !== undefined) {
      const predicate = predicateOf(current, rootId);
      const root = current.nodes.get(rootId);
      if (root?.kind === "request" ? predicate === "addressed" : predicate === "achieved" || predicate === "achieved_under") {
        return { done: true, stopReason: root?.kind === "request" ? "request_addressed" : "root_closed" };
      }
    }
    // Closure wins over the budget: if the last allowed turn closed the request, that is
    // the honest verdict, not `max_turns`.
    if (state.turn >= deps.maxTurns) return { done: true, stopReason: "max_turns" };
    const key = knowledgeKey(current);
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
    { events: seed, recent: [], turn: 0, done: false, stopReason: null, progressKey: "", stall: 0 },
    { recursionLimit: deps.maxTurns * 5 + 20 },
  );

  return {
    events: final.events,
    done: final.done,
    stopReason: final.stopReason,
    turns: final.turn,
  };
}
