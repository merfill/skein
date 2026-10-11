import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_FILES,
  cleanupWorkspaces,
  exec,
  makeWorkspace,
  read,
  request,
  run,
  search,
} from "./helpers";

afterEach(cleanupWorkspaces);

// A stored read body (its observation id) for a given file content.
function readBody(content: string): { ws: ReturnType<typeof makeWorkspace>["ws"]; events: ReturnType<typeof exec>["events"]; id: string } {
  const { ws } = makeWorkspace({ "a.txt": content });
  const r = exec(read("a.txt"), [request()], ws);
  return { ws, events: r.events, id: r.outcome.turn.nodeId as string };
}

describe("search", () => {
  it("OP-SR-1 finds matching line windows over a stored body", () => {
    const { ws, events, id } = readBody("alpha\nbeta\nGAMMA\ndelta\n");
    const text = exec(search(id, "GAMMA"), events, ws).outcome.turn.text;
    expect(text).toBe(
      [
        "stdout-1-alpha",
        "stdout-2-beta",
        "stdout:3:GAMMA",
        "stdout-4-delta",
        "stdout-5-",
      ].join("\n"),
    );
  });

  it("OP-SR-2 searches a run's stderr as well as its stdout", () => {
    const { ws } = makeWorkspace({});
    const ran = exec(run("echo OUTMARK; echo ERR_MARKER 1>&2; exit 3"), [request()], ws);
    const id = ran.outcome.turn.nodeId as string;
    const out = exec(search(id, "OUTMARK"), ran.events, ws).outcome.turn.text;
    const err = exec(search(id, "ERR_MARKER"), ran.events, ws).outcome.turn.text;
    expect(out).toContain("stdout:1:OUTMARK");
    expect(err).toContain("stderr:1:ERR_MARKER");
  });

  it("OP-SR-3 a broad pattern is truncated with a note, never a dangling next", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `hit ${i + 1}`);
    const { ws, events, id } = readBody(`${lines.join("\n")}\n`);
    const text = exec(search(id, "hit"), events, ws).outcome.turn.text;
    expect(text).toMatch(/of 300 matches; narrow the pattern/);
    expect(text).not.toContain("continue from"); // the tool has no `from`, so a cursor would be dead
    const hits = text.split("\n").filter((line) => /^stdout:\d+:hit/.test(line));
    expect(hits.length).toBeLessThan(300);
  });

  it("OP-SR-4 no matches returns an empty result set", () => {
    const { ws, events, id } = readBody("a\nb\n");
    const text = exec(search(id, "zzz"), events, ws).outcome.turn.text;
    expect(text).toBe("(no matches)");
  });

  it("OP-SR-5 an invalid pattern is reported, not crashed", () => {
    const { ws, events, id } = readBody("a\n");
    const text = exec(search(id, "("), events, ws).outcome.turn.text;
    expect(text).toMatch(/invalid pattern/);
  });

  it("OP-SR-6 a node with no stored body is reported", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const r = exec(read("src/sum.mjs"), [request()], ws);
    const actionId = [...r.state.nodes.values()].find((n) => n.kind === "action")!.id;
    const { outcome } = exec(search(actionId, "x"), r.events, ws);
    expect(outcome.turn.text).toMatch(/nothing to search/);
  });

  it("OP-SR-7 before/after context lines are honored", () => {
    const { ws, events, id } = readBody("l1\nl2\nMATCH\nl4\nl5");
    const text = exec(search(id, "MATCH"), events, ws).outcome.turn.text;
    expect(text).toBe(
      [
        "stdout-1-l1",
        "stdout-2-l2",
        "stdout:3:MATCH",
        "stdout-4-l4",
        "stdout-5-l5",
      ].join("\n"),
    );
  });
});
