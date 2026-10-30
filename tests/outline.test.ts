import { afterEach, describe, expect, it } from "vitest";

import { currentMove } from "../src/ir/traversal";
import {
  observationBody,
  outline,
  renderedState,
  stateAttempt,
  stateOutline,
  stateTurns,
} from "../src/session/outline";
import { cleanupWorkspaces, exec, execAll, makeWorkspace, move, request, run } from "./ops/helpers";

afterEach(cleanupWorkspaces);

function orientationRun() {
  const workspace = makeWorkspace({ "src/sum.mjs": "export const sum = 1;\n" });
  return {
    run: execAll([move("orientation", "find the failure"), run("echo hi")], [request()], workspace.ws, 0),
    workspace,
  };
}

function orientationState() {
  return orientationRun().run.state;
}

describe("outline: the deterministic survey", () => {
  it("summarizes the request and its states", () => {
    const state = orientationState();
    const text = outline(state);
    expect(text).toContain("request r1:");
    expect(text).toContain("orientation");
    expect(text).toContain('what="find the failure"');
    expect(text).toContain("open");
    expect(text).toContain("items=1");
  });

  it("summarizes a state's plan and transitions", () => {
    const state = orientationState();
    const moveId = currentMove(state);
    if (moveId === undefined) throw new Error("expected a move");
    const text = stateOutline(state, moveId);
    expect(text).toContain(`state ${moveId}: orientation`);
    expect(text).toContain("what: find the failure");
    expect(text).toContain("closure: open");
    expect(text).toContain("next:");
    expect(text).toContain("plan:");
    expect(text).toContain("echo hi");
  });

  it("reports an unknown anchor", () => {
    expect(stateOutline(orientationState(), "missing")).toBe("unknown state: missing");
  });

  it("lists a state's turns and supports a range", () => {
    const state = orientationState();
    const moveId = currentMove(state);
    if (moveId === undefined) throw new Error("expected a move");
    const text = stateTurns(state, moveId);
    expect(text).toContain("echo hi");
    const first = stateTurns(state, moveId, { from: 0, to: 0 });
    expect(first).toContain("echo hi");
    expect(first.split("\n")).toHaveLength(1);
    expect(stateTurns(state, "missing")).toBe("unknown state: missing");
  });

  it("lists an item's alternatives with status and result", () => {
    const state = orientationState();
    const item = [...state.nodes.values()].find((node) => node.kind === "item");
    if (item === undefined) throw new Error("expected a plan item");
    const text = stateAttempt(state, item.id);
    expect(text).toContain(`item ${item.id}:`);
    expect(text).toContain("echo hi");
    expect(text).toContain("[succeeded]");
    expect(stateAttempt(state, "missing")).toBe("unknown item: missing");
  });

  it("returns an observation body", () => {
    const state = orientationState();
    const observation = [...state.nodes.values()].find(
      (node) => node.kind === "observation" && node.label.includes("echo hi"),
    );
    if (observation === undefined) throw new Error("expected an observation");
    expect(observationBody(state, observation.id)).toContain("hi");
    expect(observationBody(state, "missing")).toBe("unknown observation: missing");
  });

  it("renders the state tape, using the journal before a closure", () => {
    const { run: opened, workspace } = orientationRun();
    const moveId = currentMove(opened.state);
    if (moveId === undefined) throw new Error("expected a move");
    expect(renderedState(opened.state, moveId)).toContain("echo hi");

    const closed = exec({ operator: "stop", why: "done" }, opened.events, workspace.ws, 1);
    const text = renderedState(closed.state, moveId, closed.events);
    expect(text).toContain("echo hi");
  });

  it("reports a missing request", () => {
    expect(outline({ ...orientationState(), rootId: undefined })).toBe("no request");
  });
});
