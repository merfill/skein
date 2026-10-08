import { afterEach, describe, expect, it } from "vitest";

import type { Event } from "../../src/ir/events";
import { fold, hasStopped, predicateOf } from "../../src/ir/graph";
import type { Context } from "../../src/ir/project";
import { stateOf } from "../../src/ir/traversal";
import { runAgent } from "../../src/loop/graph";
import type { Action, Proposal } from "../../src/llm/schemas";
import { executeAction } from "../../src/tools";
import {
  DEFAULT_FILES,
  check,
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

// A request whose chosen interpretation is achieved: the request is `addressed`.
function addressedRequest(): Event[] {
  return [
    request(),
    {
      type: "add_node",
      node: {
        id: "g1",
        space: "work",
        kind: "goal",
        label: "approach",
        payload: { what: "approach", done_when: { kind: "objective", command: "true" } },
        seq: 1,
      },
    },
    { type: "add_node", node: { id: "alt", space: "work", kind: "alternatives", label: "opts", seq: 2 } },
    { type: "add_edge", edge: { id: "ea", from: "r1", to: "alt", kind: "has_alternatives", provenance: { kind: "llm" } } },
    { type: "add_edge", edge: { id: "ei", from: "alt", to: "g1", kind: "item", provenance: { kind: "llm" } } },
    { type: "add_edge", edge: { id: "ec", from: "alt", to: "g1", kind: "chosen", provenance: { kind: "llm" } } },
    { type: "record_check", id: "chk:9", command: "true", verdict: "pass", output: "", targets: ["g1"] },
  ];
}

describe("stop", () => {
  it("OP-ST-1 records a stop node and ends the run when the request is addressed", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const events = addressedRequest();
    const state = fold(events);
    expect(predicateOf(state, "r1")).toBe("addressed");
    expect(classification({ operator: "stop", why: "done" }, events)).toEqual({
      accept: true,
    });

    const outcome = executeAction({ operator: "stop", why: "done" }, state, ws, 0);
    expect(outcome.done).toBe(true);
    expect(outcome.stopReason).toBe("request_addressed");
    const after = fold(outcome.events, state);
    expect([...after.nodes.values()].some((node) => node.kind === "stop")).toBe(true);
    // The stop node stores no status: `addressed` stays derived, the request unclosed.
    expect(predicateOf(after, "r1")).toBe("addressed");
  });

  it("REF-ST-STATE refuses stop while the request is not addressed (OP-ST-1)", () => {
    const verdict = classification({ operator: "stop" }, [request()]);
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toContain("not_addressed");
  });

  it("REF-ADDRESSED refuses create_goal and apply at an addressed request", () => {
    const events = addressedRequest();
    const created = classification(
      {
        operator: "create_goal",
        what: "another approach",
        done_when: { kind: "arbiter", text: "x" },
        plan: "another: a sketch",
        step: { command: "true" },
      },
      events,
    );
    expect(created.accept).toBe(false);
    expect(created.reason).toContain("addressed");
    const applied = classification(
      { operator: "apply", action: { tool: "run", command: "true" } },
      events,
    );
    expect(applied.accept).toBe(false);
    expect(applied.reason).toContain("addressed");
  });

  it("OP-ST-2 finishes an arbiter goal with stop via a has_stopped edge (not achieved)", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { events, state } = exec(interpretation("fix it"), [request()], ws, 0);
    const goal = [...state.nodes.values()].find((node) => node.kind === "goal");
    expect(goal).toBeDefined();
    expect(classification({ operator: "stop", why: "done" }, events).accept).toBe(true);

    const outcome = executeAction({ operator: "stop", why: "done" }, state, ws, 1);
    // Finishing a goal does not end the run: the engine returns to the parent.
    expect(outcome.done).toBe(false);
    const after = fold(outcome.events, state);
    const id = (goal as { id: string }).id;
    expect(hasStopped(after, id)).toBe(true);
    expect(stateOf(after, id)).toBe("stopped");
    // Control, not truth: the criterion is untouched.
    expect(predicateOf(after, id)).toBe("open");
  });

  it("OP-ST-3 accepts stop at a request whose interpretation has stopped", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const events: Event[] = [
      request(),
      {
        type: "add_node",
        node: {
          id: "g1",
          space: "work",
          kind: "goal",
          label: "approach",
          payload: { what: "approach", done_when: { kind: "arbiter", text: "accepted" } },
          seq: 1,
        },
      },
      { type: "add_node", node: { id: "alt", space: "work", kind: "alternatives", label: "opts", seq: 2 } },
      { type: "add_node", node: { id: "s1", space: "work", kind: "stop", label: "done", seq: 3 } },
      { type: "add_edge", edge: { id: "ea", from: "r1", to: "alt", kind: "has_alternatives", provenance: { kind: "llm" } } },
      { type: "add_edge", edge: { id: "ei", from: "alt", to: "g1", kind: "item", provenance: { kind: "llm" } } },
      { type: "add_edge", edge: { id: "ec", from: "alt", to: "g1", kind: "chosen", provenance: { kind: "llm" } } },
      { type: "add_edge", edge: { id: "es", from: "g1", to: "s1", kind: "has_stopped", provenance: { kind: "llm" } } },
    ];
    const state = fold(events);
    expect(hasStopped(state, "g1")).toBe(true);
    expect(classification({ operator: "stop" }, events).accept).toBe(true);

    const outcome = executeAction({ operator: "stop" }, state, ws, 0);
    expect(outcome.done).toBe(true);
    expect(outcome.stopReason).toBe("request_stopped");
  });

  it("REF-ST-CHECK refuses stop on an objective goal whose check has not run", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { events } = exec(interpretation("make true pass", "true", "true"), [request()], ws, 0);
    const verdict = classification({ operator: "stop" }, events);
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toContain("check_not_run");
  });

  it("OP-ST-1 the loop ends on the doxa's stop, not on a derived auto-stop", async () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    let index = 0;
    let goal: string | undefined;
    const propose = async (context: Context): Promise<Proposal> => {
      index += 1;
      if (index === 1) {
        return proposal(interpretation("make true pass", "true", "true"));
      }
      if (index === 2) {
        goal = context.path[1]?.id;
        return proposal(run("true"));
      }
      if (index === 3) {
        return proposal(check(goal as string));
      }
      if (index === 4) {
        return proposal({ operator: "stop", why: "the request is addressed" });
      }
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
    // The stop was the final accepted move (turn 4), not an engine auto-stop.
    expect(result.turns).toBe(4);
  });
});
