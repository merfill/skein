import type { Event } from "../ir/events";
import type { State } from "../ir/graph";
import type { Workspace } from "../tools/workspace";

export interface VersionCacheEntry {
  signature: string;
  version: string;
}

export type VersionCache = Map<string, VersionCacheEntry>;

function activeRefs(state: State): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>();
  const add = (ref: string, version: string): void => {
    const versions = refs.get(ref);
    if (versions) versions.add(version);
    else refs.set(ref, new Set([version]));
  };

  for (const edge of state.edges.values()) {
    if (state.edgeStatuses.get(edge.id) === "stale") continue;
    const provenance = edge.provenance;
    if (provenance.kind === "read") {
      add(provenance.ref, provenance.version);
    } else if (edge.kind === "verifies" && provenance.kind === "check") {
      for (const entry of provenance.witness ?? []) add(entry.ref, entry.version);
    }
  }

  return refs;
}

export function reconcile(
  state: State,
  workspace: Workspace,
  cache: VersionCache = new Map(),
): Event[] {
  const events: Event[] = [];
  for (const [ref, versions] of activeRefs(state)) {
    if (!ref.startsWith("file:")) continue;
    const path = ref.slice("file:".length);
    if (!workspace.exists(path)) continue;

    const signature = workspace.signature(path);
    const cached = cache.get(path);
    let version: string;
    if (cached !== undefined && cached.signature === signature) {
      version = cached.version;
    } else {
      version = workspace.version(path);
      cache.set(path, { signature, version });
    }

    if (versions.has(version)) continue;
    events.push({
      type: "mutate",
      ref,
      version,
      actionId: `reconcile:${ref}`,
    });
  }
  return events;
}
