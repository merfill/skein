// The engine-owned brief of a state: one function per state, each taking the session probe and
// returning the finished text. Nothing is assembled from titled blocks elsewhere — the label,
// the order and the wording live here, so a state's brief is read in one place.
//
// Orientation names the acceptance and needs the coordinates only. The states that work on the
// material (Patch, Research, Construction) get the coordinates plus the toolchain their work
// runs on; Verification gets the build and its test tools; Recovery gets the interpreters and
// package managers that can produce the output.

import { environmentBrief } from "./environment";
import { workspaceLines } from "./material";
import type { IslandId } from "./islands";
import type { SessionProbe } from "./session";

// The coordinates of the material: the workspace root, the shell's working directory when it
// differs, and the repository status. The listing is deliberately absent — a state that needs
// the files asks `list`; the brief states where it is, not what is there.
function factLines(probe: SessionProbe): string[] {
  if (probe.material !== undefined) return workspaceLines(probe.material, { index: false });
  const root = probe.environment?.root;
  return root !== undefined && root !== "" ? [`Workspace root: ${root}`] : [];
}

function compose(probe: SessionProbe, island: IslandId): string {
  const lines = factLines(probe);
  if (probe.environment !== undefined) {
    const environment = environmentBrief(probe.environment, island);
    if (environment !== "") lines.push(environment);
  }
  return lines.join("\n");
}

export function orientationBrief(probe: SessionProbe): string {
  return compose(probe, "orientation");
}

export function patchBrief(probe: SessionProbe): string {
  return compose(probe, "patch");
}

export function researchBrief(probe: SessionProbe): string {
  return compose(probe, "research");
}

export function recoveryBrief(probe: SessionProbe): string {
  return compose(probe, "recovery");
}

export function constructionBrief(probe: SessionProbe): string {
  return compose(probe, "construction");
}

export function verificationBrief(probe: SessionProbe): string {
  return compose(probe, "verification");
}

// End inspects nothing: its surface is the model's own reply.
export function endBrief(_probe: SessionProbe): string {
  return "";
}

export function briefFor(island: IslandId, probe: SessionProbe): string {
  if (island === "orientation") return orientationBrief(probe);
  if (island === "patch") return patchBrief(probe);
  if (island === "research") return researchBrief(probe);
  if (island === "recovery") return recoveryBrief(probe);
  if (island === "construction") return constructionBrief(probe);
  if (island === "verification") return verificationBrief(probe);
  return endBrief(probe);
}
