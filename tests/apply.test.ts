import { afterEach, describe, expect, it } from "vitest";

import { project } from "../src/ir/project";
import { fold } from "../src/ir/graph";
import { currentMove } from "../src/ir/traversal";
import { applyReaction } from "../src/session/apply";
import { cleanupWorkspaces, exec, execAll, makeWorkspace, move, request, run } from "./ops/helpers";

afterEach(cleanupWorkspaces);

function openState() {
  const workspace = makeWorkspace();
  return execAll([move("orientation", "look around"), run("echo hi")], [request()], workspace.ws, 0);
}

describe("apply: hint and memo", () => {
  it("writes a state-scoped hint node", () => {
    const { state } = openState();
    const moveId = currentMove(state);
    if (moveId === undefined) throw new Error("expected a move");
    const result = applyReaction({
      state,
      sourceUnit: "m1",
      reaction: { kind: "hint", text: "reuse the read", evidence: [moveId], state: moveId },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events).toHaveLength(1);
    const event = result.events[0];
    expect(event?.type).toBe("add_node");
    if (event?.type !== "add_node") return;
    expect(event.node.kind).toBe("hint");
    expect(event.node.payload).toMatchObject({
      text: "reuse the read",
      evidence: [moveId],
      origin: "observer",
      scope: "state",
      state: moveId,
      sourceUnit: "m1",
    });
    expect(event.node.seq).toBe(state.seq + 1);
  });

  it("writes a unit-scoped memo node", () => {
    const { state } = openState();
    const result = applyReaction({
      state,
      sourceUnit: "m1",
      reaction: { kind: "memo", text: "keep the root in mind", evidence: [currentMove(state) ?? "r1"] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const event = result.events[0];
    expect(event?.type).toBe("add_node");
    if (event?.type !== "add_node") return;
    expect(event.node.kind).toBe("memo");
    expect(event.node.payload).toMatchObject({ origin: "observer", scope: "unit", sourceUnit: "m1" });
  });

  it("rejects missing evidence, unknown state and non-move state", () => {
    const { state } = openState();
    const moveId = currentMove(state);
    if (moveId === undefined) throw new Error("expected a move");
    expect(
      applyReaction({
        state,
        sourceUnit: "m1",
        reaction: { kind: "hint", text: "x", evidence: [], state: moveId },
      }),
    ).toEqual({ ok: false, reason: "evidence is required" });
    expect(
      applyReaction({
        state,
        sourceUnit: "m1",
        reaction: { kind: "hint", text: "x", evidence: ["missing"], state: moveId },
      }),
    ).toEqual({ ok: false, reason: "unknown evidence: missing" });
    expect(
      applyReaction({
        state,
        sourceUnit: "m1",
        reaction: { kind: "hint", text: "x", evidence: [moveId], state: "missing" },
      }),
    ).toEqual({ ok: false, reason: "unknown state: missing" });
    expect(
      applyReaction({
        state,
        sourceUnit: "m1",
        reaction: { kind: "hint", text: "x", evidence: [moveId], state: "r1" },
      }),
    ).toEqual({ ok: false, reason: "hint state is not a move: r1" });
  });

  it("rejects empty or overlong text and halt", () => {
    const { state } = openState();
    const moveId = currentMove(state);
    if (moveId === undefined) throw new Error("expected a move");
    expect(
      applyReaction({
        state,
        sourceUnit: "m1",
        reaction: { kind: "hint", text: "  ", evidence: [moveId], state: moveId },
      }),
    ).toEqual({ ok: false, reason: "empty advisory text" });
    expect(
      applyReaction({
        state,
        sourceUnit: "m1",
        reaction: { kind: "hint", text: "x".repeat(801), evidence: [moveId], state: moveId },
      }),
    ).toEqual({ ok: false, reason: "advisory text too long" });
    expect(
      applyReaction({
        state,
        sourceUnit: "m1",
        reaction: { kind: "halt", reason: "stop" },
      }),
    ).toEqual({ ok: false, reason: "halt is not a task event" });
  });
});

describe("projection: hint and memo", () => {
  it("renders an open state's hint and memo as system turns", () => {
    const { state, events } = openState();
    const moveId = currentMove(state);
    if (moveId === undefined) throw new Error("expected a move");
    const hint = applyReaction({
      state,
      sourceUnit: "m1",
      reaction: { kind: "hint", text: "reuse the read", evidence: [moveId], state: moveId },
    });
    const memo = applyReaction({
      state,
      sourceUnit: "m1",
      reaction: { kind: "memo", text: "keep the root in mind", evidence: [moveId] },
    });
    if (!hint.ok || !memo.ok) throw new Error("expected applied advisories");
    const context = project(fold([...events, ...hint.events, ...memo.events]));
    const advisories = context.history.filter(
      (message) => message.role === "system" && message.text.startsWith("Tape-agent"),
    );
    expect(advisories.map((message) => message.text)).toEqual([
      "Tape-agent hint: reuse the read (evidence: w:move:2)",
      "Tape-agent memo: keep the root in mind (evidence: w:move:2)",
    ]);
  });

  it("drops the hint after the state closes but keeps the memo", () => {
    const workspace = makeWorkspace();
    const opened = execAll([move("orientation", "look around"), run("echo hi")], [request()], workspace.ws, 0);
    const moveId = currentMove(opened.state);
    if (moveId === undefined) throw new Error("expected a move");
    const hint = applyReaction({
      state: opened.state,
      sourceUnit: "m1",
      reaction: { kind: "hint", text: "state hint", evidence: [moveId], state: moveId },
    });
    const memo = applyReaction({
      state: opened.state,
      sourceUnit: "m1",
      reaction: { kind: "memo", text: "unit memo", evidence: [moveId] },
    });
    if (!hint.ok || !memo.ok) throw new Error("expected applied advisories");
    const closed = exec(
      { operator: "stop", why: "done" },
      [...opened.events, ...hint.events, ...memo.events],
      workspace.ws,
      1,
    );
    const text = project(closed.state).history.map((message) => message.text).join("\n");
    expect(text).not.toContain("state hint");
    expect(text).toContain("unit memo");
  });
});
