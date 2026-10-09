import { afterEach, describe, expect, it } from "vitest";

import type { Event } from "../../src/ir/events";
import { alternativesOf, childrenOf, criterionFailed, fold, goalOf, lastChild, planOf, stateOf } from "../../src/ir/graph";
import { currentGoalId } from "../../src/ir/traversal";
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

describe("create_goal", () => {
  it("OP-CG-1 at the request makes an interpretation: has_goal + descend", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { events, state } = exec(interpretation("fix the bug"), [request()], ws);

    const goal = goalOf(state, "r1");
    expect(goal).toBeDefined();
    expect(stateOf(state, goal as string)).toBe("open");
    expect(currentGoalId(state)).toBe(goal);
    expect(events.some((e) => e.type === "descend" && e.node === goal)).toBe(true);
  });

  it("OP-CG-2 at an open goal decomposes the current step: the sub-goal becomes its chosen alternative", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = exec(interpretation("do it", "make test", { command: "make test" }), [request()], ws);
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

  it("OP-CG-3 revises a failed goal: the new goal becomes its chosen variant", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = exec(interpretation("first try", "make test"), [request()], ws);
    const first = currentGoalId(opened.state)!;
    const refuted: Event[] = [
      ...opened.events,
      { type: "add_node", node: { id: "obs:99", space: "work", kind: "observation", label: "make test", payload: { command: "make test", target: first, exitCode: 1, }, seq: 99 } },
    ];
    expect(criterionFailed(fold(refuted), first)).toBe(true);

    const revised = exec(
      {
        operator: "create_goal",
        what: "second try",
        done_when: "done",
        plan: "second try: a sketch",
        step: { command: "true" },
        revises: [first],
      },
      refuted,
      ws,
    );
    // A failed goal is revised through its own alternatives: the new goal is the chosen
    // variant (the request's interpretation stays fixed).
    const alt = alternativesOf(revised.state, first)!;
    const variants = childrenOf(revised.state, alt);
    expect(variants).toHaveLength(1);
    expect(lastChild(revised.state, alt)).toBe(variants[0]);
    expect(stateOf(revised.state, variants[0]!)).toBe("open");
    expect(currentGoalId(revised.state)).toBe(variants[0]);
  });

  it("OP-CG-4 materializes exactly one plan item: the first step (an action)", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { state } = exec(interpretation("do it", "make test", { command: "make test" }), [request()], ws);
    const goal = currentGoalId(state)!;
    const items = childrenOf(state, planOf(state, goal)!);
    expect(items).toHaveLength(1);
    const step = state.nodes.get(items[0]!);
    expect(step?.kind).toBe("action");
    expect((step?.payload as { command?: string } | undefined)?.command).toBe("make test");
    // The initial sketch is kept on the goal payload (I3) and surfaces as `planHint`.
    expect((state.nodes.get(goal)?.payload as { plan?: string } | undefined)?.plan).toBe("do it: a sketch");
  });

  it("REF-CG-EMPTY rejects malformed fields", () => {
    const seeded = [request()];
    expect(classification({ operator: "create_goal", what: "", done_when: "x", plan: "p", step: { command: "true" } }, seeded).reason).toBe("empty_what");
    expect(classification({ operator: "create_goal", what: "g", done_when: "", plan: "p", step: { command: "true" } }, seeded).reason).toBe("empty_done_when");
    expect(classification({ operator: "create_goal", what: "g", done_when: "x", plan: "", step: { command: "true" } }, seeded).reason).toBe("empty_plan");
    expect(classification({ operator: "create_goal", what: "g", done_when: "x", plan: "p", step: { command: "" } }, seeded).reason).toBe("empty_step");
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
      { type: "add_node", node: { id: "obs:99", space: "work", kind: "observation", label: "make test", payload: { command: "make test", target: first, exitCode: 1, }, seq: 99 } },
    ];
    const reason = classification(
      {
        operator: "create_goal",
        what: "second try",
        done_when: "done",
        plan: "second try: a sketch",
        step: { command: "true" },
      },
      refuted,
    ).reason;
    expect(reason).toMatch(/missing_revision/);
  });

  it("REF-REV-UNKNOWN rejects revises at a non-refuted point", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = exec(interpretation("do it"), [request()], ws);
    const goal = currentGoalId(opened.state)!;
    const reason = classification(
      {
        operator: "create_goal",
        what: "another",
        done_when: "x",
        plan: "another: a sketch",
        step: { command: "true" },
        revises: [goal],
      },
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
      { type: "add_node", node: { id: "obs:99", space: "work", kind: "observation", label: "make test", payload: { command: "make test", target: first, exitCode: 1, }, seq: 99 } },
    ];
    const reason = classification(
      {
        operator: "create_goal",
        what: "locate",
        done_when: "x",
        plan: "locate: a sketch",
        step: { command: "true" },
        revises: [first],
      },
      refuted,
    ).reason;
    expect(reason).toBe("repeat_hypothesis");
  });

  it("REF-PLAN-DONE refuses growing an objective goal whose plan already carries a fulfilled check", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    // The goal's criterion differs from the step's command, so running the step is
    // exploratory (not the implicit check of the goal's own command).
    const opened = exec(interpretation("fix", "make check", { command: "make test" }), [request()], ws);
    const goal = currentGoalId(opened.state)!;
    const ran = exec(run("make test"), opened.events, ws);
    expect(stateOf(ran.state, goal)).toBe("open");
    const reason = classification(interpretation("grow it"), ran.events).reason;
    expect(reason).toMatch(/all plan items are fulfilled/);
  });
});
