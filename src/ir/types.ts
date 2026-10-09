export type Space = "work" | "artifact";

export const SPACES = ["work", "artifact"] as const;

export const WORK_KINDS = [
  "request",
  "goal",
  "action",
  "plan",
  "alternatives",
  "observation",
  "stop",
  "unactionable",
  "constraint",
] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

// `symbol` and `test` are reserved but not produced by the current model (§10.1).
export const ARTIFACT_KINDS = ["file", "symbol", "test"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const NODE_KINDS = [...WORK_KINDS, ...ARTIFACT_KINDS] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export interface Node {
  id: string;
  space: Space;
  kind: NodeKind;
  label: string;
  payload?: unknown;
  seq: number;
}

export interface WitnessEntry {
  ref: string;
  version: string;
}

export type Provenance =
  | { kind: "llm" }
  | { kind: "user"; turnId: string }
  | { kind: "read"; ref: string; version: string }
  | {
      kind: "grep";
      pattern: string;
      path?: string;
      include?: string;
      exclude?: string;
      from?: number;
      count?: number;
    }
  | { kind: "list"; path?: string; include?: string; exclude?: string };

// The displayed state of a node: a goal/request is `open` until the doxa stops it
// (`stopped`, a control fact — a `has_stopped` edge); an action is `executed` once it has
// produced a result. There are no truth predicates on nodes: the criterion verdict is the
// `exitCode` of the run observation, read where a decision needs it
// (docs/plans/stop_closure_plan.md §2).
export type NodeState = "open" | "executed" | "stopped";

export interface GoalPayload {
  what: string;
  why?: string;
  // The goal's criterion: a literal command the engine runs and reads by exit code.
  done_when: string;
  // The initial plan as a free-form string hint (I3). Only the first concrete step is
  // materialized in the plan container; later steps are appended one at a time.
  plan?: string;
}

export const EDGE_KINDS = [
  "has_plan",
  "item",
  "has_goal",
  "has_alternatives",
  "produces",
  "has_stopped",
  "no_goal",
  "mutates",
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export interface Edge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  provenance: Provenance;
}
