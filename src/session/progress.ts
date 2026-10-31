import type { Event } from "../ir/events";
import type { Usage } from "./telemetry";

export type ProgressAgent = "session" | "task" | "observer";

export type ProgressEvent =
  | { type: "turn_started"; agent: ProgressAgent; unitId: string; turn: number }
  | {
      type: "model_call_started";
      agent: ProgressAgent;
      unitId: string;
      turn: number;
      model?: string;
    }
  | {
      type: "model_call_finished";
      agent: ProgressAgent;
      unitId: string;
      turn: number;
      model?: string;
      usage?: Usage;
      status: "ok" | "aborted" | "error";
    }
  | {
      type: "tool_started";
      agent: ProgressAgent;
      unitId: string;
      turn: number;
      tool: string;
      target: string;
    }
  | {
      type: "tool_finished";
      agent: ProgressAgent;
      unitId: string;
      turn: number;
      tool: string;
      target: string;
      status: "ok" | "error";
      preview?: string;
    }
  | { type: "events_added"; unitId: string; events: readonly Event[] }
  | {
      type: "state_changed";
      unitId: string;
      turn: number;
      state?: string;
      what?: string;
      closed?: boolean;
    }
  | {
      type: "turn_finished";
      agent: ProgressAgent;
      unitId: string;
      turn: number;
      stopReason?: string | null;
    }
  | { type: "paused"; agent: ProgressAgent; unitId: string }
  | { type: "report_started"; unitId: string }
  | { type: "report_finished"; unitId: string; text?: string };

export type ProgressSink = (event: ProgressEvent) => void;

export const noopProgress: ProgressSink = () => {};
