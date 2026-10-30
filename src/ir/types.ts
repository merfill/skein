import type { IslandId } from "./islands";

export type Space = "work" | "artifact";

export const SPACES = ["work", "artifact"] as const;

export const WORK_KINDS = [
  "request",
  "move",
  "plan",
  "item",
  "action",
  "observation",
  "stop",
  "unactionable",
  "constraint",
  // An engine-owned fact about the session (e.g. the environment probe). It hangs off no
  // plan or state; the projection renders it where the current state needs it.
  "fact",
  // A tape-agent advisory: a state-scoped `hint` or a unit-scoped `memo`, rendered as a
  // `system` turn. Neither counts as task knowledge.
  "hint",
  "memo",
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

// The state the doxa declared it will work in (docs/ir_semantics.md §2.5). `state` is
// authored and never changes; `what` is the state's own goal text (a state IS its goal —
// there is no separate goal node, docs/plans/archive/goal_into_move_plan.md).
export interface MovePayload {
  state: IslandId;
  what: string;
  // The state's stop condition, concretized by the doxa in the request's terms (a state
  // attribute like `what`); the island's generic criterion is the fallback.
  done?: string;
  turn?: number;
}

// Relation names are the role the child plays for its owner (docs/ir_revision.md §2.2):
// a request's states hang off it via `move`; a state's plan hangs off the `move` via `plan`;
// plan items hang off a plan via `items`; an item's alternatives hang off the item via
// `alts`; a state's (the terminal move's) closure hangs off it via `stop`.
export const EDGE_KINDS = [
  "move",
  "unactionable",
  "plan",
  "stop",
  "items",
  "alts",
  "result",
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
