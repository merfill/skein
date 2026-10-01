import { END, START, StateGraph } from "@langchain/langgraph";

import type { Event } from "../ir/events";
import { fold } from "../ir/graph";
import { project } from "../ir/project";
import type { Action } from "../llm/schemas";
import { executeAction } from "../tools";
import type { Workspace } from "../tools/workspace";
import { classify } from "./classify";
import { reconcile, type VersionCache } from "./observe";
import type { Proposer } from "./propose";
import { LoopState, type LoopStateType } from "./state";

function describeTarget(action: Action): string {
  let target: string;
  switch (action.tool) {
    case "read":
    case "edit":
      target = action.path;
      break;
    case "grep":
      target = action.pattern;
      break;
    case "run":
      target = action.command;
      break;
    case "track":
      target = action.label.trim() === "" ? action.kind : `${action.kind}:${action.label}`;
      break;
    case "query":
      target =
        action.id ??
        action.verdictOf ??
        action.edgesOf ??
        action.kind ??
        action.status ??
        "query";
      break;
    case "finish":
      target = action.summary;
      break;
  }
  return target.replace(/\s+/g, " ").trim().slice(0, 120);
}

export interface AgentDeps {
  propose: Proposer;
  workspace: Workspace;
  maxTurns: number;
}

export interface AgentInput {
  goal: { id: string; label: string };
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

  const projectNode = (state: LoopStateType) => {
    const base = fold(state.events);
    const drift = reconcile(base, deps.workspace, signatures);
    return {
      events: drift,
      context: project(fold(drift, base), {
        recent: state.recent,
        tail: 6,
        budget: { turn: state.turn, maxTurns: deps.maxTurns },
      }),
    };
  };

  const proposeNode = async (state: LoopStateType) => {
    const context =
      state.context ??
      project(fold(state.events), {
        recent: state.recent,
        tail: 6,
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
            tool: proposal.action.tool,
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
    .addEdge(START, "project")
    .addEdge("project", "propose")
    .addEdge("propose", "classify")
    .addEdge("classify", "execute")
    .addConditionalEdges("execute", route)
    .compile();
}

export async function runAgent(deps: AgentDeps, input: AgentInput): Promise<AgentResult> {
  const graph = compileGraph(deps);
  const seed: Event[] = [
    {
      type: "add_node",
      node: {
        id: input.goal.id,
        space: "work",
        kind: "goal",
        label: input.goal.label,
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
    { events: seed, recent: [], turn: 0, done: false, stopReason: null },
    { recursionLimit: deps.maxTurns * 4 + 10 },
  );

  return {
    events: final.events,
    done: final.done,
    stopReason: final.stopReason,
    turns: final.turn,
  };
}
