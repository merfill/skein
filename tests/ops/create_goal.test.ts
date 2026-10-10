import { afterEach, describe, expect, it } from "vitest";

import { childrenOf, goalOf, lastChild, planOf } from "../../src/ir/graph";
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
  it("OP-CG-1 at the request makes an interpretation: goal edge + descend", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { events, state } = exec(interpretation("fix the bug"), [request()], ws);

    const goal = goalOf(state, "r1");
    expect(goal).toBeDefined();
    expect(currentGoalId(state)).toBe(goal);
    expect(events.some((e) => e.type === "descend" && e.node === goal)).toBe(true);
  });

  it("OP-CG-2 at an open goal decomposes the current item: the sub-goal becomes its chosen alternative", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    // The first command runs at once; a failing command leaves the item unfulfilled, so it
    // can be decomposed.
    const opened = exec(interpretation("do it", "false"), [request()], ws);
    const goal = currentGoalId(opened.state)!;
    const step = childrenOf(opened.state, planOf(opened.state, goal)!)[0]!;

    const staged = exec(interpretation("locate the cause"), opened.events, ws);
    // The sub-goal is appended as the item's newest (current) alternative.
    const sub = lastChild(staged.state, step)!;
    expect(staged.state.nodes.get(sub)?.kind).toBe("goal");
    expect(currentGoalId(staged.state)).toBe(sub);
  });

  it("OP-CG-3 seeds exactly one item and runs its command", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { state } = exec(interpretation("do it", "make test"), [request()], ws);
    const goal = currentGoalId(state)!;
    const items = childrenOf(state, planOf(state, goal)!);
    expect(items).toHaveLength(1);
    const item = state.nodes.get(items[0]!);
    expect(item?.kind).toBe("item");
    // The item's sole alternative is the first command, already executed (D4).
    const actionId = lastChild(state, items[0]!)!;
    const action = state.nodes.get(actionId);
    expect(action?.kind).toBe("action");
    expect((action?.payload as { command?: string } | undefined)?.command).toBe("make test");
  });

  it("REF-CG-EMPTY rejects malformed fields", () => {
    const seeded = [request()];
    expect(
      classification({ operator: "create_goal", what: "", command: "true" }, seeded)
        .reason,
    ).toBe("empty_what");
    expect(
      classification({ operator: "create_goal", what: "g", command: "" }, seeded)
        .reason,
    ).toBe("empty_command");
  });

  it("REF-NO-FOCUS rejects create_goal without a root", () => {
    expect(classification(interpretation("g"), []).reason).toBe("no_current_goal");
  });
});
