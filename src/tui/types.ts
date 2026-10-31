import type { ProgressAgent } from "../session/progress";

export type Focus = "composer" | "trace" | "task";

export interface TraceEntry {
  id: string;
  kind: "user" | "tool" | "state" | "notice" | "assistant" | "report";
  text: string;
  agent?: ProgressAgent;
  tool?: string;
  target?: string;
  status?: "running" | "ok" | "error";
  preview?: string;
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
}
