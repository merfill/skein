export interface Capability {
  id: string;
  label: string;
}

export const FRAGMENT: readonly Capability[] = [
  { id: "inspect", label: "read files and search the workspace" },
  { id: "modify", label: "edit files in the workspace" },
  { id: "execute", label: "run commands in the workspace" },
  { id: "verify", label: "settle a goal with a check (test, typecheck, or user)" },
  { id: "abduce", label: "propose goals, plans and alternatives" },
];

export function isAvailableCapability(id: string): boolean {
  return FRAGMENT.some((capability) => capability.id === id);
}
