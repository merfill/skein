import type { IslandId } from "./islands";

// An engine-owned environment fact, recorded once in the journal when the request starts
// (docs/state_testing.md §3). The probe itself lives in `src/loop/probe.ts`; this module is
// pure so the projection can select and format the subset a state needs.

export const ALL_ENVIRONMENT_GROUPS = [
  "vcs",
  "build",
  "compilers",
  "interpreters",
  "test",
  "pkg",
  "core",
  "crypto",
  "data",
  "archive",
  "net",
] as const;

export type EnvironmentGroup = (typeof ALL_ENVIRONMENT_GROUPS)[number];

export interface EnvironmentTool {
  name: string;
  group: EnvironmentGroup;
  path: string;
  version?: string;
}

export interface EnvironmentFact {
  root: string;
  found: EnvironmentTool[];
  missing: { name: string; group: EnvironmentGroup }[];
  // The agent's network policy, recorded by the harness (not discovered by a shell): this is
  // the fact that decides whether a missing runtime can be installed. The verifier has its
  // own network and is not described here.
  network?: "on" | "off";
  // The probe hit its time budget; the listed facts are still observations, not a
  // complete picture.
  partial?: boolean;
}

// Orientation establishes the inputs and the acceptance, not the toolchain: it gets no
// environment block. Patch needs the VCS tools and the interpreters that can run a search
// script, plus the toolchain the change is built with; Research needs the interpreters and
// package managers that can produce the result; Construction and Verification run the project's
// build and its declared check, and Construction reads and checks history as well.
const ORIENTATION_GROUPS: readonly EnvironmentGroup[] = [];
// Patch locates the defect and makes the change, so it needs the search tools (vcs,
// interpreters) and the toolchain the change is built with.
const PATCH_GROUPS: readonly EnvironmentGroup[] = ["vcs", "build", "compilers", "interpreters"];
const RESEARCH_GROUPS: readonly EnvironmentGroup[] = ["interpreters", "pkg"];
const RECOVERY_GROUPS: readonly EnvironmentGroup[] = RESEARCH_GROUPS;
const CONSTRUCTION_GROUPS: readonly EnvironmentGroup[] = ["vcs", "build", "compilers", "test", "interpreters", "pkg"];
const VERIFICATION_GROUPS: readonly EnvironmentGroup[] = ["build", "test", "pkg"];

function groupsFor(island?: IslandId): readonly EnvironmentGroup[] {
  // The request turn has no island and carries no probe block; the first state that opens it
  // (Orientation) gets the subset.
  if (island === undefined) return [];
  if (island === "orientation") return ORIENTATION_GROUPS;
  if (island === "patch") return PATCH_GROUPS;
  if (island === "research") return RESEARCH_GROUPS;
  if (island === "recovery") return RECOVERY_GROUPS;
  if (island === "construction") return CONSTRUCTION_GROUPS;
  if (island === "verification") return VERIFICATION_GROUPS;
  // End inspects nothing: its surface is the model's own reply.
  return [];
}

function toolLine(tool: EnvironmentTool): string {
  return tool.version !== undefined && tool.version !== "" ? `${tool.name} ${tool.version}` : tool.name;
}

// A compact brief for an explicit set of groups, or "" when it has nothing to say. Only
// decision-relevant facts: the workspace root, the network policy, and the named groups. The
// stock shell utilities (core/crypto/data/archive/net) are not an inventory worth printing:
// listing them reads as a recommendation about the method.
export function environmentGroupsBrief(
  fact: EnvironmentFact,
  groups: readonly EnvironmentGroup[],
  options: { showRoot?: boolean } = {},
): string {
  if (groups.length === 0) return "";
  const lines: string[] = [];
  if (options.showRoot === true && fact.root !== "") lines.push(`Workspace root: ${fact.root}`);
  if (fact.network !== undefined) {
    lines.push(
      fact.network === "off"
        ? "Network is available: no — no external downloads; package installs that need the network will fail."
        : "Network is available: yes.",
    );
  }
  const named = (group: EnvironmentGroup, label: string): void => {
    const inGroup = fact.found
      .filter((tool) => tool.group === group)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (inGroup.length > 0) lines.push(`${label}: ${inGroup.map(toolLine).join(", ")}.`);
  };
  if (groups.includes("vcs")) named("vcs", "Version-control tools");
  if (groups.includes("build")) named("build", "Build tools");
  if (groups.includes("compilers")) named("compilers", "Compilers");
  if (groups.includes("interpreters")) named("interpreters", "Installed interpreters");
  if (groups.includes("test")) named("test", "Test tools");
  if (groups.includes("pkg")) named("pkg", "Available package managers");
  if (fact.partial === true) lines.push("The environment scan was partial (time budget).");
  return lines.join("\n");
}

// A compact brief for the state's environment, or "" when it has nothing to say. The root is
// not printed here: a state's brief carries the coordinates (`Workspace root`,
// `Workspace repository`) once, from the material fact.
export function environmentBrief(fact: EnvironmentFact, island?: IslandId): string {
  const groups = groupsFor(island);
  if (groups.length === 0) return "";
  return environmentGroupsBrief(fact, groups);
}
