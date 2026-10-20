import { environmentBrief, type EnvironmentFact } from "./environment";
import type { IslandId } from "./islands";
import type { MaterialFact } from "./material";

// The session-scoped probe: one deterministic observation of the environment and the
// material, journalled once at request start. It is not a child of the request and is not
// copied into states; the projection renders the subset each state needs. A future session
// container owns this fact, while request trees reference it by id.
export const SESSION_PROBE_ID = "fact:session";

export interface SessionProbe {
  environment?: EnvironmentFact;
  material?: MaterialFact;
  // The probe hit its time budget; some facts may be missing.
  partial?: boolean;
}

// The environment part of the probe, under its own heading. The workspace map is rendered
// separately: Orientation owns it, and Localization/Research receive it as the Orientation
// result.
export function probeBrief(probe: SessionProbe, island?: IslandId): string {
  return probe.environment !== undefined ? environmentBrief(probe.environment, island) : "";
}
