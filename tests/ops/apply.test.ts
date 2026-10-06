import { afterEach, describe, expect, it } from "vitest";

import type { Event } from "../../src/ir/events";
import { currentVersion, predicateOf } from "../../src/ir/graph";
import { currentGoalId } from "../../src/ir/traversal";
import {
  DEFAULT_FILES,
  applyTool,
  check,
  classification,
  cleanupWorkspaces,
  edit,
  exec,
  grep,
  interpretation,
  makeWorkspace,
  read,
  request,
  run,
} from "./helpers";

afterEach(cleanupWorkspaces);

describe("apply: read", () => {
  it("OP-AP-READ-1 reads a file into an observation and records the observed version", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { state, outcome } = exec(read("src/sum.mjs"), [request()], ws);
    expect(outcome.turn.nodeId).toMatch(/^obs:/);
    expect(state.observed.get("file:src/sum.mjs")).toBeDefined();
    expect([...state.edges.values()].some((e) => e.kind === "produces")).toBe(true);
  });

  it("OP-AP-READ-2 a different window is a new action", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const first = exec(read("src/sum.mjs"), [request()], ws);
    expect(classification(read("src/sum.mjs", 1, 1), first.events).accept).toBe(true);
    const second = exec(read("src/sum.mjs", 1, 1), first.events, ws);
    expect(second.events.filter((e) => e.type === "add_node" && e.node.kind === "observation")).toHaveLength(2);
  });

  it("OP-AP-READ-3 a missing file is a fail observation, not a crash", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { outcome, state } = exec(read("src/nope.mjs"), [request()], ws);
    const obs = outcome.turn.nodeId ? state.nodes.get(outcome.turn.nodeId) : undefined;
    expect((obs?.payload as { verdict?: string } | undefined)?.verdict).toBe("fail");
  });

  it("OP-AP-READ-4 / REF-REPEAT refuses an identical read with an unchanged world", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const first = exec(read("src/sum.mjs"), [request()], ws);
    expect(classification(read("src/sum.mjs"), first.events).reason).toMatch(/repeated_action/);
  });
});

describe("apply: grep", () => {
  it("OP-AP-GREP-1 scoped grep returns matches as an observation", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { outcome } = exec(grep("sum", "src"), [request()], ws);
    expect(outcome.turn.text).toContain("sum");
  });

  it("OP-AP-GREP-2 paging with from/count is a new action", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const page = applyTool({ tool: "grep", pattern: "sum", path: "src", count: 1 });
    const first = exec(page, [request()], ws);
    const next = applyTool({ tool: "grep", pattern: "sum", path: "src", count: 1, from: 2 });
    expect(classification(next, first.events).accept).toBe(true);
  });

  it("OP-AP-GREP-3 a bad scope is a fail observation", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { outcome, state } = exec(grep("sum", "nope"), [request()], ws);
    const obs = outcome.turn.nodeId ? state.nodes.get(outcome.turn.nodeId) : undefined;
    expect((obs?.payload as { verdict?: string } | undefined)?.verdict).toBe("fail");
  });

  it("OP-AP-GREP-4 / REF-REPEAT refuses an identical grep", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const first = exec(grep("sum", "src"), [request()], ws);
    expect(classification(grep("sum", "src"), first.events).reason).toMatch(/repeated_action/);
  });
});

describe("apply: list", () => {
  it("OP-AP-LIST-1 lists files as an observation", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { outcome } = exec(applyTool({ tool: "list" }), [request()], ws);
    expect(outcome.turn.text).toContain("src/sum.mjs");
  });

  it("OP-AP-LIST-2 paging reports a next cursor", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { outcome } = exec(applyTool({ tool: "list", limit: 1 }), [request()], ws);
    const body = JSON.parse(outcome.turn.text);
    expect(body.total).toBeGreaterThan(1);
    expect(body.next).toBeDefined();
  });
});

describe("apply: edit", () => {
  it("OP-AP-EDIT-1 replaces text, records a mutate, and bumps the file version", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const first = exec(read("src/sum.mjs"), [request()], ws);
    const before = currentVersion(first.state, "file:src/sum.mjs");
    const { events, state } = exec(edit("src/sum.mjs", "a - b", "a + b"), first.events, ws);
    expect(events.some((e) => e.type === "mutate")).toBe(true);
    expect(ws.read("src/sum.mjs")).toContain("a + b");
    expect(currentVersion(state, "file:src/sum.mjs")).not.toBe(before);
  });

  it("OP-AP-EDIT-2 a missing find materializes the file and fails, recording the attempt", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { events, outcome, state } = exec(edit("src/sum.mjs", "NOT PRESENT", "x"), [request()], ws);
    const obs = outcome.turn.nodeId ? state.nodes.get(outcome.turn.nodeId) : undefined;
    expect((obs?.payload as { verdict?: string } | undefined)?.verdict).toBe("fail");
    const action = [...state.nodes.values()].find((n) => n.kind === "action");
    expect((action?.payload as { find?: string } | undefined)?.find).toBe("NOT PRESENT");
    expect(events.some((e) => e.type === "add_node" && e.node.kind === "observation")).toBe(true);
  });

  it("OP-AP-EDIT-3 / REF-EDIT-CONSTRAINT refuses a forbidden path", () => {
    const constraint: Event = {
      type: "add_node",
      node: { id: "c1", space: "work", kind: "constraint", label: "no src", payload: { forbid: ["src/"] }, seq: 1 },
    };
    const reason = classification(edit("src/sum.mjs", "a", "b"), [request(), constraint]).reason;
    expect(reason).toMatch(/constraint_violation/);
  });

  it("OP-AP-EDIT-4 / REF-EDIT-STALE refuses editing on a stale read", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const first = exec(read("src/sum.mjs"), [request()], ws);
    // A successful edit mutates the file; the read is now stale.
    const mutated = exec(edit("src/sum.mjs", "a - b", "a + b"), first.events, ws);
    expect(classification(edit("src/sum.mjs", "a + b", "a - b"), mutated.events).reason).toBe("stale_base");
  });
});

