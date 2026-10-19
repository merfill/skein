import { describe, expect, it } from "vitest";

import { ENV_FACT_ID, environmentBrief, type EnvironmentFact } from "../src/ir/environment";
import type { Event } from "../src/ir/events";
import { fold } from "../src/ir/graph";
import { project } from "../src/ir/project";
import { parseProbe } from "../src/loop/probe";

const fact: EnvironmentFact = {
  root: "/app",
  found: [
    { name: "git", group: "vcs", path: "/usr/bin/git", version: "2.39.2" },
    { name: "make", group: "build", path: "/usr/bin/make", version: "4.3" },
    { name: "python3", group: "interpreters", path: "/usr/bin/python3", version: "3.11.5" },
    { name: "perl", group: "interpreters", path: "/usr/bin/perl", version: "5.38.2" },
    { name: "jq", group: "core", path: "/usr/bin/jq" },
    { name: "sqlite3", group: "data", path: "/usr/bin/sqlite3", version: "3.45.1" },
  ],
  missing: [
    { name: "python", group: "interpreters" },
    { name: "xxd", group: "core" },
    { name: "7z", group: "archive" },
  ],
};

function request(): Event {
  return {
    type: "add_node",
    node: { id: "r1", space: "work", kind: "request", label: "task", payload: { text: "task" }, seq: 0 },
  };
}

function factEvent(): Event {
  return {
    type: "add_node",
    node: { id: ENV_FACT_ID, space: "work", kind: "fact", label: "environment", payload: fact, seq: 1 },
  };
}

function move(state: "orientation" | "research"): Event[] {
  return [
    {
      type: "add_node",
      node: { id: "m1", space: "work", kind: "move", label: state, payload: { state, what: "" }, seq: 2 },
    },
    {
      type: "add_edge",
      edge: { id: "e1", from: "r1", to: "m1", kind: "move", provenance: { kind: "llm" } },
    },
  ];
}

describe("environment probe", () => {
  it("parses the tab-separated probe output", () => {
    const parsed = parseProbe(
      [
        "ROOT\t/app",
        "git\tvcs\t/usr/bin/git\tgit version 2.39.2",
        "python3\tinterpreters\t/usr/bin/python3\tPython 3.11.5",
        "xxd\tcore\t-\t",
      ].join("\n"),
    );
    expect(parsed.root).toBe("/app");
    expect(parsed.found.find((tool) => tool.name === "git")?.version).toBe("2.39.2");
    expect(parsed.found.find((tool) => tool.name === "python3")?.version).toBe("3.11.5");
    expect(parsed.missing.map((tool) => tool.name)).toContain("xxd");
  });

  it("selects different facts for Orientation and Research", () => {
    const orientation = environmentBrief(fact, "orientation");
    expect(orientation).toContain("root: `/app`");
    expect(orientation).toContain("vcs: `git 2.39.2`");
    expect(orientation).toContain("build: `make 4.3`");
    expect(orientation).toContain("interpreters:");
    expect(orientation).not.toContain("tools:");
    expect(orientation).not.toContain("sqlite3");

    const research = environmentBrief(fact, "research");
    expect(research).not.toContain("root:");
    expect(research).not.toContain("vcs:");
    expect(research).not.toContain("build:");
    expect(research).toContain("interpreters:");
    expect(research).toContain("tools:");
    expect(research).toContain("sqlite3");
    expect(research).toContain("missing:");
    expect(research).toContain("7z");
  });

  it("renders the brief as a user turn after the request", () => {
    const orientation = project(fold([request(), factEvent(), ...move("orientation")]));
    const userTurns = orientation.history.filter((message) => message.role === "user");
    expect(userTurns[0]?.text).toBe("task");
    expect(userTurns[1]?.text).toContain("**Environment**");
    expect(userTurns[1]?.text).toContain("root: `/app`");

    const research = project(fold([request(), factEvent(), ...move("research")]));
    const researchTurns = research.history.filter((message) => message.role === "user");
    expect(researchTurns[1]?.text).toContain("**Environment**");
    expect(researchTurns[1]?.text).toContain("tools:");
    expect(researchTurns[1]?.text).not.toContain("root:");
  });

  it("gives Recovery the root with the Research tool surface", () => {
    const recovery = environmentBrief(fact, "recovery");
    expect(recovery).toContain("root: `/app`");
    expect(recovery).toContain("interpreters:");
    expect(recovery).toContain("tools:");
    expect(recovery).not.toContain("vcs:");
    expect(recovery).not.toContain("build:");
  });

  it("shows no brief for states that have not selected a subset yet", () => {
    expect(environmentBrief(fact, "patch")).toBe("");
    expect(environmentBrief(fact, "verification")).toBe("");
  });

  it("says nothing when there is no fact", () => {
    expect(environmentBrief({ root: "", found: [], missing: [] }, "orientation")).toBe("");
  });
});
