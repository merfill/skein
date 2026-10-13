import { describe, expect, it } from "vitest";

import { loadSettings } from "../../src/config/settings";
import { project, type Context } from "../../src/ir/project";
import { createChatModel } from "../../src/llm/client";
import { invokeTools } from "../../src/llm/structured";
import { buildMessages } from "../../src/loop/propose";
import { exec, makeWorkspace, request } from "../ops/helpers";

// One live LLM sequence per layout: the request names a project subdirectory and the bare
// criterion command. The state's first plan item must run that command FROM the workspace
// root, i.e. carry a `cd <dir> &&` prefix; the control lives at the root and must
// NOT be prefixed. This is the online layer for the rule in B6 and the `move` description
// (docs/tools.md §5.1). Run deliberately:
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

// A fresh request: `move` (or `decline`) is the only applicable move: the first call picks
// the state. The context is the tape: a single user turn.
function requestContext(text: string): Context {
  return {
    history: [{ role: "user", text }],
    situation: "request",
    constraints: [],
  };
}

describe.skipIf(!settings.live)("workspace-root criterion (live)", () => {
  for (const testCase of CASES) {
    it(`${testCase.name}: the first plan item runs the criterion from the workspace root`, async () => {
      const model = createChatModel(settings);
      const first = await invokeTools(model, buildMessages(requestContext(testCase.request)));
      console.info(`[${testCase.name}] ${JSON.stringify(first.actions[0]!).slice(0, 300)}`);

      expect(
        first.actions[0]!.operator === "move" || first.actions[0]!.operator === "decline",
        "an open request chooses a state",
      ).toBe(true);
      if (first.actions[0]!.operator !== "move") return;

      // Execute the declared state, then ask for its first plan item.
      const ws = makeWorkspace({}).ws;
      const moved = exec(first.actions[0]!, [request(testCase.request)], ws);
      const second = await invokeTools(model, buildMessages(project(moved.state)));
      const action = second.actions[0]!;
      expect(action.operator, "the state's first plan item is a command").toBe("apply");
      if (action.operator !== "apply" || action.action.tool !== "bash") return;

      const command = (action.action.command ?? "").trim();
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
