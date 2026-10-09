import { afterEach, describe, expect, it } from "vitest";

import { loadSettings } from "../../src/config/settings";
import type { Event } from "../../src/ir/events";
import { fold } from "../../src/ir/graph";
import { project, type Context } from "../../src/ir/project";
import { currentGoalId, focusEvents } from "../../src/ir/traversal";
import { createChatModel } from "../../src/llm/client";
import type { Action } from "../../src/llm/schemas";
import { invokeTools } from "../../src/llm/structured";
import { buildMessages } from "../../src/loop/propose";
import {
  DEFAULT_FILES,
  check,
  cleanupWorkspaces,
  exec,
  interpretation,
  makeWorkspace,
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
  return project(current, { budget: { turn: 0, maxTurns: 20 } });
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
    expectMove: (a) => expect(a.operator, "an open request is interpreted").toBe("create_goal"),
  });

  {
    // OP-AP-RUN-2 / TR-6: an objective focus whose plan is done is settled by its check
    // (checkReady), never by complete or by growing the plan.
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = exec(interpretation("fix the build", "make check", "true"), [request()], ws);
    const goal = currentGoalId(opened.state)!;
    const done = exec(run("true"), opened.events, ws);
    steps.push({
      name: "check-ready-objective",
      context: projectAt(done.events),
      expectMove: (a) => {
        expect(a.operator).toBe("apply");
        if (a.operator !== "apply") return;
        expect(a.action.tool).toBe("run");
        if (a.action.tool !== "run") return;
        expect(a.action.target, "the check targets the focus goal").toBe(goal);
      },
    });
  }

  {
    // OP-AP-RUN-5/6: a running background job is polled, not re-run.
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = exec(interpretation("fix the build", "make check"), [request()], ws);
    const action: Event = { type: "add_node", node: { id: "a:job", space: "work", kind: "action", label: "started job job-1", payload: { command: "make", background: true }, seq: 900 } };
    const observation: Event = {
      type: "add_node",
      node: {
        id: "obs:job",
        space: "work",
        kind: "observation",
        label: "started job job-1",
        payload: { command: "make", job: "job-1", state: "running", summary: "job job-1 running", output: "started job job-1 (pid 1): make\npoll with run {job: \"job-1\"}" },
        seq: 901,
      },
    };
    const edge: Event = { type: "add_edge", edge: { id: "e:job", from: "a:job", to: "obs:job", kind: "produces", provenance: { kind: "llm" } } };
    steps.push({
      name: "poll-background-job",
      context: projectAt([...opened.events, action, observation, edge]),
      expectMove: (a) => {
        expect(a.operator).toBe("apply");
        if (a.operator !== "apply") return;
        expect(a.action.tool).toBe("run");
        if (a.action.tool !== "run") return;
        expect(a.action.job, "the running job is polled by id").toBe("job-1");
      },
    });
  }

  {
    // OP-AP-RUN-4: an inconclusive check on a ready objective focus is retried at the
    // same node (checkReady is true, the goal is still open).
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = exec(interpretation("fix the build", "make check", "true"), [request()], ws);
    const goal = currentGoalId(opened.state)!;
    const done = exec(run("true"), opened.events, ws);
    const timedOut: Event = {
      type: "add_node",
      node: {
        id: "obs:timeout",
        space: "work",
        kind: "observation",
        label: "make check",
        payload: { command: "make check", target: goal },
        seq: 99,
      },
    };
    steps.push({
      name: "retry-inconclusive",
      context: projectAt([...done.events, timedOut]),
      expectMove: (a) => {
        expect(a.operator).toBe("apply");
        if (a.operator !== "apply") return;
        expect(a.action.tool).toBe("run");
        if (a.action.tool !== "run") return;
        expect(a.action.target).toBe(goal);
      },
    });
  }

  {
    // TR-6 / OP-AP-RUN-1: the plan cursor points at an action item: apply it verbatim.
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = exec(
      interpretation("carry out the request", "make check", "echo ready"),
      [request("First run `echo ready`, then continue with the task.")],
      ws,
    );
    steps.push({
      name: "apply-next-action",
      context: projectAt(opened.events),
      expectMove: (a) => {
        expect(a.operator).toBe("apply");
        if (a.operator !== "apply") return;
        expect(a.action.tool).toBe("run");
        if (a.action.tool !== "run") return;
        expect(a.action.command, "the next plan action is applied verbatim").toBe("echo ready");
      },
    });
  }

  {
    // REF-NOT-FOCUS: an objective focus is settled by its own check. The refusal at the
    // focus (with its hint) must point the model at the check.
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = exec(interpretation("fix the build", "make check", "true"), [request()], ws);
    const goal = currentGoalId(opened.state)!;
    const done = exec(run("true"), opened.events, ws);
    const refusal: Event = {
      type: "record_rejection",
      tool: "run",
      target: `run:${goal}`,
      reason: `not_current_goal: a check acts on the node in focus; check it: apply run {target: "${goal}"}`,
      turn: 0,
    };
    steps.push({
      name: "follow-focus-hint",
      context: projectAt([...done.events, refusal]),
      expectMove: (a) => {
        expect(a.operator, "the model follows the hint and checks").toBe("apply");
        if (a.operator !== "apply") return;
        expect(a.action.tool).toBe("run");
        if (a.action.tool !== "run") return;
        expect(a.action.target).toBe(goal);
      },
    });
  }

  {
    // OP-ST-2: a goal whose criterion passed offers stop.
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = exec(interpretation("fix the build", "true", "true"), [request()], ws);
    const goal = currentGoalId(opened.state)!;
    const ran = exec(run("true"), opened.events, ws);
    const checked = exec(check(goal), ran.events, ws);
    steps.push({
      name: "stop-addressed",
      context: projectAt(checked.events),
      expectMove: (a) => expect(a.operator, "an addressed request is stopped").toBe("stop"),
    });
  }

  {
    // TR-8 (F2): an open goal whose one step is done continues with an action
    // (apply), not a create_goal funnel.
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = exec(interpretation("investigate the failure", undefined, "true"), [request()], ws);
    const ran = exec(run("true"), opened.events, ws);
    steps.push({
      name: "continue-open-goal",
      context: projectAt(ran.events),
      expectMove: (a) => expect(a.operator, "an open goal continues with an action").toBe("apply"),
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
          const proposal = await invokeTools(model, buildMessages(step.context));
          console.info(`[${step.name}] attempt ${attempt}: ${JSON.stringify(proposal.action).slice(0, 240)}`);
          try {
            step.expectMove(proposal.action);
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
