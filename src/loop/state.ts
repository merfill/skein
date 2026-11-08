import type { Event } from "../ir/events";
import type { Context } from "../ir/project";
import type { Proposals } from "../llm/schemas";
import type { SessionState } from "../session/types";

// One move rendered as a role-tagged turn, kept in loop state (not IR): a proposal (the
// model's move) or a tool result. `nodeId` is the result node a tool turn produced.
export interface Turn {
  seq: number;
  kind: "proposal" | "tool";
  text: string;
  nodeId?: string;
  error?: string;
}

// The task loop's mutable state. This is a plain record now: the loop is a `while`, not a
// LangGraph graph. `events` and `recent` are append-only in the merge helper.
export interface LoopState {
  events: Event[];
  recent: Turn[];
  context: Context | null;
  proposals: Proposals | null;
  turn: number;
  done: boolean;
  // A user pause ended the loop at a committed step boundary; no stop is produced.
  paused: boolean;
  stopReason: string | null;
  // The message behind a terminal stop (the `llm_error` text), persisted by the caller.
  stopText: string | null;
  session: SessionState | null;
  grace: boolean;
  // The structural move just refused (classify created no node): its rendered reason and
  // the call it corresponds to, so the next turn renders it as an assistant call + `tool`
  // reason (the model sees why its move failed, §2.7). Reset to null on every accepted move.
  rejection: { text: string; name: string; args: Record<string, unknown> } | null;
  // Consecutive model replies with no actions. One retry is allowed; the second stops the
  // task as `no_decision` instead of spinning forever now that there is no turn cap.
  noProposal: number;
}
