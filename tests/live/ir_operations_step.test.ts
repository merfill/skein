import { afterEach, describe, expect, it } from "vitest";

import { loadSettings } from "../../src/config/settings";
import type { Event } from "../../src/ir/events";
import { fold } from "../../src/ir/graph";
import { project, type Context } from "../../src/ir/project";
import { focusEvents } from "../../src/ir/traversal";
import { createChatModel } from "../../src/llm/client";
import type { Action } from "../../src/llm/schemas";
import { propose } from "../../src/loop/propose";
import {
  DEFAULT_FILES,
  cleanupWorkspaces,
  exec,
  execAll,
  makeWorkspace,
  move,
  request,
  run,
} from "../ops/helpers";

// Live, one-LLM-call checks of the operation families: build a projection OFFLINE (so it
// is exactly what the engine would show), then assert the SHAPE of the next move the live
// model proposes. No task is solved here — this is the online layer of
// docs/ir_operations.md §5. Run deliberately:
//   SKEIN_REASONING_EFFORT=low SKEIN_LIVE=true npx vitest run tests/live/ir_operations_step.test.ts

const settings = loadSettings();

afterEach(cleanupWorkspaces);

function projectAt(events: readonly Event[]): Context {
  // Fold the deterministic focus normalization the loop applies before projecting, so an
  // addressed request is shown with the focus already returned to it.
  const base = fold(events);
  const drift = focusEvents(base);
  const current = drift.length > 0 ? fold(drift, base) : base;
  return project(current);
}

interface Step {
  name: string;
  context: Context;
  // A tolerant shape check: the move family is asserted, not the exact phrasing.
  expectMove: (action: Action) => void;
}

function buildSteps(): Step[] {
  const steps: Step[] = [];

  // OP-CG-1: an open request must be interpreted.
  steps.push({
    name: "interpret-request",
    context: projectAt([request()]),
    expectMove: (a) => expect(["move", "decline"], "an open request chooses a state").toContain(a.operator),
  });

  {
    // OP-AP-RUN-1 / TR-7: an open state continues with an action (or stops).
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = execAll(
      [move("reconnaissance", "carry out the request"), run("echo ready")],
      [request("First run `echo ready`, then continue with the task.")],
      ws,
    );
    steps.push({
      name: "apply-next-action",
      context: projectAt(opened.events),
      expectMove: (a) => expect(["apply", "stop"], "an open state continues or stops").toContain(a.operator),
    });
  }

  {
    // OP-ST-1: an open goal offers stop (or a further command); there is no criterion.
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = execAll([move("reconnaissance", "fix the build"), run("true")], [request()], ws);
    steps.push({
      name: "stop-open-goal",
      context: projectAt(opened.events),
      expectMove: (a) => expect(["apply", "stop"], "an open goal offers stop").toContain(a.operator),
    });
  }

  {
    // TR-8 (F2): an open goal whose one step is done continues with an action (apply),
    // not a create_goal funnel.
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = execAll([move("reconnaissance", "investigate the failure"), run("true")], [request()], ws);
    const ran = exec(run("true"), opened.events, ws);
    steps.push({
      name: "continue-open-goal",
      context: projectAt(ran.events),
      expectMove: (a) => expect(["apply", "stop"], "an open goal continues").toContain(a.operator),
    });
  }

  {
    // OP-RC (recall): a long result's head scrolled off; re-read it from the STORED result
    // (by id) instead of re-running the command.
    const { ws } = makeWorkspace({});
    const opened = execAll(
      [move("reconnaissance", "inspect the failing output"), run("true")],
      [request("The command's output is long; the part I need scrolled off the top. Re-read more of the stored result.")],
      ws,
    );
    const ran = exec(run("for i in $(seq 1 3000); do echo row $i; done"), opened.events, ws);
    steps.push({
      name: "recall-stored-body",
      context: projectAt(ran.events),
      expectMove: (a) =>
        expect(["recall"], "read more of the stored result (not a re-run)").toContain(a.operator),
    });
  }

  {
    // OP-SR (search): find a marker inside a big stored output instead of paging it.
    const { ws } = makeWorkspace({});
    const opened = execAll(
      [move("reconnaissance", "locate the failure in the output"), run("true")],
      [request("Find the line naming MIDDLE_ASSERT_FAIL in the long output; it is somewhere in the middle.")],
      ws,
    );
    const ran = exec(
      run("for i in $(seq 1 3000); do echo row $i; done; echo MIDDLE_ASSERT_FAIL"),
      opened.events,
      ws,
    );
    steps.push({
      name: "search-stored-body",
      context: projectAt(ran.events),
      expectMove: (a) =>
        expect(["search"], "search a pattern inside the stored result").toContain(a.operator),
    });
  }

  return steps;
}

describe.skipIf(!settings.live)("IR operations steps (live)", () => {
  // The model is stochastic; a step passes if ANY attempt proposes the expected family
  // (the scenario harness does the same via SKEIN_SCENARIO_REPEATS). The console line
  // records every attempt, so a persistent miss is still visible.
  const attempts = Math.max(1, Number(process.env.SKEIN_STEP_REPEATS ?? "3") || 3);

  for (const step of buildSteps()) {
    it(
      `${step.name}: proposes the expected move family`,
      async () => {
        const errors: string[] = [];
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          const model = createChatModel(settings);
          const proposal = await propose(model, step.context);
          console.info(`[${step.name}] attempt ${attempt}: ${JSON.stringify(proposal.actions[0]!).slice(0, 240)}`);
          try {
            step.expectMove(proposal.actions[0]!);
            return;
          } catch (error) {
            errors.push((error as Error).message.split("\n")[0] ?? String(error));
          }
        }
        expect.fail(`${step.name}: no attempt matched in ${attempts}: ${errors.join(" | ")}`);
      },
      60_000 * attempts,
    );
  }
});
