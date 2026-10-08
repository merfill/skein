import type { SandboxTask } from "../task";

// terminal-bench `cobol-modernization`: modernize a COBOL program (gnucobol is in the
// image); the verifier compiles and runs it.
export const cobolModernization: SandboxTask = {
  id: "cobol-modernization",
  image: "alexgshaw/cobol-modernization:20251031",
};
