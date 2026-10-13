import { afterEach, describe, expect, it } from "vitest";

import type { Action } from "../../src/llm/schemas";
import { cleanupContainers, dockerAvailable, dockerImageAvailable } from "./docker";
import { runTask, taskAvailable } from "./harness";
import { scripted } from "./run";
import { fixGit } from "./tasks/fix-git";
import { cleanupSandboxes } from "./workspace";

afterEach(() => {
  cleanupContainers();
  cleanupSandboxes();
}, 120_000);

// Offline (no model) validation of the Docker backend against the task's own image and
// verifier. The engine drives a scripted proposer; the check is the cached test_outputs.py.

const toWork: Action = { operator: "move", state: "reconnaissance", what: "recover the lost personal-site changes and merge them into master" };
const goal: Action = {
  operator: "apply",
  action: { tool: "bash", command: "git log --oneline --all" },
};
const restore: Action = {
  operator: "apply",
  action: {
    tool: "bash",
    command:
      "cp /app/resources/patch_files/about.md /app/personal-site/_includes/about.md && " +
      "cp /app/resources/patch_files/default.html /app/personal-site/_layouts/default.html",
  },
};
const stopState: Action = { operator: "stop", why: "the reference files are restored" };
const toEnd: Action = { operator: "move", state: "handoff", what: "" };
const stopRequest: Action = { operator: "stop", why: "the reference files are restored" };

const image = fixGit.image ?? "";
const ready = dockerAvailable() && dockerImageAvailable(image) && taskAvailable("fix-git");

describe.skipIf(!ready)("fix-git task (docker image verifier)", () => {
  it("rewards restoring the site files with 1", async () => {
    const run = await runTask(fixGit, scripted([toWork, goal, restore, stopState, toEnd, stopRequest], stopRequest), { maxTurns: 6 });
    expect(run.reward).toBe(1);
    expect(run.check.code).toBe(0);
  }, 300_000);

  it("rewards an untouched repo with 0", async () => {
    const run = await runTask(fixGit, scripted([toWork, goal, stopState, toEnd, stopRequest], stopRequest), { maxTurns: 5 });
    expect(run.reward).toBe(0);
  }, 300_000);
});
