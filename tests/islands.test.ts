import { afterEach, describe, expect, it } from "vitest";

import { fold } from "../src/ir/graph";
import { ISLAND_IDS, ISLANDS, isIsland } from "../src/ir/islands";
import { islandOf, project } from "../src/ir/project";
import { ISLAND_INSTRUCTIONS } from "../src/loop/prompt";
import { buildMessages } from "../src/loop/propose";
import { PROPOSAL_TOOLS, toProposal } from "../src/llm/tools";
import {
  cleanupWorkspaces,
  execAll,
  makeWorkspace,
  move,
  read,
  request,
  withGoal,
} from "./ops/helpers";

afterEach(cleanupWorkspaces);

// The island vocabulary is single-sourced: the `move` `state` enum, the base prompt's
// state graph and the per-island criteria all derive from `src/ir/islands.ts`
// (docs/prompt_state_machine_concept.md).
describe("islands: the closed vocabulary", () => {
  it("is closed, complete and self-consistent", () => {
    expect(new Set(ISLAND_IDS).size).toBe(ISLAND_IDS.length);
    for (const id of ISLAND_IDS) {
      const island = ISLANDS[id];
      expect(island.id).toBe(id);
      expect(island.label).not.toBe("");
      expect(island.what).not.toBe("");
      expect(island.criterion).not.toBe("");
      expect(island.relief).not.toBe("");
      for (const edge of island.next) {
        expect(isIsland(edge.to)).toBe(true);
        expect(edge.when).not.toBe("");
      }
    }
    expect(isIsland("atlantis")).toBe(false);
  });

  it("exposes the island enum as the move `state` parameter", () => {
    const tool = PROPOSAL_TOOLS.find((entry) => entry.function.name === "move");
    const props = (tool?.function.parameters.properties ?? {}) as Record<
      string,
      { enum?: unknown }
    >;
    expect(props.state?.enum).toEqual([...ISLAND_IDS]);
  });

  it("exposes the goal text as the move `what` parameter", () => {
    const tool = PROPOSAL_TOOLS.find((entry) => entry.function.name === "move");
    const props = (tool?.function.parameters.properties ?? {}) as Record<string, unknown>;
    expect(props.what).toBeTruthy();
    expect(props.state).toBeTruthy();
  });
});

describe("islands: the doxa authors the state at move", () => {
  it("maps a move call with its goal text into the IR", () => {
    const proposal = toProposal("move", { state: "reconnaissance", what: "map the repo" }, "");
    expect(proposal.action).toEqual({ operator: "move", state: "reconnaissance", what: "map the repo" });
  });

  it("refuses an unknown island at parse (a structural error, not a gate)", () => {
    expect(() => toProposal("move", { state: "atlantis" }, "")).toThrow();
  });

  it("runs any tool as the state's first plan item", () => {
    const { ws } = makeWorkspace({ "a.txt": "hello world\n" });
    const res = execAll([move("localization", "read a"), read("a.txt")], [request()], ws);
    const kinds = res.outcome.events
      .filter((event) => event.type === "add_node")
      .map((event) => (event as { node: { kind: string } }).node.kind);
    expect(kinds).toEqual(["action", "plan", "item", "file", "observation"]);
    const observation = res.outcome.events.find(
      (event) => event.type === "add_node" && (event as { node: { kind: string } }).node.kind === "observation",
    );
    expect(JSON.stringify(observation)).toContain("hello world");
  });
});

describe("islands: the projection highlights the state", () => {
  it("projects the island and injects its work into the system prefix", () => {
    const { ws } = makeWorkspace({ "a.txt": "x\n" });
    const res = execAll(withGoal("recon", "true"), [request()], ws);
    const context = project(res.state);
    expect(context.situation).toBe("working");
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
