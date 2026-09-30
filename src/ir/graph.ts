import type { Event } from "./events";
import type { Edge, Node, Status } from "./types";

export interface CheckRecord {
  seq: number;
  command: string;
  verdict: "pass" | "fail";
  output: string;
  outputRef?: string;
  claimIds: string[];
}

export interface State {
  nodes: Map<string, Node>;
  edges: Map<string, Edge>;
  statuses: Map<string, Status>;
  edgeStatuses: Map<string, Status>;
  checks: CheckRecord[];
  goalId?: string;
  seq: number;
}

export function emptyState(): State {
  return {
    nodes: new Map(),
    edges: new Map(),
    statuses: new Map(),
    edgeStatuses: new Map(),
    checks: [],
    seq: 0,
  };
}

function defaultStatus(node: Node): Status {
  switch (node.kind) {
    case "decision":
      return "active";
    case "action":
      return "applied";
    case "constraint":
      return "must";
    case "file":
    case "symbol":
    case "test":
      return "believed";
    default:
      return "open";
  }
}

export function fold(events: readonly Event[], base: State = emptyState()): State {
  const state: State = {
    nodes: new Map(base.nodes),
    edges: new Map(base.edges),
    statuses: new Map(base.statuses),
    edgeStatuses: new Map(base.edgeStatuses),
    checks: [...base.checks],
    goalId: base.goalId,
    seq: base.seq,
  };

  for (const event of events) applyEvent(state, event);

  return state;
}

function applyEvent(state: State, event: Event): void {
  state.seq += 1;

  switch (event.type) {
    case "add_node": {
      state.nodes.set(event.node.id, event.node);
      state.statuses.set(event.node.id, defaultStatus(event.node));
      if (event.node.kind === "goal" && state.goalId === undefined) {
        state.goalId = event.node.id;
      }
      break;
    }
    case "add_edge": {
      state.edges.set(event.edge.id, event.edge);
      state.edgeStatuses.set(event.edge.id, event.edge.status);
      break;
    }
    case "set_status": {
      if (state.nodes.has(event.id)) state.statuses.set(event.id, event.status);
      else state.edgeStatuses.set(event.id, event.status);
      break;
    }
    case "mutate": {
      for (const edge of state.edges.values()) {
        const provenance = edge.provenance;
        if (
          provenance.kind === "read" &&
          provenance.ref === event.ref &&
          provenance.version !== event.version
        ) {
          state.edgeStatuses.set(edge.id, "stale");
        }
      }
      break;
    }
    case "record_check": {
      state.checks.push({
        seq: state.seq,
        command: event.command,
        verdict: event.verdict,
        output: event.output,
        outputRef: event.outputRef,
        claimIds: event.claimIds,
      });
      for (const id of event.claimIds) {
        state.statuses.set(id, event.verdict === "pass" ? "verified" : "refuted");
      }
      break;
    }
  }
}
