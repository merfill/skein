import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { materializeTask, stageVerifier, taskAvailable } from "./harness";
import { fixOcamlGcTask } from "./tasks/fix-ocaml-gc";
import { cleanupSandboxes } from "./workspace";

// The verifier must not be in the agent's workspace: the agent's shell can read `.skein`, and
// the task's Harbor `test.sh` names the exact revision to fix. It is staged only after the
// agent, before the check (docs/testing.md §3.6). No Docker or model here.

afterEach(() => cleanupSandboxes());

describe.skipIf(!taskAvailable(fixOcamlGcTask.id))("verifier staging", () => {
  it("the agent workspace carries no verifier before it is staged", () => {
    const { root } = materializeTask(fixOcamlGcTask);
    expect(existsSync(join(root, ".skein", "tests"))).toBe(false);
  });

  it("stages the task verifier and the pytest-free runner afterwards", () => {
    const { root } = materializeTask(fixOcamlGcTask);
    stageVerifier(root, fixOcamlGcTask);
    expect(existsSync(join(root, ".skein", "tests", "test_outputs.py"))).toBe(true);
    expect(existsSync(join(root, ".skein", "tests", "run.py"))).toBe(true);
  });
});
