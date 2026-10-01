import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadSettings } from "../src/config/settings";
import { fold } from "../src/ir/graph";
import { project, type Context } from "../src/ir/project";
import { reasoningOffBody } from "../src/llm/client";
import type { Action, Proposal } from "../src/llm/schemas";
import { classify } from "../src/loop/classify";
import { runAgent } from "../src/loop/graph";
import { executeAction } from "../src/tools";
import { fsWorkspace } from "../src/tools/workspace";
import { unboundWorkNodes, verifiedWithoutCheck } from "./invariants";

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

  it("accepts a bound track proposal as a hypothesis", () => {
    const state = fold([
      {
        type: "add_node",
        node: { id: "g1", space: "work", kind: "goal", label: "green", seq: 0 },
      },
    ]);
    const verdict = classify(
      {
        thought: "",
        action: { tool: "track", kind: "claim", label: "off-by-one", parent: "g1" },
      },
      state,
    );
    expect(verdict).toEqual({ category: "hypothesis", accept: true });
  });

  it("refuses a claim without a parent", () => {
    const state = fold([
      {
        type: "add_node",
        node: { id: "g1", space: "work", kind: "goal", label: "green", seq: 0 },
      },
    ]);
    const verdict = classify(
      { thought: "", action: { tool: "track", kind: "claim", label: "off-by-one" } },
      state,
    );
    expect(verdict).toEqual({
      category: "rejected",
      accept: false,
      reason: "missing_parent",
    });
  });

  it("refuses a parent that is neither a goal nor a subgoal", () => {
    const state = fold([
      {
        type: "add_node",
        node: { id: "g1", space: "work", kind: "goal", label: "green", seq: 0 },
      },
      {
        type: "add_node",
        node: { id: "c1", space: "work", kind: "claim", label: "existing", seq: 1 },
      },
    ]);
    const verdict = classify(
      {
        thought: "",
        action: { tool: "decompose", parent: "c1", label: "cache read path" },
      },
      state,
    );
    expect(verdict).toEqual({
      category: "rejected",
      accept: false,
      reason: "invalid_parent",
    });
  });

  it("refuses a decision whose alternative repeats its label", () => {
    const state = fold([
      {
        type: "add_node",
        node: { id: "g1", space: "work", kind: "goal", label: "green", seq: 0 },
      },
    ]);
    const verdict = classify(
      {
        thought: "",
        action: {
          tool: "decide",
          parent: "g1",
          label: "cache in the data layer",
          alternatives: ["cache in the data layer"],
          rationale: "simpler",
        },
      },
      state,
    );
    expect(verdict).toEqual({
      category: "rejected",
      accept: false,
      reason: "alternative_equals_label",
    });
  });

  it("accepts a bound decompose and decide", () => {
    const state = fold([
      {
        type: "add_node",
        node: { id: "g1", space: "work", kind: "goal", label: "green", seq: 0 },
      },
      {
        type: "add_node",
        node: { id: "sg1", space: "work", kind: "subgoal", label: "read path", seq: 1 },
      },
    ]);
    expect(
      classify(
        { thought: "", action: { tool: "decompose", parent: "g1", label: "cache read path" } },
        state,
      ),
    ).toEqual({ category: "hypothesis", accept: true });
    expect(
      classify(
        {
          thought: "",
          action: { tool: "decide", parent: "sg1", label: "data layer", rationale: "simpler" },
        },
        state,
      ),
    ).toEqual({ category: "hypothesis", accept: true });
  });
});

