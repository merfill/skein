export type Space = "work" | "artifact";

export const SPACES = ["work", "artifact"] as const;

export const WORK_KINDS = [
  "request",
  "goal",
  "action",
  "plan",
  "alternatives",
  "observation",
  "check",
  "stop",
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

export type Verdict = "pass" | "fail" | "inconclusive";

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
  | { kind: "list"; path?: string; include?: string; exclude?: string }
  | {
      kind: "check";
      command: string;
      verdict: Verdict;
      outputRef?: string;
    };

// State is derived, never stored: these predicates are computed from the
// incident event nodes (§2.5).
export const PREDICATES = [
  "open",
  "executed",
  "achieved",
  "achieved_under",
  "refuted",
  "abandoned",
  "addressed",
] as const;
export type Predicate = (typeof PREDICATES)[number];

// A goal's criterion. `objective` is a literal command the arbiter runs; `arbiter` is an
// external acceptance (a person or a test runner) — doxa cannot settle either one.
export type DoneWhen =
  | { kind: "objective"; command: string }
  | { kind: "arbiter"; text: string };

export interface GoalPayload {
  what: string;
  why?: string;
  done_when: DoneWhen;
  // The initial plan as a free-form string hint (I3). Only the first concrete step is
  // materialized in the plan container; later steps are appended one at a time.
  plan?: string;
}

export const EDGE_KINDS = [
  "has_plan",
  "item",
  "has_alternatives",
  "chosen",
  "under",
  "produces",
  "verifies",
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
