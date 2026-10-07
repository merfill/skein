import { afterEach, describe, expect, it } from "vitest";

import type { Event } from "../../src/ir/events";
import { checkIsStale, fold, predicateOf } from "../../src/ir/graph";
import type { DoneWhen } from "../../src/ir/types";
import {
  DEFAULT_FILES,
  check,
  cleanupWorkspaces,
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

function planEvent(goalId: string, planId: string, items: string[], seq: number): Event[] {
  return [
    { type: "add_node", node: { id: planId, space: "work", kind: "plan", label: "plan", seq } },
    {
      type: "add_edge",
      edge: { id: `${planId}:h`, from: goalId, to: planId, kind: "has_plan", provenance: { kind: "llm" } },
    },
    ...items.map((item, index) => ({
      type: "add_edge" as const,
      edge: {
        id: `${planId}:i:${index}`,
        from: planId,
        to: item,
        kind: "item" as const,
        provenance: { kind: "llm" as const },
      },
    })),
  ];
}

// An external (arbiter) acceptance of a goal: a passing check, recorded as by the user,
// with no command criterion. It settles any goal it targets.
function acceptEvent(goalId: string, seq: number): Event {
  return {
    type: "record_check",
    id: `chk:${seq}`,
    command: "user acceptance",
    verdict: "pass",
    output: "",
    actor: "user",
    targets: [goalId],
  };
}

const SUBJECTIVE: DoneWhen = { kind: "arbiter", text: "done" };
const OBJECTIVE: DoneWhen = { kind: "objective", command: "make test" };

describe("derived predicates", () => {
  it("DER-REQ-1 marks the request addressed only when the chosen interpretation settles", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = exec(interpretation("fix the bug", "true"), [request()], ws);
    const goalId = [...opened.state.nodes.keys()].find((id) => id.startsWith("w:goal:"));
    expect(goalId).toBeDefined();
    expect(predicateOf(opened.state, "r1")).toBe("open");

    const closed = exec(check(goalId!), opened.events, ws);
    expect(predicateOf(closed.state, goalId!)).toBe("achieved");
    expect(predicateOf(closed.state, "r1")).toBe("addressed");
  });

  it("DER-GOAL-1 reaches achieved via a passing check with no assumptions", () => {
    const events: Event[] = [request(), goalNode("g1", "fix it", OBJECTIVE, 1), checkEvent(2, ["g1"], "pass")];
    expect(predicateOf(fold(events), "g1")).toBe("achieved");
  });

  it("DER-GOAL-2 reaches achieved_under via a passing check with under", () => {
    const withUnder: Event[] = [
      request(),
      goalNode("g1", "fix it", OBJECTIVE, 1),
      goalNode("asm", "assume x", SUBJECTIVE, 2),
      checkEvent(3, ["g1"], "pass", ["asm"]),
    ];
    expect(predicateOf(fold(withUnder), "g1")).toBe("achieved_under");
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

  it("DER-GOAL-6 lets the newer check win across checks", () => {
    const base: Event[] = [request(), goalNode("g1", "fix it", OBJECTIVE, 1)];
    const failThenPass: Event[] = [...base, checkEvent(2, ["g1"], "fail"), checkEvent(3, ["g1"], "pass")];
    // the pass (seq 3) is newer than the fail (seq 2) -> achieved.
    expect(predicateOf(fold(failThenPass), "g1")).toBe("achieved");

    const passThenFail: Event[] = [...base, checkEvent(2, ["g1"], "pass"), checkEvent(3, ["g1"], "fail")];
    // the fail (seq 3) is newer than the pass (seq 2) -> refuted.
    expect(predicateOf(fold(passThenFail), "g1")).toBe("refuted");
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

describe("logos closure (check propagation)", () => {
  it("DER-CLOSE-1 closes a matching objective plan ancestor on a passing check", () => {
    const events: Event[] = [
      request(),
      goalNode("root", "fix it", OBJECTIVE, 1),
      goalNode("s1", "reproduce", SUBJECTIVE, 2),
      goalNode("s2", "fix", OBJECTIVE, 3),
      ...planEvent("root", "p", ["s1", "s2"], 4),
      acceptEvent("s1", 5),
      checkEvent(6, ["s2"], "pass"),
    ];
    const state = fold(events);
    expect(predicateOf(state, "s2")).toBe("achieved");
    expect(predicateOf(state, "root")).toBe("achieved");
  });

  it("DER-CLOSE-2 does not close an ancestor with a different criterion", () => {
    const events: Event[] = [
      request(),
      goalNode("root", "fix it", { kind: "objective", command: "make check" }, 1),
      goalNode("s1", "reproduce", SUBJECTIVE, 2),
      goalNode("s2", "fix", OBJECTIVE, 3),
      ...planEvent("root", "p", ["s1", "s2"], 4),
      acceptEvent("s1", 5),
      checkEvent(6, ["s2"], "pass"),
    ];
    const state = fold(events);
    expect(predicateOf(state, "s2")).toBe("achieved");
    expect(predicateOf(state, "root")).toBe("open");
  });

  it("DER-CLOSE-3 does not close an ancestor while a sibling stage is unsettled", () => {
    const events: Event[] = [
      request(),
      goalNode("root", "fix it", OBJECTIVE, 1),
      goalNode("s1", "reproduce", SUBJECTIVE, 2),
      goalNode("s2", "fix", OBJECTIVE, 3),
      ...planEvent("root", "p", ["s1", "s2"], 4),
      checkEvent(6, ["s2"], "pass"),
    ];
    const state = fold(events);
    expect(predicateOf(state, "s2")).toBe("achieved");
    expect(predicateOf(state, "root")).toBe("open");
  });

  it("DER-CLOSE-4 closes the whole chain upward (nested plans)", () => {
    const events: Event[] = [
      request(),
      goalNode("root", "fix it", OBJECTIVE, 1),
      goalNode("mid", "fix", OBJECTIVE, 2),
      goalNode("leaf", "fix", OBJECTIVE, 3),
      ...planEvent("root", "p1", ["mid"], 4),
      ...planEvent("mid", "p2", ["leaf"], 5),
      checkEvent(6, ["leaf"], "pass"),
    ];
    const state = fold(events);
    expect(predicateOf(state, "leaf")).toBe("achieved");
    expect(predicateOf(state, "mid")).toBe("achieved");
    expect(predicateOf(state, "root")).toBe("achieved");
  });

  it("DER-CLOSE-5 carries the check's assumptions to the ancestor (achieved_under)", () => {
    const events: Event[] = [
      request(),
      goalNode("root", "fix it", OBJECTIVE, 1),
      goalNode("asm", "assume", SUBJECTIVE, 2),
      goalNode("s1", "reproduce", SUBJECTIVE, 3),
      goalNode("s2", "fix", OBJECTIVE, 4),
      ...planEvent("root", "p", ["s1", "s2"], 5),
      acceptEvent("s1", 6),
      checkEvent(7, ["s2"], "pass", ["asm"]),
    ];
    const state = fold(events);
    expect(predicateOf(state, "root")).toBe("achieved_under");
  });
});
