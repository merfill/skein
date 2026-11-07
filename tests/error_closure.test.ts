import { afterEach, describe, expect, it } from "vitest";

import type { Context } from "../src/ir/project";
import { project } from "../src/ir/project";
import { fold } from "../src/ir/graph";
import type { Action, Proposals } from "../src/llm/schemas";
import { runAgent } from "../src/loop/graph";
import { cleanupWorkspaces, makeWorkspace } from "./ops/helpers";

afterEach(cleanupWorkspaces);

const move = (state: "research" | "patch" | "end", what = "work"): Action => ({
  operator: "move",
  state,
  what,
});
const stop = (why = "done"): Action => ({ operator: "stop", why });

function stops(state: ReturnType<typeof fold>) {
  return [...state.nodes.values()].filter((node) => node.kind === "stop");
}

describe("llm_error: the engine still closes and reports", () => {
  it("closes the open state, enters End and writes the report", async () => {
    const workspace = makeWorkspace().ws;
    const propose = async (context: Context): Promise<Proposals> => {
      if (context.situation === "request") return { thought: "", actions: [move("patch", "fix it")] };
      if (context.situation === "working") throw new Error("invalid tool call");
      if (context.situation === "terminal") {
        return { thought: "# Report\n\nThe run was interrupted.", actions: [] };
      }
      throw new Error(`unexpected situation ${context.situation}`);
    };

    const result = await runAgent({ propose, workspace }, { request: { id: "r1", text: "fix" } });
    expect(result.stopReason).toBe("llm_error");
    expect(result.stopText).toContain("invalid tool call");

    const state = fold(result.events);
    const history = project(state).history.map((message) => message.text);
    expect(history.some((text) => text.startsWith("Finish state Patch — llm_error: invalid tool call"))).toBe(true);
    expect(history).toContain("Start state End");
    expect(history.some((text) => text.startsWith("Finish state End — # Report"))).toBe(true);
    const all = stops(state);
    expect(all).toHaveLength(2);
    expect(all.every((node) => (node.payload as { error?: unknown }).error === true)).toBe(true);
  });

  it("does not add a second stop when the state was already closed", async () => {
    const workspace = makeWorkspace().ws;
    const propose = async (context: Context): Promise<Proposals> => {
      if (context.situation === "request") return { thought: "", actions: [move("patch", "fix it")] };
      if (context.situation === "working") return { thought: "fixed", actions: [stop("fixed")] };
      if (context.situation === "transition") throw new Error("transition failed");
      if (context.situation === "terminal") {
        return { thought: "The change was made before the call failed.", actions: [] };
      }
      throw new Error(`unexpected situation ${context.situation}`);
    };

    const result = await runAgent({ propose, workspace }, { request: { id: "r1", text: "fix" } });
    expect(result.stopReason).toBe("llm_error");
    const state = fold(result.events);
    const history = project(state).history.map((message) => message.text);
    expect(history).toContain("Finish state Patch — fixed");
    expect(history.filter((text) => text.startsWith("Finish state Patch")).length).toBe(1);
    expect(history.some((text) => text.startsWith("Finish state End — The change was made"))).toBe(true);
    expect(stops(state)).toHaveLength(2);
  });

  it("falls back to a tape report when the report call also fails", async () => {
    const workspace = makeWorkspace().ws;
    const propose = async (context: Context): Promise<Proposals> => {
      if (context.situation === "request") return { thought: "", actions: [move("patch", "fix it")] };
      throw new Error("provider unavailable");
    };

    const result = await runAgent({ propose, workspace }, { request: { id: "r1", text: "fix" } });
    expect(result.stopReason).toBe("llm_error");
    const state = fold(result.events);
    const history = project(state).history.map((message) => message.text);
    expect(history.some((text) => text.startsWith("Finish state Patch — llm_error: provider unavailable"))).toBe(true);
    const end = history.find((text) => text.startsWith("Finish state End — "));
    expect(end).toContain("interrupted by an error");
    expect(end).toContain("provider unavailable");
  });

  it("writes the fallback report when the error happened in End", async () => {
    const workspace = makeWorkspace().ws;
    const propose = async (context: Context): Promise<Proposals> => {
      if (context.situation === "request") return { thought: "", actions: [move("research", "solve")] };
      if (context.situation === "working") return { thought: "solved", actions: [stop("solved")] };
      if (context.situation === "transition") return { thought: "", actions: [move("end", "report")] };
      throw new Error("report provider unavailable");
    };

    const result = await runAgent({ propose, workspace }, { request: { id: "r1", text: "fix" } });
    expect(result.stopReason).toBe("llm_error");
    const state = fold(result.events);
    const history = project(state).history.map((message) => message.text);
    expect(history.some((text) => text.startsWith("Finish state End — "))).toBe(true);
    expect(history.some((text) => text.includes("report provider unavailable"))).toBe(true);
    expect(stops(state)).toHaveLength(2);
  });
});
