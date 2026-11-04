import { afterEach, describe, expect, it } from "vitest";

import { fold } from "../src/ir/graph";
import { currentMove } from "../src/ir/traversal";
import {
  observationBody,
  outline,
  renderedState,
  stateOutline,
  stateTape,
  stateTurns,
} from "../src/session/outline";
import { cleanupWorkspaces, exec, execAll, makeWorkspace, move, request, run, write } from "./ops/helpers";

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
    expect(text).toContain("turns=1");
  });

  it("summarizes a state's turns and transitions", () => {
    const state = orientationState();
    const moveId = currentMove(state);
    if (moveId === undefined) throw new Error("expected a move");
    const text = stateOutline(state, moveId);
    expect(text).toContain(`state ${moveId}: orientation`);
    expect(text).toContain("what: find the failure");
    expect(text).toContain("closure: open");
    expect(text).toContain("next:");
    expect(text).toContain("turns:");
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

  it("lists a turn with its status and result", () => {
    const state = orientationState();
    const moveId = currentMove(state);
    if (moveId === undefined) throw new Error("expected a move");
    const text = stateTurns(state, moveId);
    expect(text).toContain("echo hi");
    expect(text).toContain("[succeeded]");
    expect(text).toContain("-> obs:");
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

  it("renders the observer's state tape as a chronology of reasoning, action and result", () => {
    const state = orientationState();
    const moveId = currentMove(state);
    if (moveId === undefined) throw new Error("expected a move");
    const text = stateTape(state, moveId);
    expect(text).toContain("request r1:");
    expect(text).toContain(`state ${moveId}: orientation`);
    expect(text).toContain("what: find the failure");
    expect(text).toContain("## ");
    expect(text).toContain("action: echo hi");
    // The observation is addressed by id: a hint's `evidence` must be able to name it.
    expect(text).toMatch(/-> obs:\d+/);
    expect(text).toContain("hi");
  });

  it("renders a successful write as the path it mutated, never as a missing result", () => {
    // `write` attaches `mutates` and never a result node. Reading only the `result` edge made a
    // successful write look like a failed one — and the observer then told the agent to redo it.
    const workspace = makeWorkspace({});
    const executed = execAll(
      [move("orientation", "write the answer"), write("answer.txt", "42\n")],
      [request()],
      workspace.ws,
      0,
    );
    const moveId = currentMove(executed.state);
    if (moveId === undefined) throw new Error("expected a move");
    const text = stateTape(executed.state, moveId);
    expect(text).toContain("action: write answer.txt");
    expect(text).toContain("-> mutated answer.txt");
    expect(text).not.toContain("-> no result");
  });

  it("still reports no result for an action with neither a result nor a mutation", () => {
    // A stray action node (no tool ever ran it) is the honest "no result" case: the fallback
    // must not invent success just because most actions mutate something.
    const state = fold([
      {
        type: "add_node",
        node: { id: "r1", space: "work", kind: "request", label: "task", payload: { text: "task" }, seq: 0 },
      },
      {
        type: "add_node",
        node: { id: "w:move:1", space: "work", kind: "move", label: "do it", payload: { state: "orientation", what: "do it" }, seq: 1 },
      },
      {
        type: "add_edge",
        edge: { id: "e:1", from: "r1", to: "w:move:1", kind: "move", provenance: { kind: "llm" } },
      },
      {
        type: "add_node",
        node: { id: "w:turns:2", space: "work", kind: "turns", label: "turns for w:move:1", seq: 2 },
      },
      {
        type: "add_edge",
        edge: { id: "e:2", from: "w:move:1", to: "w:turns:2", kind: "turns", provenance: { kind: "llm" } },
      },
      {
        type: "add_node",
        node: { id: "w:action:3", space: "work", kind: "action", label: "stray action", payload: { turn: 1 }, seq: 3 },
      },
      {
        type: "add_edge",
        edge: { id: "e:3", from: "w:turns:2", to: "w:action:3", kind: "turn", provenance: { kind: "llm" } },
      },
    ]);
    const text = stateTape(state, "w:move:1");
    expect(text).toContain("## w:action:3");
    expect(text).toContain("-> no result");
  });

  it("puts the reasoning before the action it preceded", () => {
    const state = fold([
      {
        type: "add_node",
        node: {
          id: "r1",
          space: "work",
          kind: "request",
          label: "task",
          payload: { text: "task" },
          seq: 0,
        },
      },
      {
        type: "add_node",
        node: {
          id: "w:move:1",
          space: "work",
          kind: "move",
          label: "patch it",
          payload: { state: "patch", what: "patch it", turn: 0 },
          seq: 1,
        },
      },
      {
        type: "add_node",
        node: { id: "w:turns:2", space: "work", kind: "turns", label: "turns", seq: 2 },
      },
      {
        type: "add_edge",
        edge: {
          id: "e1",
          from: "r1",
          to: "w:move:1",
          kind: "move",
          provenance: { kind: "llm" },
        },
      },
      {
        type: "add_edge",
        edge: {
          id: "e2",
          from: "w:move:1",
          to: "w:turns:2",
          kind: "turns",
          provenance: { kind: "llm" },
        },
      },
      {
        type: "add_node",
        node: {
          id: "w:action:3",
          space: "work",
          kind: "action",
          label: "echo hi",
          payload: { turn: 1, reasoning: "I am stuck on the padding" },
          seq: 3,
        },
      },
      {
        type: "add_edge",
        edge: {
          id: "e3",
          from: "w:turns:2",
          to: "w:action:3",
          kind: "turn",
          provenance: { kind: "llm" },
        },
      },
    ]);
    const text = stateTape(state, "w:move:1");
    const thinking = text.indexOf("thinking: I am stuck on the padding");
    const action = text.indexOf("action: echo hi");
    expect(thinking).toBeGreaterThan(-1);
    expect(thinking).toBeLessThan(action);
  });

  it("does not clip the state tape's observation bodies", () => {
    // The observer gets the whole body: clipping is insurance for the task tape, not a cap here.
    const state = orientationState();
    const moveId = currentMove(state);
    if (moveId === undefined) throw new Error("expected a move");
    expect(stateTape(state, moveId)).not.toContain("chars omitted");
  });

  // The request label is cut to 120 chars for one-line display; the observer must read the
  // request's own text, or it reasons about the part that happens to be visible.
  it("shows the whole request, not the 120-char display label", () => {
    const body = "Requirement: all three files must match.\nSuccess Criteria: compare A, B and C.";
    const long = `${"x".repeat(110)} ${body}`;
    // Exactly the node `runAgent` seeds: the label is the display cut, the payload is the text.
    const state = fold([
      {
        type: "add_node",
        node: {
          id: "r1",
          space: "work",
          kind: "request",
          label: long.replace(/\s+/g, " ").trim().slice(0, 120),
          payload: { text: long },
          seq: 0,
        },
      },
    ]);
    expect(state.nodes.get("r1")?.label).toHaveLength(120);
    expect(outline(state)).toContain("Success Criteria: compare A, B and C.");
    expect(observationBody(state, "r1")).toContain("Success Criteria: compare A, B and C.");
    expect(observationBody(state, "r1")).toBe(long);
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
