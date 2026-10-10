import { Annotation } from "@langchain/langgraph";

import type { Event } from "../ir/events";
import type { Context } from "../ir/project";
import type { Proposal } from "../llm/schemas";
import type { Classification } from "./classify";

// One move rendered as a role-tagged turn, kept in loop state (not IR): a proposal (the
// doxa's move) or a tool result. `nodeId` is the result node a tool turn produced, absent
// for a `recall`/`search` (which creates no node).
export interface Turn {
  seq: number;
  kind: "proposal" | "tool";
  text: string;
  nodeId?: string;
  error?: string;
  // The rendered call of a move with no node (a `recall`/`search`), so the projection re-inserts the
  // arguments instead of a bare operator name.
  call?: string;
}

const last = <T>(fallback: T) => ({
  reducer: (_current: T, update: T): T => update,
  default: () => fallback,
});

export const LoopState = Annotation.Root({
  events: Annotation<Event[]>({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
  recent: Annotation<Turn[]>({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
  context: Annotation<Context | null>(last<Context | null>(null)),
  proposal: Annotation<Proposal | null>(last<Proposal | null>(null)),
  classification: Annotation<Classification | null>(last<Classification | null>(null)),
  turn: Annotation<number>(last(0)),
  done: Annotation<boolean>(last(false)),
  stopReason: Annotation<string | null>(last<string | null>(null)),
  // The message behind a terminal stop (currently the `llm_error` text), so it can be
  // persisted to the run trace instead of living only in a transient turn (graph §propose).
  stopText: Annotation<string | null>(last<string | null>(null)),
  progressKey: Annotation<string>(last("")),
  stall: Annotation<number>(last(0)),
  // The reason a structural move was just refused (classify created no node), rendered as a
  // transient `tool` message on the next turn so the doxa sees why its move failed (§2.7).
  // Reset to null on every accepted move.
  rejection: Annotation<string | null>(last<string | null>(null)),
  // A signature of the last accepted move when it leaves no node in the tree (recall/search):
  // retrieving a fragment is progress even though it adds no observation (§2.8).
  moveKey: Annotation<string>(last("")),
  // The working set: bodies the model pulled back with `recall {id}`, held for HELD_TURNS
  // turns and refreshed on each request. Ephemeral loop state, not IR (a recall stores no
  // node). Level results are kept structurally, not here.
  held: Annotation<HeldEntry[]>(last<HeldEntry[]>([])),
  // Ids retrieved by `recall {id}` (even ones with no body, e.g. action/goal nodes), with
  // their TTL: the guard refuses re-recalling an id while it is still recent.
  queried: Annotation<HeldEntry[]>(last<HeldEntry[]>([])),
});

export interface HeldEntry {
  id: string;
  expiresAt: number;
  // Last fetch turn: the working set is kept by recency, so a fresh body is never starved
  // by a long-lived one.
  pinnedAt: number;
}

export type LoopStateType = typeof LoopState.State;
