import { afterEach, describe, expect, it } from "vitest";

import type { Event } from "../../src/ir/events";
import { fold, predicateOf } from "../../src/ir/graph";
import { applicable, currentGoalId } from "../../src/ir/traversal";
import type { DoneWhen } from "../../src/ir/types";
import {
  DEFAULT_FILES,
  check,
  classification,
  cleanupWorkspaces,
  exec,
  interpretation,
  makeWorkspace,
  request,
  run,
} from "./helpers";

afterEach(cleanupWorkspaces);

const OBJECTIVE: DoneWhen = { kind: "objective", command: "make test" };
const ARBITER: DoneWhen = { kind: "arbiter", text: "done" };

function goalNode(id: string, what: string, done_when: DoneWhen, seq: number): Event {
  return {
    type: "add_node",
    node: { id, space: "work", kind: "goal", label: what, payload: { what, done_when }, seq },
  };
}

// An objective focus with an unexecuted action step: the pure ReAct start of the arm.
function openGoalWithStep(): Event[] {
  return [
    request(),
    goalNode("g1", "fix", OBJECTIVE, 1),
    { type: "add_node", node: { id: "p", space: "work", kind: "plan", label: "plan", seq: 2 } },
    { type: "add_edge", edge: { id: "e1", from: "g1", to: "p", kind: "has_plan", provenance: { kind: "llm" } } },
    { type: "add_node", node: { id: "a1", space: "work", kind: "action", label: "make test", payload: { command: "make test" }, seq: 3 } },
    { type: "add_edge", edge: { id: "e2", from: "p", to: "a1", kind: "item", provenance: { kind: "llm" } } },
    { type: "descend", node: "g1" },
  ];
}

function addressedRequest(): Event[] {
  return [
    request(),
    goalNode("g1", "approach", OBJECTIVE, 1),
    { type: "add_node", node: { id: "alt", space: "work", kind: "alternatives", label: "opts", seq: 2 } },
    { type: "add_edge", edge: { id: "ea", from: "r1", to: "alt", kind: "has_alternatives", provenance: { kind: "llm" } } },
    { type: "add_edge", edge: { id: "ei", from: "alt", to: "g1", kind: "item", provenance: { kind: "llm" } } },
    { type: "add_edge", edge: { id: "ec", from: "alt", to: "g1", kind: "chosen", provenance: { kind: "llm" } } },
    { type: "record_check", id: "chk:9", command: "make test", verdict: "pass", output: "", targets: ["g1"] },
  ];
}

describe("frontier (applicable)", () => {
  it("TR-8 an open request is interpreted; an addressed one accepts only stop", () => {
    const open = applicable(fold([request()]), "r1");
    expect(open).toMatchObject({ createGoal: true, apply: false, stop: false, checkReady: false });

    const addressed = fold(addressedRequest());
    expect(predicateOf(addressed, "r1")).toBe("addressed");
    const done = applicable(addressed, "r1");
    expect(done).toEqual({
      goalId: "r1",
      createGoal: false,
      apply: false,
      return: false,
      stop: true,
      checkReady: false,
    });
  });

  it("TR-8 an open goal with a current step: apply and create_goal, no check yet", () => {
    const { createGoal, apply, checkReady, nextAction } = applicable(
      fold(openGoalWithStep()),
      "g1",
    );
    expect(createGoal).toBe(true); // the step can be decomposed into a sub-goal
    expect(apply).toBe(true); // a command may be executed now
    expect(checkReady).toBe(false);
    expect(nextAction).toBe("a1");
  });

  it("TR-8 an objective goal whose plan is done: check it, do not grow it", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = exec(interpretation("fix", "true", "true"), [request()], ws);
    const goal = currentGoalId(opened.state)!;
    const ran = exec(run("true"), opened.events, ws);

    const frontier = applicable(ran.state, goal);
    expect(frontier.checkReady).toBe(true);
    expect(frontier.createGoal).toBe(false); // no step to decompose, and growth is refused
    expect(frontier.apply).toBe(true);
    // The gate agrees: a new stage is refused, the check is accepted.
    expect(classification(interpretation("add a stage", "true", "true"), ran.events).reason).toMatch(
      /all plan items are fulfilled/,
    );
    expect(classification(check(goal), ran.events).accept).toBe(true);
  });

  it("TR-8 an arbiter goal whose plan is done still offers apply (no funnel)", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = exec(interpretation("investigate"), [request()], ws);
    const goal = currentGoalId(opened.state)!;
    const ran = exec(run("true"), opened.events, ws);

    const frontier = applicable(ran.state, goal);
    expect(frontier.checkReady).toBe(false); // arbiter: never checked
    expect(frontier.createGoal).toBe(false); // no unfulfilled step
    expect(frontier.apply).toBe(true); // the legal continue is not hidden
    // The gate agrees: a bare run (continue the work) is accepted, not a dead end.
    expect(classification(run("echo next"), ran.events).accept).toBe(true);
  });

  it("TR-8 a refuted goal offers a revision, not more actions", () => {
    const state = fold([
      request(),
      goalNode("g1", "broken", ARBITER, 1),
      { type: "record_check", id: "chk:2", command: "make test", verdict: "fail", output: "", targets: ["g1"] },
      { type: "descend", node: "g1" },
    ]);
    expect(predicateOf(state, "g1")).toBe("refuted");
    expect(applicable(state, "g1")).toMatchObject({ createGoal: true, apply: false, stop: false });
  });
});
