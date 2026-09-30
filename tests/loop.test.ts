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
import { executeAction } from "../src/tools";
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

describe("query", () => {
  const workspace = () => fsWorkspace(setup("off-by-one"));

  it("filters claims by status and writes no events", () => {
    const state = fold([
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", seq: 0 } },
      { type: "add_node", node: { id: "c1", space: "work", kind: "claim", label: "off by one", seq: 1 } },
      { type: "add_node", node: { id: "c2", space: "work", kind: "claim", label: "other", seq: 2 } },
      {
        type: "record_check",
        command: "npm test",
        verdict: "pass",
        output: "ok",
        claimIds: ["c1"],
      },
    ]);

    const outcome = executeAction(
      { tool: "query", kind: "claim", status: "verified" },
      state,
      workspace(),
      0,
    );

    expect(outcome.events).toEqual([]);
    expect(outcome.turn.text).toContain("c1");
    expect(outcome.turn.text).not.toContain("c2");
  });

  it("returns the verdict trail for a claim", () => {
    const state = fold([
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", seq: 0 } },
      { type: "add_node", node: { id: "c1", space: "work", kind: "claim", label: "off by one", seq: 1 } },
      { type: "add_node", node: { id: "obs:2", space: "work", kind: "observation", label: "run npm test", seq: 2 } },
      {
        type: "add_edge",
        edge: {
          id: "e:3",
          from: "obs:2",
          to: "c1",
          kind: "verifies",
          provenance: { kind: "check", command: "npm test", verdict: "fail" },
          status: "open",
        },
      },
      {
        type: "record_check",
        command: "npm test",
        verdict: "fail",
        output: "boom",
        claimIds: ["c1"],
      },
    ]);

    const outcome = executeAction({ tool: "query", verdictOf: "c1" }, state, workspace(), 0);

    expect(outcome.turn.text).toContain("boom");
    expect(outcome.turn.text).toContain("checks");
    expect(outcome.turn.text).toContain("obs:2");
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

  it("reverts a shell mutation of a file a constraint forbids", async () => {
    const root = setup("off-by-one");
    const workspace = fsWorkspace(root);
    const testBefore = readFileSync(join(root, "test", "sum.test.mjs"), "utf8");

    const result = await runAgent(
      {
        propose: scripted([
          { tool: "run", command: "printf '15\\n' > test/sum.test.mjs" },
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
    expect(result.events.filter((event) => event.type === "record_check")).toHaveLength(0);
    expect(
      result.events.some(
        (event) =>
          event.type === "add_node" && event.node.label.startsWith("constraint violation"),
      ),
    ).toBe(true);
  });

  it("spills truncated output to .skein and keeps head+tail in context", async () => {
    const root = setup("off-by-one");
    const workspace = fsWorkspace(root);
    const command =
      "node -e \"process.stdout.write('HEAD' + 'a'.repeat(20000) + 'TAIL')\"";

    const result = await runAgent(
      {
        propose: scripted([
          { tool: "run", command },
          { tool: "finish", summary: "done" },
        ]),
        workspace,
        maxTurns: 5,
      },
      { goal: { id: "g1", label: "noop" } },
    );

    const check = result.events.find((event) => event.type === "record_check");
    if (!check || check.type !== "record_check") throw new Error("no check recorded");
    const ref = check.outputRef;
    if (!ref) throw new Error("no output ref");
    expect(check.output).toContain("HEAD");
    expect(check.output).toContain("TAIL");
    expect(check.output).toContain("full output");
    expect(check.output.length).toBeLessThan(20000);

    const full = workspace.read(ref);
    expect(full.length).toBeGreaterThan(20000);
    expect(full).toContain("HEAD");
    expect(full).toContain("TAIL");
    expect(workspace.list()).not.toContain(ref);

    const observation = result.events.find(
      (event) =>
        event.type === "add_node" &&
        event.node.kind === "observation" &&
        event.node.label.startsWith("run "),
    );
    if (!observation || observation.type !== "add_node") {
      throw new Error("no run observation");
    }
    expect(observation.node.payload).toMatchObject({ outputRef: ref });
  });
});
