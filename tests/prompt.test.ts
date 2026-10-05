import { describe, expect, it } from "vitest";

import { SYSTEM_PROMPT } from "../src/loop/propose";

// The engine captures stdout and stderr separately, so the prompt must stop the model
// from merging them with a shell redirect (docs/tools.md §4.3): a merged command hides
// which stream carried the failure.

describe("system prompt: stream discipline", () => {
  it("categorically forbids merging stdout and stderr", () => {
    expect(SYSTEM_PROMPT).toMatch(/NEVER merge/);
    expect(SYSTEM_PROMPT).toContain("2>&1");
    expect(SYSTEM_PROMPT).toContain("&>");
  });

  it("tells the model that lastResult carries output and error separately", () => {
    expect(SYSTEM_PROMPT).toMatch(/"output" is stdout and "error" is stderr/);
  });

  it("keeps the no-pipe rule (the exit code must survive)", () => {
    expect(SYSTEM_PROMPT).toMatch(/never pipe them through `tail`\/`head`/i);
  });

  it("requires objective commands to be runnable from the workspace root", () => {
    expect(SYSTEM_PROMPT).toMatch(/WORKSPACE ROOT/);
    expect(SYSTEM_PROMPT).toContain("cd <dir> &&");
  });

  it("reacts to a missing path as a wrong working directory, not bad code", () => {
    expect(SYSTEM_PROMPT).toMatch(/WRONG WORKING DIRECTORY/);
    expect(SYSTEM_PROMPT).toContain("No such file or directory");
  });
});
