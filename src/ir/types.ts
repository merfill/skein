import type { StateId } from "./islands";

export type Space = "work" | "artifact";

export const SPACES = ["work", "artifact"] as const;

export const WORK_KINDS = [
  "request",
  "move",
  "turns",
  "action",
  "observation",
  "stop",
  "unactionable",
  "constraint",
  // An engine-owned fact about the session (e.g. the environment probe). It hangs off no
  // turns container or state; the projection renders it where the current state needs it.
  "fact",
  // A tape-agent advisory: a state-scoped `hint` or a unit-scoped `memo`, rendered as a
  // `system` turn. Neither counts as task knowledge.
  "hint",
  "memo",
  // A plan developed by the `plan` unit: the plan node and its ordered items. They are a
  // session-level artifact (the session agent's execution list), never task knowledge.
  "plan",
  "plan_item",
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

// The state the model declared it will work in (docs/en/ir.md §2.5). `state` is
// authored and never changes; `what` is the state's own goal text (a state IS its goal —
// there is no separate goal node).
export interface MovePayload {
  state: StateId;
  what: string;
  // The state's stop condition, concretized by the model in the request's terms (a state
  // attribute like `what`); the island's generic criterion is the fallback.
  done?: string;
  turn?: number;
}

// A plan item is one work order the session agent executes as an ordinary unit. `kind` is the
// agent the item needs (a general answer or a workspace change); it is the planner's mark, and
// the session agent still chooses the operation it opens. `order` is the item's 1-based place
// in the plan; items are never rewritten, a rework is a new plan.
export type PlanItemKind = "general" | "task" | "document";

export interface PlanItemPayload {
  title: string;
  detail: string;
  kind: PlanItemKind;
  done?: string;
  order: number;
}

// The plan header: a short summary that introduces the items (the markdown is rendered from
// the items, never stored separately).
export interface PlanPayload {
  summary?: string;
}

// Relation names are the role the child plays for its owner (docs/en/ir.md §2.2):
// a request's states hang off it via `move`; a state's turns container hangs off the `move`
// via `turns`; each turn (action) hangs off the container via `turn`; a state's (the terminal
// move's) closure hangs off it via `stop`.
export const EDGE_KINDS = [
  "move",
  "unactionable",
  "turns",
  "turn",
  "stop",
  "result",
  "mutates",
  // A plan unit's move owns the plan header (`plan`); the header owns its ordered items
  // (`plan_item`). These are session-level artifacts, not state transitions, so `fold` keeps
  // them out of the `move`/`turn` ordered-children maps.
  "plan",
  "plan_item",
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export interface Edge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  provenance: Provenance;
}
