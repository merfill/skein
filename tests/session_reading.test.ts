import { describe, expect, it } from "vitest";

import { readUnit, type ReadFile } from "../src/session/reading";
import { attentionOf, createSession } from "../src/session/session";
import { unitOutline, sessionOutline } from "../src/session/session_outline";
import { bodyText, searchUnit } from "../src/session/session_memory";

const text = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join("\n");
const readFile: ReadFile = () => ({
  text,
  version: "v1",
  bytes: text.length,
  lines: 200,
});

describe("reading unit: one action, preview and address", () => {
  it("creates a completed reading unit with the full size and a bounded preview", () => {
    const session = createSession();
    const result = readUnit(session, "big.txt", readFile);

    expect(result.unitId).toBe("reading:1");
    expect(result.observationId).toBe("obs:reading:1");
    expect(result.bytes).toBe(text.length);
    expect(result.lines).toBe(200);
    expect(result.preview).toContain("lines 1–120 of 200; continue from 121");
    expect(attentionOf(session, "reading:1")).toBe("completed");

    const outline = sessionOutline(session);
    expect(outline).toContain(
      `1. reading reading:1 "big.txt" completed; read ${text.length} B, 200 line(s); obs:reading:1`,
    );
  });

  it("reads the full body by window and searches beyond the preview", () => {
    const session = createSession();
    const result = readUnit(session, "big.txt", readFile);

    const body = bodyText(session, result.unitId, result.observationId, { start: 200, end: 200 }, readFile);
    expect(body).toContain("line 200");

    const found = searchUnit(session, result.unitId, "line 150", {}, readFile);
    expect(found).toContain("[obs:reading:1] line 150:");
    expect(found).toContain("line 150");

    const withoutReader = bodyText(session, result.unitId, result.observationId, { start: 200, end: 200 });
    expect(withoutReader).not.toContain("line 200");
  });

  it("describes the reading unit at L1", () => {
    const session = createSession();
    const result = readUnit(session, "big.txt", readFile);
    const outline = unitOutline(session, result.unitId);
    expect(outline).toContain("unit reading:1 (reading) status: completed");
    expect(outline).toContain("path: big.txt");
    expect(outline).toContain(`bytes: ${text.length}`);
    expect(outline).toContain("lines: 200");
    expect(outline).toContain("observation: obs:reading:1");
  });
});
