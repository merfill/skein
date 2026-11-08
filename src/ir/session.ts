import type { EnvironmentFact } from "./environment";
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
