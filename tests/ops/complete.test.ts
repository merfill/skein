import { afterEach, describe, expect, it } from "vitest";

import type { Event } from "../../src/ir/events";
import { fold, predicateOf } from "../../src/ir/graph";
import {
  DEFAULT_FILES,
  classification,
  cleanupWorkspaces,
  complete,
  exec,
  interpretation,
  makeWorkspace,
  request,
} from "./helpers";

afterEach(cleanupWorkspaces);

describe("complete", () => {
  it("OP-CP-1 closes the subjective focus as achieved_under with a complete node + closes edge", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = exec(interpretation("do it"), [request()], ws);
    const goal = [...opened.state.nodes.keys()].find((id) => id.startsWith("w:goal:"))!;
    const { events, state } = exec(complete(goal, "accepted note"), opened.events, ws);

    expect(predicateOf(state, goal)).toBe("achieved_under");
    expect([...state.nodes.values()].some((n) => n.kind === "complete")).toBe(true);
    expect([...state.edges.values()].some((e) => e.kind === "closes" && e.to === goal)).toBe(true);
    // `events` is well-formed: the closure is journaled, not implicit.
    expect(events.some((e) => e.type === "add_edge" && e.edge.kind === "closes")).toBe(true);
  });

  it("OP-CP-2 records the assumptions of a closure with under edges", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = exec(interpretation("do it"), [request()], ws);
    const goal = [...opened.state.nodes.keys()].find((id) => id.startsWith("w:goal:"))!;
    const { state } = exec(complete(goal, undefined, [goal]), opened.events, ws);
    expect(predicateOf(state, goal)).toBe("achieved_under");
    expect([...state.edges.values()].some((e) => e.kind === "under" && e.to === goal)).toBe(true);
  });

  it("OP-CP-3 refuses completing a root goal (a tree rooted at a goal, not a request)", () => {
    const root: Event = {
      type: "add_node",
      node: { id: "g0", space: "work", kind: "goal", label: "top", payload: { what: "top", done_when: { kind: "subjective", text: "x" } }, seq: 0 },
    };
    expect(predicateOf(fold([root]), "g0")).toBe("open");
    expect(classification(complete(), [root]).reason).toBe("root_not_completable");
  });

  it("REF-CP-TARGET rejects completing a non-goal node as invalid_goal", () => {
    const events: Event[] = [
      request(),
      { type: "add_node", node: { id: "o1", space: "work", kind: "observation", label: "body", seq: 1 } },
    ];
    expect(classification(complete("o1"), events).reason).toBe("invalid_goal");
  });

  it("REF-CP-OBJ refuses complete on an objective goal", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = exec(interpretation("fix", "make test"), [request()], ws);
    const reason = classification(complete(), opened.events).reason;
    expect(reason).toMatch(/objective_goal_needs_check/);
  });

  it("REF-NOT-FOCUS refuses completing a non-focus ancestor", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = exec(interpretation("do it"), [request()], ws);
    const parent = [...opened.state.nodes.keys()].find((id) => id.startsWith("w:goal:"))!;
    const staged = exec(interpretation("child"), opened.events, ws);
    const child = [...staged.state.nodes.keys()].filter((id) => id.startsWith("w:goal:")).at(-1)!;

    const reason = classification(complete(parent), staged.events).reason;
    expect(reason).toMatch(/not_current_goal/);
    expect(reason).toContain(child); // the hint names the actual focus
  });
});
