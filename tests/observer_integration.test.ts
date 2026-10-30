import { afterEach, describe, expect, it } from "vitest";

import { fold } from "../src/ir/graph";
import type { Proposals } from "../src/llm/schemas";
import { runAgent } from "../src/loop/graph";
import type { RequestObserver, ObserverTools } from "../src/session/observer";
import { cleanupWorkspaces, makeWorkspace, move, run } from "./ops/helpers";

afterEach(cleanupWorkspaces);

const tools: ObserverTools = {
  outline: () => "outline body",
  state: (_state, anchor) => `state ${anchor}`,
};

function loopingPropose() {
  let turn = 0;
  return async (): Promise<Proposals> => {
    turn += 1;
    return {
      thought: "",
      actions: [turn === 1 ? move("orientation", "look around") : run("echo a")],
    };
  };
}

describe("observer integration: progress", () => {
  it("applies a memo once and records the trigger and reaction", async () => {
    const workspace = makeWorkspace().ws;
    let calls = 0;
    const agent: RequestObserver = async () => {
      calls += 1;
      return calls === 1
        ? { decision: { kind: "memo", text: "same loop", evidence: ["r1"] } }
        : {};
    };
    const result = await runAgent(
      {
        propose: loopingPropose(),
        workspace,
        maxTurns: 6,
        observer: { agent, tools },
      },
      { request: { id: "r1", text: "green" } },
    );

    const nodes = [...fold(result.events).nodes.values()];
    expect(nodes.filter((node) => node.kind === "memo")).toHaveLength(1);
    const journal = result.session?.journal ?? [];
    expect(journal.filter((event) => event.type === "trigger").length).toBeGreaterThan(0);
    expect(journal.filter((event) => event.type === "reaction")).toHaveLength(1);
    const opened = journal.filter((event) => event.type === "open_unit").map((event) => event.unitType);
    expect(opened[0]).toBe("task");
    expect(opened.filter((type) => type === "observer").length).toBeGreaterThan(0);
    expect(result.stopReason).toBe("max_turns");
  });

  it("halts without writing a stop node", async () => {
    const workspace = makeWorkspace().ws;
    const agent: RequestObserver = async () => ({
      decision: { kind: "halt", reason: "cannot diagnose the loop" },
    });
    const result = await runAgent(
      {
        propose: loopingPropose(),
        workspace,
        maxTurns: 8,
        observer: { agent, tools },
      },
      { request: { id: "r1", text: "green" } },
    );

    expect(result.done).toBe(true);
    expect(result.stopReason).toBe("observer_halt");
    expect(result.stopText).toBe("cannot diagnose the loop");
    expect([...fold(result.events).nodes.values()].some((node) => node.kind === "stop")).toBe(false);
    expect(
      result.session?.journal.some(
        (event) =>
          event.type === "reaction" &&
          event.reaction.kind === "halt" &&
          event.reaction.reason === "cannot diagnose the loop",
      ),
    ).toBe(true);
  });
});
