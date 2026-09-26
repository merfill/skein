import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadSettings } from "../src/config/settings";
import { fold } from "../src/ir/graph";
import type { Context } from "../src/ir/project";
import { reasoningOffBody } from "../src/llm/client";
import type { Action, Proposal } from "../src/llm/schemas";
import { classify } from "../src/loop/classify";
import { runAgent } from "../src/loop/graph";
import { fsWorkspace } from "../src/tools/workspace";
import { verifiedWithoutCheck } from "./invariants";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "bugfix");

const tempDirs: string[] = [];

function setup(fixture: string): string {
  const root = mkdtempSync(join(tmpdir(), `skein-${fixture}-`));
  cpSync(join(FIXTURES, fixture), root, { recursive: true });
  tempDirs.push(root);
  return root;
}

function scripted(actions: Action[]) {
  let index = 0;
  return async (_context: Context): Promise<Proposal> => {
    const action = actions[index];
    index += 1;
    if (!action) throw new Error("script exhausted");
    return { thought: `step ${index}`, action };
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("reasoning is disabled", () => {
  it("puts DeepSeek thinking and RouterAI reasoning in the request body", () => {
    expect(reasoningOffBody("none")).toEqual({
      thinking: { type: "disabled" },
      reasoning: { effort: "none" },
    });
  });

  it("loads settings from env with defaults", () => {
    const settings = loadSettings({ SKEIN_TEMPERATURE: "0.5" } as NodeJS.ProcessEnv);
    expect(settings.temperature).toBe(0.5);
    expect(settings.reasoningEffort).toBe("none");
    expect(settings.live).toBe(false);
  });
});

describe("classify", () => {
  it("rejects an edit forbidden by a constraint", () => {
    const state = fold([
      {
        type: "add_node",
        node: {
          id: "k1",
          space: "work",
          kind: "constraint",
          label: "do not edit tests",
          payload: { forbid: ["\\.test\\.mjs$"] },
          seq: 0,
        },
      },
    ]);
    const verdict = classify(
      {
        thought: "",
        action: {
          tool: "edit",
          path: "test/sum.test.mjs",
          find: "a",
          replace: "b",
        },
      },
      state,
    );
    expect(verdict.accept).toBe(false);
    expect(verdict.category).toBe("rejected");
  });

  it("accepts a track proposal as a hypothesis", () => {
    const verdict = classify(
      {
        thought: "",
        action: { tool: "track", kind: "claim", label: "off-by-one" },
      },
      fold([]),
    );
    expect(verdict).toEqual({ category: "hypothesis", accept: true });
  });
});

describe("runAgent (scripted, offline)", () => {
  it("fixes a failing test end to end", async () => {
    const root = setup("off-by-one");
    const workspace = fsWorkspace(root);
    const testBefore = readFileSync(join(root, "test", "sum.test.mjs"), "utf8");

    expect(workspace.run("node --test").code).not.toBe(0);

    const result = await runAgent(
      {
        propose: scripted([
          { tool: "read", path: "src/sum.mjs" },
          { tool: "track", kind: "claim", label: "loop stops one short" },
          {
            tool: "edit",
            path: "src/sum.mjs",
            find: "i < n",
            replace: "i <= n",
          },
          { tool: "run", command: "node --test" },
          { tool: "finish", summary: "fixed" },
        ]),
        workspace,
        maxTurns: 10,
      },
      {
        goal: { id: "g1", label: "make node --test pass" },
        constraints: [
          { id: "k1", label: "do not edit tests", forbid: ["\\.test\\.mjs$"] },
        ],
      },
    );

    expect(result.done).toBe(true);
    expect(result.stopReason).toBe("finish");
    expect(workspace.run("node --test").code).toBe(0);
    expect(readFileSync(join(root, "test", "sum.test.mjs"), "utf8")).toBe(testBefore);

    const state = fold(result.events);
    const claim = [...state.nodes.values()].find((node) => node.kind === "claim");
    if (!claim) throw new Error("no claim recorded");
    expect(state.statuses.get(claim.id)).toBe("verified");

    expect(workspace.exists("src/sum.mjs")).toBe(true);
    expect(
      [...state.edgeStatuses.values()].filter((status) => status === "stale").length,
    ).toBeGreaterThan(0);
    expect(state.statuses.get("g1")).toBe("open");
    expect(result.events.filter((event) => event.type === "mutate")).toHaveLength(1);
    expect(verifiedWithoutCheck(result.events)).toEqual([]);
  });

  it("does not touch a file a constraint forbids", async () => {
    const root = setup("off-by-one");
    const workspace = fsWorkspace(root);
    const testBefore = readFileSync(join(root, "test", "sum.test.mjs"), "utf8");

    const result = await runAgent(
      {
        propose: scripted([
          {
            tool: "edit",
            path: "test/sum.test.mjs",
            find: "15",
            replace: "10",
          },
          { tool: "finish", summary: "done" },
        ]),
        workspace,
        maxTurns: 5,
      },
      {
        goal: { id: "g1", label: "make node --test pass" },
        constraints: [
          { id: "k1", label: "do not edit tests", forbid: ["\\.test\\.mjs$"] },
        ],
      },
    );

    expect(result.done).toBe(true);
    expect(readFileSync(join(root, "test", "sum.test.mjs"), "utf8")).toBe(testBefore);
    expect(result.events.filter((event) => event.type === "mutate")).toHaveLength(0);
  });
});
