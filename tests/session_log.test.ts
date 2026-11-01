import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSessionLog } from "../src/session/session_log";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "skein-log-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("session log", () => {
  it("writes JSONL to .skein/session.log by default", () => {
    const root = makeRoot();
    const log = createSessionLog(root, {});
    log.write({ type: "session_start", model: "m" });
    log.write({ type: "user", text: "hello" });
    log.close();
    expect(log.path).toBe(join(root, ".skein", "session.log"));
    const lines = readFileSync(log.path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ type: "session_start", model: "m" });
    expect(JSON.parse(lines[1] ?? "{}")).toMatchObject({ type: "user", text: "hello" });
  });

  it("honours a custom path and the off switch", () => {
    const root = makeRoot();
    const custom = join(root, "trace.jsonl");
    const log = createSessionLog(root, { SKEIN_LOG: custom });
    expect(log.path).toBe(custom);
    log.write({ type: "x" });
    expect(existsSync(custom)).toBe(true);
    log.close();

    const off = createSessionLog(root, { SKEIN_LOG: "off" });
    expect(off.path).toBe("");
    off.write({ type: "x" });
    expect(existsSync(join(root, ".skein", "session.log"))).toBe(false);
  });
});
