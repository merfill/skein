import { describe, expect, it } from "vitest";

import { loadSettings } from "../../src/config/settings";
import type { Context } from "../../src/ir/project";
import { createChatModel } from "../../src/llm/client";
import { invokeTools } from "../../src/llm/structured";
import { buildMessages } from "../../src/loop/propose";

// One live LLM call per layout: the request names a project subdirectory and the bare
// criterion command. The interpretation's `done_when` must run that command FROM the
// workspace root, i.e. carry a `cd <dir> &&` prefix; the control lives at the root and must
// NOT be prefixed. This is the online layer for the rule in B6 and the `create_goal`
// description (docs/tools.md §5.1). Run deliberately:
//   SKEIN_LIVE=true npx vitest run tests/live/root-cd.test.ts

const settings = loadSettings();

interface Case {
  name: string;
  // null = the project is at the workspace root (no `cd` expected).
  subdir: string | null;
  request: string;
  // The criterion command the request names, expected verbatim in `done_when`.
  command: string;
}

const CASES: Case[] = [
  {
    name: "node-app",
    subdir: "app",
    request: "The Node project is checked out under app/. Make its tests pass; the test command is `npm test`.",
    command: "npm test",
  },
  {
    name: "python-py",
    subdir: "py",
    request: "The Python package lives in py/. Make the tests pass; the command is `pytest`.",
    command: "pytest",
  },
  {
    name: "rust-rust",
    subdir: "rust",
    request: "The Rust crate is under rust/. Make the tests pass; the command is `cargo test`.",
    command: "cargo test",
  },
  {
    name: "go-svc",
    subdir: "svc",
    request: "The Go service is in svc/. Make the tests pass; the command is `go test ./...`.",
    command: "go test ./...",
  },
  {
    name: "root-control",
    subdir: null,
    request: "The project is at the workspace root. Make the tests pass; the test command is `npm test`.",
    command: "npm test",
  },
];

// A fresh request: `create_goal` (or `decline`) is the only applicable move, so the first
// and only call is the interpretation.
function requestContext(text: string): Context {
  return {
    path: [{ id: "r1", kind: "request", text }],
    constraints: [],
    calls: [],
    shown: [],
    applicable: ["create_goal", "decline"],
    budget: { turn: 0, maxTurns: 20, remaining: 20 },
  };
}

describe.skipIf(!settings.live)("workspace-root criterion (live)", () => {
  for (const testCase of CASES) {
    it(`${testCase.name}: done_when runs the criterion from the workspace root`, async () => {
      const model = createChatModel(settings);
      const proposal = await invokeTools(model, buildMessages(requestContext(testCase.request)));
      console.info(`[${testCase.name}] ${JSON.stringify(proposal.action).slice(0, 300)}`);

      expect(proposal.action.operator, "an open request is interpreted").toBe("create_goal");
      if (proposal.action.operator !== "create_goal") return;

      const command = proposal.action.command.trim();
      expect(command, "the first plan command keeps the criterion command").toContain(testCase.command);
      if (testCase.subdir === null) {
        expect(command, "a root-level criterion needs no cd prefix").not.toMatch(/^cd\s/);
      } else {
        expect(command, "a subdirectory criterion must cd first").toMatch(
          new RegExp(`^cd\\s+(?:\\./)?${testCase.subdir}\\b`),
        );
      }
    }, 60_000);
  }
});
