import { describe, expect, it } from "vitest";

import { markdownLines } from "../src/tui/markdown";
import { theme } from "../src/tui/theme";
import { traceLines } from "../src/tui/trace_lines";

describe("TUI markdown", () => {
  it("renders headings, bullets, inline formatting and code", () => {
    const lines = traceLines(
      [
        {
          id: "a",
          kind: "assistant",
          text: [
            "## Changes",
            "",
            "- **one** item with `code`",
            "- a [link](https://example.com)",
            "",
            "```ts",
            "const x = 1;",
            "```",
          ].join("\n"),
        },
      ],
      60,
    );
    const text = lines.map((line) => line.text).join("\n");
    expect(text).toContain("Changes");
    expect(text).not.toContain("##");
    expect(text).toContain("• one item with code");
    expect(text).toContain("• a link (https://example.com)");
    expect(text).toContain("const x = 1;");
    expect(text).not.toContain("**");
  });
});

describe("TUI markdown spans", () => {
  it("keeps inline styles and highlights code", () => {
    const lines = markdownLines("This is **bold** and `code`.\n\n```ts\nconst x: number = 1;\n```", 80);
    const flat = lines.flatMap((line) => line.spans ?? []);
    expect(flat.some((span) => span.text === "bold" && span.bold === true)).toBe(true);
    expect(flat.some((span) => span.text === "code" && span.color === theme.code)).toBe(true);
    expect(flat.some((span) => span.text.includes("const") && span.color === theme.syntax.keyword)).toBe(true);
    expect(flat.some((span) => span.text === "1" && span.color === theme.code)).toBe(true);
  });
});
