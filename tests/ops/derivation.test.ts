import { afterEach, describe, expect, it } from "vitest";

import type { Event } from "../../src/ir/events";
import { checkIsStale, fold, predicateOf } from "../../src/ir/graph";
import type { DoneWhen } from "../../src/ir/types";
import {
  DEFAULT_FILES,
  cleanupWorkspaces,
  complete,
  exec,
  interpretation,
  makeWorkspace,
  request,
} from "./helpers";

afterEach(cleanupWorkspaces);

function goalNode(id: string, what: string, done_when: DoneWhen, seq: number): Event {
  return {
    type: "add_node",
    node: { id, space: "work", kind: "goal", label: what, payload: { what, done_when }, seq },
  };
}

function checkEvent(
  seq: number,
  targets: string[],
  verdict: "pass" | "fail" | "inconclusive",
  under?: string[],
): Event {
  return {
    type: "record_check",
    id: `chk:${seq}`,
    command: "make test",
    verdict,
    output: "",
    targets,
    ...(under !== undefined ? { under } : {}),
  };
}

const SUBJECTIVE: DoneWhen = { kind: "subjective", text: "done" };
const OBJECTIVE: DoneWhen = { kind: "objective", command: "make test" };

describe("derived predicates", () => {
  it("DER-REQ-1 marks the request addressed only when the chosen interpretation settles", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = exec(interpretation("fix the bug"), [request()], ws);
    const goalId = [...opened.state.nodes.keys()].find((id) => id.startsWith("w:goal:"));
    expect(goalId).toBeDefined();
    expect(predicateOf(opened.state, "r1")).toBe("open");

    const closed = exec(complete(goalId!), opened.events, ws);
    expect(predicateOf(closed.state, goalId!)).toBe("achieved_under");
    expect(predicateOf(closed.state, "r1")).toBe("addressed");
  });

  it("DER-GOAL-1 reaches achieved via a passing check with no assumptions", () => {
    const events: Event[] = [request(), goalNode("g1", "fix it", OBJECTIVE, 1), checkEvent(2, ["g1"], "pass")];
    expect(predicateOf(fold(events), "g1")).toBe("achieved");
  });

  it("DER-GOAL-2 reaches achieved_under via a passing check with under, or a complete", () => {
    const withUnder: Event[] = [
      request(),
      goalNode("g1", "fix it", OBJECTIVE, 1),
      goalNode("asm", "assume x", SUBJECTIVE, 2),
      checkEvent(3, ["g1"], "pass", ["asm"]),
    ];
    expect(predicateOf(fold(withUnder), "g1")).toBe("achieved_under");

    const withComplete: Event[] = [
      request(),
      goalNode("g1", "fix it", SUBJECTIVE, 1),
      { type: "add_node", node: { id: "c1", space: "work", kind: "complete", label: "complete g1", seq: 2 } },
      { type: "add_edge", edge: { id: "e1", from: "c1", to: "g1", kind: "closes", provenance: { kind: "llm" } } },
    ];
    expect(predicateOf(fold(withComplete), "g1")).toBe("achieved_under");
  });

  it("DER-GOAL-3 refutes on a failing check", () => {
    const events: Event[] = [request(), goalNode("g1", "fix it", OBJECTIVE, 1), checkEvent(2, ["g1"], "fail")];
    expect(predicateOf(fold(events), "g1")).toBe("refuted");
  });

  it("DER-GOAL-4 stays open on an inconclusive check", () => {
    const events: Event[] = [request(), goalNode("g1", "fix it", OBJECTIVE, 1), checkEvent(2, ["g1"], "inconclusive")];
    expect(predicateOf(fold(events), "g1")).toBe("open");
  });

  it("DER-GOAL-5 abandons an unselected variant once a sibling is chosen", () => {
    const events: Event[] = [
      request(),
      { type: "add_node", node: { id: "alt", space: "work", kind: "alternatives", label: "opts", seq: 1 } },
      goalNode("g1", "first try", SUBJECTIVE, 2),
      goalNode("g2", "second try", SUBJECTIVE, 3),
      { type: "add_edge", edge: { id: "e1", from: "r1", to: "alt", kind: "has_alternatives", provenance: { kind: "llm" } } },
      { type: "add_edge", edge: { id: "e2", from: "alt", to: "g1", kind: "item", provenance: { kind: "llm" } } },
      { type: "add_edge", edge: { id: "e3", from: "alt", to: "g2", kind: "item", provenance: { kind: "llm" } } },
      { type: "add_edge", edge: { id: "e4", from: "alt", to: "g2", kind: "chosen", provenance: { kind: "llm" } } },
    ];
    expect(predicateOf(fold(events), "g1")).toBe("abandoned");
    expect(predicateOf(fold(events), "g2")).toBe("open");
  });

  it("DER-GOAL-6 lets the newer closure win across check and complete", () => {
    const base: Event[] = [request(), goalNode("g1", "fix it", SUBJECTIVE, 1)];
    const checkThenComplete: Event[] = [
      ...base,
      checkEvent(2, ["g1"], "fail"),
      { type: "add_node", node: { id: "c1", space: "work", kind: "complete", label: "complete g1", seq: 3 } },
      { type: "add_edge", edge: { id: "e1", from: "c1", to: "g1", kind: "closes", provenance: { kind: "llm" } } },
    ];
    // complete (seq 3) is newer than the fail (seq 2) -> achieved_under.
    expect(predicateOf(fold(checkThenComplete), "g1")).toBe("achieved_under");

    const completeThenCheck: Event[] = [
      ...base,
      { type: "add_node", node: { id: "c1", space: "work", kind: "complete", label: "complete g1", seq: 2 } },
      { type: "add_edge", edge: { id: "e1", from: "c1", to: "g1", kind: "closes", provenance: { kind: "llm" } } },
      checkEvent(3, ["g1"], "fail"),
    ];
    // the fail (seq 3) is newer than the complete (seq 2) -> refuted.
    expect(predicateOf(fold(completeThenCheck), "g1")).toBe("refuted");
  });

  it("DER-ACT-1 marks an action executed once it produces or mutates", () => {
    const produced: Event[] = [
      request(),
      { type: "add_node", node: { id: "a1", space: "work", kind: "action", label: "read", seq: 1 } },
      { type: "add_node", node: { id: "o1", space: "work", kind: "observation", label: "body", seq: 2 } },
      { type: "add_edge", edge: { id: "e1", from: "a1", to: "o1", kind: "produces", provenance: { kind: "read", ref: "file:x", version: "v" } } },
    ];
    expect(predicateOf(fold(produced), "a1")).toBe("executed");
  });

  it("DER-ACT-2 abandons an action superseded by a chosen sibling", () => {
    const events: Event[] = [
      request(),
      { type: "add_node", node: { id: "a1", space: "work", kind: "action", label: "old", seq: 1 } },
      { type: "add_node", node: { id: "alt", space: "work", kind: "alternatives", label: "opts", seq: 2 } },
      { type: "add_node", node: { id: "a2", space: "work", kind: "action", label: "new", seq: 3 } },
      { type: "add_edge", edge: { id: "e1", from: "a1", to: "alt", kind: "has_alternatives", provenance: { kind: "llm" } } },
      { type: "add_edge", edge: { id: "e2", from: "alt", to: "a1", kind: "item", provenance: { kind: "llm" } } },
      { type: "add_edge", edge: { id: "e3", from: "alt", to: "a2", kind: "item", provenance: { kind: "llm" } } },
      { type: "add_edge", edge: { id: "e4", from: "alt", to: "a2", kind: "chosen", provenance: { kind: "llm" } } },
    ];
    expect(predicateOf(fold(events), "a1")).toBe("abandoned");
    expect(predicateOf(fold(events), "a2")).toBe("open");
  });

  it("DER-STALE-1 stales a check whose witness version changed", () => {
    const events: Event[] = [
      request(),
      goalNode("g1", "fix it", OBJECTIVE, 1),
      { type: "add_node", node: { id: "f:src/x", space: "artifact", kind: "file", label: "src/x", seq: 2 } },
      {
        type: "record_check",
        id: "chk:3",
        command: "make test",
        verdict: "pass",
        output: "",
        targets: ["g1"],
        witness: [{ ref: "file:src/x", version: "v1" }],
      },
      { type: "mutate", ref: "file:src/x", version: "v2", actionId: "a1" },
    ];
    expect(checkIsStale(fold(events), "chk:3")).toBe(true);
  });
});
