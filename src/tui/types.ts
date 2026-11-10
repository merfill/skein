import type { ProgressAgent } from "../session/progress";
import type { FileDiff } from "../tools";

export type Focus = "composer" | "trace" | "task";

export interface TraceEntry {
  id: string;
  kind: "user" | "tool" | "state" | "notice" | "assistant" | "report" | "thought";
  text: string;
  agent?: ProgressAgent;
  tool?: string;
  target?: string;
  status?: "running" | "ok" | "error";
  preview?: string;
  // The model's hidden reasoning and how long that call took.
  reasoning?: string;
  durationMs?: number;
  // The edit preimage for a coloured diff.
  edit?: { path: string; find: string; replace: string };
  // Whole-file before/after for a mutation (`edit`/`write`/`apply_patch`).
  diffs?: FileDiff[];
  // Per-block collapse state; the default depends on the kind (thought/tool collapsed).
  collapsed?: boolean;
}

export interface TraceSpan {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
}

export interface TraceLine {
  text: string;
  spans?: TraceSpan[];
  color?: string;
  dim?: boolean;
  bold?: boolean;
  underline?: boolean;
  // The message block this line belongs to (for a full-width background and a click target).
  entryId?: string;
  bg?: string;
}
