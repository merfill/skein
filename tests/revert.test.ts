import { afterEach, describe, expect, it } from "vitest";

import { isFailedVerificationMove, lastPatchBefore, revertFailedPatch, revertLastPatch } from "../src/ir/attempts";
import { currentVersion, fold } from "../src/ir/graph";
import { project } from "../src/ir/project";
import { currentMove } from "../src/ir/traversal";
import type { Action } from "../src/llm/schemas";
import { runAgent } from "../src/loop/graph";
import type { Workspace } from "../src/tools/workspace";
import { createCheckpoint } from "./sandbox/checkpoint";
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
  write,
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

// A workspace with the harness's artifact store: entering Patch checkpoints the tree, so a
// failed Verification can restore paths the applied calls cannot reconstruct.
function checkpointedWorkspace(): { ws: Workspace } {
  const { ws, root } = makeWorkspace(DEFAULT_FILES);
  const checkpoint = createCheckpoint(root);
  return {
    ws: {
      ...ws,
      checkpoint: (label) => checkpoint.checkpoint(label),
      restoreCheckpoint: (id, paths) => checkpoint.restore(id, paths),
    },
  };
}

function failedPatchOn(ws: Workspace, actions: readonly Action[]) {
  let step = execAll(withGoal("do it", "true"), [request()], ws);
  step = exec({ operator: "stop", why: "mapped" }, step.events, ws);
  step = execAll([move("localization", "find it"), read("src/sum.mjs")], step.events, ws);
  step = exec({ operator: "stop", why: "named" }, step.events, ws);
  step = execAll([move("patch", "fix it"), ...actions], step.events, ws);
  const patchMoveId = currentMove(step.state) as string;
  step = exec({ operator: "stop", why: "changed" }, step.events, ws);
  step = execAll([move("verification", "check it"), run("exit 2")], step.events, ws);
  step = exec({ operator: "stop", why: "still fails" }, step.events, ws);
  return { ws, events: step.events, state: step.state, patchMoveId };
}

function failedPatch(actions: readonly Action[]) {
  const { ws } = checkpointedWorkspace();
  return failedPatchOn(ws, actions);
}

