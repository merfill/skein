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
    done_when: { kind: "objective", command: "make -C testsuite one DIR=tests/basic" },
    plan: "read the sweep code, fix it, then run the basic testsuite",
    step: { command: "grep -n RLE-SWEEP-BUG ocaml/runtime/shared_heap.c" },
  },
  FIX_EDIT,
  { operator: "apply", action: { tool: "run", target: "w:goal:2" } },
  { operator: "stop", why: "the testsuite passes" },
];

const arbiter: Action[] = [
  {
    operator: "create_goal",
    what: "fix the RLE sweep regression so the compiler bootstraps",
    done_when: { kind: "arbiter", text: "the OCaml fix is complete and accepted" },
    plan: "read the sweep code, fix it, then verify",
    step: { command: "grep -n RLE-SWEEP-BUG ocaml/runtime/shared_heap.c" },
  },
  FIX_EDIT,
];

describe("fix-ocaml-gc sandbox (engine, scripted proposer)", () => {
  it("settles an objective goal by its own check, then stops", async () => {
    const { result } = await runSandbox(fixOcamlGc, FIX_OCAML_REQUEST, scripted(objective), { maxTurns: 8 });
    expect(result.stopReason).toBe("request_addressed");
    expect(result.turns).toBe(4);
    expect(result.events.filter((event) => event.type === "record_check")).toHaveLength(1);
    expect(result.events.filter((event) => event.type === "record_rejection")).toHaveLength(0);
  });

  // The doxa`s `stop` finishes the goal frame (a `has_stopped` edge, not `achieved`);
  // the engine returns to the request, which then stops too. No arbiter is wired — the
  // external acceptance is post-hoc (the Harbor verifier). Before the fix this burned the
  // budget on 10 refused `stop`s and ended at `max_turns` (bench_report.md §4.4.2).
  it("finishes an arbiter goal by stop and hands over, without an arbiter", async () => {
    const { result } = await runSandbox(fixOcamlGc, FIX_OCAML_REQUEST, scripted(arbiter, { operator: "stop" }), {
      maxTurns: 12,
    });
    expect(result.stopReason).toBe("request_stopped");
    expect(result.turns).toBe(4);
    expect(result.events.filter((event) => event.type === "record_rejection")).toHaveLength(0);
  });

  // The invariant is untouched for objective goals: `stop` cannot settle them, the check
  // must run first (`check_not_run`).
  it("refuses stop on an objective goal whose check has not run", async () => {
    const { result } = await runSandbox(
      fixOcamlGc,
      FIX_OCAML_REQUEST,
      scripted([objective[0] as Action, { operator: "stop" }], { operator: "stop" }),
      { maxTurns: 4 },
    );
    const reasons = result.events
      .filter((event) => event.type === "record_rejection")
      .map((event) => (event as { reason?: string }).reason ?? "");
    expect(reasons.some((reason) => reason.startsWith("check_not_run"))).toBe(true);
    expect(result.stopReason).toBe("max_turns");
  });
});
