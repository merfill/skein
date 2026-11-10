import { describe, expect, it } from "vitest";

import { theme } from "../src/tui/theme";
import { traceLines } from "../src/tui/trace_lines";
import type { TraceEntry } from "../src/tui/types";

function texts(entries: readonly TraceEntry[]): string {
  return traceLines(entries, 60)
    .map((line) => line.text)
    .join("\n");
}

describe("trace blocks", () => {
  it("keeps reasoning collapsed behind a timed Thought header", () => {
    const entry: TraceEntry = {
      id: "thought",
      kind: "thought",
      text: "",
      reasoning: "first thought\nsecond thought",
      durationMs: 7300,
      collapsed: true,
    };
    const collapsed = traceLines([entry], 60);
    expect(collapsed[0]?.text).toContain("+ Thought: 7.3s");
    expect(collapsed[0]?.entryId).toBe("thought");
    expect(collapsed[0]?.bg).toBe(theme.blockBg);
    expect(collapsed.map((line) => line.text).join("\n")).not.toContain("second thought");

    const expanded = traceLines([{ ...entry, collapsed: false }], 60);
    const body = expanded.map((line) => line.text).join("\n");
    expect(body).toContain("− Thought: 7.3s");
    expect(body).toContain("first thought");
    expect(body).toContain("second thought");
  });

  it("shows a collapsed tool preview teaser and expands the rest on demand", () => {
    const preview = Array.from({ length: 8 }, (_, index) => `preview-${index + 1}`).join("\n");
    const entry: TraceEntry = {
      id: "tool",
      kind: "tool",
      text: "",
      tool: "bash",
      target: "make test",
      status: "ok",
      preview,
      collapsed: true,
    };
    const collapsed = texts([entry]);
    expect(collapsed).toContain("▸ ✓ bash make test");
    // The first five result lines are the collapsed teaser.
    expect(collapsed).toContain("preview-1");
    expect(collapsed).toContain("preview-5");
    expect(collapsed).not.toContain("preview-6");
    expect(collapsed).toContain("+3 more lines · click to expand");
    // Expanding shows the whole preview.
    const expanded = texts([{ ...entry, collapsed: false }]);
    expect(expanded).toContain("preview-1");
    expect(expanded).toContain("preview-8");
  });

  it("renders a whole-file diff with path, line numbers and colours", () => {
    const entry: TraceEntry = {
      id: "write",
      kind: "tool",
      text: "",
      tool: "write",
      target: "write src/a.ts",
      status: "ok",
      collapsed: false,
      diffs: [{ path: "src/a.ts", before: "a\nb\nc\n", after: "a\nB\nc\n" }],
    };
    const out = traceLines([entry], 80);
    const body = out.map((line) => line.text).join("\n");
    expect(body).toContain("src/a.ts");
    expect(body).toContain("- b");
    expect(body).toContain("+ B");
    // Old/new line numbers are in the gutter.
    expect(body).toMatch(/2\s+- b/);
    expect(out.some((line) => line.color === theme.syntax.deletion)).toBe(true);
    expect(out.some((line) => line.color === theme.syntax.addition)).toBe(true);
  });

  it("renders an edit as a coloured line diff", () => {
    const entry: TraceEntry = {
      id: "edit",
      kind: "tool",
      text: "",
      tool: "edit",
      target: "edit src/a.ts",
      status: "ok",
      collapsed: false,
      edit: { path: "src/a.ts", find: "const a = 1;\nkeep", replace: "const a = 2;\nkeep" },
    };
    const out = traceLines([entry], 60);
    const body = out.map((line) => line.text).join("\n");
    expect(body).toContain("(+1 −1)");
    expect(body).toContain("- const a = 1;");
    expect(body).toContain("+ const a = 2;");
    expect(body).toContain("  keep");
    expect(out.some((line) => line.color === theme.syntax.deletion)).toBe(true);
    expect(out.some((line) => line.color === theme.syntax.addition)).toBe(true);
  });

  it("collapses an assistant message to a one-line preview", () => {
    const entry: TraceEntry = {
      id: "answer",
      kind: "assistant",
      text: "first line\nsecond line",
      collapsed: true,
    };
    const out = traceLines([entry], 60);
    expect(out.some((line) => line.text.includes("first line"))).toBe(true);
    expect(out.some((line) => line.text.includes("second line"))).toBe(false);
    expect(out.every((line) => line.entryId === "answer")).toBe(true);
  });
});
