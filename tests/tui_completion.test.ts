import { describe, expect, it } from "vitest";

import {
  detectMention,
  detectSlash,
  rankCommands,
  rankFiles,
  replaceRange,
} from "../src/tui/completion";

describe("mention detection", () => {
  it("finds a token at the start of the input", () => {
    expect(detectMention("@src", 4)).toEqual({ start: 0, end: 4, query: "src" });
  });

  it("finds a token after whitespace", () => {
    expect(detectMention("read @src/app", 13)).toEqual({ start: 5, end: 13, query: "src/app" });
  });

  it("uses the cursor as the query end", () => {
    expect(detectMention("@src/app.ts", 4)).toEqual({ start: 0, end: 11, query: "src" });
  });

  it("ignores an @ inside a word", () => {
    expect(detectMention("foo@bar", 7)).toBeUndefined();
    expect(detectMention("mail user@host", 15)).toBeUndefined();
  });

  it("treats a lone @ as an empty query", () => {
    expect(detectMention("@", 1)).toEqual({ start: 0, end: 1, query: "" });
  });
});

describe("file ranking", () => {
  const files = ["README.md", "src/app.ts", "src/deep/nested/app.test.ts", "docs/app.md"];

  it("prefers a basename prefix and then the shorter path", () => {
    expect(rankFiles(files, "ap")).toEqual([
      "src/app.ts",
      "docs/app.md",
      "src/deep/nested/app.test.ts",
    ]);
  });

  it("ranks an exact basename first", () => {
    expect(rankFiles(files, "app.ts")[0]).toBe("src/app.ts");
  });

  it("matches a path fragment", () => {
    expect(rankFiles(files, "deep")).toEqual(["src/deep/nested/app.test.ts"]);
  });

  it("returns the first files for an empty query", () => {
    expect(rankFiles(files, "", 2)).toEqual(["README.md", "src/app.ts"]);
  });

  it("respects the limit", () => {
    expect(rankFiles(files, "a", 1)).toHaveLength(1);
  });
});

describe("slash commands", () => {
  it("detects a bare command line", () => {
    expect(detectSlash("/he")).toEqual({ query: "he" });
    expect(detectSlash("/")).toEqual({ query: "" });
  });

  it("does not treat arguments or text as a menu", () => {
    expect(detectSlash("/theme light")).toBeUndefined();
    expect(detectSlash("hello /he")).toBeUndefined();
    expect(detectSlash("//literal")).toBeUndefined();
  });

  it("ranks prefix matches before substring matches", () => {
    const names = rankCommands("s").map((command) => command.name);
    expect(names[0]).toBe("status");
    expect(names).toContain("pause");
  });

  it("lists everything for an empty query", () => {
    expect(rankCommands("").map((command) => command.name)).toContain("new");
  });
});

describe("range replacement", () => {
  it("replaces a mention token and leaves the cursor after it", () => {
    expect(replaceRange("read @sr now", 5, 8, "@src/app.ts ")).toEqual({
      input: "read @src/app.ts  now",
      cursor: 17,
    });
  });

  it("replaces the whole input for a command completion", () => {
    expect(replaceRange("/he", 0, 3, "/help ")).toEqual({ input: "/help ", cursor: 6 });
  });
});
