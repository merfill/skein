import { afterEach, describe, expect, it } from "vitest";

import type { Event } from "../../src/ir/events";
import { currentFocus, fold } from "../../src/ir/graph";
import { applicable, focusEvents } from "../../src/ir/traversal";
import {
  classification,
  cleanupWorkspaces,
  exec,
  execAll,
  makeWorkspace,
  move,
  request,
  run,
  withGoal,
} from "./helpers";

afterEach(cleanupWorkspaces);

describe("frontier (applicable)", () => {
  it("TR-8 a fresh request offers move and decline", () => {
    const open = applicable(fold([request()]), "r1");
    expect(open).toEqual({
      focus: "r1",
      move: true,
      apply: false,
      return: false,
      stop: false,
      decline: true,
    });
  });

  it("a declared state offers apply and stop (work it; no criterion gate)", () => {
    const { ws } = makeWorkspace({});
    const moved = exec(move("reconnaissance", "map the repo"), [request()], ws);
    const moveId = currentFocus(moved.state)!;
    expect(moved.state.nodes.get(moveId)?.kind).toBe("move");
    expect(applicable(moved.state, moveId)).toMatchObject({
      apply: true,
      stop: true,
      move: false,
    });
  });

  it("TR-8 an open state offers apply and stop (no criterion gate)", () => {
    const { ws } = makeWorkspace({});
    const { events, state } = execAll(withGoal("fix", "true"), [request()], ws);
    const moveId = currentFocus(state)!;
    expect(applicable(state, moveId)).toMatchObject({
      apply: true,
      stop: true,
      decline: false,
    });
    expect(events.length).toBeGreaterThan(0);
  });

  it("a finished state offers the transition move", () => {
    const { ws } = makeWorkspace({});
    const opened = execAll(withGoal("find", "true", "localization"), [request()], ws);
    const stopped = exec({ operator: "stop", why: "done" }, opened.events, ws);
    const focused = fold(focusEvents(stopped.state), stopped.state);
    const moveId = currentFocus(focused)!;
    expect(focused.nodes.get(moveId)?.kind).toBe("move");
    expect(applicable(focused, moveId)).toMatchObject({ move: true, apply: false, stop: false });
  });

  it("the terminal state offers stop", () => {
    const { ws } = makeWorkspace({});
    const moved = exec(move("handoff"), [request()], ws);
    const moveId = currentFocus(moved.state)!;
    expect(applicable(moved.state, moveId)).toMatchObject({ stop: true, move: false, apply: false });
  });

  it("REF-NO-STATE refuses apply at the request (declare a state first)", () => {
    const events: Event[] = [request()];
    expect(classification(run("ls"), events).reason).toContain("no_state");
  });

  it("REF-STATE-OPEN refuses a move while the state is still open", () => {
    const { ws } = makeWorkspace({});
    const opened = execAll(withGoal("fix", "false"), [request()], ws);
    expect(classification(move("patch"), opened.events).reason).toContain("state_open");
  });
});
