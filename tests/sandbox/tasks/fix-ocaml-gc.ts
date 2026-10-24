import type { SandboxTask } from "../task";

// terminal-bench `fix-ocaml-gc`: fix a run-length sweep bug in the OCaml GC. The verifier
// re-runs the testsuite, which needs a full compiler rebuild — heavy, so this task is not in
// the fast offline suite. The rootless Docker path runs the task's own `tests/test.sh`, which
// re-clones a pristine testsuite (stopping test tampering), rebuilds and recreates tests.txt;
// `checkSetup`/`checkIn` are for the legacy/opencode path only. The virtual counterpart
// (tests/sandbox/live-trace.ts) is unchanged.
export const fixOcamlGcTask: SandboxTask = {
  id: "fix-ocaml-gc",
  image: "alexgshaw/fix-ocaml-gc:20251031",
  // The criterion rebuilds the whole compiler; run foreground it is one (long) turn, but a
  // rebuild plus the testsuite and any retries still need room. The Harbor acceptance ran
  // at 60.
  maxTurns: 60,
  checkIn: "host",
  checkSetup:
    "cd /app/ocaml && make clean && ./configure && make -j4 && rm -f tests.txt && (make -C testsuite one DIR=tests/basic | tee tests.txt || true)",
};
