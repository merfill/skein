import { afterEach, describe, expect, it } from "vitest";

import { planOf } from "../../src/ir/graph";
import { project } from "../../src/ir/project";
import { currentMove, isMoveFinished, moveIsland } from "../../src/ir/traversal";
import {
  DEFAULT_FILES,
  classification,
  cleanupWorkspaces,
  exec,
  execAll,
  makeWorkspace,
  move,
  request,
  run,
} from "./helpers";

afterEach(cleanupWorkspaces);

describe("move", () => {
  it("OP-MV-1 opens a state as a flat child of the request, descends into it, with no plan yet", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { state } = exec(move("orientation", "map the repo"), [request()], ws);
    const moveNode = currentMove(state);
    expect(moveNode).toBeDefined();
    expect(state.nodes.get(moveNode as string)?.kind).toBe("move");
    expect(moveIsland(state, moveNode as string)).toBe("orientation");
    // The edge is request → move (`move` relation); the request has no goal of its own.
    expect(
      [...state.edges.values()].some(
        (edge) => edge.kind === "move" && edge.from === "r1" && edge.to === moveNode,
      ),
    ).toBe(true);
    // The state IS its goal: the `what` rides the move; there is no plan until the first apply.
    expect((state.nodes.get(moveNode as string)?.payload as { what?: string }).what).toBe("map the repo");
    expect(planOf(state, moveNode as string)).toBeUndefined();
  });

  it("OP-MV-2 a move after a finished state is a sibling, not a child", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = execAll([move("localization", "find it"), run("true")], [request()], ws);
    const stopped = exec({ operator: "stop", why: "done" }, opened.events, ws);
    const moved = exec(move("patch", "apply the fix"), stopped.events, ws);

    const moves = [...moved.state.nodes.values()]
      .filter((node) => node.kind === "move")
      .map((node) => node.id);
    expect(moves).toHaveLength(2);
    // Both moves hang directly off the request (flat siblings).
    for (const id of moves) {
      expect(
        [...moved.state.edges.values()].some(
          (edge) => edge.kind === "move" && edge.from === "r1" && edge.to === id,
        ),
      ).toBe(true);
    }
    expect(currentMove(moved.state)).toBe(moves[1]);
  });

  it("OP-MV-3 the terminal state accepts stop directly (DER-REQ-1)", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const moved = exec(move("finish"), [request()], ws);
    const moveId = currentMove(moved.state)!;
    expect(moveIsland(moved.state, moveId)).toBe("finish");
    expect(isMoveFinished(moved.state, moveId)).toBe(false);
    const stopped = exec({ operator: "stop", why: "done" }, moved.events, ws);
    expect(stopped.outcome.done).toBe(true);
    expect(stopped.outcome.stopReason).toBe("request_addressed");
    expect(isMoveFinished(stopped.state, moveId)).toBe(true);
  });

  it("OP-MV-4 carries the note into the finished state's compaction line", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = execAll([move("localization", "find it"), run("true")], [request()], ws);
    const stopped = exec({ operator: "stop", why: "the line is named" }, opened.events, ws);
    const moved = exec(
      { operator: "move", state: "patch", what: "apply the fix", note: "named p += Whsize_hd(hd)" },
      stopped.events,
      ws,
    );
    const texts = project(moved.state).history.map((message) => message.text).join("\n");
    expect(texts).toContain("Finish state Localization — the line is named");
    expect(texts).toContain("(note: named p += Whsize_hd(hd))");
  });

  it("REF-MV-EMPTY rejects a move without a state", () => {
    const verdict = classification({ operator: "move", state: "atlantis" } as never, [request()]);
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toContain("empty_state");
  });

  it("REF-MV-WHAT rejects a non-terminal move with no goal text", () => {
    const verdict = classification(
      { operator: "move", state: "orientation", what: "   " },
      [request()],
    );
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toContain("empty_what");
  });

  it("DER-STATE-1 a state is finished only when it is stopped", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = execAll([move("localization", "find it"), run("true")], [request()], ws);
    const moveId = currentMove(opened.state)!;
    expect(isMoveFinished(opened.state, moveId)).toBe(false);
    const stopped = exec({ operator: "stop", why: "done" }, opened.events, ws);
    expect(isMoveFinished(stopped.state, moveId)).toBe(true);
  });

  it("DER-STATE-2 the current state is the last move child of the request", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = execAll([move("localization", "find it"), run("true")], [request()], ws);
    const stopped = exec({ operator: "stop", why: "done" }, opened.events, ws);
    const moved = exec(move("patch", "apply the fix"), stopped.events, ws);
    const ids = [...moved.state.nodes.values()].filter((n) => n.kind === "move").map((n) => n.id);
    expect(currentMove(moved.state)).toBe(ids[ids.length - 1]);
    expect(moveIsland(moved.state, currentMove(moved.state)!)).toBe("patch");
  });
});
