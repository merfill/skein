import type { State } from "./graph";

export function forbiddenPatterns(state: State): string[] {
  const patterns: string[] = [];
  for (const node of state.nodes.values()) {
    if (node.kind !== "constraint") continue;
    const payload = node.payload as { forbid?: unknown } | undefined;
    if (payload && Array.isArray(payload.forbid)) {
      for (const pattern of payload.forbid) {
        if (typeof pattern === "string") patterns.push(pattern);
      }
    }
  }
  return patterns;
}

export function matchesPath(pattern: string, path: string): boolean {
  try {
    return new RegExp(pattern).test(path);
  } catch {
    return false;
  }
}