function objectiveAtFocus(ws: ReturnType<typeof makeWorkspace>["ws"], command: string) {
  const opened = exec(interpretation("fix", command), [request()], ws);
  return { goal: currentGoalId(opened.state)!, events: opened.events };
}

describe("apply: run", () => {
  it("OP-AP-RUN-1 runs an exploratory command and records its output", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { outcome } = exec(run("echo hello"), [request()], ws);
    expect(outcome.turn.text).toContain("hello");
  });

  it("OP-AP-RUN-1 / REF-REPEAT refuses an identical exploratory run", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const first = exec(run("echo hello"), [request()], ws);
    expect(classification(run("echo hello"), first.events).reason).toMatch(/repeated_action/);
  });

  it("OP-AP-RUN-2 checks an objective focus goal and settles it", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { goal, events } = objectiveAtFocus(ws, "true");
    expect(classification(check(goal), events).accept).toBe(true);
    const { events: after, state } = exec(check(goal), events, ws);
    expect(after.some((e) => e.type === "record_check" && e.verdict === "pass")).toBe(true);
    expect(predicateOf(state, goal)).toBe("achieved");
  });

  it("OP-AP-RUN-3 a check with under links assumptions and reaches achieved_under", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { goal, events } = objectiveAtFocus(ws, "true");
    const withUnder = applyTool({ tool: "run", target: goal, under: [goal] });
    const { state } = exec(withUnder, events, ws);
    expect(predicateOf(state, goal)).toBe("achieved_under");
    expect([...state.edges.values()].some((e) => e.kind === "under")).toBe(true);
  });

  it("OP-AP-RUN-4 an inconclusive check stays open and may be retried", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES, { runTimeoutMs: 150 });
    const opened = exec(interpretation("fix", "sleep 5"), [request()], ws);
    const goal = currentGoalId(opened.state)!;
    const first = exec(check(goal), opened.events, ws);
    expect(predicateOf(first.state, goal)).toBe("open");
    expect(classification(check(goal), first.events).accept).toBe(true);
  });

  it("OP-AP-RUN-5 starts a background command and returns a job id", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { outcome } = exec(applyTool({ tool: "run", background: true, command: "true" }), [request()], ws);
    expect(outcome.turn.text).toMatch(/started job job-\d+/);
  });

  it("OP-AP-RUN-6 polls a background job to completion", async () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const started = exec(applyTool({ tool: "run", background: true, command: "true" }), [request()], ws);
    const jobId = started.outcome.turn.text.match(/job-\d+/)?.[0];
    expect(jobId).toBeDefined();

    let events = started.events;
    let text = "";
    for (let i = 0; i < 100; i += 1) {
      const poll = exec(applyTool({ tool: "run", job: jobId! }), events, ws);
      events = poll.events;
      text = poll.outcome.turn.text;
      if (!/running/.test(text)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(text).toMatch(/exit 0/);
  });

  it("REF-RUN-EMPTY rejects a run with neither command nor target", () => {
    expect(classification(applyTool({ tool: "run" }), [request()]).reason).toMatch(/needs a command/);
  });

  it("REF-RUN-SUBJ rejects a check of a subjective goal", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const opened = exec(interpretation("do it"), [request()], ws);
    const goal = currentGoalId(opened.state)!;
    expect(classification(check(goal), opened.events).reason).toMatch(/subjective_goal_needs_complete/);
  });

  it("REF-RUN-TARGET rejects a check of a non-goal", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const first = exec(read("src/sum.mjs"), [request()], ws);
    const obs = first.outcome.turn.nodeId!;
    expect(classification(check(obs), first.events).reason).toBe("invalid_target");
  });

  it("REF-RUN-CMD rejects substituting a check's command", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { goal, events } = objectiveAtFocus(ws, "true");
    const bad = applyTool({ tool: "run", target: goal, command: "false" });
    expect(classification(bad, events).reason).toMatch(/its check runs its own command/);
  });

  it("REF-RUN-BGCHECK rejects backgrounding a check", () => {
    const { ws } = makeWorkspace(DEFAULT_FILES);
    const { goal, events } = objectiveAtFocus(ws, "true");
    const bad = applyTool({ tool: "run", target: goal, background: true });
    expect(classification(bad, events).reason).toMatch(/background_target/);
  });

  it("REF-RUN-BGCMD rejects background without a command", () => {
    expect(classification(applyTool({ tool: "run", background: true }), [request()]).reason).toMatch(/background_run/);
  });

  it("REF-RUN-POLL rejects a poll with extra fields", () => {
    const bad = applyTool({ tool: "run", job: "job-1", command: "x" });
    expect(classification(bad, [request()]).reason).toMatch(/job_poll/);
  });
});
