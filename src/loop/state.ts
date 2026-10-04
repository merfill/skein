import { Annotation } from "@langchain/langgraph";

import type { Event } from "../ir/events";
import type { Context, Turn } from "../ir/project";
import type { Proposal } from "../llm/schemas";
import type { Classification } from "./classify";

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
  progressKey: Annotation<string>(last("")),
  stall: Annotation<number>(last(0)),
  // The working set: results the model explicitly asked to see (via `need` or a
  // `query {id}`), held for HELD_TURNS turns and refreshed on each request. Ephemeral
  // loop state, not IR (query/need store no nodes).
  held: Annotation<HeldEntry[]>(last<HeldEntry[]>([])),
  // How often each result was requested, surviving eviction: feeds the adaptive TTL.
  heldRequests: Annotation<Record<string, number>>(last<Record<string, number>>({})),
  // Ids retrieved by `query {id}` (even ones with no body, e.g. action/goal nodes), with
  // their TTL: the guard refuses re-querying an id while it is still recent.
  queried: Annotation<HeldEntry[]>(last<HeldEntry[]>([])),
});

export interface HeldEntry {
  id: string;
  expiresAt: number;
  // Last request turn: the working set is kept by recency, so a fresh body is never
  // starved by a long-lived one (matters when TTLs differ, i.e. adaptive).
  pinnedAt: number;
}

export type LoopStateType = typeof LoopState.State;
