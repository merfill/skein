export interface Capability {
  id: string;
  label: string;
}

export const FRAGMENT: readonly Capability[] = [
  { id: "inspect", label: "read files and search the workspace" },
  { id: "modify", label: "edit files in the workspace" },
  { id: "execute", label: "run commands in the workspace" },
  { id: "verify", label: "run a build or test and read its result (ordinary output; a goal closes only by stop)" },
  { id: "abduce", label: "propose goals, plans and alternatives" },
];

export function isAvailableCapability(id: string): boolean {
  return FRAGMENT.some((capability) => capability.id === id);
}
