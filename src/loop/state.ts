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
});

export type LoopStateType = typeof LoopState.State;
