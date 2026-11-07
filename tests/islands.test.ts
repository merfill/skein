import { afterEach, describe, expect, it } from "vitest";

import { fold } from "../src/ir/graph";
import { ISLAND_IDS, ISLANDS, LIVE_ISLAND_IDS, isIsland, stateDescription } from "../src/ir/islands";
import { islandOf, project } from "../src/ir/project";
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
// (docs/en/system_prompt.md).
describe("islands: the closed vocabulary", () => {
  it("is closed, complete and self-consistent", () => {
    expect(new Set(ISLAND_IDS).size).toBe(ISLAND_IDS.length);
    for (const id of ISLAND_IDS) {
      const island = ISLANDS[id];
      expect(island.id).toBe(id);
      expect(island.label).not.toBe("");
      expect(island.what).not.toBe("");
      for (const edge of island.next) {
        expect(isIsland(edge.to)).toBe(true);
        expect(edge.when).not.toBe("");
      }
    }
    expect(isIsland("atlantis")).toBe(false);
  });

  it("routes the epistemic and productive states", () => {
    const targets = (id: (typeof ISLAND_IDS)[number]): string[] =>
      ISLANDS[id].next.map((edge) => edge.to);
    expect(targets("research")).toEqual(["end", "patch"]);
    expect(targets("patch")).toEqual(["verification", "research"]);
    expect(targets("construction")).toEqual(expect.arrayContaining(["end", "research"]));
    expect(targets("verification")).toEqual(expect.arrayContaining(["end", "patch"]));
  });

  it("scopes the write-class to the productive states: the island delimits the apply surface", () => {
    const write = new Set(["edit", "write", "apply_patch"]);
    const productive = new Set(["research", "patch", "construction"]);
    for (const id of ISLAND_IDS) {
      const hasWrite = ISLANDS[id].applies.some((tool) => write.has(tool));
      expect(hasWrite).toBe(productive.has(id));
    }
    expect(ISLANDS.research.applies).toContain("write");
    expect(ISLANDS.research.applies).not.toContain("edit");
    expect(ISLANDS.construction.applies).toEqual(expect.arrayContaining(["edit", "write", "apply_patch"]));
    expect(ISLANDS.end.applies).toEqual([]);
  });

  it("renders each state's description (State + Done, no Now)", () => {
    for (const id of ISLAND_IDS) {
      const description = stateDescription(ISLANDS[id]);
      expect(description).toContain("State:");
      expect(description).not.toContain("Now:");
    }
  });

  it("exposes the island enum as the move `state` parameter", () => {
    const tool = PROPOSAL_TOOLS.find((entry) => entry.function.name === "move");
    const props = (tool?.function.parameters.properties ?? {}) as Record<
      string,
      { enum?: unknown }
    >;
    expect(props.state?.enum).toEqual([...LIVE_ISLAND_IDS]);
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
    const proposal = toProposal("move", { state: "patch", what: "map the repo" }, "");
    expect(proposal.action).toEqual({ operator: "move", state: "patch", what: "map the repo" });
  });

  it("refuses an unknown island at parse (a structural error, not a gate)", () => {
    expect(() => toProposal("move", { state: "atlantis" }, "")).toThrow();
  });

  it("runs any tool as the state's first turn", () => {
    const { ws } = makeWorkspace({ "a.txt": "hello world\n" });
    const res = execAll([move("patch", "read a"), read("a.txt")], [request()], ws);
    const kinds = res.outcome.events
      .filter((event) => event.type === "add_node")
      .map((event) => (event as { node: { kind: string } }).node.kind);
    expect(kinds).toEqual(["action", "turns", "file", "observation"]);
    const observation = res.outcome.events.find(
      (event) => event.type === "add_node" && (event as { node: { kind: string } }).node.kind === "observation",
    );
    expect(JSON.stringify(observation)).toContain("hello world");
  });
});

describe("islands: the projection highlights the state", () => {
  it("appends the state's goal as one user turn, not the state entry", () => {
    const { ws } = makeWorkspace({ "a.txt": "x\n" });
    const res = execAll(withGoal("recon", "true"), [request()], ws);
    const context = project(res.state);
    expect(context.situation).toBe("working");
    expect(context.island).toBe("patch");
    expect(islandOf(res.state)).toBe("patch");
    const start = context.history.find((m) => m.role === "system" && m.text.startsWith("Start state"))?.text ?? "";
    expect(start).toBe("Start state Patch");
    expect(context.history.some((m) => m.role === "system" && m.text === ISLANDS.patch.instruction)).toBe(false);
    const messages = buildMessages(context);
    const last = messages.at(-1);
    expect(last?.role).toBe("user");
    expect(String(last?.content)).toContain(
      `Goal: ${ISLANDS.patch.what}.`,
    );
    expect(String(last?.content)).toContain("Your earlier guess (may be wrong): recon");
    expect(String(last?.content)).toContain(`Done when: "${ISLANDS.patch.criterion.replace(/\.\s*$/, "")}".`);
    expect(String(last?.content)).toContain(`Plan:\n${ISLANDS.patch.instruction}`);
    expect(String(last?.content)).toContain(
      "The original user request is context for this state, not its goal.",
    );
  });

  it("has no island on a fresh request", () => {
    const context = project(fold([request()]));
    expect(context.situation).toBe("request");
    expect(context.island).toBeUndefined();
  });
});
