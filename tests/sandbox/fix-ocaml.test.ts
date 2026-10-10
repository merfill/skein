import { afterEach, describe, expect, it } from "vitest";

import type { Action } from "../../src/llm/schemas";
import { runSandbox, scripted } from "./run";
import { FIX_EDIT, FIX_OCAML_REQUEST, fixOcamlGc } from "./specs/fix-ocaml-gc";
import { cleanupSandboxes } from "./workspace";

afterEach(cleanupSandboxes);

// Deterministic engine tests over a virtual workspace — no model, no Docker
// (docs/testing_ru.md §3). The trajectory is a scripted `Action` sequence, so a failure
// points at the engine (classify / refusal / termination), not at the model's wording.

const objective: Action[] = [
  {
    operator: "create_goal",
    what: "fix the RLE sweep regression so the compiler bootstraps",
    command: "grep -n RLE-SWEEP-BUG ocaml/runtime/shared_heap.c",
  },
  FIX_EDIT,
  { operator: "apply", action: { tool: "run", command: "make -C testsuite one DIR=tests/basic" } },
  { operator: "stop", why: "the goal is done" },
];

describe("fix-ocaml-gc sandbox (engine, scripted proposer)", () => {
  it("carries the plan through edit and a run, then stops the goal", async () => {
    const { result } = await runSandbox(fixOcamlGc, FIX_OCAML_REQUEST, scripted(objective), { maxTurns: 8 });
    // `stop` appends the goal's last plan item and the run ends because the request's goal
    // is stopped (there is no criterion gate).
    expect(result.stopReason).toBe("request_addressed");
    expect(result.turns).toBe(4);
    expect(result.events.filter((event) => event.type === "record_rejection")).toHaveLength(0);
  });

  it("accepts stop on an open goal (no criterion gate)", async () => {
    const { result } = await runSandbox(
      fixOcamlGc,
      FIX_OCAML_REQUEST,
      scripted(
        [objective[0] as Action, { operator: "stop", why: "done" }],
        { operator: "stop", why: "done" },
      ),
      { maxTurns: 4 },
    );
    expect(result.stopReason).toBe("request_addressed");
  });
});
