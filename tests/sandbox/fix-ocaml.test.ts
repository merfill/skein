import { afterEach, describe, expect, it } from "vitest";

import type { Action } from "../../src/llm/schemas";
import { runSandbox, scripted } from "./run";
import { FIX_EDIT, FIX_OCAML_REQUEST, fixOcamlGc } from "./specs/fix-ocaml-gc";
import { cleanupSandboxes } from "./workspace";

afterEach(cleanupSandboxes);

// Deterministic engine tests over a virtual workspace — no model, no Docker
// (docs/testing_ru.md §3). The trajectory is a scripted `Action` sequence, so a failure
// points at the engine (classify / refusal / termination), not at the model's wording.

const toWork: Action = { operator: "move", state: "patch", what: "fix the RLE sweep regression so the compiler bootstraps", done: "the fix is in" };
const goal: Action = {
  operator: "apply",
  action: { tool: "bash", command: "grep -n RLE-SWEEP-BUG ocaml/runtime/shared_heap.c" },
};
const stopState: Action = { operator: "stop", why: "the state is done" };
// Patch makes the change; Verification checks it. The request starts directly in Patch
// (there is no orientation pass).
const toVerification: Action = {
  operator: "move",
  state: "verification",
  what: "check the RLE-sweep fix",
};
const toResearch: Action = {
  operator: "move",
  state: "research",
  what: "inspect the RLE sweep",
};
const toEnd: Action = { operator: "move", state: "end", what: "" };
const stopRequest: Action = { operator: "stop", why: "the goal is done" };

const objective: Action[] = [
  toWork,
  goal,
  FIX_EDIT,
  { operator: "apply", action: { tool: "bash", command: "make -C testsuite one DIR=tests/basic" } },
  stopState,
  toVerification,
  stopState,
  toEnd,
  stopRequest,
];

describe("fix-ocaml-gc sandbox (engine, scripted proposer)", () => {
  it("carries the plan through edit and a run, then stops the state and the request", async () => {
    const { result } = await runSandbox(fixOcamlGc, FIX_OCAML_REQUEST, scripted(objective), { maxTurns: 10 });
    // `stop` closes the state; a `move` to the terminal state and a `stop` there end the
    // request (there is no criterion gate).
    expect(result.stopReason).toBe("request_addressed");
    expect(result.turns).toBe(9);
    expect(result.events.filter((event) => event.type === "record_rejection")).toHaveLength(0);
  });

  it("accepts stop on an open state (no criterion gate)", async () => {
    const { result } = await runSandbox(
      fixOcamlGc,
      FIX_OCAML_REQUEST,
      scripted([toResearch, goal, stopState, toEnd, stopRequest], stopRequest),
      { maxTurns: 6 },
    );
    expect(result.stopReason).toBe("request_addressed");
  });
});
