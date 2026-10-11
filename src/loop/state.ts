import { Annotation } from "@langchain/langgraph";

import type { Event } from "../ir/events";
import type { Context } from "../ir/project";
import type { Proposals } from "../llm/schemas";

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
  // The structured call behind `call`, so the projection emits a native `tool` result.
  callName?: string;
  callArgs?: Record<string, unknown>;
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
  proposals: Annotation<Proposals | null>(last<Proposals | null>(null)),
  turn: Annotation<number>(last(0)),
  done: Annotation<boolean>(last(false)),
  stopReason: Annotation<string | null>(last<string | null>(null)),
  // The message behind a terminal stop (currently the `llm_error` text), so it can be
  // persisted to the run trace instead of living only in a transient turn (graph §propose).
  stopText: Annotation<string | null>(last<string | null>(null)),
  progressKey: Annotation<string>(last("")),
  stall: Annotation<number>(last(0)),
  // The structural move just refused (classify created no node): its rendered reason and the
  // call it corresponds to, so the next turn renders it as an assistant call + `tool` reason
  // (the doxa sees why its move failed, §2.7). Reset to null on every accepted move.
  rejection: Annotation<{ text: string; name: string; args: Record<string, unknown> } | null>(
    last<{ text: string; name: string; args: Record<string, unknown> } | null>(null),
  ),
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
