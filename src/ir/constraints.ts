import type { State } from "./graph";

export interface ForbiddenConstraint {
  id: string;
  pattern: string;
}

export function forbiddenConstraints(state: State): ForbiddenConstraint[] {
  const found: ForbiddenConstraint[] = [];
  for (const node of state.nodes.values()) {
    if (node.kind !== "constraint") continue;
    const payload = node.payload as { forbid?: unknown } | undefined;
    if (payload && Array.isArray(payload.forbid)) {
      for (const pattern of payload.forbid) {
        if (typeof pattern === "string") found.push({ id: node.id, pattern });
      }
    }
  }
  return found;
}

export function forbiddenPatterns(state: State): string[] {
  return forbiddenConstraints(state).map((entry) => entry.pattern);
}

export function matchesPath(pattern: string, path: string): boolean {
  try {
    return new RegExp(pattern).test(path);
  } catch {
    return false;
  }
}
