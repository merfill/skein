import type { SandboxTask } from "../task";

// terminal-bench `custom-memory-heap-crash`: fix a static-destruction crash against a custom
// allocator. The image has a custom gcc and valgrind; the verifier compiles/runs and imports
// pytest (sandbox shim).
export const customMemoryHeapCrash: SandboxTask = {
  id: "custom-memory-heap-crash",
  image: "alexgshaw/custom-memory-heap-crash:20251031",
};
