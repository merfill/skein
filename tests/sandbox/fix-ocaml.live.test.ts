import { afterEach, describe, expect, it } from "vitest";

import { loadSettings } from "../../src/config/settings";
import type { Context } from "../../src/ir/project";
import { createChatModel } from "../../src/llm/client";
import type { Proposal } from "../../src/llm/schemas";
import { invokeTools } from "../../src/llm/structured";
import { buildMessages, promptText } from "../../src/loop/propose";
import { runSandbox } from "./run";
import { BUG, FIX_OCAML_REQUEST, fixOcamlGc } from "./specs/fix-ocaml-gc";
import { cleanupSandboxes } from "./workspace";

afterEach(cleanupSandboxes);

// The same sandbox as fix-ocaml.test.ts, but with the LIVE model as the proposer: no
// Docker, a virtual workspace, and the real engine. It exercises the model-driven side
// (does it finish and stop, instead of looping) and is cheap because the "world" is tiny.
//   SKEIN_LIVE=true npx vitest run tests/sandbox/fix-ocaml.live.test.ts

const settings = loadSettings();

describe.skipIf(!settings.live)("fix-ocaml-gc sandbox (live model)", () => {
  it(
    "works the task and stops (finishes the goal / ends the request)",
    async () => {
      const model = createChatModel(settings);
      const rebuild = (maxTokens: number) => createChatModel({ ...settings, maxTokens });
      const trajectory: { turn: number; action: string; chars: number }[] = [];

      const propose = async (context: Context): Promise<Proposal> => {
        const proposal = await invokeTools(model, buildMessages(context), { settings, rebuild });
        const a = proposal.action;
        const label =
          a.operator === "apply" ? `apply:${a.action.tool}` : a.operator;
        trajectory.push({ turn: trajectory.length, action: label, chars: promptText(context).length });
        console.info(
          `[sandbox-live] t${trajectory.length - 1} ${label} chars=${trajectory[trajectory.length - 1]?.chars} thought="${proposal.thought.slice(0, 90)}"`,
        );
        return proposal;
      };

      const { result, workspace } = await runSandbox(fixOcamlGc, FIX_OCAML_REQUEST, propose, {
        maxTurns: 24,
      });

      const refusals = result.events
        .filter((event) => event.type === "record_rejection")
        .map((event) => (event as { reason?: string }).reason ?? "");
      const actions = trajectory.map((entry) => entry.action).join(",");
      const fixed = !(workspace.read("ocaml/runtime/shared_heap.c") ?? "").includes(BUG);
      console.info(
        `[sandbox-live] done=${result.done} stop=${result.stopReason} turns=${result.turns} fixed=${fixed} refusals=${refusals.length} actions=[${actions}]`,
      );

      // The engine invariant under test: the run terminates on the doxa's move, not by
      // burning the budget on refused `stop` (bench_report.md §4.4.2).
      expect(result.done).toBe(true);
      expect(result.stopReason).not.toBe("max_turns");
      // `fixed` is a model-quality signal, not an engine invariant: logged for the run.
      expect(refusals.filter((reason) => reason.startsWith("not_addressed"))).toHaveLength(0);
    },
    300_000,
  );
});
