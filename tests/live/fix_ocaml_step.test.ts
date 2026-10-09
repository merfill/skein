import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadSettings } from "../../src/config/settings";
import type { Context } from "../../src/ir/project";
import { createChatModel } from "../../src/llm/client";
import { invokeTools } from "../../src/llm/structured";
import { buildMessages } from "../../src/loop/propose";

// A live check of the fix-ocaml-gc shape without running the whole task: replay a saved
// projection from a step of the real run (`2026-10-04__22-38-56 / gkxcDTi`), adapted to
// the current projection, through the live model with the current prompt. It verifies the
// two behaviours this change is about, not the OCaml fix itself:
//   * the prompt keeps the model from merging stdout and stderr (`2>&1`);
//   * a visible `repeat_hypothesis` refusal stops the model from repeating the same what.
// See docs/tools.md §4.3 and docs/projection.md §3.1. Run deliberately:
//   SKEIN_LIVE=true npx vitest run tests/live/fix_ocaml_step.test.ts

interface Step {
  name: string;
  what: string;
  refusedWhat?: string;
  // The step's failed check is a missing path: a proposed objective command must resolve
  // the project directory (not repeat the bare command from the instruction).
  cwdReaction?: boolean;
  // The focus is a stage whose check was inconclusive, under an open objective
  // interpretation: a proposed check must target the focus, not the ancestor.
  focusCheck?: boolean;
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
  const path = context.path.map((node, index) =>
    index === 0 && node.kind === "request" ? { ...node, text: fixture.instruction } : node,
  );
  return { ...context, path };
}

describe.skipIf(!settings.live)("fix-ocaml-gc step (live)", () => {
  for (const step of fixture.steps) {
    it(`${step.name}: reacts to the error/refusal without merging streams`, async () => {
      const model = createChatModel(settings);
      const proposal = await invokeTools(model, buildMessages(withInstruction(step.context)));
      console.info(`[${step.name}] ${JSON.stringify(proposal.action).slice(0, 400)}`);

      if (proposal.action.operator === "apply" && proposal.action.action.tool === "run") {
        const command = proposal.action.action.command ?? "";
        expect(command, "a proposed run must not merge stdout and stderr").not.toMatch(/2>&1|&>/);
      }

      if (
        step.focusCheck === true &&
        proposal.action.operator === "apply" &&
        proposal.action.action.tool === "run" &&
        proposal.action.action.target !== undefined
      ) {
        const focus = step.context.path[step.context.path.length - 1]?.id;
        expect(
          proposal.action.action.target,
          "a check must target the node in focus (path[last]), never an ancestor interpretation",
        ).toBe(focus);
      }

      if (step.refusedWhat !== undefined && proposal.action.operator === "create_goal") {
        expect(
          proposal.action.what,
          "a visible repeat_hypothesis refusal must stop an exact repeat",
        ).not.toBe(step.refusedWhat);
      }

      if (
        step.cwdReaction === true &&
        proposal.action.operator === "create_goal"
      ) {
        const command = proposal.action.done_when;
        expect(
          command.trim(),
          "a revised command must not repeat the bare workspace-root command",
        ).not.toBe("make -C testsuite one DIR=tests/basic");
        expect(command, "it must resolve the project directory (ocaml/)").toMatch(/ocaml/);
      }
    });
  }
});
