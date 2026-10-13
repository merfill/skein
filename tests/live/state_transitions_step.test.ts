import { afterEach, describe, expect, it } from "vitest";

import { loadSettings } from "../../src/config/settings";
import type { Event } from "../../src/ir/events";
import { fold } from "../../src/ir/graph";
import type { IslandId } from "../../src/ir/islands";
import { project, type Context, type ProjectOptions } from "../../src/ir/project";
import { focusEvents } from "../../src/ir/traversal";
import { createChatModel } from "../../src/llm/client";
import type { Action } from "../../src/llm/schemas";
import { invokeTools } from "../../src/llm/structured";
import { buildMessages } from "../../src/loop/propose";
import {
  DEFAULT_FILES,
  cleanupWorkspaces,
  exec,
  makeWorkspace,
  request,
} from "../ops/helpers";

// The synthetic live gate for state transitions (docs/plans/state_transitions_plan.md §4 G).
// Build a projection OFFLINE (exactly what the engine would show) and assert the SHAPE of the
// live model's next move: when a state's criterion holds it must move on, and a stalled goal
// must react to the nudge. No task is solved here — cheap, one LLM call per attempt. This is
// the gate before the expensive `fix-ocaml-gc` bench; run deliberately:
//   SKEIN_LIVE=true npx vitest run tests/live/state_transitions_step.test.ts

const settings = loadSettings();

afterEach(cleanupWorkspaces);

// Fold the deterministic focus normalization the loop applies before projecting.
function projectAt(events: readonly Event[], options: ProjectOptions = {}): Context {
  const base = fold(events);
  const drift = focusEvents(base);
  const current = drift.length > 0 ? fold(drift, base) : base;
  return project(current, options);
}

// A goal entered in `state` whose seed command already ran; the caller appends further moves.
function goalIn(state: IslandId, command = "true"): Event[] {
  const { ws } = makeWorkspace(DEFAULT_FILES);
  return exec(
    { operator: "create_goal", what: "the goal", state, action: { tool: "bash", command } },
    [request("Fix the failing test.")],
    ws,
  ).events;
}

const isEdit = (a: Action): boolean => a.operator === "apply" && a.action.tool === "edit";
const transitionTo =
  (states: readonly string[]) =>
  (a: Action): boolean =>
    a.operator === "create_goal" && (states as readonly string[]).includes(a.state);

interface Step {
  name: string;
  context: Context;
  // A tolerant shape check: the move family is asserted, not the exact phrasing.
  expectMove: (action: Action) => void;
}

function buildSteps(): Step[] {
  const steps: Step[] = [];

  // Localization, criterion met: the bug lines are already on the tape -> edit now (or move to
  // Patch). A further read/recall/grep is exactly the drift this change targets.
  {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = exec(
      { operator: "create_goal", what: "fix sum", state: "localization", action: { tool: "bash", command: "true" } },
      [request("The test fails: sum(1,2) returns -1. Fix it.")],
      ws,
    );
    const read = exec({ operator: "apply", action: { tool: "read", path: "src/sum.mjs" } }, opened.events, ws);
    steps.push({
      name: "localized-edit-now",
      context: projectAt(read.events),
      expectMove: (a) =>
        expect(
          isEdit(a) || transitionTo(["patch"])(a),
          "the change is named: edit now (or move to Patch), do not keep reading",
        ).toBe(true),
    });
  }

  // Reconnaissance, criterion met: the project map is on the tape -> transition (or act), not
  // another listing.
  {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = exec(
      { operator: "create_goal", what: "orient", state: "reconnaissance", action: { tool: "bash", command: "node --test" } },
      [request("The test suite fails. Find and fix the bug.")],
      ws,
    );
    const listed = exec({ operator: "apply", action: { tool: "list" } }, opened.events, ws);
    steps.push({
      name: "recon-transition",
      context: projectAt(listed.events),
      expectMove: (a) =>
        expect(
          transitionTo(["reproduction", "localization", "design", "patch"])(a) ||
            (a.operator === "apply" && a.action.tool !== "list"),
          "the map is known: move to the next state or act, do not list again",
        ).toBe(true),
    });
  }

  // Verification, the request's acceptance command just passed -> stop (or Hand-off). The
  // request names the command and the run is green, so the criterion is visibly met.
  {
    const { ws } = makeWorkspace({
      "src/sum.mjs": "export function sum(a, b) {\n  return a + b;\n}\n",
      "test/sum.test.mjs": "import { sum } from '../src/sum.mjs';\nimport assert from 'node:assert';\nassert.equal(sum(1, 2), 3);\n",
    });
    const verified = exec(
      { operator: "create_goal", what: "confirm the sum fix", state: "verification", action: { tool: "bash", command: "node --test" } },
      [request("Fix the sum bug in src/sum.mjs; the acceptance command is `node --test`.")],
      ws,
    );
    steps.push({
      name: "verified-stop",
      context: projectAt(verified.events),
      expectMove: (a) =>
        expect(
          a.operator === "stop" || transitionTo(["handoff"])(a),
          "the acceptance command passed: stop (or move to Hand-off)",
        ).toBe(true),
    });
  }

  // Hand-off -> stop.
  {
    const events = goalIn("handoff");
    steps.push({
      name: "handoff-stop",
      context: projectAt(events),
      expectMove: (a) => expect(a.operator, "Hand-off is terminal: stop").toBe("stop"),
    });
  }

  // A stalled Localization goal: several reads, no edit, with the nudge -> a decisive move.
  {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = exec(
      { operator: "create_goal", what: "fix sum", state: "localization", action: { tool: "bash", command: "true" } },
      [request("The test fails: sum(1,2) returns -1. Fix it.")],
      ws,
    );
    const read = exec({ operator: "apply", action: { tool: "read", path: "src/sum.mjs" } }, opened.events, ws);
    steps.push({
      name: "nudge-stalled",
      context: projectAt(read.events, { stall: 2 }),
      expectMove: (a) =>
        expect(
          isEdit(a) || transitionTo(["patch", "handoff", "localization"])(a) || a.operator === "stop",
          "stalled: decide now — edit, change state, or stop",
        ).toBe(true),
    });
  }

  return steps;
}

describe.skipIf(!settings.live)("state transitions steps (live)", () => {
  // The model is stochastic; a step passes if ANY attempt proposes the expected family.
  const attempts = Math.max(1, Number(process.env.SKEIN_STEP_REPEATS ?? "3") || 3);

  for (const step of buildSteps()) {
    it(
      `${step.name}: proposes the expected move family`,
      async () => {
        const errors: string[] = [];
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          const model = createChatModel(settings);
          const proposal = await invokeTools(model, buildMessages(step.context));
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
