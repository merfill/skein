import { afterEach, describe, expect, it } from "vitest";

import { project } from "../src/ir/project";
import { transitionInstruction } from "../src/loop/prompt/blocks";
import { buildMessages } from "../src/loop/propose";
import type { Action } from "../src/llm/schemas";
import {
  DEFAULT_FILES,
  classification,
  cleanupWorkspaces,
  exec,
  execAll,
  makeWorkspace,
  move,
  request,
  withGoal,
} from "./ops/helpers";

afterEach(cleanupWorkspaces);

type Corrective = "research" | "patch";

const stop = (why: string): Action => ({ operator: "stop", why });

// A state with one plan item, then closed with `why`: the tape is left at its transition.
function finished(state: Corrective, why: string) {
  const { ws } = makeWorkspace(DEFAULT_FILES);
  const opened = execAll(withGoal("the object", "true", state), [request()], ws);
  const stopped = exec(stop(why), opened.events, ws);
  return { ws, events: stopped.events, context: project(stopped.state) };
}

const tail = (context: ReturnType<typeof project>): string =>
  String(buildMessages(context).at(-1)?.content);

// The corrective edges are a transition choice only: a state still open cannot use them, and
// the in-state conduct stays free of transition text (docs/states_ru.md §2.3-2.4, §4).
describe("routing: the corrective Patch ↔ Research edge", () => {
  it("a finished Patch offers Research only as a situation, not as a routine exit", () => {
    const { context } = finished("patch", "this is a situation, not a defect to locate");
    expect(context.situation).toBe("transition");
    expect(context.island).toBe("patch");

    const instruction = tail(context);
    expect(instruction).toContain("- Verification — the change is applied, and the edited lines read back.");
    expect(instruction).toContain(
      "- Research — the work turns out to be a situation, not a defect to locate and fix.",
    );
    expect(instruction).toContain("Choose exactly one next state:");
    expect(instruction).not.toContain("Recovery");
    expect(instruction).not.toContain("Orientation");
  });

  it("a finished Research offers End and Patch by their conditions", () => {
    const { context } = finished("research", "this is a code defect to locate");
    expect(context.situation).toBe("transition");
    expect(context.island).toBe("research");

    const instruction = tail(context);
    expect(instruction).toContain(
      "- End — the required result exists in its declared form and matches the material or the request.",
    );
    expect(instruction).toContain("- Patch — the work is a code defect not yet located or fixed.");
    expect(instruction).not.toContain("Verification");
    expect(instruction).not.toContain("Localization");
  });

  it("the engine accepts the corrective move and keeps the old state closed", () => {
    const { ws, events } = finished("research", "not a situation");
    const correction = move("patch", "the defect");
    expect(classification(correction, events).accept).toBe(true);

    const moved = exec(correction, events, ws);
    const next = project(moved.state);
    expect(next.situation).toBe("working");
    expect(next.island).toBe("patch");
    expect(next.history.some((m) => m.text === "Start state Research")).toBe(true);
    expect(next.history.some((m) => m.text.startsWith("Finish state Research"))).toBe(true);
    // The closed state's plan is elided; the new state has no plan yet.
    expect(next.history.filter((m) => m.role === "tool")).toHaveLength(0);
  });

  it("the correction works in the other direction too", () => {
    const { ws, events } = finished("patch", "the defect is not in this artifact");
    const correction = move("research", "the situation");
    expect(classification(correction, events).accept).toBe(true);

    const next = project(exec(correction, events, ws).state);
    expect(next.situation).toBe("working");
    expect(next.island).toBe("research");
    expect(next.history.some((m) => m.text.startsWith("Finish state Patch"))).toBe(true);
  });

  it("the edges are not an escape hatch while the state is still open", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = execAll(withGoal("the object", "true", "patch"), [request()], ws);
    expect(project(opened.state).situation).toBe("working");
    expect(classification(move("research", "the situation"), opened.events).accept).toBe(false);
    expect(tail(project(opened.state))).not.toContain("Choose Research");
  });

  it("the corrective text stays off the in-state conduct", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = execAll(withGoal("the object", "true", "patch"), [request()], ws);
    const stateText = project(opened.state)
      .history.map((message) => message.text)
      .join("\n");
    expect(stateText).not.toContain("Choose Research");
    expect(stateText).not.toContain("Choose Verification");
    expect(transitionInstruction("research")).toContain("a code defect not yet located or fixed");
  });
});

// Localization merged into Patch (2026-11-04): the cause and the change it implies are one
// loop, not a handoff, so a failed change is revised inside Patch and Verification returns to
// Patch. The island still renders for journals written before the merge.
describe("routing: Localization merged into Patch", () => {
  it("a finished Patch never offers Localization: the cause is revised in place", () => {
    const { context } = finished("patch", "the cause was wrong");
    const instruction = tail(context);
    expect(instruction).toContain("- Verification —");
    expect(instruction).not.toContain("- Localization —");
    expect(instruction).not.toContain("back in doubt");
  });

  it("a failed Verification returns to Patch, not to Localization", () => {
    expect(transitionInstruction("verification")).toContain("- Patch — the acceptance fails.");
    expect(transitionInstruction("verification")).not.toContain("Choose Localization");
  });

});
