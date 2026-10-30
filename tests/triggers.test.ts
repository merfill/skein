import { describe, expect, it } from "vitest";

import {
  DEFAULT_BUDGET_TURNS,
  DEFAULT_GRACE_TURNS,
  DEFAULT_STATE_CYCLE_ENTRIES,
  DEFAULT_STATE_LONG_TURNS,
  loadSettings,
} from "../src/config/settings";
import { fold, type State } from "../src/ir/graph";
import type { Event } from "../src/ir/events";
import { createSession, openUnit, recordTrigger } from "../src/session/session";
import { detectTriggers } from "../src/session/triggers";

const request: Event = {
  type: "add_node",
  node: { id: "r1", space: "work", kind: "request", label: "task", seq: 0 },
};

function observation(id: string, label: string, seq: number): Event {
  return {
    type: "add_node",
    node: { id, space: "work", kind: "observation", label, seq },
  };
}

function moveTo(id: string, island: string, seq: number, turn: number): Event[] {
  return [
    {
      type: "add_node",
      node: {
        id,
        space: "work",
        kind: "move",
        label: island,
        payload: { state: island, what: island, turn },
        seq,
      },
    },
    {
      type: "add_edge",
      edge: {
        id: `e:${id}`,
        from: "r1",
        to: id,
        kind: "move",
        provenance: { kind: "llm" },
      },
    },
  ];
}

function stateWith(...events: Event[]): State {
  return fold([request, ...events]);
}

function readySession(): ReturnType<typeof createSession> {
  const session = createSession();
  openUnit(session, "r1", "task");
  return session;
}

describe("triggers: state cycle and long state", () => {
  it("fires state_cycle on the third entry into the same state", () => {
    const session = readySession();
    const state = stateWith(
      ...moveTo("m1", "orientation", 1, 1),
      ...moveTo("m2", "orientation", 2, 2),
      ...moveTo("m3", "orientation", 3, 3),
    );
    const triggers = detectTriggers({ state, session, unitId: "r1", turn: 3 });
    expect(triggers.map((trigger) => trigger.kind)).toEqual(["state_cycle"]);
    expect(triggers[0]?.anchor).toBe("m3");
  });

  it("does not fire state_cycle before the third entry or twice for the same move", () => {
    const session = readySession();
    const before = stateWith(
      ...moveTo("m1", "orientation", 1, 1),
      ...moveTo("m2", "orientation", 2, 2),
    );
    expect(detectTriggers({ state: before, session, unitId: "r1", turn: 2 })).toEqual([]);

    const third = stateWith(
      ...moveTo("m1", "orientation", 1, 1),
      ...moveTo("m2", "orientation", 2, 2),
      ...moveTo("m3", "orientation", 3, 3),
    );
    const [trigger] = detectTriggers({ state: third, session, unitId: "r1", turn: 3 });
    if (trigger === undefined) throw new Error("expected a trigger");
    recordTrigger(session, "r1", 3, trigger);
    expect(detectTriggers({ state: third, session, unitId: "r1", turn: 4 })).toEqual([]);
  });

  it("fires state_long when the current state exceeds the turn limit", () => {
    const session = readySession();
    const state = stateWith(...moveTo("m1", "orientation", 1, 1));
    expect(detectTriggers({ state, session, unitId: "r1", turn: 21 })).toEqual([]);
    const triggers = detectTriggers({ state, session, unitId: "r1", turn: 22 });
    expect(triggers.map((trigger) => trigger.kind)).toEqual(["state_long"]);
    expect(triggers[0]?.anchor).toBe("m1");
  });

  it("does not repeat state_long for the same state entry", () => {
    const session = readySession();
    const state = stateWith(...moveTo("m1", "orientation", 1, 1));
    const [trigger] = detectTriggers({ state, session, unitId: "r1", turn: 22 });
    if (trigger === undefined) throw new Error("expected a trigger");
    recordTrigger(session, "r1", 22, trigger);
    expect(detectTriggers({ state, session, unitId: "r1", turn: 23 })).toEqual([]);
  });
});

