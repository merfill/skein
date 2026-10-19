import type { IslandId } from "./islands";

// An engine-owned environment fact, recorded once in the journal when the request starts
// (docs/state_testing.md §3). The probe itself lives in `src/loop/probe.ts`; this module is
// pure so the projection can select and format the subset a state needs.

export type EnvironmentGroup =
  | "vcs"
  | "build"
  | "interpreters"
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
}

export const ENV_FACT_ID = "fact:env";

// The groups each state needs. Orientation maps the material and how success is judged, so it
// gets the root, version control, build systems and interpreters; Research probes the source,
// so it gets the interpreters and the tools used to inspect/decode/verify it.
const ORIENTATION_GROUPS: readonly EnvironmentGroup[] = ["vcs", "build", "interpreters", "pkg"];
const RESEARCH_GROUPS: readonly EnvironmentGroup[] = [
  "interpreters",
  "core",
  "crypto",
  "data",
  "archive",
  "net",
];
// Recovery writes the search script and the output, so it also needs the workspace root.
const RECOVERY_GROUPS: readonly EnvironmentGroup[] = RESEARCH_GROUPS;

const TOOL_GROUPS: ReadonlySet<EnvironmentGroup> = new Set(["core", "crypto", "data", "archive", "net"]);

function groupsFor(island?: IslandId): readonly EnvironmentGroup[] {
  // The request turn has no island yet; Orientation is the state that opens it.
  if (island === undefined || island === "orientation") return ORIENTATION_GROUPS;
  if (island === "research") return RESEARCH_GROUPS;
  if (island === "recovery") return RECOVERY_GROUPS;
  // Other states are added separately; until then they get no environment brief.
  return [];
}

function toolLine(tool: EnvironmentTool): string {
  const label = tool.version !== undefined && tool.version !== "" ? `${tool.name} ${tool.version}` : tool.name;
  return `\`${label}\``;
}

// A compact Markdown brief for the state, or "" when it has nothing to say. Only facts: no
// recommendation about which language to use.
export function environmentBrief(fact: EnvironmentFact, island?: IslandId): string {
  const groups = groupsFor(island);
  const found = fact.found.filter((tool) => groups.includes(tool.group));
  const missing = fact.missing.filter((tool) => groups.includes(tool.group));
  const lines: string[] = ["**Environment** (probed automatically):"];
  const showRoot = island === undefined || island === "orientation" || island === "recovery";
  if (showRoot && fact.root !== "") lines.push(`- root: \`${fact.root}\``);

  const tools = found.filter((tool) => TOOL_GROUPS.has(tool.group)).sort((a, b) => a.name.localeCompare(b.name));
  for (const group of ["vcs", "build", "interpreters", "pkg"] as const) {
    if (!groups.includes(group)) continue;
    const inGroup = found.filter((tool) => tool.group === group).sort((a, b) => a.name.localeCompare(b.name));
    if (inGroup.length === 0) continue;
    const label = group === "pkg" ? "package managers" : group;
    lines.push(`- ${label}: ${inGroup.map(toolLine).join(", ")}`);
  }
  if (tools.length > 0) lines.push(`- tools: ${tools.map(toolLine).join(", ")}`);
  if (missing.length > 0) {
    lines.push(`- missing: ${missing.map((tool) => `\`${tool.name}\``).join(", ")}`);
  }
  return lines.length > 1 ? lines.join("\n") : "";
}
