import { afterEach, describe, expect, it } from "vitest";

import { currentMove } from "../src/ir/traversal";
import { createSession, openUnit } from "../src/session/session";
import {
  observationBody,
  outline,
  renderedState,
  stateAttempt,
  stateOutline,
  stateTurns,
} from "../src/session/outline";
import { detectTriggers } from "../src/session/triggers";
import { cleanupWorkspaces } from "./ops/helpers";
import { entryCycleScenario, longStateScenario } from "./sandbox/observer-fixtures";

afterEach(cleanupWorkspaces);

function sessionFor(unitId = "r1") {
  const session = createSession();
  openUnit(session, unitId, "task");
  return session;
}

describe("observer fixtures: entry cycle", () => {
  it("fires state_cycle on the third patch entry", () => {
    const scenario = entryCycleScenario();
    const triggers = detectTriggers(
      { state: scenario.state, session: sessionFor(), unitId: "r1", turn: scenario.turn },
      { maxTurns: 100 },
    );
    expect(triggers.map((trigger) => trigger.kind)).toEqual(["state_cycle"]);
    expect(scenario.state.stateEntries.get("patch")).toBe(3);
    const current = currentMove(scenario.state);
    if (current === undefined) throw new Error("expected a current state");
    expect(stateOutline(scenario.state, current, scenario.turn)).toContain("entries: 3");
    expect(stateOutline(scenario.state, current, scenario.turn)).toContain("turns: 0");
  });

  it("has a usable tape for the observer tools", () => {
    const scenario = entryCycleScenario();
    const state = scenario.state;
    const verification = [...state.nodes.values()].find(
      (node) => node.kind === "move" && node.payload !== undefined && (node.payload as { state?: string }).state === "verification",
    );
    if (verification === undefined) throw new Error("expected a verification state");
    expect(stateOutline(state, verification.id)).toContain("verification");
    expect(stateOutline(state, verification.id)).toContain("entries: 2");
    expect(stateTurns(state, verification.id)).toContain("echo verify");
    const item = [...state.nodes.values()].find((node) => node.kind === "item");
    if (item === undefined) throw new Error("expected an item");
    expect(stateAttempt(state, item.id)).toContain("[succeeded]");
    const observation = [...state.nodes.values()].find((node) => node.kind === "observation");
    if (observation === undefined) throw new Error("expected an observation");
    expect(observationBody(state, observation.id)).not.toBe("");
    expect(renderedState(state, verification.id, scenario.events)).toContain("Start state");
    expect(outline(state)).toContain("patch");
  });
});

describe("observer fixtures: long state", () => {
  it("fires state_long after more than 20 turns", () => {
    const scenario = longStateScenario();
    const triggers = detectTriggers(
      { state: scenario.state, session: sessionFor(), unitId: "r1", turn: scenario.turn },
      { maxTurns: 100 },
    );
    expect(triggers.map((trigger) => trigger.kind)).toEqual(["state_long"]);
    expect(scenario.turn).toBe(22);
  });

  it("has 21 turns and the current state for the observer", () => {
    const scenario = longStateScenario();
    const state = scenario.state;
    const move = [...state.nodes.values()].find((node) => node.kind === "move");
    if (move === undefined) throw new Error("expected a move");
    expect(stateTurns(state, move.id).split("\n")).toHaveLength(21);
    expect(outline(state)).toContain("items=21");
    expect(outline(state, scenario.turn)).toContain("entries=1 turns=21");
    expect(stateOutline(state, move.id, scenario.turn)).toContain("turns: 21");
    expect(renderedState(state, move.id, scenario.events)).toContain("echo 1");
  });
});
