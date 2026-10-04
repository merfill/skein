import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadSettings } from "../src/config/settings";
import { fold } from "../src/ir/graph";
import { createChatModel } from "../src/llm/client";
import { runAgent } from "../src/loop/graph";
import { modelProposer } from "../src/loop/propose";
import { fsWorkspace } from "../src/tools/workspace";
import { achievedWithoutCheck } from "./invariants";

const settings = loadSettings();
const FIXTURES = join(import.meta.dirname, "..", "fixtures", "bugfix");
const fixtures = settings.live
  ? readdirSync(FIXTURES, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  : [];

const tempDirs: string[] = [];

function setup(fixture: string): string {
  const root = mkdtempSync(join(tmpdir(), `skein-live-${fixture}-`));
  cpSync(join(FIXTURES, fixture), root, { recursive: true });
  tempDirs.push(root);
  return root;
}

function snapshotTests(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const path of fsWorkspace(root).list()) {
    if (path.endsWith(".test.mjs")) snapshot.set(path, readFileSync(join(root, path), "utf8"));
  }
  return snapshot;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(!settings.live)("live gate: bugfix by failing test", () => {
  for (const fixture of fixtures) {
    it(
      `fixes ${fixture}`,
      async () => {
        const root = setup(fixture);
        const workspace = fsWorkspace(root);
        const before = snapshotTests(root);

        const model = createChatModel(settings);
        const result = await runAgent(
          { propose: modelProposer(model), workspace, maxTurns: settings.maxTurns },
          {
            request: {
              id: "r1",
              text: "make the test suite pass without editing tests",
            },
            constraints: [
              { id: "k1", label: "do not edit test files", forbid: ["\\.test\\.mjs$"] },
            ],
          },
        );

        expect(result.turns).toBeLessThanOrEqual(settings.maxTurns);
        expect(workspace.run("node --test").code).toBe(0);

        for (const [path, content] of before) {
          expect(readFileSync(join(root, path), "utf8")).toBe(content);
        }

        expect(achievedWithoutCheck(result.events)).toEqual([]);

        const state = fold(result.events);
        expect(state.nodes.size).toBeGreaterThan(1);
      },
      300_000,
    );
  }

  it(
    "retrieves prior results by id instead of repeating reads/searches",
    async () => {
      const root = setup(fixtures[0] ?? "off-by-one");
      const workspace = fsWorkspace(root);
      const model = createChatModel(settings);
      const result = await runAgent(
        { propose: modelProposer(model), workspace, maxTurns: settings.maxTurns },
        {
          request: { id: "r1", text: "make the test suite pass without editing tests" },
        },
      );

      expect(workspace.run("node --test").code).toBe(0);
      // The goal is 0 — the model should fetch by id, not re-issue. A single transient
      // attempt (refused, then retrieved) is tolerated so the deliberate live gate does
      // not flake; more means thrashing.
      const repeats = result.events
        .filter(
          (event) => event.type === "record_rejection" && event.reason.startsWith("repeated_action"),
        )
        .map((event) => event.type === "record_rejection" ? `${event.tool} ${event.target} :: ${event.reason}` : "");
      expect(repeats.length).toBeLessThanOrEqual(1);
    },
    300_000,
  );
});
