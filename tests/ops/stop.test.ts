import { afterEach, describe, expect, it } from "vitest";

import type { Context } from "../../src/ir/project";
import { childrenOf, fold, hasStopped, planOf } from "../../src/ir/graph";
import { currentMove } from "../../src/ir/traversal";
import { runAgent } from "../../src/loop/graph";
import type { Action, Proposals } from "../../src/llm/schemas";
import { executeAction } from "../../src/tools";
import {
  DEFAULT_FILES,
  classification,
  cleanupWorkspaces,
  execAll,
  makeWorkspace,
  request,
  withGoal,
} from "./helpers";

afterEach(cleanupWorkspaces);

function proposal(action: Action): Proposals {
  return { thought: "", actions: [action] };
}

describe("stop", () => {
  it("REF-ST-STATE refuses stop when the focus is not a state (the request)", () => {
    const verdict = classification({ operator: "stop" }, [request()]);
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toContain("not_addressed");
  });

  it("OP-ST-1 accepts stop on an open state (no criterion gate)", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { events } = execAll(withGoal("make true pass", "true"), [request()], ws);
    const verdict = classification({ operator: "stop" }, events);
    expect(verdict.accept).toBe(true);
  });

  it("OP-ST-2 records the closure on the state via a `stop` relation, not as a plan item", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = execAll(withGoal("make true pass", "true"), [request()], ws);
    const moveId = currentMove(opened.state)!;
    expect(classification({ operator: "stop", why: "done" }, opened.events).accept).toBe(true);

    const outcome = executeAction({ operator: "stop", why: "done" }, opened.state, ws, 1);
    // Finishing a state does not end the run here: the request ends when the terminal state
    // is stopped (the loop detects it).
    expect(outcome.done).toBe(false);
    const after = fold(outcome.events, opened.state);
    expect(hasStopped(after, moveId)).toBe(true);
    // The closure lives on the state (`stop` relation), not among the plan items.
    const plan = planOf(after, moveId)!;
    const items = childrenOf(after, plan);
    expect(items.every((id) => after.nodes.get(id)?.kind !== "stop")).toBe(true);
  });

  it("OP-ST-3 stop on the terminal state ends the request (request_addressed)", async () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    let index = 0;
    const propose = async (_context: Context): Promise<Proposals> => {
      index += 1;
      if (index === 1) return proposal({ operator: "move", state: "orientation", what: "map the repo", done: "mapped" });
      if (index === 2) return proposal({ operator: "apply", action: { tool: "bash", command: "true" } });
      if (index === 3) return proposal({ operator: "stop", why: "the state is done" });
      if (index === 4) return proposal({ operator: "move", state: "end", what: "" });
      if (index === 5) return proposal({ operator: "stop", why: "the request is done" });
      return proposal({ operator: "recall", id: "r1" });
    };
    const result = await runAgent(
      { propose, workspace: ws, maxTurns: 8 },
      { request: { id: "r1", text: "green" } },
    );

    expect(result.done).toBe(true);
    expect(result.stopReason).toBe("request_addressed");
    expect(
      result.events.some((event) => event.type === "add_node" && event.node.kind === "stop"),
    ).toBe(true);
    // The terminal state is a `move`; its stop hangs off the move (no goal there).
    const moves = [...fold(result.events).nodes.values()].filter((node) => node.kind === "move");
    expect(moves).toHaveLength(2);
  });
});