describe("revert: checkpoint covers bash, write and deletions", () => {
  it("restores a bash edit and a deletion, and removes a file the Patch created", () => {
    const { ws, state, patchMoveId } = failedPatch([
      run("sed -i 's/return a - b;/return a + b;/' src/sum.mjs"),
      run("rm test/sum.test.mjs"),
      write("out.txt", "new artifact\n"),
    ]);
    expect(ws.read("src/sum.mjs")).toContain("return a + b;");
    expect(ws.exists("test/sum.test.mjs")).toBe(false);
    expect(ws.exists("out.txt")).toBe(true);

    const outcome = revertLastPatch(state, patchMoveId, ws);
    expect(outcome.report.reverted).toBe(true);
    expect(ws.read("src/sum.mjs")).toContain("return a - b;");
    expect(ws.read("src/sum.mjs")).not.toContain("return a + b;");
    expect(ws.exists("test/sum.test.mjs")).toBe(true);
    expect(ws.exists("out.txt")).toBe(false);
    expect(outcome.events[0]).toMatchObject({ type: "revert", patchMoveId });
  });

  it("carries the failure in the Finish lines, not in a failed-attempt block", () => {
    const { ws, events } = failedPatch([
      run("sed -i 's/return a - b;/return a + b;/' src/sum.mjs"),
    ]);
    const moved = exec(move("localization", "find again"), events, ws);
    const history = project(moved.state).history;
    expect(history.some((message) => message.text.startsWith("Previous failed attempt:"))).toBe(false);
    expect(history.map((message) => message.text)).toContain("Finish state Verification — still fails");
    expect(history.map((message) => message.text)).toContain("Finish state Patch — changed");
  });

  it("without a checkpoint, write in a Patch is still a conflict", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { state, patchMoveId } = failedPatchOn(ws, [write("out.txt", "new artifact\n")]);
    const outcome = revertLastPatch(state, patchMoveId, ws);
    expect(outcome.report.reverted).toBe(false);
    expect(outcome.report.conflict).toContain("preimage");
    expect(ws.exists("out.txt")).toBe(true);
  });

  it("the loop restores a bash change before the move to Patch", async () => {
    const { ws, events } = failedPatch([
      run("sed -i 's/return a - b;/return a + b;/' src/sum.mjs"),
    ]);
    expect(ws.read("src/sum.mjs")).toContain("return a + b;");
    const result = await runAgent(
      {
        propose: async () => ({
          thought: "verification failed; the coordinates still hold",
          actions: [move("patch", "fix again")],
        }),
        workspace: ws,
        maxTurns: 2,
      },
      { request: { id: "r1", text: "fix it" }, seed: events, startTurn: 1 },
    );
    expect(result.events.some((event) => event.type === "revert")).toBe(true);
    expect(ws.read("src/sum.mjs")).toContain("return a - b;");
    expect(ws.read("src/sum.mjs")).not.toContain("return a + b;");
  });
});

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

  it("re-entering Localization has no failed-attempt block; the revert is in the journal", () => {
    const { ws, events, state, patchMoveId } = failedAttempt();
    const outcome = revertLastPatch(state, patchMoveId, ws);
    const moved = exec(move("localization", "find again"), [...events, ...outcome.events], ws);
    const history = project(moved.state).history;
    expect(history.some((message) => message.text.startsWith("Previous failed attempt:"))).toBe(false);
    expect(history.map((message) => message.text)).toContain("Finish state Verification — still fails");
    expect(fold([...events, ...outcome.events]).reverted.has(patchMoveId)).toBe(true);
  });

  it("re-entering Patch keeps the Start/Finish record and adds no failed-attempt block", () => {
    const { ws, events, state, patchMoveId } = failedAttempt();
    const outcome = revertLastPatch(state, patchMoveId, ws);
    const localization = exec(move("localization", "find again"), [...events, ...outcome.events], ws);
    const stopped = exec({ operator: "stop", why: "named again" }, localization.events, ws);
    const patch = exec(move("patch", "fix again"), stopped.events, ws);
    const history = project(patch.state).history;
    const starts = history
      .map((message, index) => (message.role === "system" && message.text.startsWith("Start state Patch") ? index : -1))
      .filter((index) => index >= 0);
    expect(starts).toHaveLength(2);
    expect(history.some((message) => message.text.startsWith("Previous failed attempt:"))).toBe(false);
    expect(history.map((message) => message.text)).toContain("Finish state Verification — still fails");
  });

  it("keeps the doxa's failure why in the Finish line even when the run exited 0", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    let step = execAll(withGoal("do it", "true"), [request()], ws);
    step = exec({ operator: "stop", why: "mapped" }, step.events, ws);
    step = execAll([move("localization", "find it"), read("src/sum.mjs")], step.events, ws);
    step = exec({ operator: "stop", why: "named" }, step.events, ws);
    step = execAll([move("patch", "fix it"), edit("src/sum.mjs", "return a - b;", "return a + b;")], step.events, ws);
    step = exec({ operator: "stop", why: "changed" }, step.events, ws);
    step = execAll([move("verification", "check it"), run("true")], step.events, ws);
    step = exec({ operator: "stop", why: "acceptance failed: tests/basic failed" }, step.events, ws);
    // No revert: exit 0 means the engine sees no failed run. The model's why still explains the
    // failure, and the Finish line carries it.
    const moved = exec(move("localization", "find again"), step.events, ws);
    const history = project(moved.state).history;
    expect(history.map((message) => message.text)).toContain(
      "Finish state Verification — acceptance failed: tests/basic failed",
    );
    expect(history.some((message) => message.text.startsWith("Previous failed attempt:"))).toBe(false);
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

  it("treats a move to Patch as a failed Verification move", () => {
    const { state } = failedAttempt();
    expect(isFailedVerificationMove(state, move("patch", "fix again"))).toBe(true);
  });

  it("the loop reverts before the move to Patch", async () => {
    const { ws, events } = failedAttempt();
    expect(ws.read("src/sum.mjs")).toContain("return a + b;");
    const result = await runAgent(
      {
        propose: async () => ({
          thought: "verification failed; the coordinates still hold",
          actions: [move("patch", "fix again")],
        }),
        workspace: ws,
        maxTurns: 2,
      },
      { request: { id: "r1", text: "fix it" }, seed: events, startTurn: 1 },
    );
    expect(result.events.some((event) => event.type === "revert")).toBe(true);
    expect(ws.read("src/sum.mjs")).toContain("return a - b;");
    const history = project(fold(result.events)).history;
    const starts = history
      .map((message, index) => (message.role === "system" && message.text.startsWith("Start state Patch") ? index : -1))
      .filter((index) => index >= 0);
    const lastStart = starts.at(-1);
    expect(lastStart).toBeDefined();
    expect(history.some((message) => message.text.startsWith("Previous failed attempt:"))).toBe(false);
    expect(history.map((message) => message.text)).toContain("Finish state Verification — still fails");
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
