import { describe, expect, it } from "vitest";

import type { Event } from "../src/ir/events";
import { createSession, openUnit } from "../src/session/session";
import {
  bodyText,
  searchUnit,
  stateDetail,
  stateTurnHistory,
} from "../src/session/session_memory";

function journal(): Event[] {
  let seq = 0;
  const add = (id: string, kind: "request" | "move" | "plan" | "item" | "action" | "observation", label: string, payload?: unknown): Event => ({
    type: "add_node",
    node: { id, space: "work", kind, label, ...(payload !== undefined ? { payload } : {}), seq: seq++ },
  });
  const edge = (id: string, from: string, to: string, kind: "move" | "plan" | "items" | "alts" | "result"): Event => ({
    type: "add_edge",
    edge: { id, from, to, kind, provenance: { kind: "llm" } },
  });
  return [
    add("req", "request", "fix the parser"),
    add("m1", "move", "patch", { state: "patch", what: "fix it", turn: 1 }),
    edge("e:m1", "req", "m1", "move"),
    add("p1", "plan", "plan"),
    edge("e:p1", "m1", "p1", "plan"),
    add("i1", "item", "edit parser.c"),
    edge("e:i1", "p1", "i1", "items"),
    add("a1", "action", "edit parser.c", { command: "edit", reasoning: "the tokenizer drops the last token" }),
    edge("e:a1", "i1", "a1", "alts"),
    add("o1", "observation", "edited", {
      output: "line one\nneedle is here\nline three",
      exitCode: 0,
    }),
    edge("e:o1", "a1", "o1", "result"),
  ];
}

function ready() {
  const session = createSession();
  openUnit(session, "r1", "task", journal());
  return session;
}

describe("session memory: L2, turns, body, search", () => {
  it("shows a state's plan with the result id and alternatives", () => {
    const detail = stateDetail(ready(), "r1", "m1");
    expect(detail).toContain("state m1: patch");
    expect(detail).toContain('what: fix it');
    expect(detail).toContain("closure: open");
    expect(detail).toContain("- i1: edit parser.c [succeeded] -> o1: exit 0 (alternatives: 1)");
  });

  it("shows the turns with the task agent's reasoning", () => {
    const turns = stateTurnHistory(ready(), "r1", "m1");
    expect(turns).toContain("- edit parser.c: edit parser.c [succeeded] -> o1: exit 0");
    expect(turns).toContain("reasoning: the tokenizer drops the last token");
  });

  it("reads an observation body by id and by window", () => {
    const session = ready();
    expect(bodyText(session, "r1", "o1")).toContain("needle is here");
    expect(bodyText(session, "r1", "a1")).toContain("needle is here");
    const window = bodyText(session, "r1", "o1", { start: 3, end: 3 });
    expect(window).toContain("needle is here");
    expect(window).not.toContain("line one");
    expect(window).toContain("continue from 4");
    expect(bodyText(session, "r1", "req")).toContain("request, not an observation");
  });

  it("searches a unit's observations and returns the id and line", () => {
    const result = searchUnit(ready(), "r1", "needle");
    expect(result).toContain("[o1] line 3:");
    expect(result).toContain("needle is here");
    expect(searchUnit(ready(), "r1", "absent")).toBe("no matches");
  });
});
