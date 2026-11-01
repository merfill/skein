import { oneLine, wrap } from "./format";
import { highlightCode } from "./highlight";
import { markdownLines } from "./markdown";
import { theme } from "./theme";
import type { TraceEntry, TraceLine, TraceSpan } from "./types";

const MAX_PREVIEW_LINES = 400;
const MAX_REASONING_LINES = 200;
const MAX_DIFF_LINES = 400;
const MAX_DIFF_CELLS = 160_000;

const LANGUAGES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  java: "java",
  kt: "kotlin",
  cs: "csharp",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  md: "markdown",
  sql: "sql",
  html: "xml",
  css: "css",
  xml: "xml",
};

function agentPrefix(agent: TraceEntry["agent"]): string {
  if (agent === "session") return "[session] ";
  if (agent === "general") return "[general] ";
  if (agent === "observer") return "[observer] ";
  return "";
}

function block(entry: TraceEntry, line: TraceLine): TraceLine {
  return { ...line, entryId: entry.id, bg: theme.blockBg };
}

function separator(out: TraceLine[]): void {
  if (out.length > 0 && out[out.length - 1]?.text.trim() !== "") out.push({ text: " " });
}

function plainLines(text: string, width: number, dim = true): TraceLine[] {
  const out: TraceLine[] = [];
  for (const source of text.replace(/\t/g, "  ").split("\n")) {
    if (source === "") {
      out.push({ text: " ", dim });
    } else {
      for (const part of wrap(source, Math.max(10, width))) out.push({ text: part, dim });
    }
  }
  return out;
}

function languageOf(target: string | undefined): string | undefined {
  if (target === undefined) return undefined;
  const path = target.split(/\s+/).at(-1) ?? target;
  const ext = path.split(".").pop()?.toLowerCase();
  return ext !== undefined ? LANGUAGES[ext] : undefined;
}

function spansLine(spans: readonly TraceSpan[]): TraceLine {
  return { text: spans.map((span) => span.text).join(""), spans: [...spans] };
}

type DiffKind = "same" | "add" | "del";
interface DiffOp {
  kind: DiffKind;
  text: string;
}

