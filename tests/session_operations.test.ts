import { describe, expect, it } from "vitest";

import type { Event } from "../src/ir/events";
import { applyOperation, validateOperation } from "../src/session/operations";
import {
  attentionOf,
  createSession,
  openUnit,
  pushUnit,
  sessionFocus,
} from "../src/session/session";

function request(id = "req", text = "task"): Event {
  return {
    type: "add_node",
    node: { id, space: "work", kind: "request", label: text, payload: { text }, seq: 0 },
  };
}

function move(id: string, island: string, seq: number): Event[] {
  return [
    {
      type: "add_node",
      node: {
        id,
        space: "work",
        kind: "move",
        label: island,
        payload: { state: island, what: "do it", turn: seq },
        seq,
      },
    },
    {
      type: "add_edge",
      edge: {
        id: `e:${id}`,
        from: "req",
        to: id,
        kind: "move",
        provenance: { kind: "llm" },
      },
    },
  ];
}

function stop(moveId: string, why: string, seq: number): Event[] {
  return [
    {
      type: "add_node",
      node: { id: `s:${moveId}`, space: "work", kind: "stop", label: why, seq },
    },
    {
      type: "add_edge",
      edge: {
        id: `es:${moveId}`,
        from: moveId,
        to: `s:${moveId}`,
        kind: "stop",
        provenance: { kind: "llm" },
      },
    },
  ];
}

function taskSession() {
  const session = createSession();
  openUnit(session, "r1", "task", [request(), ...move("m1", "patch", 1)]);
  openUnit(session, "session:1", "session");
  pushUnit(session, "r1", 0);
  return session;
}

describe("session operations: logos checks and applies", () => {
  it("answers without changing any unit or focus", () => {
    const session = taskSession();
    const before = session.journal.length;
    const result = applyOperation({
      session,
      operation: { kind: "respond", text: "hello" },
      turn: 3,
      sourceUnit: "session:1",
    });
    expect(result.ok).toBe(true);
    expect(sessionFocus(session)?.unitId).toBe("r1");
    expect(session.journal).toHaveLength(before + 1);
    expect(session.journal.at(-1)).toEqual({
      type: "operation",
      unitId: "session:1",
      turn: 3,
      operation: { kind: "respond", text: "hello" },
    });
  });

  it("starts a task: the old focus is popped, the text becomes pending", () => {
    const session = taskSession();
    const task = session.units.get("r1");
    const journalBefore = task?.journal.length ?? 0;
    const result = applyOperation({
      session,
      operation: { kind: "start", text: "fix the parser" },
      turn: 4,
      sourceUnit: "session:1",
    });
    expect(result.ok).toBe(true);
    expect(sessionFocus(session)).toBeUndefined();
    expect(session.pending).toEqual({ text: "fix the parser" });
    expect(attentionOf(session, "r1")).toBe("suspended");
    expect(task?.journal.length).toBe(journalBefore);
    expect(
      session.journal.some(
        (event) => event.type === "operation" && event.operation.kind === "start",
      ),
    ).toBe(true);
  });

  it("starts from a completed focus without changing its status", () => {
    const session = createSession();
    openUnit(session, "r1", "task", [
      request(),
      ...move("m1", "end", 1),
      ...stop("m1", "make check passed", 2),
    ]);
    openUnit(session, "session:1", "session");
    pushUnit(session, "r1", 0);
    const result = applyOperation({
      session,
      operation: { kind: "start", text: "start another task" },
      turn: 5,
      sourceUnit: "session:1",
    });
    expect(result.ok).toBe(true);
    expect(attentionOf(session, "r1")).toBe("completed");
    expect(session.pending).toEqual({ text: "start another task" });
  });

  it("starts from an empty session", () => {
    const session = createSession();
    openUnit(session, "session:1", "session");
    const result = applyOperation({
      session,
      operation: { kind: "start", text: "first task" },
      turn: 0,
      sourceUnit: "session:1",
    });
    expect(result.ok).toBe(true);
    expect(sessionFocus(session)).toBeUndefined();
    expect(session.pending).toEqual({ text: "first task" });
  });

  it("refuses empty text, long text and an unknown source", () => {
    const session = taskSession();
    const before = session.journal.length;
    expect(validateOperation(session, { kind: "respond", text: "  " })).toBe("empty text");
    expect(validateOperation(session, { kind: "respond", text: "x".repeat(4001) })).toBe(
      "text too long (max 4000)",
    );
    expect(validateOperation(session, { kind: "start", text: "x".repeat(4001) })).toBe(
      "text too long (max 4000)",
    );
    expect(
      applyOperation({
        session,
        operation: { kind: "respond", text: "hi" },
        turn: 0,
        sourceUnit: "missing",
      }),
    ).toEqual({ ok: false, reason: "unknown source unit: missing" });
    expect(session.journal).toHaveLength(before);
  });

  it("accepts a Markdown answer up to 4000 chars", () => {
    const session = taskSession();
    const answer = [
      "## Findings",
      "",
      "- `src/session/driver.ts`: opens a task unit.",
      "- `src/session/session.ts`: derives attention from journals.",
    ].join("\n");
    expect(validateOperation(session, { kind: "respond", text: answer })).toBeUndefined();
    expect(
      validateOperation(session, { kind: "respond", text: "x".repeat(4000) }),
    ).toBeUndefined();
  });
});
