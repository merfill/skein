import type { Event } from "../ir/events";
import { openUnit } from "./session";
import type { SessionState } from "./types";

// A reading unit is a one-step session fact: path -> observation. It has no states or plan.
// The observation carries a bounded preview and the address of the full body (path + version);
// the full text is not copied onto the tape (docs/session_concepts.md §5).

export interface ReadFileResult {
  text: string;
  version?: string;
  bytes?: number;
  lines?: number;
}

export type ReadFile = (path: string) => ReadFileResult;

export const READING_PREVIEW_BYTES = 8000;
export const READING_PREVIEW_LINES = 120;

export interface ReadingResult {
  unitId: string;
  observationId: string;
  path: string;
  bytes: number;
  lines: number;
  version?: string;
  preview: string;
  total: number;
  start: number;
  end: number;
}

interface Preview {
  body: string;
  start: number;
  end: number;
  total: number;
}

function previewOf(text: string): Preview {
  const lines = text.split("\n");
  const total = lines.length;
  let end = Math.min(READING_PREVIEW_LINES, total);
  let body = lines.slice(0, end).join("\n");
  if (body.length > READING_PREVIEW_BYTES) {
    body = body.slice(0, READING_PREVIEW_BYTES);
    end = Math.max(1, body.split("\n").length);
    body = lines.slice(0, end).join("\n");
  }
  return { body, start: 1, end, total };
}

function previewText(preview: Preview): string {
  return preview.end < preview.total
    ? `${preview.body}\n…[lines ${preview.start}–${preview.end} of ${preview.total}; continue from ${preview.end + 1}]`
    : preview.body;
}

function nextReadingId(session: SessionState): string {
  let index = 1;
  while (session.units.has(`reading:${index}`)) index += 1;
  return `reading:${index}`;
}

// Read a file in one action and leave a reading unit: a request (the path) and an observation
// (metadata + preview). The full body is fetched from `readFile` by path when needed.
export function readUnit(
  session: SessionState,
  path: string,
  readFile: ReadFile,
): ReadingResult {
  if (path.trim() === "") throw new Error("empty path");
  const file = readFile(path);
  const bytes = file.bytes ?? file.text.length;
  const lines = file.lines ?? file.text.split("\n").length;
  const preview = previewOf(file.text);
  const unitId = nextReadingId(session);
  const observationId = `obs:${unitId}`;

  const events: Event[] = [
    {
      type: "add_node",
      node: {
        id: unitId,
        space: "work",
        kind: "request",
        label: path.replace(/\s+/g, " ").trim().slice(0, 120),
        payload: { text: path },
        seq: 0,
      },
    },
    {
      type: "add_node",
      node: {
        id: observationId,
        space: "work",
        kind: "observation",
        label: `read ${path}`,
        payload: {
          origin: "engine",
          path,
          ...(file.version !== undefined ? { version: file.version } : {}),
          bytes,
          lines,
          output: preview.body,
          start: preview.start,
          end: preview.end,
          total: preview.total,
          ref: path,
        },
        seq: 1,
      },
    },
  ];

  openUnit(session, unitId, "reading", events, 0);
  return {
    unitId,
    observationId,
    path,
    bytes,
    lines,
    ...(file.version !== undefined ? { version: file.version } : {}),
    preview: previewText(preview),
    total: preview.total,
    start: preview.start,
    end: preview.end,
  };
}

export function readingResultText(result: ReadingResult): string {
  return [
    `reading ${result.unitId}`,
    `path: ${result.path}`,
    `bytes: ${result.bytes}; lines: ${result.lines}`,
    `observation: ${result.observationId}`,
    result.end < result.total
      ? `preview (lines ${result.start}-${result.end} of ${result.total}; use body for more):`
      : "preview (complete file):",
    result.preview,
  ].join("\n");
}

// The text of a reading observation: the full file from `readFile` when the version still
// matches, otherwise the bounded preview stored in the journal.
export function readingText(
  payload: { path?: unknown; version?: unknown; output?: unknown },
  readFile?: ReadFile,
): string | undefined {
  if (typeof payload.path === "string" && readFile !== undefined) {
    try {
      const file = readFile(payload.path);
      if (
        typeof payload.version !== "string" ||
        file.version === undefined ||
        file.version === payload.version
      ) {
        return file.text;
      }
    } catch {
      // fall through to the preview
    }
  }
  return typeof payload.output === "string" ? payload.output : undefined;
}
