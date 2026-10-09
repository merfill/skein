import type { Event } from "../ir/events";
import { witnessOf, type State } from "../ir/graph";
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

  for (const node of state.nodes.values()) {
    if (node.kind !== "observation") continue;
    const payload = node.payload as { ref?: unknown; version?: unknown } | undefined;
    if (typeof payload?.ref === "string" && typeof payload.version === "string") {
      add(payload.ref, payload.version);
    }
    // A run's witness: the files it rested on, so a later change stales it.
    for (const entry of witnessOf(state, node.id) ?? []) add(entry.ref, entry.version);
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

    let signature: string;
    let version: string;
    try {
      signature = workspace.signature(path);
      const cached = cache.get(path);
      if (cached !== undefined && cached.signature === signature) {
        version = cached.version;
      } else {
        version = workspace.version(path);
        cache.set(path, { signature, version });
      }
    } catch {
      // The file vanished between the existence check and the read.
      continue;
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
