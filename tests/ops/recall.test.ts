import { afterEach, describe, expect, it } from "vitest";

import { fold } from "../../src/ir/graph";
import { READ_LIMIT } from "../../src/tools";
import {
  DEFAULT_FILES,
  classification,
  cleanupWorkspaces,
  exec,
  makeWorkspace,
  read,
  recall,
  request,
  run,
} from "./helpers";

afterEach(cleanupWorkspaces);

// A stored read body plus the action that produced it (an id with no stored body).
function seeded() {
  const { ws } = makeWorkspace(DEFAULT_FILES);
  const read1 = exec(read("src/sum.mjs"), [request()], ws);
  const observationId = read1.outcome.turn.nodeId!;
  const actionId = [...read1.state.nodes.values()].find((n) => n.kind === "action")!.id;
  return { ws, events: read1.events, state: read1.state, observationId, actionId };
}

describe("recall", () => {
  it("OP-RC-1 by id returns the stored body and adds no node", () => {
    const { ws, events, observationId } = seeded();
    const { outcome, events: after } = exec(recall(observationId), events, ws);
    expect(outcome.turn.text).toContain("export function sum");
    expect(after).toHaveLength(events.length);
  });

  it("OP-RC-2 a window reports start/end/total and the continued cursor", () => {
    const { ws, events, observationId } = seeded();
    const { outcome } = exec(recall(observationId, 1, 1), events, ws);
    const body = JSON.parse(outcome.turn.text);
    expect(body.start).toBe(1);
    expect(body.end).toBe(1);
    expect(body.total).toBeGreaterThan(1);
  });

  it("OP-RC-3 a large spilled run body recalls the whole, windowed to the budget", () => {
    const { ws } = makeWorkspace({});
    const ran = exec(run("printf '%s\\n' {1..20000}"), [request()], ws);
    const id = ran.outcome.turn.nodeId!;
    const { outcome } = exec(recall(id), ran.events, ws);
    expect(outcome.turn.text.length).toBeLessThanOrEqual(READ_LIMIT);
    const body = JSON.parse(outcome.turn.text) as { output: string; end: number; total: number };
    expect(body.total).toBeGreaterThan(body.end); // a window, not the whole stream
    expect(body.output).toContain("1\n2\n3"); // the head is reachable
  });

  it("OP-RC-4 a node with no stored body is reported, not crashed", () => {
    const { ws, events, actionId } = seeded();
    const { outcome } = exec(recall(actionId), events, ws);
    expect(outcome.turn.text).toMatch(/nothing to recall/);
  });

  it("OP-RC-5 an unknown id is reported", () => {
    const { ws, events } = seeded();
    const { outcome } = exec(recall("obs:9999"), events, ws);
    expect(outcome.turn.text).toMatch(/nothing to recall/);
  });

  it("REF-RECALL-REPEAT refuses a bare recall of a body in view; a window is allowed", () => {
    const { events, observationId } = seeded();
    expect(classification(recall(observationId), events, [observationId]).reason).toMatch(
      /repeated_action/,
    );
    expect(classification(recall(observationId, 2), events, [observationId]).accept).toBe(true);
  });

  it("OP-RC-6 a recall never adds a node or edge to the journal", () => {
    const { ws, events, observationId } = seeded();
    const before = fold(events);
    const after = fold([...events, ...exec(recall(observationId), events, ws).outcome.events]);
    expect(after.nodes.size).toBe(before.nodes.size);
    expect(after.edges.size).toBe(before.edges.size);
  });
});
