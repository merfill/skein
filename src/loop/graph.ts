import { END, START, StateGraph } from "@langchain/langgraph";

import type { Event } from "../ir/events";
import { childrenOf, currentVersion, fold, planOf, predicateOf, type State } from "../ir/graph";
import { knowledgeKey } from "../ir/progress";
import { project } from "../ir/project";
import { focusEvents } from "../ir/traversal";
import type { Action, Proposal } from "../llm/schemas";
import { OUTPUT_LIMIT, commandOf, executeAction, resolveBody } from "../tools";
import type { Workspace } from "../tools/workspace";
import { classify } from "./classify";
import { reconcile, type VersionCache } from "./observe";
import type { Proposer } from "./propose";
import { LoopState, type HeldEntry, type LoopStateType } from "./state";

// How long a body stays in the working set after the model fetched it with `query {id}`,
// and the two caps that keep it light (docs §9). Retention is otherwise structural: the
// produced results of every level on the branch stay in view until the parent closes.
// A fresh query refreshes the entry; eviction drops the least recently requested first.
// TTL 6 covers the observed cross-level gaps — see tests/workingset.test.ts.
const HELD_TURNS = 6;
const MAX_HELD = 5;
const HELD_CHARS = 2 * OUTPUT_LIMIT;

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

// Every goal on the branch plus its plan descendants. A stage's evidence (the diff that
// localized the bug) must stay in view while an ancestor on the branch is still open, even
// after the stage itself closes — otherwise the model re-fetches it with a `query` call.
// Plan-only (not alternatives): abandoned sibling interpretations stay out.
function branchSubtree(state: State, roots: readonly string[]): Set<string> {
  const out = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (out.has(id)) continue;
    out.add(id);
    const plan = planOf(state, id);
    if (plan !== undefined) {
      for (const child of childrenOf(state, plan)) stack.push(child);
    }
  }
  return out;
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
  held?: { turns?: number; max?: number; chars?: number };
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
    // - explicit: bodies the model fetched with `query {id}` from other levels, held for
    //   HELD_TURNS.
    const explicit = state.held
      .filter((entry) => entry.expiresAt >= state.turn)
      .sort((a, b) => b.pinnedAt - a.pinnedAt);
    const explicitIds = new Set(explicit.map((entry) => entry.id));
    // Every level under the branch, not just the leaf: a stage's evidence (the error that
    // motivated the next stage) stays in view until the parent closes. Newest first, so
    // the current level still wins the caps and an open stage never drops its own evidence.
    const roots =
      current.branch.length > 0
        ? current.branch
        : current.rootId !== undefined
          ? [current.rootId]
          : [];
    const levelIds = branchSubtree(current, roots);
    const level: HeldEntry[] = [];
    if (levelIds.size > 0) {
      for (const node of current.nodes.values()) {
        if (node.kind !== "action") continue;
        const focus = current.focusOf.get(node.id);
        if (focus === undefined || !levelIds.has(focus)) continue;
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
    // The working set is engine-owned: the projection keeps the branch levels' results,
    // and only `query {id}` (execute) pins a body from elsewhere. The model does not
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
    const held =
      pinIds.length > 0 ? pinHeld(state.held, pinIds, state.turn, heldTurns) : state.held;
    const queried =
      proposal.action.operator === "query" && proposal.action.id !== undefined
        ? pinHeld(state.queried, [proposal.action.id], state.turn, heldTurns)
        : state.queried;
    return {
      events: outcome.events,
      recent: [outcome.turn],
      turn: state.turn + 1,
      done: outcome.done,
      stopReason: outcome.stopReason,
      held,
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