// A line diff: trim the common prefix/suffix, then LCS the middle. Large replacements fall
// back to a plain delete/add block instead of an O(n²) table.
function diffOps(find: string, replace: string): DiffOp[] {
  const left = find.split("\n");
  const right = replace.split("\n");
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let endLeft = left.length;
  let endRight = right.length;
  while (
    endLeft > start &&
    endRight > start &&
    left[endLeft - 1] === right[endRight - 1]
  ) {
    endLeft -= 1;
    endRight -= 1;
  }
  const ops: DiffOp[] = [];
  for (let index = 0; index < start; index += 1) ops.push({ kind: "same", text: left[index] ?? "" });
  const midLeft = left.slice(start, endLeft);
  const midRight = right.slice(start, endRight);
  if (midLeft.length * midRight.length > MAX_DIFF_CELLS) {
    for (const text of midLeft) ops.push({ kind: "del", text });
    for (const text of midRight) ops.push({ kind: "add", text });
  } else {
    const table = Array.from({ length: midLeft.length + 1 }, () =>
      new Array<number>(midRight.length + 1).fill(0),
    );
    for (let i = midLeft.length - 1; i >= 0; i -= 1) {
      for (let j = midRight.length - 1; j >= 0; j -= 1) {
        table[i]![j] =
          midLeft[i] === midRight[j]
            ? (table[i + 1]![j + 1] ?? 0) + 1
            : Math.max(table[i + 1]![j] ?? 0, table[i]![j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midLeft.length && j < midRight.length) {
      if (midLeft[i] === midRight[j]) {
        ops.push({ kind: "same", text: midLeft[i] ?? "" });
        i += 1;
        j += 1;
      } else if ((table[i + 1]![j] ?? 0) >= (table[i]![j + 1] ?? 0)) {
        ops.push({ kind: "del", text: midLeft[i] ?? "" });
        i += 1;
      } else {
        ops.push({ kind: "add", text: midRight[j] ?? "" });
        j += 1;
      }
    }
    while (i < midLeft.length) {
      ops.push({ kind: "del", text: midLeft[i] ?? "" });
      i += 1;
    }
    while (j < midRight.length) {
      ops.push({ kind: "add", text: midRight[j] ?? "" });
      j += 1;
    }
  }
  for (let index = endLeft; index < left.length; index += 1) {
    ops.push({ kind: "same", text: left[index] ?? "" });
  }
  return ops;
}

function diffCounts(ops: readonly DiffOp[]): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const op of ops) {
    if (op.kind === "add") added += 1;
    if (op.kind === "del") deleted += 1;
  }
  return { added, deleted };
}

function diffLines(entry: TraceEntry, width: number): TraceLine[] {
  const edit = entry.edit;
  if (edit === undefined) return [];
  const out: TraceLine[] = [];
  const ops = diffOps(edit.find, edit.replace);
  const shown = ops.slice(0, MAX_DIFF_LINES);
  for (const op of shown) {
    const sign = op.kind === "add" ? "+" : op.kind === "del" ? "-" : " ";
    const color =
      op.kind === "add"
        ? theme.syntax.addition
        : op.kind === "del"
          ? theme.syntax.deletion
          : undefined;
    const parts = wrap(op.text === "" ? " " : op.text, Math.max(10, width - 4));
    parts.forEach((part, index) => {
      out.push(
        block(entry, {
          text: `  ${index === 0 ? sign : " "} ${part}`,
          ...(color !== undefined ? { color } : {}),
          ...(op.kind === "same" ? { dim: true } : {}),
        }),
      );
    });
  }
  if (ops.length > shown.length) out.push(block(entry, { text: "  …", dim: true }));
  return out;
}

function previewLines(entry: TraceEntry, width: number): TraceLine[] {
  const text = entry.preview ?? "";
  const language = entry.tool === "read" ? languageOf(entry.target) : undefined;
  if (language !== undefined) {
    let body = text;
    const first = body.split("\n")[0] ?? "";
    if (/ lines \d+[-–]\d+ of \d+$/.test(first)) body = body.slice(first.length + 1);
    const highlighted = highlightCode(language, body).slice(0, MAX_PREVIEW_LINES);
    return highlighted.map((spans) => block(entry, spansLine(spans)));
  }
  return plainLines(text, Math.max(10, width - 4))
    .slice(0, MAX_PREVIEW_LINES)
    .map((line) => block(entry, { ...line, text: `  ${line.text}` }));
}

function toolLines(entry: TraceEntry, width: number): TraceLine[] {
  const status = entry.status === "running" ? "…" : entry.status === "error" ? "!" : "✓";
  const tool = entry.tool ?? "?";
  const rawTarget = entry.target ?? "";
  const target = oneLine(
    rawTarget.startsWith(`${tool} `) ? rawTarget.slice(tool.length + 1) : rawTarget,
    Math.max(12, width - 28),
  );
  const collapsed = entry.collapsed !== false;
  const ops = entry.edit !== undefined ? diffOps(entry.edit.find, entry.edit.replace) : undefined;
  const counts = ops !== undefined ? diffCounts(ops) : undefined;
  const summary =
    counts !== undefined ? ` (+${counts.added} −${counts.deleted})` : "";
  const out: TraceLine[] = [
    block(entry, {
      text: `  ${collapsed ? "▸" : "▾"} ${status} ${agentPrefix(entry.agent)}${tool} ${target}${summary}`,
      color:
        entry.status === "error"
          ? theme.error
          : entry.status === "running"
            ? theme.warning
            : theme.success,
    }),
  ];
  if (!collapsed) {
    if (entry.edit !== undefined) out.push(...diffLines(entry, width));
    else if (entry.preview !== undefined && entry.preview.trim() !== "") {
      out.push(...previewLines(entry, width));
    }
  }
  return out;
}

function thoughtLines(entry: TraceEntry, width: number): TraceLine[] {
  const collapsed = entry.collapsed !== false;
  const seconds = entry.durationMs !== undefined ? entry.durationMs / 1000 : undefined;
  const header = `  ${collapsed ? "+" : "−"} Thought${seconds !== undefined ? `: ${seconds.toFixed(1)}s` : ""}`;
  const out = [block(entry, { text: header, dim: true, color: theme.muted })];
  if (!collapsed && entry.reasoning !== undefined && entry.reasoning !== "") {
    const lines = plainLines(entry.reasoning, Math.max(10, width - 4));
    for (const line of lines.slice(0, MAX_REASONING_LINES)) {
      out.push(block(entry, { ...line, text: `  ${line.text}` }));
    }
    if (lines.length > MAX_REASONING_LINES) out.push(block(entry, { text: "  …", dim: true }));
  }
  return out;
}

function assistantLines(entry: TraceEntry, width: number): TraceLine[] {
  if (entry.collapsed === true) {
    const first = entry.text.split("\n")[0] ?? "";
    return [
      block(entry, {
        text: `  ▸ ${oneLine(first, Math.max(10, width - 6))} …`,
        dim: true,
      }),
    ];
  }
  return markdownLines(entry.text, width).map((line) => block(entry, line));
}

function reportLines(entry: TraceEntry, width: number): TraceLine[] {
  const header = block(entry, { text: "Report", bold: true, color: theme.report });
  if (entry.collapsed === true) {
    const first = entry.text.split("\n")[0] ?? "";
    return [
      header,
      block(entry, {
        text: `  ▸ ${oneLine(first, Math.max(10, width - 6))} …`,
        dim: true,
      }),
    ];
  }
  return [header, ...markdownLines(entry.text, width).map((line) => block(entry, line))];
}

export interface TraceWindow {
  start: number;
  visible: TraceLine[];
  hiddenAbove: number;
  hiddenBelow: number;
}

// The trace viewport: a scroll offset counted from the bottom, with one row reserved for
// each "more" indicator. Both the panel and the click hit-test use this, so they cannot drift.
export function traceWindow(
  lines: readonly TraceLine[],
  rows: number,
  focused: boolean,
  scroll: number,
): TraceWindow {
  const viewport = Math.max(1, rows - (focused ? 2 : 0));
  const maxScroll0 = Math.max(0, lines.length - viewport);
  const offset0 = Math.min(scroll, maxScroll0);
  const reserve = (offset0 > 0 ? 1 : 0) + (offset0 < maxScroll0 ? 1 : 0);
  const contentRows = Math.max(1, viewport - reserve);
  const contentScroll = Math.max(0, lines.length - contentRows);
  const offset = Math.min(scroll, contentScroll);
  const start = Math.max(0, lines.length - contentRows - offset);
  const visible = lines.slice(start, start + contentRows);
  return {
    start,
    visible,
    hiddenAbove: offset,
    hiddenBelow: Math.max(0, lines.length - start - contentRows),
  };
}

export function traceLines(entries: readonly TraceEntry[], width: number): TraceLine[] {
  const out: TraceLine[] = [];
  for (const entry of entries) {
    switch (entry.kind) {
      case "user": {
        separator(out);
        for (const line of wrap(entry.text, Math.max(20, width - 4))) {
          out.push(block(entry, { text: `> ${line}`, color: theme.user, bold: true }));
        }
        break;
      }
      case "tool": {
        separator(out);
        out.push(...toolLines(entry, width));
        break;
      }
      case "thought": {
        separator(out);
        out.push(...thoughtLines(entry, width));
        break;
      }
      case "state": {
        const parts = wrap(entry.text, Math.max(10, width - 4));
        parts.forEach((part, index) => {
          out.push({
            text: index === 0 ? `  ■ ${part}` : `    ${part}`,
            color: theme.state,
            bold: true,
          });
        });
        break;
      }
      case "notice": {
        const parts = wrap(entry.text, Math.max(10, width - 2));
        for (const part of parts) out.push({ text: `  ${part}`, dim: true });
        break;
      }
      case "assistant": {
        separator(out);
        out.push(...assistantLines(entry, width));
        break;
      }
      case "report": {
        separator(out);
        out.push(...reportLines(entry, width));
        break;
      }
    }
  }
  return out;
}
