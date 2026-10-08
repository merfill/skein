import { afterEach, describe, expect, it } from "vitest";

import type { Action } from "../../src/llm/schemas";
import { cleanupContainers, dockerAvailable, dockerImageAvailable } from "./docker";
import { runTask, taskAvailable } from "./harness";
import { scripted } from "./run";
import { SOLUTION_COMMAND, type SandboxTask } from "./task";
import { cobolModernization } from "./tasks/cobol-modernization";
import { crack7zHash } from "./tasks/crack-7z-hash";
import { customMemoryHeapCrash } from "./tasks/custom-memory-heap-crash";
import { dbWalRecovery } from "./tasks/db-wal-recovery";
import { fixCodeVulnerability } from "./tasks/fix-code-vulnerability";
import { fixOcamlGcTask } from "./tasks/fix-ocaml-gc";
import { gitLeakRecovery } from "./tasks/git-leak-recovery";
import { logSummaryDateRanges } from "./tasks/log-summary-date-ranges";
import { modernizeScientificStack } from "./tasks/modernize-scientific-stack";
import { opensslSelfsignedCert } from "./tasks/openssl-selfsigned-cert";
import { passwordRecovery } from "./tasks/password-recovery";
import { cleanupSandboxes } from "./workspace";

afterEach(() => {
  cleanupContainers();
  cleanupSandboxes();
}, 120_000);

// Offline (no model) validation of the Docker backend against each task's own image and
// verifier: a no-op proposal scores 0; replaying the task's `solution/solve.sh` scores 1.
// This proves the container mount, the WORKDIR, the verifier plumbing and the apt shim.

// `fix-ocaml-gc` is registered but deliberately excluded: its verifier rebuilds the OCaml
// compiler (minutes), so it is validated on demand, not in the fast offline suite.
const IMAGE_TASKS: SandboxTask[] = [
  logSummaryDateRanges,
  opensslSelfsignedCert,
  gitLeakRecovery,
  cobolModernization,
  modernizeScientificStack,
  customMemoryHeapCrash,
  passwordRecovery,
  dbWalRecovery,
  crack7zHash,
  fixCodeVulnerability,
];

const goal = (what: string): Action => ({
  operator: "create_goal",
  what,
  done_when: { kind: "arbiter", text: "the verifier accepts the result" },
  plan: "work the task, then let the verifier score it",
  step: { command: "pwd" },
});
const solve: Action = { operator: "apply", action: { tool: "run", command: SOLUTION_COMMAND } };
const stop: Action = { operator: "stop", why: "done" };

describe("ported image tasks (docker)", () => {
  for (const task of IMAGE_TASKS) {
    const ready = dockerAvailable() && dockerImageAvailable(task.image ?? "") && taskAvailable(task.id);
    describe.skipIf(!ready)(task.id, () => {
      it("scores 0 without work", async () => {
        const run = await runTask(task, scripted([goal(task.id)], stop), { maxTurns: 2 });
        expect(run.reward).toBe(0);
      }, 300_000);

      it("scores 1 on the task's own solution", async () => {
        const run = await runTask(task, scripted([goal(task.id), solve], stop), {
          maxTurns: 3,
          stageSolution: true,
        });
        expect(run.reward).toBe(1);
        expect(run.check.code).toBe(0);
      }, 300_000);
    });
  }
});

// `fix-ocaml-gc`'s verifier rebuilds the OCaml compiler (minutes); run it on demand:
//   SKEIN_SLOW_TASKS=1 SKEIN_LIVE=false npx vitest run tests/sandbox/tasks.test.ts -t fix-ocaml
const slowReady =
  process.env.SKEIN_SLOW_TASKS === "1" &&
  dockerAvailable() &&
  dockerImageAvailable(fixOcamlGcTask.image ?? "") &&
  taskAvailable(fixOcamlGcTask.id);

describe.skipIf(!slowReady)("fix-ocaml-gc (slow, rebuild verifier)", () => {
  it("scores 1 on the task's own solution", async () => {
    const run = await runTask(fixOcamlGcTask, scripted([goal(fixOcamlGcTask.id), solve], stop), {
      maxTurns: 3,
      stageSolution: true,
    });
    expect(run.reward).toBe(1);
  }, 1_800_000);
});
