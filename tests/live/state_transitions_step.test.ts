import { afterEach, describe, expect, it } from "vitest";

import { loadSettings } from "../../src/config/settings";
import type { Event } from "../../src/ir/events";
import { fold } from "../../src/ir/graph";
import type { IslandId } from "../../src/ir/islands";
import { project, type Context, type ProjectOptions } from "../../src/ir/project";
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

// The synthetic live gate for the state protocol (docs/plans/archive/state_protocol_plan.md §12).
// Build a projection OFFLINE (exactly what the engine would show) and assert the SHAPE of the
// live model's next move at each focus: a fresh request chooses a state (`move`); a fresh
// state gets its first plan item (`apply`); an open state whose criterion holds is stopped;
// a finished state transitions; the terminal state is stopped. No task is solved here — cheap,
// one LLM call per attempt. This is the gate before the expensive `fix-ocaml-gc` bench; run
// deliberately:
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

// A declared state whose goal's seed command already ran.
function stateIn(state: IslandId, command = "true"): Event[] {
  const { ws } = makeWorkspace(DEFAULT_FILES);
  return execAll([move(state, "the goal"), run(command)], [request("Fix the failing test.")], ws)
    .events;
}

const isStop = (a: Action): boolean => a.operator === "stop";

interface Step {
  name: string;
  context: Context;
  // A tolerant shape check: the move family is asserted, not the exact phrasing.
  expectMove: (action: Action) => void;
}

function buildSteps(): Step[] {
  const steps: Step[] = [];

  // A fresh request: choose the first state.
  {
    steps.push({
      name: "request-choose-state",
      context: projectAt([request("Fix the failing test.")]),
      expectMove: (a) =>
        expect(a.operator === "move" || a.operator === "decline", "a fresh request moves to a state").toBe(
          true,
        ),
    });
  }

  // A fresh state (declared, no goal yet): concretize its work.
  {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const moved = exec(move("orientation", "map the repo"), [request("Fix the failing test.")], ws);
    steps.push({
      name: "move-concretize",
      context: projectAt(moved.events),
      expectMove: (a) =>
        expect(a.operator, "a fresh state gets its first plan item").toBe("apply"),
    });
  }

  // An open goal whose criterion holds: stop the state.
  {
    const { ws } = makeWorkspace({
      "src/sum.mjs": "export function sum(a, b) {\n  return a + b;\n}\n",
      "test/sum.mjs": "import { sum } from '../src/sum.mjs';\nconsole.log(sum(1,2));\n",
    });
    const opened = execAll([move("verification", "confirm the fix"), run("node test/sum.mjs")], [request("Confirm the sum fix.")], ws);
    steps.push({
      name: "goal-stop",
      context: projectAt(opened.events),
      expectMove: (a) =>
        expect(
          isStop(a) || a.operator === "apply",
          "the command passed: stop the state (or act); do not re-verify",
        ).toBe(true),
    });
  }

  // A finished state: transition with a move.
  {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = execAll([move("localization", "find the cause"), run("true")], [request("Fix the failing test.")], ws);
    const stopped = exec({ operator: "stop", why: "the line is named" }, opened.events, ws);
    steps.push({
      name: "transition-move",
      context: projectAt(stopped.events),
      expectMove: (a) =>
        expect(a.operator, "a finished state transitions with a move").toBe("move"),
    });
  }

  // The terminal state: stop to finish the request.
  {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const moved = exec(move("end"), [request("Done.")], ws);
    steps.push({
      name: "terminal-stop",
      context: projectAt(moved.events),
      expectMove: (a) => expect(a.operator, "the terminal state stops").toBe("stop"),
    });
  }

  // A moved-and-opened state: its island instruction names the state.
  {
    const events = stateIn("orientation");
    steps.push({
      name: "goal-island-known",
      context: projectAt(events),
      expectMove: (a) => expect(a.operator).not.toBe("move"),
    });
  }

  return steps;
}

describe.skipIf(!settings.live)("state protocol steps (live)", () => {
  // The model is stochastic; a step passes if ANY attempt proposes the expected family.
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
