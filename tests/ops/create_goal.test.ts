import { afterEach, describe, expect, it } from "vitest";

import { alternativesOf, childrenOf, goalOf, lastChild, planOf } from "../../src/ir/graph";
import { currentGoalId } from "../../src/ir/traversal";
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

describe("create_goal", () => {
  it("OP-CG-1 at the request makes an interpretation: has_goal + descend", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { events, state } = exec(interpretation("fix the bug"), [request()], ws);

    const goal = goalOf(state, "r1");
    expect(goal).toBeDefined();
    expect(currentGoalId(state)).toBe(goal);
    expect(events.some((e) => e.type === "descend" && e.node === goal)).toBe(true);
  });

  it("OP-CG-2 at an open goal decomposes the current plan item: the sub-goal becomes its chosen alternative", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = exec(interpretation("do it", "make test"), [request()], ws);
    const goal = currentGoalId(opened.state)!;
    const step = childrenOf(opened.state, planOf(opened.state, goal)!)[0]!;

    const staged = exec(interpretation("locate the cause"), opened.events, ws);
    const alt = alternativesOf(staged.state, step);
    expect(alt).toBeDefined();
    const items = childrenOf(staged.state, alt!);
    expect(items).toHaveLength(1);
    const sub = items[0]!;
    expect(lastChild(staged.state, alt!)).toBe(sub);
    expect(currentGoalId(staged.state)).toBe(sub);
  });

  it("OP-CG-3 seeds exactly one plan item: the first command, and keeps the sketch", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { state } = exec(interpretation("do it", "make test"), [request()], ws);
    const goal = currentGoalId(state)!;
    const items = childrenOf(state, planOf(state, goal)!);
    expect(items).toHaveLength(1);
    const step = state.nodes.get(items[0]!);
    expect(step?.kind).toBe("action");
    expect((step?.payload as { command?: string } | undefined)?.command).toBe("make test");
    // The sketch is kept on the goal payload (I3).
    expect((state.nodes.get(goal)?.payload as { sketch?: string } | undefined)?.sketch).toBe(
      "do it: a sketch",
    );
  });

  it("REF-CG-EMPTY rejects malformed fields", () => {
    const seeded = [request()];
    expect(
      classification({ operator: "create_goal", what: "", sketch: "p", command: "true" }, seeded)
        .reason,
    ).toBe("empty_what");
    expect(
      classification({ operator: "create_goal", what: "g", sketch: "", command: "true" }, seeded)
        .reason,
    ).toBe("empty_sketch");
    expect(
      classification({ operator: "create_goal", what: "g", sketch: "p", command: "" }, seeded)
        .reason,
    ).toBe("empty_command");
  });

  it("REF-NO-FOCUS rejects create_goal without a root", () => {
    expect(classification(interpretation("g"), []).reason).toBe("no_current_goal");
  });
});
