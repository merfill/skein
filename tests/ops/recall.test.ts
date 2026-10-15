import { afterEach, describe, expect, it } from "vitest";

import { fold } from "../../src/ir/graph";
import { QUERY_BODY_LIMIT } from "../../src/tools";
import {
  DEFAULT_FILES,
  classification,
  cleanupWorkspaces,
  exec,
  execAll,
  makeWorkspace,
  move,
  read,
  recall,
  request,
  run,
} from "./helpers";

afterEach(cleanupWorkspaces);

// A stored read body plus the action that produced it (an id with no stored body), inside an
// open state (recall is work of an open state).
function seeded() {
  const { ws } = makeWorkspace(DEFAULT_FILES);
  const read1 = execAll([move("orientation", "go"), read("src/sum.mjs")], [request()], ws);
  const observationId = read1.outcome.turn.nodeId!;
  const actionId = [...read1.state.nodes.values()].find((n) => n.kind === "action")!.id;
  return { ws, events: read1.events, state: read1.state, observationId, actionId };
}

describe("recall", () => {
  it("OP-RC-1 by id returns the stored body and appends it to the state's tape", () => {
    const { ws, events, observationId } = seeded();
    const { outcome, events: after } = exec(recall(observationId), events, ws);
    expect(outcome.turn.text).toContain("export function sum");
    expect(after.length).toBeGreaterThan(events.length);
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
    expect(outcome.turn.text.length).toBeLessThanOrEqual(QUERY_BODY_LIMIT);
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

  it("REF-RC-STATE refuses a recall outside an open state", () => {
    expect(classification(recall("obs:1"), [request()]).reason).toMatch(/no_state/);
  });

  it("OP-RC-6 a recall appends an action + observation to the journal", () => {
    const { ws, events, observationId } = seeded();
    const before = fold(events);
    const after = fold([...events, ...exec(recall(observationId), events, ws).outcome.events]);
    expect(after.nodes.size).toBeGreaterThan(before.nodes.size);
  });
});
