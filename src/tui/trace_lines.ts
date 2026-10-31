import { oneLine, wrap } from "./format";
import { markdownLines } from "./markdown";
import { theme } from "./theme";
import type { TraceEntry, TraceLine } from "./types";

const PREVIEW_LINES = 4;

function agentPrefix(agent: TraceEntry["agent"]): string {
  if (agent === "session") return "[session] ";
  if (agent === "general") return "[general] ";
  if (agent === "observer") return "[observer] ";
  return "";
}

function previewLines(text: string, width: number): TraceLine[] {
  const source = text.replace(/\t/g, "  ").split("\n");
  const lines: string[] = [];
  for (const line of source) {
    if (line === "") {
      lines.push("");
    } else {
      lines.push(...wrap(line, Math.max(10, width - 2)));
    }
  }
  const shown = lines.slice(0, PREVIEW_LINES);
  const out: TraceLine[] = shown.map((line) => ({ text: `  ${line}`, dim: true }));
  if (lines.length > PREVIEW_LINES) out.push({ text: "  …", dim: true });
  return out;
}

export function traceLines(entries: readonly TraceEntry[], width: number): TraceLine[] {
  const out: TraceLine[] = [];
  for (const entry of entries) {
    switch (entry.kind) {
      case "user": {
        if (out.length > 0) out.push({ text: "" });
        for (const line of wrap(entry.text, Math.max(20, width - 2))) {
          out.push({ text: `> ${line}`, color: theme.user, bold: true });
        }
        break;
      }
      case "tool": {
        const status = entry.status === "running" ? "…" : entry.status === "error" ? "!" : "✓";
        const tool = entry.tool ?? "?";
        const rawTarget = entry.target ?? "";
        const target = oneLine(
          rawTarget.startsWith(`${tool} `) ? rawTarget.slice(tool.length + 1) : rawTarget,
          Math.max(12, width - 24),
        );
        out.push({
          text: `  ${status} ${agentPrefix(entry.agent)}${tool} ${target}`,
          color:
            entry.status === "error"
              ? theme.error
              : entry.status === "running"
                ? theme.warning
                : theme.success,
        });
        if (entry.preview !== undefined && entry.preview.trim() !== "") {
          out.push(...previewLines(entry.preview, width));
        }
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
        if (out.length > 0) out.push({ text: "" });
        out.push(...markdownLines(entry.text, width));
        break;
      }
      case "report": {
        if (out.length > 0) out.push({ text: "" });
        out.push({ text: "Report", bold: true, color: theme.report });
        out.push(...markdownLines(entry.text, width));
        break;
      }
    }
  }
  return out;
}
