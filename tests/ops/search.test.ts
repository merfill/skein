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

interface SearchJson {
  total: number;
  returned: number;
  next?: number;
  note?: string;
  context?: { before: number; after: number };
  error?: string;
  results: { stream: string; line: number; match: string; before: string[]; after: string[] }[];
}

describe("search", () => {
  it("OP-SR-1 finds matching line windows over a stored body", () => {
    const { ws, events, id } = readBody("alpha\nbeta\nGAMMA\ndelta\n");
    const body = JSON.parse(exec(search(id, "GAMMA"), events, ws).outcome.turn.text) as SearchJson;
    expect(body.total).toBe(1);
    expect(body.results[0]?.match).toBe("GAMMA");
    expect(body.results[0]?.stream).toBe("stdout");
  });

  it("OP-SR-2 searches a run's stderr as well as its stdout", () => {
    const { ws } = makeWorkspace({});
    const ran = exec(run("echo OUTMARK; echo ERR_MARKER 1>&2; exit 3"), [request()], ws);
    const id = ran.outcome.turn.nodeId as string;
    const out = JSON.parse(exec(search(id, "OUTMARK"), ran.events, ws).outcome.turn.text) as SearchJson;
    const err = JSON.parse(exec(search(id, "ERR_MARKER"), ran.events, ws).outcome.turn.text) as SearchJson;
    expect(out.total).toBe(1);
    expect(err.total).toBe(1);
    expect(err.results[0]?.stream).toBe("stderr");
  });

  it("OP-SR-3 a broad pattern is truncated with a note, never a dangling next", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `hit ${i + 1}`);
    const { ws, events, id } = readBody(`${lines.join("\n")}\n`);
    const body = JSON.parse(exec(search(id, "hit"), events, ws).outcome.turn.text) as SearchJson;
    expect(body.total).toBe(300);
    expect(body.returned).toBeLessThan(300);
    expect(body.next).toBeUndefined(); // the tool has no `from`, so a cursor would be dead
    expect(body.note).toMatch(/narrow the pattern/);
  });

  it("OP-SR-4 no matches returns an empty result set", () => {
    const { ws, events, id } = readBody("a\nb\n");
    const body = JSON.parse(exec(search(id, "zzz"), events, ws).outcome.turn.text) as SearchJson;
    expect(body.total).toBe(0);
    expect(body.results).toEqual([]);
  });

  it("OP-SR-5 an invalid pattern is reported, not crashed", () => {
    const { ws, events, id } = readBody("a\n");
    const body = JSON.parse(exec(search(id, "("), events, ws).outcome.turn.text) as SearchJson;
    expect(body.error).toMatch(/invalid pattern/);
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
    const body = JSON.parse(exec(search(id, "MATCH"), events, ws).outcome.turn.text) as SearchJson;
    expect(body.context).toEqual({ before: 3, after: 3 });
    expect(body.results[0]?.before).toEqual(["l1", "l2"]);
    expect(body.results[0]?.after).toEqual(["l4", "l5"]);
  });
});
