import { describe, expect, it } from "vitest";

import type { Event } from "../src/ir/events";
import {
  appendUnitEvent,
  createSession,
  focusedUnit,
  observerDepth,
  openUnit,
  popUnit,
  pushUnit,
  recordReaction,
  recordTrigger,
  sessionFocus,
  setPending,
  takePending,
  unitOf,
} from "../src/session/session";

const requestEvent: Event = {
  type: "add_node",
  node: {
    id: "r1",
    space: "work",
    kind: "request",
    label: "task",
    seq: 0,
  },
};

describe("session: the append-only container", () => {
  it("starts empty", () => {
    const session = createSession();
    expect(session.journal).toEqual([]);
    expect(session.units.size).toBe(0);
    expect(session.stack).toEqual([]);
    expect(session.pending).toBeUndefined();
    expect(sessionFocus(session)).toBeUndefined();
    expect(focusedUnit(session)).toBeUndefined();
  });

  it("opens units without rewriting their journals", () => {
    const session = createSession();
    const unit = openUnit(session, "r1", "task", [requestEvent], 4);
    expect(unitOf(session, "r1")).toBe(unit);
    expect(unit.journal).toEqual([requestEvent]);
    expect(unit.turn).toBe(4);
    expect(session.journal).toEqual([
      { type: "open_unit", unitId: "r1", unitType: "task", turn: 4 },
    ]);
  });

  it("appends to a unit journal and keeps the session journal separate", () => {
    const session = createSession();
    openUnit(session, "r1", "task");
    appendUnitEvent(session, "r1", requestEvent);
    expect(unitOf(session, "r1").journal).toEqual([requestEvent]);
    expect(session.journal).toEqual([
      { type: "open_unit", unitId: "r1", unitType: "task", turn: 0 },
    ]);
  });

  it("makes focus the top of the stack", () => {
    const session = createSession();
    const task = openUnit(session, "r1", "task");
    pushUnit(session, "r1", 2);
    expect(sessionFocus(session)).toEqual({ unitId: "r1", turn: 2 });
    expect(focusedUnit(session)).toBe(task);
  });

  it("supports nested units and returns to the outer one", () => {
    const session = createSession();
    openUnit(session, "r1", "task");
    openUnit(session, "m1", "observer");
    pushUnit(session, "r1", 3);
    pushUnit(session, "m1", 1);
    expect(sessionFocus(session)?.unitId).toBe("m1");
    expect(popUnit(session)).toEqual({ unitId: "m1", turn: 1 });
    expect(sessionFocus(session)?.unitId).toBe("r1");
    expect(popUnit(session)).toEqual({ unitId: "r1", turn: 3 });
    expect(sessionFocus(session)).toBeUndefined();
  });

  it("does not append a pop event on an empty stack", () => {
    const session = createSession();
    expect(popUnit(session)).toBeUndefined();
    expect(session.journal).toEqual([]);
  });

  it("tracks the observer depth in the stack", () => {
    const session = createSession();
    openUnit(session, "r1", "task");
    pushUnit(session, "r1", 0);
    expect(observerDepth(session)).toBe(0);
    openUnit(session, "o1", "observer");
    pushUnit(session, "o1", 0);
    expect(observerDepth(session)).toBe(1);
    openUnit(session, "o2", "observer");
    pushUnit(session, "o2", 0);
    expect(observerDepth(session)).toBe(2);
    popUnit(session);
    expect(observerDepth(session)).toBe(1);
  });

  it("rejects a duplicate or unknown unit", () => {
    const session = createSession();
    openUnit(session, "r1", "task");
    expect(() => openUnit(session, "r1", "observer")).toThrow("unit already open: r1");
    expect(() => pushUnit(session, "missing", 0)).toThrow("unknown unit: missing");
    expect(() => unitOf(session, "missing")).toThrow("unknown unit: missing");
  });

  it("keeps at most one pending utterance and replaces it", () => {
    const session = createSession();
    setPending(session, "first");
    setPending(session, "second");
    expect(session.pending).toEqual({ text: "second" });
    expect(takePending(session)).toEqual({ text: "second" });
    expect(session.pending).toBeUndefined();
    expect(takePending(session)).toBeUndefined();
  });

  it("records triggers and reactions without touching unit journals", () => {
    const session = createSession();
    openUnit(session, "r1", "task");
    recordTrigger(session, "r1", 1, {
      id: "t1",
      kind: "budget",
      anchor: "m1",
      evidence: ["o1"],
      epoch: 1,
    });
    recordReaction(session, "r1", {
      kind: "hint",
      text: "reuse o1",
      evidence: ["o1"],
      state: "m1",
    });
    expect(session.journal).toEqual([
      { type: "open_unit", unitId: "r1", unitType: "task", turn: 0 },
      {
        type: "trigger",
        unitId: "r1",
        turn: 1,
        trigger: { id: "t1", kind: "budget", anchor: "m1", evidence: ["o1"], epoch: 1 },
      },
      {
        type: "reaction",
        unitId: "r1",
        reaction: { kind: "hint", text: "reuse o1", evidence: ["o1"], state: "m1" },
      },
    ]);
    expect(unitOf(session, "r1").journal).toEqual([]);
  });

  it("only appends to the session journal", () => {
    const session = createSession();
    openUnit(session, "r1", "task");
    const prefix = [...session.journal];
    pushUnit(session, "r1", 0);
    setPending(session, "next");
    takePending(session);
    popUnit(session);
    expect(session.journal.slice(0, prefix.length)).toEqual(prefix);
    expect(session.journal.length).toBe(prefix.length + 2);
  });
});
