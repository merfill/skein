import { afterEach, describe, expect, it } from "vitest";

import type { Event } from "../../src/ir/events";
import { unactionableOf } from "../../src/ir/graph";
import type { Action } from "../../src/llm/schemas";
import {
  DEFAULT_FILES,
  classification,
  cleanupWorkspaces,
  exec,
  interpretation,
  makeWorkspace,
  request,
} from "./helpers";

afterEach(cleanupWorkspaces);

function decline(why?: string): Action {
  return { operator: "decline", ...(why !== undefined ? { why } : {}) };
}

// A request already interpreted as a goal (the interpretation is fixed).
function interpretedRequest(): Event[] {
  return [
    request(),
    {
      type: "add_node",
      node: {
        id: "g1",
        space: "work",
        kind: "goal",
        label: "approach",
        payload: { what: "approach" },
        seq: 1,
      },
    },
    { type: "add_edge", edge: { id: "eg", from: "r1", to: "g1", kind: "goal", provenance: { kind: "llm" } } },
  ];
}

describe("decline", () => {
  it("OP-DC-1 records an unactionable node under the request and ends the run", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const events = [request("привет, дядя Вася")];
    expect(classification(decline("chit-chat, no task"), events).accept).toBe(true);

    const { state, outcome } = exec(decline("chit-chat, no task"), events, ws, 0);
    expect(outcome.done).toBe(true);
    expect(outcome.stopReason).toBe("request_unactionable");
    const id = unactionableOf(state, "r1");
    expect(id).toBeDefined();
    expect(state.nodes.get(id as string)?.kind).toBe("unactionable");
  });

  it("REF-DC-NOTREQ refuses decline when the focus is not the request (OP-DC-1)", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { events } = exec(interpretation("fix it"), [request()], ws, 0);
    const verdict = classification(decline("nah"), events);
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toContain("not_request");
  });

  it("REF-DC-ADDR refuses decline once the request has an interpretation (OP-DC-1)", () => {
    const verdict = classification(decline("nah"), interpretedRequest());
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toContain("interpreted");
  });
});
