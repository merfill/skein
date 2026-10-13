import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadSettings } from "../../src/config/settings";
import type { Context } from "../../src/ir/project";
import { createChatModel } from "../../src/llm/client";
import { propose } from "../../src/loop/propose";

// A live check of the fix-ocaml-gc shape without running the whole task: replay saved
// projections from decision points of a real `fix-ocaml-gc` run
// (`bench/runs/sandbox-tasks/2026-10-13T11-51-44-681Z-fix-ocaml-gc`) through the live model
// with the current prompt and the current surface (`propose`). It verifies two behaviours of
// the projection, not the OCaml fix itself:
//   * a proposed run must not merge stdout and stderr (`2>&1`);
//   * after a command failed for a missing project path, the revised command must resolve the
//     project directory (`ocaml/`), not repeat the bare workspace-root path.
// See docs/system_prompt.md and docs/projection.md. Run deliberately:
//   SKEIN_LIVE=true npx vitest run tests/live/fix_ocaml_step.test.ts

interface Step {
  name: string;
  what: string;
  // The step's failed check is a missing path: a proposed objective command must resolve
  // the project directory (not repeat the bare workspace-root command).
  cwdReaction?: boolean;
  context: Context;
}

interface Fixture {
  instruction: string;
  steps: Step[];
}

const settings = loadSettings();
const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "fixtures", "live", "fix-ocaml-gc-steps.json"), "utf8"),
) as Fixture;

function withInstruction(context: Context): Context {
  const history = context.history.map((message, index) =>
    index === 0 && message.role === "user" ? { ...message, text: fixture.instruction } : message,
  );
  return { ...context, history };
}

describe.skipIf(!settings.live)("fix-ocaml-gc step (live)", () => {
  for (const step of fixture.steps) {
    it(`${step.name}: reacts to the error without merging streams`, async () => {
      const model = createChatModel(settings);
      const proposal = await propose(model, withInstruction(step.context));
      console.info(`[${step.name}] ${JSON.stringify(proposal.actions[0]!).slice(0, 400)}`);

      const action = proposal.actions[0]!;
      if (action.operator !== "apply") return;

      // The bash tool captures stdout and stderr SEPARATELY. If a run merges them into a
      // pipe, it must still surface the left side's exit code (the failure this guard exists
      // for): `pipefail`, `PIPESTATUS`, or an explicit `echo $?`.
      const command = action.action.tool === "bash" ? (action.action.command ?? "") : "";
      if (/2>&1/.test(command)) {
        expect(command, "a merged run must not hide the exit code").toMatch(
          /pipefail|\bPIPESTATUS\b|echo\s+[^;&|]*\$\?/,
        );
      }

      if (step.cwdReaction === true) {
        const target =
          action.action.tool === "bash"
            ? (action.action.command ?? "")
            : "path" in action.action
              ? (action.action.path ?? "")
              : "";
        expect(target, "the move must resolve the project directory (ocaml/)").toMatch(/ocaml/);
      }
    });
  }
});
