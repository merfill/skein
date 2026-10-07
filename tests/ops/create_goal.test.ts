import { afterEach, describe, expect, it } from "vitest";

import type { Event } from "../../src/ir/events";
import { alternativesOf, childrenOf, fold, latestChosen, planOf, predicateOf } from "../../src/ir/graph";
import { currentGoalId } from "../../src/ir/traversal";
import type { PlanItem } from "../../src/llm/schemas";
import {
  DEFAULT_FILES,
  classification,
  cleanupWorkspaces,
  exec,
  interpretation,
  makeWorkspace,
  request,
  run,
} from "./helpers";

afterEach(cleanupWorkspaces);

const PLAN: PlanItem[] = [
  { kind: "goal", what: "locate the cause", done_when: { kind: "arbiter", text: "named" } },
  { kind: "action", command: "make test" },
];

describe("create_goal", () => {
  it("OP-CG-1 at the request makes an interpretation: alternatives + chosen + descend", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { events, state } = exec(interpretation("fix the bug"), [request()], ws);

    const alt = alternativesOf(state, "r1");
    expect(alt).toBeDefined();
    const goal = childrenOf(state, alt!)[0]!;
    expect(latestChosen(state, alt!)).toBe(goal);
    expect(predicateOf(state, goal)).toBe("open");
    expect(currentGoalId(state)).toBe(goal);
    expect(events.some((e) => e.type === "descend" && e.node === goal)).toBe(true);
  });

  it("OP-CG-2 at an open goal adds a stage item under a plan", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = exec(interpretation("do it"), [request()], ws);
    const goal = currentGoalId(opened.state)!;

    const staged = exec(interpretation("locate the cause"), opened.events, ws);
    const plan = planOf(staged.state, goal);
    expect(plan).toBeDefined();
    const items = childrenOf(staged.state, plan!);
    expect(items).toHaveLength(1);
    expect(predicateOf(staged.state, items[0]!)).toBe("open");
    expect(currentGoalId(staged.state)).toBe(items[0]);
  });

  it("OP-CG-3 revises a refuted option: the new goal becomes the chosen sibling", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = exec(interpretation("first try", "make test"), [request()], ws);
    const first = currentGoalId(opened.state)!;
    const refuted: Event[] = [
      ...opened.events,
      { type: "record_check", command: "make test", verdict: "fail", output: "", targets: [first] },
    ];
    expect(predicateOf(fold(refuted), first)).toBe("refuted");

    const revised = exec(
      { operator: "create_goal", what: "second try", done_when: { kind: "arbiter", text: "done" }, revises: [first] },
      refuted,
      ws,
    );
    const alt = alternativesOf(revised.state, "r1")!;
    const siblings = childrenOf(revised.state, alt);
    expect(siblings).toHaveLength(2);
    expect(latestChosen(revised.state, alt)).toBe(siblings[1]);
    expect(predicateOf(revised.state, siblings[1]!)).toBe("open");
  });

  it("OP-CG-4 builds a plan whose item kinds and order are preserved", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { state } = exec(interpretation("do it", "make test", PLAN), [request()], ws);
    const goal = currentGoalId(state)!;
    const items = childrenOf(state, planOf(state, goal)!);
    expect(items).toHaveLength(2);
    expect(state.nodes.get(items[0]!)?.kind).toBe("goal");
    expect(state.nodes.get(items[1]!)?.kind).toBe("action");
  });

  it("OP-CG-5 nests a plan inside an item goal", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const nested: PlanItem[] = [
      { kind: "goal", what: "child", done_when: { kind: "arbiter", text: "x" }, plan: [PLAN[1]!] },
    ];
    const { state } = exec(interpretation("do it", "make test", nested), [request()], ws);
    const goal = currentGoalId(state)!;
    const child = childrenOf(state, planOf(state, goal)!)[0]!;
    expect(planOf(state, child)).toBeDefined();
    expect(childrenOf(state, planOf(state, child)!)).toHaveLength(1);
  });

  it("REF-CG-EMPTY rejects malformed fields", () => {
    const seeded = [request()];
    expect(classification({ operator: "create_goal", what: "", done_when: { kind: "arbiter", text: "x" } }, seeded).reason).toBe("empty_what");
    expect(classification({ operator: "create_goal", what: "g", done_when: { kind: "arbiter", text: "" } }, seeded).reason).toBe("empty_done_when");
    expect(classification({ operator: "create_goal", what: "g", done_when: { kind: "arbiter", text: "x" }, plan: [] }, seeded).reason).toBe("empty_plan");
    expect(classification({ operator: "create_goal", what: "g", done_when: { kind: "arbiter", text: "x" }, plan: [{ kind: "goal", what: "", done_when: { kind: "arbiter", text: "y" } }] }, seeded).reason).toBe("empty_item");
  });

  it("REF-NO-FOCUS rejects create_goal without a root", () => {
    expect(classification(interpretation("g"), []).reason).toBe("no_current_goal");
  });

  it("REF-REV-MISSING requires every failed option in revises", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = exec(interpretation("first try", "make test"), [request()], ws);
    const first = currentGoalId(opened.state)!;
    const refuted: Event[] = [
      ...opened.events,
      { type: "record_check", command: "make test", verdict: "fail", output: "", targets: [first] },
    ];
    const reason = classification(
      { operator: "create_goal", what: "second try", done_when: { kind: "arbiter", text: "done" } },
      refuted,
    ).reason;
    expect(reason).toMatch(/missing_revision/);
  });

  it("REF-REV-UNKNOWN rejects revises at a non-refuted point", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = exec(interpretation("do it"), [request()], ws);
    const goal = currentGoalId(opened.state)!;
    const reason = classification(
      { operator: "create_goal", what: "another", done_when: { kind: "arbiter", text: "x" }, revises: [goal] },
      opened.events,
    ).reason;
    expect(reason).toMatch(/unknown_revision/);
  });

  it("REF-REPEAT-HYP rejects repeating a refuted hypothesis", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = exec(interpretation("locate", "make test"), [request()], ws);
    const first = currentGoalId(opened.state)!;
    const refuted: Event[] = [
      ...opened.events,
      { type: "record_check", command: "make test", verdict: "fail", output: "", targets: [first] },
    ];
    const reason = classification(
      { operator: "create_goal", what: "locate", done_when: { kind: "arbiter", text: "x" }, revises: [first] },
      refuted,
    ).reason;
    expect(reason).toBe("repeat_hypothesis");
  });

  it("REF-PLAN-DONE refuses growing an objective goal whose plan already carries a fulfilled check", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    // The goal's criterion differs from the plan item's command, so running the item is
    // exploratory (not the implicit check of the goal's own command).
    const objective: PlanItem[] = [{ kind: "action", command: "make test" }];
    const opened = exec(interpretation("fix", "make check", objective), [request()], ws);
    const goal = currentGoalId(opened.state)!;
    const ran = exec(run("make test"), opened.events, ws);
    expect(predicateOf(ran.state, goal)).toBe("open");
    const reason = classification(interpretation("grow it"), ran.events).reason;
    expect(reason).toMatch(/all plan items are fulfilled/);
  });
});
