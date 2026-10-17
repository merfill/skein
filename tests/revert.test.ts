import { afterEach, describe, expect, it } from "vitest";

import { lastPatchBefore, revertFailedPatch, revertLastPatch } from "../src/ir/attempts";
import { currentVersion, fold } from "../src/ir/graph";
import { project } from "../src/ir/project";
import { currentMove } from "../src/ir/traversal";
import { runAgent } from "../src/loop/graph";
import {
  DEFAULT_FILES,
  cleanupWorkspaces,
  edit,
  exec,
  execAll,
  makeWorkspace,
  move,
  read,
  request,
  run,
  withGoal,
} from "./ops/helpers";

afterEach(cleanupWorkspaces);

function failedAttempt() {
  const { ws } = makeWorkspace(DEFAULT_FILES);
  let step = execAll(withGoal("do it", "true"), [request()], ws);
  step = exec({ operator: "stop", why: "mapped" }, step.events, ws);
  step = execAll([move("localization", "find it"), read("src/sum.mjs")], step.events, ws);
  step = exec({ operator: "stop", why: "named" }, step.events, ws);
  step = execAll(
    [move("patch", "fix it"), edit("src/sum.mjs", "return a - b;", "return a + b;")],
    step.events,
    ws,
  );
  const patchMoveId = currentMove(step.state) as string;
  step = exec({ operator: "stop", why: "changed" }, step.events, ws);
  step = execAll([move("verification", "check it"), run("exit 2")], step.events, ws);
  step = exec({ operator: "stop", why: "still fails" }, step.events, ws);
  return { ws, events: step.events, state: step.state, patchMoveId };
}

describe("revert: failed Patch -> Localization", () => {
  it("restores the pre-patch text, journals a revert, and updates the world version", () => {
    const { ws, events, state, patchMoveId } = failedAttempt();
    expect(ws.read("src/sum.mjs")).toContain("return a + b;");

    const outcome = revertLastPatch(state, patchMoveId, ws);
    expect(outcome.report.reverted).toBe(true);
    expect(outcome.events).toHaveLength(1);
    expect(outcome.events[0]).toMatchObject({ type: "revert", patchMoveId });
    expect(ws.read("src/sum.mjs")).toContain("return a - b;");
    expect(ws.read("src/sum.mjs")).not.toContain("return a + b;");

    const after = fold([...events, ...outcome.events]);
    expect(after.reverted.has(patchMoveId)).toBe(true);
    expect(currentVersion(after, "file:src/sum.mjs")).toBe(ws.version("src/sum.mjs"));
  });

  it("re-entering Localization says the change was reverted and allows the same area", () => {
    const { ws, events, state, patchMoveId } = failedAttempt();
    const outcome = revertLastPatch(state, patchMoveId, ws);
    const moved = exec(move("localization", "find again"), [...events, ...outcome.events], ws);
    const block = project(moved.state).history.find((message) =>
      message.text.startsWith("Previous failed attempt:"),
    );
    expect(block?.text).toContain("has been reverted in the workspace");
    expect(block?.text).toContain("A different change is required");
    expect(block?.text).not.toContain("look elsewhere");
  });

  it("does not revert a passing Verification", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    let step = execAll(withGoal("do it", "true"), [request()], ws);
    step = exec({ operator: "stop", why: "mapped" }, step.events, ws);
    step = execAll([move("localization", "find it")], step.events, ws);
    step = exec({ operator: "stop", why: "named" }, step.events, ws);
    step = execAll([move("patch", "fix it"), edit("src/sum.mjs", "a - b", "a + b")], step.events, ws);
    step = exec({ operator: "stop", why: "changed" }, step.events, ws);
    step = execAll([move("verification", "check it"), run("true")], step.events, ws);
    step = exec({ operator: "stop", why: "passes" }, step.events, ws);
    expect(revertFailedPatch(step.state, ws)).toEqual([]);
  });

  it("leaves the tree untouched and reports a conflict when the patched text is gone", () => {
    const { ws, state, patchMoveId } = failedAttempt();
    ws.write("src/sum.mjs", "export function sum() { return 0; }\n");
    const outcome = revertLastPatch(state, patchMoveId, ws);
    expect(outcome.report.reverted).toBe(false);
    expect(outcome.report.conflict).toBeDefined();
    expect(outcome.events).toEqual([]);
    expect(ws.read("src/sum.mjs")).toBe("export function sum() { return 0; }\n");
  });

  it("finds the last Patch before the failed Verification", () => {
    const { state, patchMoveId } = failedAttempt();
    const verification = currentMove(state) as string;
    expect(lastPatchBefore(state, verification)).toBe(patchMoveId);
  });

  it("the loop reverts before the move to Localization", async () => {
    const { ws, events, state } = failedAttempt();
    expect(ws.read("src/sum.mjs")).toContain("return a + b;");
    const result = await runAgent(
      {
        propose: async () => ({
          thought: "verification failed; re-localize",
          actions: [move("localization", "find again")],
        }),
        workspace: ws,
        maxTurns: 2,
      },
      { request: { id: "r1", text: "fix it" }, seed: events, startTurn: 1 },
    );
    expect(result.events.some((event) => event.type === "revert")).toBe(true);
    expect(ws.read("src/sum.mjs")).toContain("return a - b;");
    expect(state.reverted.size).toBe(0);
  });
});