describe("graph actions", () => {
  const workspace = () => fsWorkspace(setup("off-by-one"));

  it("decompose creates a subgoal and a decomposes edge with llm provenance", () => {
    const state = fold([
      {
        type: "add_node",
        node: { id: "g1", space: "work", kind: "goal", label: "add caching", seq: 0 },
      },
    ]);
    const outcome = executeAction(
      { tool: "decompose", parent: "g1", label: "cache the read path" },
      state,
      workspace(),
      0,
    );
    const next = fold(outcome.events, state);
    const subgoal = [...next.nodes.values()].find((node) => node.kind === "subgoal");
    const decomposes = [...next.edges.values()].find((e) => e.kind === "decomposes");
    expect(subgoal?.label).toBe("cache the read path");
    expect(decomposes).toMatchObject({
      from: "g1",
      to: subgoal?.id,
      provenance: { kind: "llm" },
    });
  });

  it("decide creates a decision, its alternatives, and path edges", () => {
    const state = fold([
      {
        type: "add_node",
        node: { id: "g1", space: "work", kind: "goal", label: "add caching", seq: 0 },
      },
      {
        type: "add_node",
        node: { id: "sg1", space: "work", kind: "subgoal", label: "cache read path", seq: 1 },
      },
      {
        type: "add_edge",
        edge: {
          id: "ed",
          from: "g1",
          to: "sg1",
          kind: "decomposes",
          provenance: { kind: "llm" },
          status: "open",
        },
      },
    ]);
    const outcome = executeAction(
      {
        tool: "decide",
        parent: "sg1",
        label: "cache in the data layer",
        alternatives: ["cache via middleware", "cache in the data layer"],
        rationale: "simpler",
      },
      state,
      workspace(),
      0,
    );
    const next = fold(outcome.events, state);
    const decisions = [...next.nodes.values()].filter((node) => node.kind === "decision");
    const chosen = decisions.find((node) => node.label === "cache in the data layer");
    const rejected = decisions.find((node) => node.label === "cache via middleware");
    if (!chosen || !rejected) throw new Error("decisions not recorded");
    expect(decisions).toHaveLength(2);
    expect(next.statuses.get(chosen.id)).toBe("active");
    expect(next.statuses.get(rejected.id)).toBe("superseded");
    expect(chosen.payload).toEqual({
      options: ["cache in the data layer", "cache via middleware"],
      chosen: "cache in the data layer",
      rationale: "simpler",
    });
    const justifies = [...next.edges.values()].find((e) => e.kind === "justifies");
    const chosenOver = [...next.edges.values()].find((e) => e.kind === "chosen_over");
    expect(justifies).toMatchObject({
      from: chosen.id,
      to: "sg1",
      provenance: { kind: "llm" },
    });
    expect(chosenOver).toMatchObject({
      from: chosen.id,
      to: rejected.id,
      provenance: { kind: "llm" },
    });
    expect(project(next).frontier.decisions).toEqual([
      { id: chosen.id, label: "cache in the data layer", over: [rejected.id] },
    ]);
  });

  it("reuses an existing decision node when a later decision rejects it", () => {
    const state = fold([
      {
        type: "add_node",
        node: { id: "g1", space: "work", kind: "goal", label: "add caching", seq: 0 },
      },
    ]);
    const first = executeAction(
      { tool: "decide", parent: "g1", label: "cache in the data layer", rationale: "r" },
      state,
      workspace(),
      0,
    );
    const afterFirst = fold(first.events, state);
    const original = [...afterFirst.nodes.values()].find((node) => node.kind === "decision");
    if (!original) throw new Error("no decision recorded");
    const second = executeAction(
      {
        tool: "decide",
        parent: "g1",
        label: "cache via middleware",
        alternatives: ["cache in the data layer"],
        rationale: "r",
      },
      afterFirst,
      workspace(),
      1,
    );
    const afterSecond = fold(second.events, afterFirst);
    expect(afterSecond.statuses.get(original.id)).toBe("superseded");
    expect(
      [...afterSecond.nodes.values()].filter(
        (node) => node.kind === "decision" && afterSecond.statuses.get(node.id) === "active",
      ),
    ).toMatchObject([{ label: "cache via middleware" }]);
    expect(
      [...afterSecond.nodes.values()].filter((node) => node.kind === "decision"),
    ).toHaveLength(2);
  });

  it("track attaches a claim to its parent with a supports edge", () => {
    const state = fold([
      {
        type: "add_node",
        node: { id: "g1", space: "work", kind: "goal", label: "add caching", seq: 0 },
      },
    ]);
    const outcome = executeAction(
      {
        tool: "track",
        kind: "claim",
        label: "hits are served from memory",
        parent: "g1",
        rationale: "r",
      },
      state,
      workspace(),
      0,
    );
    const next = fold(outcome.events, state);
    const claim = [...next.nodes.values()].find((node) => node.kind === "claim");
    if (!claim) throw new Error("no claim recorded");
    const supports = [...next.edges.values()].find((e) => e.kind === "supports");
    expect(supports).toMatchObject({ from: claim.id, to: "g1", provenance: { kind: "llm" } });
    expect(project(next).frontier.claims).toEqual([
      { id: claim.id, label: "hits are served from memory", supports: "g1" },
    ]);
  });

  it("track keeps a constraint global", () => {
    const outcome = executeAction(
      {
        tool: "track",
        kind: "constraint",
        label: "do not edit tests",
        forbid: ["\\.test\\.mjs$"],
      },
      fold([]),
      workspace(),
      0,
    );
    const next = fold(outcome.events);
    expect([...next.edges.values()].filter((e) => e.kind === "supports")).toHaveLength(0);
    expect(next.statuses.get("w:constraint:1")).toBe("must");
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
    expect(outcome.turn.text).toContain("arbiter");
  });

  it("still reaches a node omitted from the index window", () => {
    const nodes = [1, 2, 3, 4].map((n) => ({
      type: "add_node" as const,
      node: {
        id: `obs:${n}`,
        space: "work" as const,
        kind: "observation" as const,
        label: `step ${n}`,
        seq: n,
      },
    }));
    const state = fold(nodes);
    const context = project(state, { tail: 1 });
    expect(context.index.recent.map((entry) => entry.id)).toEqual(["obs:4"]);

    const outcome = executeAction({ tool: "query", id: "obs:1" }, state, workspace(), 0);
    expect(outcome.turn.text).toContain("obs:1");
    expect(outcome.turn.text).not.toContain("obs:4");
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
          { tool: "track", kind: "claim", label: "loop stops one short", parent: "g1" },
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
    expect(unboundWorkNodes(result.events)).toEqual([]);
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

  it("records a refusal for a forbidden edit", async () => {
    const root = setup("off-by-one");
    const workspace = fsWorkspace(root);

    const result = await runAgent(
      {
        propose: scripted([
          { tool: "edit", path: "test/sum.test.mjs", find: "15", replace: "10" },
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

    const rejection = result.events.find((event) => event.type === "record_rejection");
    if (!rejection || rejection.type !== "record_rejection") {
      throw new Error("no rejection recorded");
    }
    expect(rejection.tool).toBe("edit");
    expect(rejection.target).toBe("test/sum.test.mjs");
    expect(rejection.reason).toBe("constraint_violation:\\.test\\.mjs$");
    expect(rejection.constraintId).toBe("k1");
    expect(project(fold(result.events)).frontier.refusals).toEqual([
      "edit test/sum.test.mjs — constraint_violation:\\.test\\.mjs$ (k1)",
    ]);
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

  it("invalidates a verified claim when the code changes again", async () => {
    const root = setup("off-by-one");
    const workspace = fsWorkspace(root);

    const result = await runAgent(
      {
        propose: scripted([
          { tool: "read", path: "src/sum.mjs" },
          { tool: "track", kind: "claim", label: "loop stops one short", parent: "g1" },
          { tool: "edit", path: "src/sum.mjs", find: "i < n", replace: "i <= n" },
          { tool: "run", command: "node --test" },
          {
            tool: "edit",
            path: "src/sum.mjs",
            find: "let total = 0;",
            replace: "let total = 0; // sum",
          },
          { tool: "finish", summary: "done" },
        ]),
        workspace,
        maxTurns: 10,
      },
      { goal: { id: "g1", label: "make node --test pass" } },
    );

    const state = fold(result.events);
    const frontier = project(state).frontier;
    expect(frontier.verified).toEqual([]);
    expect(frontier.invalidated).toHaveLength(1);
    expect(
      [...state.edgeStatuses.entries()].some(
        ([id, status]) =>
          status === "stale" && state.edges.get(id)?.kind === "verifies",
      ),
    ).toBe(true);
  });

  it("records a mutate for a non-forbidden file a run changed", async () => {
    const root = setup("off-by-one");
    const workspace = fsWorkspace(root);

    const result = await runAgent(
      {
        propose: scripted([
          { tool: "run", command: "printf 'note\\n' > src/note.txt" },
          { tool: "finish", summary: "done" },
        ]),
        workspace,
        maxTurns: 5,
      },
      { goal: { id: "g1", label: "noop" } },
    );

    expect(
      result.events.some(
        (event) => event.type === "mutate" && event.ref === "file:src/note.txt",
      ),
    ).toBe(true);
  });

  it("observes an external change and records a mutate", async () => {
    const root = setup("off-by-one");
    const workspace = fsWorkspace(root);
    let step = 0;
    const proposer = async (): Promise<Proposal> => {
      const current = step;
      step += 1;
      if (current === 0) {
        return { thought: "read", action: { tool: "read", path: "src/sum.mjs" } };
      }
      if (current === 1) {
        workspace.write("src/sum.mjs", "export function sumTo() { return 0; }\n");
        return { thought: "look", action: { tool: "grep", pattern: "sumTo" } };
      }
      return { thought: "done", action: { tool: "finish", summary: "done" } };
    };

    const result = await runAgent(
      { propose: proposer, workspace, maxTurns: 5 },
      { goal: { id: "g1", label: "noop" } },
    );

    expect(
      result.events.some(
        (event) => event.type === "mutate" && event.actionId.startsWith("reconcile"),
      ),
    ).toBe(true);
  });
});
