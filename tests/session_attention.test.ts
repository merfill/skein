import { describe, expect, it } from "vitest";

import type { Event } from "../src/ir/events";
import { fold } from "../src/ir/graph";
import {
  abandonUnit,
  attentionOf,
  createSession,
  openUnit,
  popUnit,
  pushUnit,
  recordOperation,
  suspendUnit,
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

function closedTask(): Event[] {
  return [request(), ...move("m1", "end", 1), ...stop("m1", "make check passed", 2)];
}

describe("session attention: derived statuses", () => {
  it("marks the focus active and the deferred unit suspended", () => {
    const session = createSession();
    openUnit(session, "r1", "task");
    openUnit(session, "r2", "task");
    pushUnit(session, "r1", 0);
    pushUnit(session, "r2", 0);
    expect(attentionOf(session, "r2")).toBe("active");
    expect(attentionOf(session, "r1")).toBe("suspended");
  });

  it("marks a unit abandoned without closing its state", () => {
    const session = createSession();
    const task = openUnit(session, "r1", "task", [request(), ...move("m1", "patch", 1)]);
    pushUnit(session, "r1", 0);
    abandonUnit(session, "r1", 1);
    expect(attentionOf(session, "r1")).toBe("abandoned");
    expect(task.journal).toHaveLength(3);
    expect([...fold(task.journal).nodes.values()].some((node) => node.kind === "stop")).toBe(false);
  });

  it("derives completed from the terminal state's stop", () => {
    const session = createSession();
    openUnit(session, "r1", "task", closedTask());
    pushUnit(session, "r1", 0);
    expect(attentionOf(session, "r1")).toBe("completed");
  });

  it("derives completed from a declined request", () => {
    const session = createSession();
    openUnit(session, "r1", "task", [
      request(),
      {
        type: "add_node",
        node: { id: "u1", space: "work", kind: "unactionable", label: "not actionable", seq: 1 },
      },
      {
        type: "add_edge",
        edge: {
          id: "e:u1",
          from: "req",
          to: "u1",
          kind: "unactionable",
          provenance: { kind: "llm" },
        },
      },
    ]);
    expect(attentionOf(session, "r1")).toBe("completed");
  });

  it("lets abandoned win over a closure", () => {
    const session = createSession();
    openUnit(session, "r1", "task", closedTask());
    pushUnit(session, "r1", 0);
    abandonUnit(session, "r1", 1);
    expect(attentionOf(session, "r1")).toBe("abandoned");
  });

  it("completes a session unit once its operation is committed", () => {
    const session = createSession();
    openUnit(session, "session:1", "session");
    recordOperation(session, "session:1", 0, { kind: "respond", text: "hello" });
    expect(attentionOf(session, "session:1")).toBe("completed");
  });

  it("keeps waiting (suspended) after suspend without abandon", () => {
    const session = createSession();
    openUnit(session, "r1", "task", [request(), ...move("m1", "patch", 1)]);
    pushUnit(session, "r1", 0);
    suspendUnit(session, "r1", 1);
    popUnit(session);
    expect(attentionOf(session, "r1")).toBe("suspended");
  });

  it("only grows the session journal", () => {
    const session = createSession();
    openUnit(session, "r1", "task");
    const prefix = [...session.journal];
    pushUnit(session, "r1", 0);
    suspendUnit(session, "r1", 1);
    abandonUnit(session, "r1", 2);
    expect(session.journal.slice(0, prefix.length)).toEqual(prefix);
    expect(session.journal).toHaveLength(prefix.length + 3);
  });
});
