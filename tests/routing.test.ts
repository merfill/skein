import { afterEach, describe, expect, it } from "vitest";

import { project } from "../src/ir/project";
import { transitionInstruction, turnInstruction } from "../src/loop/prompt/blocks";
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

type Corrective = "localization" | "research";

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
// the in-state conduct stays free of transition text (docs/states_ru.md §2.2-2.3, §4).
describe("routing: the corrective Localization ↔ Research edges", () => {
  it("a finished Localization offers Research only as a situation, not as a routine exit", () => {
    const { context } = finished("localization", "this is a situation, not a code defect");
    expect(context.situation).toBe("transition");
    expect(context.island).toBe("localization");

    const instruction = tail(context);
    expect(instruction).toContain("Choose Patch when the target is named and a cause is suspected.");
    expect(instruction).toContain(
      "Choose Research only when the work is a situation, not a code defect to locate.",
    );
    expect(instruction).toContain("Next states from Localization:");
    expect(instruction).toContain("- Research —");
    // Only the state's `next` targets are offered.
    expect(instruction).not.toContain("Recovery");
  });

  it("a finished Research offers Localization as a code-defect correction", () => {
    const { context } = finished("research", "this is a code defect to locate");
    expect(context.situation).toBe("transition");
    expect(context.island).toBe("research");

    const instruction = tail(context);
    expect(instruction).toContain("Choose Localization when the work is a code defect to locate.");
    expect(instruction).toContain("- Localization —");
    expect(instruction).not.toContain("Patch");
  });

  it("the engine accepts the corrective move and keeps the old state closed", () => {
    const { ws, events } = finished("localization", "not a code defect");
    const correction = move("research", "the situation");
    expect(classification(correction, events).accept).toBe(true);

    const moved = exec(correction, events, ws);
    const next = project(moved.state);
    expect(next.situation).toBe("plan");
    expect(next.island).toBe("research");
    expect(next.history.some((m) => m.text === "Start state Localization")).toBe(true);
    expect(next.history.some((m) => m.text.startsWith("Finish state Localization"))).toBe(true);
    // The closed state's plan is elided; the new state has no plan yet.
    expect(next.history.filter((m) => m.role === "tool")).toHaveLength(0);
  });

  it("the correction works in the other direction too", () => {
    const { ws, events } = finished("research", "a code defect to locate");
    const correction = move("localization", "the code defect");
    expect(classification(correction, events).accept).toBe(true);

    const next = project(exec(correction, events, ws).state);
    expect(next.situation).toBe("plan");
    expect(next.island).toBe("localization");
    expect(next.history.some((m) => m.text.startsWith("Finish state Research"))).toBe(true);
  });

  it("the edges are not an escape hatch while the state is still open", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = execAll(withGoal("the object", "true", "localization"), [request()], ws);
    expect(project(opened.state).situation).toBe("working");
    expect(classification(move("research", "the situation"), opened.events).accept).toBe(false);
    expect(tail(project(opened.state))).not.toContain("Choose Research");
  });

  it("the corrective text stays off the in-state conduct", () => {
    expect(turnInstruction("localization")).not.toContain("Choose Research");
    expect(turnInstruction("research")).not.toContain("Choose Localization");
    expect(transitionInstruction("localization")).toContain("not a code defect to locate");
    expect(transitionInstruction("research")).toContain("a code defect to locate");
  });
});
