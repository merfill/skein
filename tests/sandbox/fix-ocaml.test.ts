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
    done_when: "make -C testsuite one DIR=tests/basic",
    plan: "read the sweep code, fix it, then run the basic testsuite",
    step: { command: "grep -n RLE-SWEEP-BUG ocaml/runtime/shared_heap.c" },
  },
  FIX_EDIT,
  { operator: "apply", action: { tool: "run", target: "w:goal:2" } },
  { operator: "stop", why: "the goal is done" },
];

describe("fix-ocaml-gc sandbox (engine, scripted proposer)", () => {
  it("settles an objective goal by its own check, then stops the goal", async () => {
    const { result } = await runSandbox(fixOcamlGc, FIX_OCAML_REQUEST, scripted(objective), { maxTurns: 8 });
    // The goal's criterion passes on the check turn; `stop` then appends the goal's last
    // plan item and the run ends because the request's goal is stopped.
    expect(result.stopReason).toBe("request_addressed");
    expect(result.turns).toBe(4);
    expect(
      result.events.filter(
        (event) =>
          event.type === "add_node" &&
          event.node.kind === "observation" &&
          (event.node.payload as { target?: string } | undefined)?.target !== undefined,
      ),
    ).toHaveLength(1);
    expect(result.events.filter((event) => event.type === "record_rejection")).toHaveLength(0);
  });

  // For now only positive stops are accepted: `stop` on a goal whose criterion has not
  // passed is refused (`check_not_run`), and the run ends on the budget, not on a premature
  // stop (this is the `fix-ocaml-gc` defect from bench_report.md §4.4.2: it must be gone).
  it("refuses stop on a goal whose check has not run (check_not_run)", async () => {
    const { result } = await runSandbox(
      fixOcamlGc,
      FIX_OCAML_REQUEST,
      scripted([objective[0] as Action, { operator: "stop", why: "premature" }], {
        operator: "stop",
        why: "premature",
      }),
      { maxTurns: 4 },
    );
    const reasons = result.events
      .filter((event) => event.type === "record_rejection")
      .map((event) => (event as { reason?: string }).reason ?? "");
    expect(reasons.some((reason) => reason.startsWith("check_not_run"))).toBe(true);
    expect(result.stopReason).toBe("max_turns");
  });
});
