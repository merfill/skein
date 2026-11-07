// The engine-owned brief of a state: one function per state, each taking the session probe and
// returning the finished text. Nothing is assembled from titled blocks elsewhere — the label,
// the order and the wording live here, so a state's brief is read in one place.
//
// Every working state gets the coordinates plus the toolchain its work runs on (Patch, Research,
// Construction, Verification); End gets nothing. The engine already records the root and the
// repository status, so the request starts directly in a productive state.

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

// The request turn's brief: the same procedure the Research state uses (coordinates plus its
// environment subset), so the first `move` is not blind. No listing.
export function requestBrief(probe: SessionProbe): string {
  return researchBrief(probe);
}

export function patchBrief(probe: SessionProbe): string {
  return compose(probe, "patch");
}

export function researchBrief(probe: SessionProbe): string {
  return compose(probe, "research");
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
  if (island === "patch") return patchBrief(probe);
  if (island === "research") return researchBrief(probe);
  if (island === "construction") return constructionBrief(probe);
  if (island === "verification") return verificationBrief(probe);
  return endBrief(probe);
}
