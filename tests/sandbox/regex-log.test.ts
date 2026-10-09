import { afterEach, describe, expect, it } from "vitest";

import type { Action } from "../../src/llm/schemas";
import { containerWorkspace } from "./container";
import { runTask, taskAvailable } from "./harness";
import { scripted } from "./run";
import { regexLog } from "./tasks/regex-log";
import { cleanupSandboxes, newSandboxRoot } from "./workspace";

afterEach(cleanupSandboxes);

// Offline, deterministic: the container primitive (bwrap), the `/app` path rewrite, and the
// real task harness + verifier. No model, no network, no Docker.

describe("sandbox container (bwrap)", () => {
  it("runs a real shell with the workspace at /app and no network", () => {
    const root = newSandboxRoot("skein-container-");
    const workspace = containerWorkspace(root);
    workspace.write("hello.txt", "hi");
    const result = workspace.run('cat /app/hello.txt; echo "---"; python3 -c "print(6*7)"');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("hi");
    expect(result.stdout).toContain("42");
    expect(workspace.run("getent hosts example.com").code).not.toBe(0);
  }, 30_000);

  it("rewrites absolute /app paths for the file tools", () => {
    const root = newSandboxRoot("skein-container-");
    const workspace = containerWorkspace(root);
    workspace.write("/app/regex.txt", "abc");
    expect(workspace.read("regex.txt")).toBe("abc");
    expect(workspace.read("/app/regex.txt")).toBe("abc");
    expect(workspace.exists("regex.txt")).toBe(true);
  }, 30_000);
});

// The official solution regex (solution/solve.sh); the task's verifier expects exactly these
// matches. Embedded here only as the test's own fixture.
const GOOD_REGEX = String.raw`(?=.*(?:^|[^0-9A-Za-z])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?=$|[^0-9A-Za-z])).*(?:^|[^0-9A-Za-z])(\d{4}-(?:(?:01|03|05|07|08|10|12)-(?:0[1-9]|[12]\d|3[01])|(?:04|06|09|11)-(?:0[1-9]|[12]\d|30)|02-(?:0[1-9]|1\d|2[0-9])))(?=$|[^0-9A-Za-z])`;
const BAD_REGEX = String.raw`\d{4}-\d{2}-\d{2}`;

function proposerFor(regex: string) {
  const goal: Action = {
    operator: "create_goal",
    what: "write a regex matching the last date on lines with an IPv4 address",
    done_when: "the regex passes the task's tests",
    plan: "write the regex to /app/regex.txt, then let the verifier run",
    step: { command: "pwd" },
  };
  const write: Action = { operator: "apply", action: { tool: "write", path: "/app/regex.txt", content: regex } };
  const stop: Action = { operator: "stop", why: "the regex is written" };
  return scripted([goal, write], stop);
}

describe.skipIf(!taskAvailable("regex-log"))("regex-log task (real container verifier)", () => {
  it("rewards a correct regex with 1", async () => {
    const run = await runTask(regexLog, proposerFor(GOOD_REGEX), { maxTurns: 3 });
    expect(run.reward).toBe(1);
    expect(run.check.stdout).toContain("PASS test_regex_matches_dates");
  }, 60_000);

  it("rewards a wrong regex with 0", async () => {
    const run = await runTask(regexLog, proposerFor(BAD_REGEX), { maxTurns: 3 });
    expect(run.reward).toBe(0);
    expect(run.check.stdout).toContain("FAIL test_regex_matches_dates");
  }, 60_000);
});
