export interface Capability {
  id: string;
  label: string;
}

export const FRAGMENT: readonly Capability[] = [
  { id: "inspect", label: "read and search files" },
  { id: "modify", label: "edit and write files" },
  { id: "execute", label: "run shell commands — builds, tests, git" },
  { id: "reference", label: "fetch a reference file from the web" },
  { id: "plan", label: "interpret the request and split the work into steps" },
];

export function isAvailableCapability(id: string): boolean {
  return FRAGMENT.some((capability) => capability.id === id);
}
