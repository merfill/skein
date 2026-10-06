import { afterEach, describe, expect, it } from "vitest";

import { childrenOf, fold } from "../../src/ir/graph";
import {
  DEFAULT_FILES,
  classification,
  cleanupWorkspaces,
  exec,
  makeWorkspace,
  query,
  read,
  request,
} from "./helpers";

afterEach(cleanupWorkspaces);

function seeded() {
  const { ws } = makeWorkspace(DEFAULT_FILES);
  const read1 = exec(read("src/sum.mjs"), [request()], ws);
  const observationId = read1.outcome.turn.nodeId!;
  const actionId = [...read1.state.nodes.values()].find((n) => n.kind === "action")!.id;
  return { ws, events: read1.events, state: read1.state, observationId, actionId };
}

describe("query", () => {
  it("OP-QR-1 by id returns the stored body and adds no node", () => {
    const { ws, events, observationId } = seeded();
    const { outcome, events: after } = exec(query(observationId), events, ws);
    expect(outcome.turn.text).toContain("export function sum");
    expect(after).toHaveLength(events.length);
  });

  it("OP-QR-2 by id for a node without a body returns its row and incident edges", () => {
    const { ws, events, actionId } = seeded();
    const { outcome } = exec(query(actionId), events, ws);
    expect(outcome.turn.text).toContain(actionId);
    expect(outcome.turn.text).toContain("produces");
  });

  it("OP-QR-3 by id with a window reports start/end/total and the continued cursor", () => {
    const { ws, events, observationId } = seeded();
    const { outcome } = exec({ operator: "query", id: observationId, start: 1, end: 1 }, events, ws);
    const body = JSON.parse(outcome.turn.text);
    expect(body.start).toBe(1);
    expect(body.end).toBe(1);
    expect(body.total).toBeGreaterThan(1);
  });

  it("OP-QR-4 state query by kind returns matching nodes", () => {
    const { ws, events } = seeded();
    const { outcome } = exec({ operator: "query", kind: "observation" }, events, ws);
    expect(outcome.turn.text).toContain('"kind": "observation"');
  });

  it("OP-QR-5 state query by edgesOf returns incident edges", () => {
    const { ws, events, actionId } = seeded();
    const { outcome } = exec({ operator: "query", edgesOf: actionId }, events, ws);
    expect(outcome.turn.text).toContain('"edges"');
    expect(outcome.turn.text).toContain(actionId);
  });

  it("OP-QR-6 / REF-REPEAT refuses re-querying a body already in shown", () => {
    const { events, observationId } = seeded();
    const reason = classification(query(observationId), events, [observationId]).reason;
    expect(reason).toMatch(/repeated_action/);
  });

  it("keeps the journal stable: a query never adds a node or edge", () => {
    const { ws, events, observationId } = seeded();
    const before = fold(events);
    const after = fold([...events, ...exec(query(observationId), events, ws).outcome.events]);
    expect(after.nodes.size).toBe(before.nodes.size);
    expect(after.edges.size).toBe(before.edges.size);
    // sanity: the children index is unaffected
    for (const [id, kids] of before.children) {
      expect(childrenOf(after, id)).toEqual(kids);
    }
  });
});