describe("triggers: budget", () => {
  it("fires only when the remaining budget is within K", () => {
    const session = readySession();
    const state = stateWith(...moveTo("m1", "orientation", 1, 1), observation("o1", "read", 2));
    const input = { state, session, unitId: "r1", turn: 8 };
    expect(detectTriggers({ ...input, turn: 6 }, { maxTurns: 10, budgetTurns: 3 })).toEqual([]);
    const triggers = detectTriggers(input, { maxTurns: 10, budgetTurns: 3 });
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({ kind: "budget", anchor: "m1", epoch: 1 });
    expect(triggers[0]?.evidence).toContain("o1");
  });

  it("does not fire at the hard limit or at a terminal state", () => {
    const session = readySession();
    const state = stateWith(...moveTo("m1", "orientation", 1, 1), observation("o1", "read", 2));
    expect(
      detectTriggers({ state, session, unitId: "r1", turn: 10 }, { maxTurns: 10, budgetTurns: 3 }),
    ).toEqual([]);
    expect(
      detectTriggers(
        { state, session, unitId: "r1", turn: 8, terminal: true },
        { maxTurns: 10, budgetTurns: 3 },
      ),
    ).toEqual([]);
  });

  it("fires only once for the unit", () => {
    const session = readySession();
    const state = stateWith(...moveTo("m1", "orientation", 1, 1), observation("o1", "read", 2));
    const input = { state, session, unitId: "r1", turn: 8 };
    const [trigger] = detectTriggers(input, { maxTurns: 10, budgetTurns: 3 });
    if (trigger === undefined) throw new Error("expected a trigger");
    recordTrigger(session, "r1", 8, trigger);
    expect(detectTriggers({ ...input, turn: 9 }, { maxTurns: 10, budgetTurns: 3 })).toEqual([]);
  });

  it("does not fire when the current state is closed", () => {
    const session = readySession();
    const state = stateWith(
      ...moveTo("m1", "orientation", 1, 1),
      {
        type: "add_node",
        node: { id: "s1", space: "work", kind: "stop", label: "done", seq: 2 },
      },
      {
        type: "add_edge",
        edge: {
          id: "e:s1",
          from: "m1",
          to: "s1",
          kind: "stop",
          provenance: { kind: "llm" },
        },
      },
    );
    expect(
      detectTriggers({ state, session, unitId: "r1", turn: 8 }, { maxTurns: 10 }),
    ).toEqual([]);
  });

  it("returns the same trigger for the same input", () => {
    const session = readySession();
    const state = stateWith(...moveTo("m1", "orientation", 1, 1), observation("o1", "read", 2));
    const input = { state, session, unitId: "r1", turn: 8 };
    expect(detectTriggers(input, { maxTurns: 10 })).toEqual(detectTriggers(input, { maxTurns: 10 }));
  });
});

describe("triggers: thresholds", () => {
  it("uses named defaults and reads environment overrides", () => {
    expect(DEFAULT_STATE_CYCLE_ENTRIES).toBe(3);
    expect(DEFAULT_STATE_LONG_TURNS).toBe(20);
    expect(DEFAULT_BUDGET_TURNS).toBe(3);
    expect(DEFAULT_GRACE_TURNS).toBe(5);
    const settings = loadSettings({
      SKEIN_STATE_CYCLE_ENTRIES: "4",
      SKEIN_STATE_LONG_TURNS: "30",
      SKEIN_BUDGET_TURNS: "2",
      SKEIN_GRACE_TURNS: "7",
    });
    expect(settings.stateCycleEntries).toBe(4);
    expect(settings.stateLongTurns).toBe(30);
    expect(settings.budgetTurns).toBe(2);
    expect(settings.graceTurns).toBe(7);
    expect(loadSettings({}).observer).toBe(true);
    expect(loadSettings({ SKEIN_OBSERVER: "false" }).observer).toBe(false);
  });
});
