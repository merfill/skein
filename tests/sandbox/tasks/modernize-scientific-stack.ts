import type { SandboxTask } from "../task";

// terminal-bench `modernize-scientific-stack`: rewrite a legacy climate script against the
// modern numpy/pandas stack. The image already has the libraries (pip at build); the
// verifier runs the rewritten script and imports pytest (satisfied by the sandbox shim).
export const modernizeScientificStack: SandboxTask = {
  id: "modernize-scientific-stack",
  image: "alexgshaw/modernize-scientific-stack:20251031",
};
