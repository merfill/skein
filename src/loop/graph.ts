import { END, START, StateGraph } from "@langchain/langgraph";

import type { Event } from "../ir/events";
import { fold, predicateOf, type State } from "../ir/graph";
import { knowledgeKey } from "../ir/progress";
import { project } from "../ir/project";
import { focusEvents } from "../ir/traversal";
import type { Action } from "../llm/schemas";
import { commandOf, executeAction } from "../tools";
import type { Workspace } from "../tools/workspace";
import { classify } from "./classify";
import { reconcile, type VersionCache } from "./observe";
import type { Proposer } from "./propose";
import { LoopState, type LoopStateType } from "./state";

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

  // Resolve the bodies the model asked to see this turn (hypothesis + `need`, §8):
  // inline output from the payload, or the referenced temp file read by the loop
  // (project stays pure).
  const resolveOutput = (state: State, id: string): string | undefined => {
    const node = state.nodes.get(id);
    if (node === undefined) return undefined;
    const payload = node.payload as Record<string, unknown> | undefined;
    if (typeof payload?.output === "string") return payload.output;
    const ref = typeof payload?.outputRef === "string" ? payload.outputRef : undefined;
    if (ref !== undefined) {
      try {
        return deps.workspace.read(ref);
      } catch {
        return undefined;
      }
    }
    return undefined;
  };

  const projectNode = (state: LoopStateType) => {
    const base = fold(state.events);
    const drift = reconcile(base, deps.workspace, signatures);
    let current = fold(drift, base);
    const focus = focusEvents(current);
    if (focus.length > 0) current = fold(focus, current);
    const lastTool = [...state.recent].reverse().find((turn) => turn.kind === "tool")?.text;
    const recalled = (state.proposal?.need ?? [])
      .map((id) => {
        const output = resolveOutput(current, id);
        return output !== undefined ? { id, output } : undefined;
      })
      .filter((entry): entry is { id: string; output: string } => entry !== undefined);
    return {
      events: [...drift, ...focus],
      context: project(current, {
        budget: { turn: state.turn, maxTurns: deps.maxTurns },
        ...(lastTool !== undefined ? { lastOutput: lastTool } : {}),
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
    const proposal = await deps.propose(context);
    return {
      context,
      proposal,
      recent: [{ seq: state.turn, kind: "proposal" as const, text: proposal.thought }],
    };
  };

  const classifyNode = (state: LoopStateType) => {
    if (!state.proposal) return { classification: null };
    return { classification: classify(state.proposal, fold(state.events)) };
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
    return {
      events: outcome.events,
      recent: [outcome.turn],
      turn: state.turn + 1,
      done: outcome.done,
      stopReason: outcome.stopReason,
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
