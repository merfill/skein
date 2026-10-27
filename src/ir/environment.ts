import type { IslandId } from "./islands";

// An engine-owned environment fact, recorded once in the journal when the request starts
// (docs/state_testing.md §3). The probe itself lives in `src/loop/probe.ts`; this module is
// pure so the projection can select and format the subset a state needs.

export type EnvironmentGroup =
  | "vcs"
  | "build"
  | "compilers"
  | "interpreters"
  | "test"
  | "pkg"
  | "core"
  | "crypto"
  | "data"
  | "archive"
  | "net";

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
// environment block. Research probes the source, so it gets the interpreters and the tools
// used to inspect/decode/verify it.
const ORIENTATION_GROUPS: readonly EnvironmentGroup[] = [];
// Localization walks the material with the shell and its search tools: it needs the VCS
// tools, the core text tools, and interpreters for a search script.
const LOCALIZATION_GROUPS: readonly EnvironmentGroup[] = ["vcs", "core", "interpreters"];
const RESEARCH_GROUPS: readonly EnvironmentGroup[] = [
  "interpreters",
  "core",
  "crypto",
  "data",
  "archive",
  "net",
  "pkg",
];
// Recovery writes the output and scratch copies, so it uses the same tool surface as Research
// and also needs the workspace root.
const RECOVERY_GROUPS: readonly EnvironmentGroup[] = RESEARCH_GROUPS;
// Construction and Verification run the project's build and its declared check.
const CONSTRUCTION_GROUPS: readonly EnvironmentGroup[] = ["build", "compilers", "test", "interpreters", "pkg"];
const VERIFICATION_GROUPS: readonly EnvironmentGroup[] = ["build", "test", "pkg"];

const TOOL_GROUPS: ReadonlySet<EnvironmentGroup> = new Set(["core", "crypto", "data", "archive", "net"]);

function groupsFor(island?: IslandId): readonly EnvironmentGroup[] {
  // The request turn has no island and carries no probe block; the first state that opens it
  // (Orientation) gets the subset.
  if (island === undefined) return [];
  if (island === "orientation") return ORIENTATION_GROUPS;
  if (island === "localization") return LOCALIZATION_GROUPS;
  if (island === "research") return RESEARCH_GROUPS;
  if (island === "recovery") return RECOVERY_GROUPS;
  if (island === "construction") return CONSTRUCTION_GROUPS;
  if (island === "verification") return VERIFICATION_GROUPS;
  // Localization and End inspect the material with the model's own search tools.
  return [];
}

function toolLine(tool: EnvironmentTool): string {
  return tool.version !== undefined && tool.version !== "" ? `${tool.name} ${tool.version}` : tool.name;
}

// A compact Markdown brief for the state, or "" when it has nothing to say. Only facts: no
// recommendation about which language to use.
export function environmentBrief(fact: EnvironmentFact, island?: IslandId): string {
  const groups = groupsFor(island);
  if (groups.length === 0) return "";
  const found = fact.found.filter((tool) => groups.includes(tool.group));
  const missing = fact.missing.filter((tool) => groups.includes(tool.group));
  const partial = fact.partial === true ? " (partial; the probe hit its time budget)" : "";
  const lines: string[] = [`Environment${partial}`];
  const showRoot =
    island === "orientation" ||
    island === "recovery" ||
    island === "construction" ||
    island === "verification";
  if (showRoot && fact.root !== "") lines.push(`root: ${fact.root}`);
  if (fact.network !== undefined) {
    lines.push(
      fact.network === "off"
        ? "network: off — no external downloads; package installs that need the network will fail"
        : "network: on",
    );
  }

  const tools = found.filter((tool) => TOOL_GROUPS.has(tool.group)).sort((a, b) => a.name.localeCompare(b.name));
  for (const group of ["vcs", "build", "compilers", "interpreters", "test", "pkg"] as const) {
    if (!groups.includes(group)) continue;
    const inGroup = found.filter((tool) => tool.group === group).sort((a, b) => a.name.localeCompare(b.name));
    if (inGroup.length === 0) continue;
    const label =
      group === "pkg"
        ? "package managers"
        : group === "vcs"
          ? "version-control tools"
          : group === "build"
            ? "build tools"
            : group === "test"
              ? "test tools"
              : group;
    lines.push(`${label}: ${inGroup.map(toolLine).join(", ")}`);
  }
  if (tools.length > 0) lines.push(`tools: ${tools.map(toolLine).join(", ")}`);
  if (missing.length > 0) {
    const shown = missing.slice(0, 12).map((tool) => tool.name);
    const more = missing.length > shown.length ? `, … (+${missing.length - shown.length} more)` : "";
    lines.push(`missing: ${shown.join(", ")}${more}`);
  }
  return lines.length > 1 ? lines.join("\n") : "";
}
