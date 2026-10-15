import { Annotation } from "@langchain/langgraph";

import type { Event } from "../ir/events";
import type { Context } from "../ir/project";
import type { Proposals } from "../llm/schemas";

// One move rendered as a role-tagged turn, kept in loop state (not IR): a proposal (the
// doxa's move) or a tool result. `nodeId` is the result node a tool turn produced.
export interface Turn {
  seq: number;
  kind: "proposal" | "tool";
  text: string;
  nodeId?: string;
  error?: string;
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
});

export type LoopStateType = typeof LoopState.State;
