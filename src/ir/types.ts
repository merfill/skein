export type Space = "work" | "artifact";

export const SPACES = ["work", "artifact"] as const;

export const WORK_KINDS = [
  "goal",
  "subgoal",
  "claim",
  "decision",
  "action",
  "observation",
  "check",
  "constraint",
] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

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

export type Verdict = "pass" | "fail";

export interface WitnessEntry {
  ref: string;
  version: string;
}

export type Provenance =
  | { kind: "llm" }
  | { kind: "user"; turnId: string }
  | { kind: "read"; ref: string; version: string }
  | { kind: "grep"; pattern: string }
  | {
      kind: "check";
      command: string;
      verdict: Verdict;
      outputRef?: string;
    };

export const STATUSES = [
  "open",
  "verified",
  "refuted",
  "superseded",
  "active",
  "applied",
  "reverted",
  "achieved",
  "abandoned",
  "must",
  "believed",
  "stale",
  "confirmed",
] as const;
export type Status = (typeof STATUSES)[number];

export const EDGE_KINDS = [
  "decomposes",
  "supports",
  "refutes",
  "depends_on",
  "chosen_over",
  "justifies",
  "touches",
  "locates",
  "verifies",
  "violates",
  "calls",
  "defines",
  "imports",
  "tests",
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export interface Edge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  provenance: Provenance;
  status: Status;
  version?: string;
}
