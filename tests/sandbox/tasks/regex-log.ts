import type { SandboxTask } from "../task";

// terminal-bench `regex-log`, ported without Docker: the environment is bare (`FROM
// ubuntu`, `WORKDIR /app`), so there are no files or setup; the request is the cached
// `instruction.md` and the check is the cached `tests/test_outputs.py` (the default). The
// agent must write `/app/regex.txt`.
export const regexLog: SandboxTask = { id: "regex-log" };
