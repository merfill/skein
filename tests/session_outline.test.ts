import { describe, expect, it } from "vitest";

import type { Event } from "../src/ir/events";
import {
  attentionOf,
  createSession,
  openUnit,
  pushUnit,
  recordOperation,
  recordRefusal,
} from "../src/session/session";
import { sessionOutline, unitOutline } from "../src/session/session_outline";

function request(id = "req", text = "task"): Event {
  return {
    type: "add_node",
    node: { id, space: "work", kind: "request", label: text, payload: { text }, seq: 0 },
  };
}

function move(id: string, island: string, seq: number, what = "do it"): Event[] {
  return [
    {
      type: "add_node",
      node: {
        id,
        space: "work",
        kind: "move",
        label: island,
        payload: { state: island, what, turn: seq },
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

function closedTask(label = "fix pool_sweep"): Event[] {
  return [
    request("req", label),
    ...move("m1", "end", 1, "finish"),
    ...stop("m1", "make check passed", 2),
  ];
}

function ready() {
  const session = createSession();
  openUnit(session, "r1", "task", closedTask());
  openUnit(session, "r2", "task", [request("req", "read AGENTS.md"), ...move("m1", "patch", 1)]);
  return session;
}

describe("session outline: L0 and L1", () => {
  it("lists units with their status and how they ended", () => {
    const session = ready();
    const outline = sessionOutline(session);
    expect(outline).toContain('1. task r1 "fix pool_sweep" completed; end: "make check passed"');
    expect(outline).toContain('2. task r2 "read AGENTS.md" suspended; open at patch');
  });

  it("shows the session unit's answer and reformulation in the trace", () => {
    const session = createSession();
    openUnit(session, "m1", "session", [request("req", "hello")]);
    recordOperation(session, "m1", 1, { kind: "respond", text: "hi" });
    openUnit(session, "m2", "session", [request("req", "now do X")]);
    recordOperation(session, "m2", 2, { kind: "start", text: "do X with the earlier context" });
    const outline = sessionOutline(session);
    expect(outline).toContain('1. session m1 "hello" completed; respond: "hi"');
    expect(outline).toContain(
      '2. session m2 "now do X" completed; start: "do X with the earlier context"',
    );
  });

  it("renders a refused decision with its reasoning", () => {
    const session = createSession();
    openUnit(session, "m1", "session", [request("req", "apply the rule")]);
    recordRefusal(
      session,
      "m1",
      1,
      { kind: "start", text: "apply the rule to src/app.txt" },
      "text too long (max 4000)",
      "the model explained three alternatives",
    );
    expect(attentionOf(session, "m1")).toBe("completed");
    const outline = sessionOutline(session);
    expect(outline).toContain(
      'start: "apply the rule to src/app.txt" (refused: text too long (max 4000))',
    );
    expect(outline).toContain('reasoning: "the model explained three alternatives"');
  });

  it("is deterministic and skips observer journals", () => {
    const session = ready();
    openUnit(session, "observer:1", "observer", [request("req", "internal")]);
    expect(sessionOutline(session)).toBe(sessionOutline(session));
    expect(sessionOutline(session)).not.toContain("observer:1");
    expect(sessionOutline(session)).not.toContain("internal");
  });

  it("truncates L0 explicitly with a cursor", () => {
    const session = createSession();
    for (let index = 1; index <= 4; index += 1) {
      openUnit(session, `u${index}`, "task", [request("req", `task ${index}`)]);
    }
    pushUnit(session, "u4", 0);
    const outline = sessionOutline(session, { limit: 2 });
    expect(outline.split("\n")[0]).toBe("... 2 more (before u3)");
    expect(outline).toContain('3. task u3 "task 3"');
    expect(outline).toContain('4. task u4 "task 4" active; open');
  });

  it("shows the focus even when it is outside the last window", () => {
    const session = createSession();
    for (let index = 1; index <= 4; index += 1) {
      openUnit(session, `u${index}`, "task", [request("req", `task ${index}`)]);
    }
    pushUnit(session, "u1", 0);
    const outline = sessionOutline(session, { limit: 2 });
    expect(outline).toContain('1. task u1 "task 1" active; open');
    expect(outline.split("\n")[0]).toBe("... 1 more (before u3)");
  });

  it("outlines one unit's states and closure", () => {
    const session = ready();
    const outline = unitOutline(session, "r1");
    expect(outline).toContain("unit r1 (task) status: completed");
    expect(outline).toContain("request: fix pool_sweep");
    expect(outline).toContain('m1 end what="finish" closed: make check passed');
  });

  it("truncates L1 explicitly with a cursor", () => {
    const session = createSession();
    openUnit(session, "r1", "task", [
      request(),
      ...move("m1", "orientation", 1),
      ...move("m2", "localization", 2),
      ...move("m3", "patch", 3),
    ]);
    const outline = unitOutline(session, "r1", { limit: 2 });
    expect(outline).toContain("... 1 more (before m2)");
    expect(outline).not.toContain("m1 orientation");
    expect(outline).toContain("m2 localization");
    expect(outline).toContain("m3 patch");
  });
});
