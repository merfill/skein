import { afterEach, describe, expect, it } from "vitest";

import { fold, goalOf } from "../src/ir/graph";
import { ISLAND_IDS, ISLANDS, isIsland } from "../src/ir/islands";
import { islandOf, project } from "../src/ir/project";
import { ISLAND_INSTRUCTIONS } from "../src/loop/prompt";
import { buildMessages } from "../src/loop/propose";
import type { Action } from "../src/llm/schemas";
import { PROPOSAL_TOOLS, toProposal } from "../src/llm/tools";
import {
  cleanupWorkspaces,
  exec,
  interpretation,
  makeWorkspace,
  request,
} from "./ops/helpers";

afterEach(cleanupWorkspaces);

// The island vocabulary is single-sourced: the `create_goal` `state` enum, the base prompt's
// state graph and the per-island relief all derive from `src/ir/islands.ts`
// (docs/prompt_state_machine_concept.md).
describe("islands: the closed vocabulary", () => {
  it("is closed, complete and self-consistent", () => {
    expect(new Set(ISLAND_IDS).size).toBe(ISLAND_IDS.length);
    for (const id of ISLAND_IDS) {
      const island = ISLANDS[id];
      expect(island.id).toBe(id);
      expect(island.label).not.toBe("");
      expect(island.criterion).not.toBe("");
      expect(island.relief).not.toBe("");
      for (const next of island.next) expect(isIsland(next)).toBe(true);
    }
    expect(isIsland("atlantis")).toBe(false);
  });

  it("exposes the island enum as the create_goal `state` parameter", () => {
    const tool = PROPOSAL_TOOLS.find((entry) => entry.function.name === "create_goal");
    const props = (tool?.function.parameters.properties ?? {}) as Record<
      string,
      { enum?: unknown; anyOf?: unknown }
    >;
    expect(props.state?.enum).toEqual([...ISLAND_IDS]);
    // The seed is any tool: the nested `action` is a union.
    expect(props.action?.anyOf ?? props.action?.enum ?? props.action).toBeTruthy();
  });
});

describe("islands: the doxa authors the state at create_goal", () => {
  it("maps a create_goal call with a non-bash seed into the IR", () => {
    const proposal = toProposal(
      "create_goal",
      { what: "recon", state: "reconnaissance", action: { tool: "read", filePath: "a.txt" } },
      "",
    );
    expect(proposal.action).toEqual({
      operator: "create_goal",
      what: "recon",
      state: "reconnaissance",
      action: { tool: "read", path: "a.txt" },
    });
  });

  it("refuses an unknown island at parse (a structural error, not a gate)", () => {
    expect(() =>
      toProposal(
        "create_goal",
        { what: "x", state: "atlantis", action: { tool: "bash", command: "true" } },
        "",
      ),
    ).toThrow();
  });

  it("runs any seed tool as the goal's first item", () => {
    const { ws } = makeWorkspace({ "a.txt": "hello world\n" });
    const action: Action = {
      operator: "create_goal",
      what: "read a",
      state: "localization",
      action: { tool: "read", path: "a.txt" },
    };
    const res = exec(action, [request()], ws);
    const kinds = res.outcome.events
      .filter((event) => event.type === "add_node")
      .map((event) => (event as { node: { kind: string } }).node.kind);
    expect(kinds).toEqual(["goal", "plan", "item", "action", "file", "observation"]);
    const goal = goalOf(res.state, "r1") as string;
    expect((res.state.nodes.get(goal)?.payload as { state?: string }).state).toBe("localization");
    const observation = res.outcome.events.find(
      (event) => event.type === "add_node" && (event as { node: { kind: string } }).node.kind === "observation",
    );
    expect(JSON.stringify(observation)).toContain("hello world");
  });
});

describe("islands: the projection highlights the state", () => {
  it("projects the island and injects its relief into the system prefix", () => {
    const { ws } = makeWorkspace({ "a.txt": "x\n" });
    const res = exec(interpretation("recon", "true"), [request()], ws);
    const context = project(res.state);
    expect(context.situation).toBe("goal");
    expect(context.island).toBe("reconnaissance");
    expect(islandOf(res.state)).toBe("reconnaissance");
    const messages = buildMessages(context);
    expect(messages.some((message) => String(message.content) === ISLAND_INSTRUCTIONS.reconnaissance)).toBe(
      true,
    );
  });

  it("has no island on a fresh request", () => {
    const context = project(fold([request()]));
    expect(context.situation).toBe("request");
    expect(context.island).toBeUndefined();
  });
});
