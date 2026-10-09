import { afterEach, describe, expect, it } from "vitest";

import type { Context } from "../../src/ir/project";
import { childrenOf, fold, goalOf, hasStopped, planOf } from "../../src/ir/graph";
import { runAgent } from "../../src/loop/graph";
import type { Action, Proposal } from "../../src/llm/schemas";
import { executeAction } from "../../src/tools";
import {
  DEFAULT_FILES,
  classification,
  cleanupWorkspaces,
  exec,
  interpretation,
  makeWorkspace,
  request,
  run,
} from "./helpers";

afterEach(cleanupWorkspaces);

function proposal(action: Action): Proposal {
  return { thought: "", action };
}

describe("stop", () => {
  it("REF-ST-STATE refuses stop when the focus is not a goal (the request)", () => {
    const verdict = classification({ operator: "stop" }, [request()]);
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toContain("not_addressed");
  });

  it("OP-ST-1 accepts stop on an open goal (no criterion gate)", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { events } = exec(interpretation("make true pass", "true"), [request()], ws, 0);
    const verdict = classification({ operator: "stop" }, events);
    expect(verdict.accept).toBe(true);
  });

  it("OP-ST-2 appends the stop as the last plan item and records a has_stopped edge", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = exec(interpretation("make true pass", "true"), [request()], ws, 0);
    const goal = goalOf(opened.state, "r1")!;
    expect(classification({ operator: "stop", why: "done" }, opened.events).accept).toBe(true);

    const outcome = executeAction({ operator: "stop", why: "done" }, opened.state, ws, 1);
    // Finishing a goal does not end the run here: the request ends when its goal is
    // stopped (the loop detects it).
    expect(outcome.done).toBe(false);
    const after = fold(outcome.events, opened.state);
    expect(hasStopped(after, goal)).toBe(true);
    // The stop is the LAST item of the goal's plan.
    const items = childrenOf(after, planOf(after, goal)!);
    const last = after.nodes.get(items[items.length - 1]!);
    expect(last?.kind).toBe("stop");
  });

  it("OP-ST-3 the loop ends when the request's goal is stopped (request_addressed)", async () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    let index = 0;
    const propose = async (_context: Context): Promise<Proposal> => {
      index += 1;
      if (index === 1) return proposal(interpretation("make true pass", "true"));
      if (index === 2) return proposal(run("true"));
      if (index === 3) return proposal({ operator: "stop", why: "the goal is done" });
      return proposal({ operator: "query", id: "r1" });
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
  });
});
