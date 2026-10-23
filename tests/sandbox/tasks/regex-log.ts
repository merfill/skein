import type { SandboxTask } from "../task";

// terminal-bench `regex-log`: the environment is bare (`FROM ubuntu`, `WORKDIR /app`), so
// there are no files or setup; the request is the cached `instruction.md` and the check is
// the cached `tests/test_outputs.py` (the default). The agent must write `/app/regex.txt`.
// The image has no Python, so the verifier runs in a separate verifier container
// (`checkIn: "host"`), exactly like the other image tasks.
export const regexLog: SandboxTask = {
  id: "regex-log",
  image: "alexgshaw/regex-log:20251031",
  checkIn: "host",
};
