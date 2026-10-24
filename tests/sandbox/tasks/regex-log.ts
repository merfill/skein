import type { SandboxTask } from "../task";

// terminal-bench `regex-log`: the environment is bare (`FROM ubuntu`, `WORKDIR /app`), so
// there are no files or setup; the request is the cached `instruction.md`. The agent must
// write `/app/regex.txt`. The image has no Python: the task's own `tests/test.sh` installs it
// with `uv` during verification, as Harbor does. The rootless Docker path runs that script in
// the agent's container after it; `checkIn` is legacy/opencode only.
export const regexLog: SandboxTask = {
  id: "regex-log",
  image: "alexgshaw/regex-log:20251031",
  checkIn: "host",
};
