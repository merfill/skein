import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { inquiryMessages, runInquiryUnit, seedInquiry, type InquiryDeps } from "../src/inquiry";
import type { Event } from "../src/ir/events";
import { fold, hypothesisPayloadOf } from "../src/ir/graph";
import type { Action, Proposals } from "../src/llm/schemas";
import { toProposal } from "../src/llm/tools";
import { executeAction } from "../src/tools";
import { fsWorkspace, type Workspace } from "../src/tools/workspace";

function open(
  label: string,
  suppose: string,
  ifTrue = "yes",
  ifFalse = "no",
): Action {
  return { operator: "open_hypothesis", label, suppose, ifTrue, ifFalse };
}

function close(
  id: string,
  verdict: "confirmed" | "refuted" | "dropped",
  summary = "summary of the work",
): Action {
  return { operator: "close_hypothesis", id, verdict, summary };
}

function closeGoal(
  outcome: "achieved" | "not_achieved",
  summary = "final report",
): Action {
  return { operator: "close_goal", outcome, summary };
}

function read(path: string): Action {
  return { operator: "apply", action: { tool: "read", path } };
}

function write(path: string, content: string): Action {
  return { operator: "apply", action: { tool: "write", path, content } };
}

function bash(command: string): Action {
  return { operator: "apply", action: { tool: "bash", command } };
}

function step(
  events: Event[],
  workspace: Workspace,
  action: Action,
  turn = 0,
): { events: Event[]; text: string } {
  const state = fold(events);
  const outcome = executeAction(action, state, workspace, turn, undefined, { hypothesisRules: true });
  return { events: [...events, ...outcome.events], text: outcome.turn.text };
}

function textOf(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => {
      if (part.type === "text" || part.type === "reasoning") return part.text;
      if (part.type === "tool-result") {
        const value = (part.output as { value?: unknown }).value;
        return typeof value === "string" ? value : "";
      }
      return "";
    })
    .join("\n");
}

describe("inquiry", () => {
  let dir: string;
  let workspace: Workspace;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skein-inquiry-"));
    writeFileSync(join(dir, "a.txt"), "alpha\n");
    writeFileSync(join(dir, "b.txt"), "beta\n");
    workspace = fsWorkspace(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs a hypothesis and closes the goal with its summary", async () => {
    let stepNo = 0;
    const propose = async (): Promise<Proposals> => {
      stepNo += 1;
      if (stepNo === 1) return { thought: "", actions: [open("file", "a.txt exists")] };
      if (stepNo === 2) return { thought: "", actions: [read("a.txt")] };
      if (stepNo === 3) return { thought: "", actions: [close("C1", "confirmed", "a.txt exists")] };
      if (stepNo === 4) return { thought: "", actions: [closeGoal("achieved", "the final report")] };
      throw new Error("unexpected turn");
    };
    const deps: InquiryDeps = { propose, workspace, maxTurns: 10 };
    const result = await runInquiryUnit(deps, {
      request: { id: "r1", text: "check a.txt" },
    });

    expect(result.final).toBe("the final report");
    expect(result.turns).toBe(4);
    expect(result.done).toBe(true);
    expect(result.stopReason).toBe("achieved");
    expect(result.unresolved).toEqual([]);
    const tape = inquiryMessages(fold(result.events), { id: "r1", text: "check a.txt" })
      .map(textOf)
      .join("\n");
    expect(tape).toContain("Opening hypothesis C1: file.");
    expect(tape).toContain("Closing hypothesis C1: confirmed");
    expect(tape).toContain("Closing formula H: achieved.");
    expect(tape).toContain("Summary: the final report");
    expect(tape).not.toContain("step under");
  });

  it("refuses a malformed open_hypothesis instead of throwing", () => {
    const events = seedInquiry({ id: "r1", text: "t" });
    const proposal = toProposal(
      "open_hypothesis",
      { suppose: "s", if_true: "y", if_false: "n" },
      "",
    );
    const outcome = executeAction(proposal.action, fold(events), workspace, 0, undefined, {
      hypothesisRules: true,
    });
    expect(outcome.turn.text).toContain("bad_hypothesis");

    const empty = step(events, workspace, open("", "s"));
    expect(empty.text).toContain("bad_hypothesis");
  });

  it("records a model error instead of crashing", async () => {
    const propose = async (): Promise<Proposals> => {
      throw new Error("invalid tool call");
    };
    const result = await runInquiryUnit(
      { propose, workspace, maxTurns: 5 },
      { request: { id: "r1", text: "t" } },
    );
    expect(result.done).toBe(false);
    expect(result.stopReason).toBe("model_error");
    expect(result.final).toBe("");
  });

  it("requires an open hypothesis for actions", () => {
    let events = seedInquiry({ id: "r1", text: "t" });
    expect(step(events, workspace, bash("echo hi")).text).toContain("no_open");

    const empty = step(events, workspace, open("q", "s", "", ""));
    expect(empty.text).toContain("bad_expectation");

    events = step(events, workspace, open("p", "s")).events;
    const written = step(events, workspace, write("c.txt", "x"));
    expect(written.text).toContain("wrote c.txt");
  });

  it("fixes a hypothesis's mode by its first child and refuses mixing", () => {
    let events = seedInquiry({ id: "r1", text: "t" });
    events = step(events, workspace, open("p", "s")).events;
    events = step(events, workspace, read("a.txt")).events;
    expect(step(events, workspace, open("q", "s")).text).toContain("not_formula");

    let nested = seedInquiry({ id: "r1", text: "t" });
    nested = step(nested, workspace, open("root", "s")).events;
    nested = step(nested, workspace, open("child", "s")).events;
    nested = step(nested, workspace, read("a.txt")).events;
    nested = step(nested, workspace, close("C1.1", "confirmed")).events;
    expect(step(nested, workspace, bash("echo hi")).text).toContain("not_leaf");
  });

  it("refuses to close a hypothesis with no child", () => {
    let events = seedInquiry({ id: "r1", text: "t" });
    events = step(events, workspace, open("p", "s")).events;
    expect(step(events, workspace, close("C1", "confirmed")).text).toContain("empty_hypothesis");
  });

  it("nests hypotheses with hierarchical ids and closes the active one", () => {
    let events = seedInquiry({ id: "r1", text: "t" });
    events = step(events, workspace, open("root", "s")).events;
    events = step(events, workspace, open("child", "s")).events;
    events = step(events, workspace, read("a.txt")).events;

    const tape = inquiryMessages(fold(events), { id: "r1", text: "t" }).map(textOf).join("\n");
    expect(tape).toContain("Opening hypothesis C1: root.");
    expect(tape).toContain("Opening hypothesis C1.1: child.");

    // The parent formula is not closeable while its child is open.
    expect(step(events, workspace, close("C1", "confirmed")).text).toContain("not_open");
    events = step(events, workspace, close("C1.1", "confirmed", "child done")).events;

    // The parent is now a formula and takes sub-hypotheses, not actions.
    expect(step(events, workspace, bash("echo hi")).text).toContain("not_leaf");
    events = step(events, workspace, close("C1", "confirmed", "formula done")).events;

    // A new root takes the next root id.
    events = step(events, workspace, open("second", "s")).events;
    const tape2 = inquiryMessages(fold(events), { id: "r1", text: "t" }).map(textOf).join("\n");
    expect(tape2).toContain("Opening hypothesis C2: second.");
  });

  it("requires the open formula to be closed before the goal", () => {
    let events = seedInquiry({ id: "r1", text: "t" });
    events = step(events, workspace, open("root", "s")).events;
    events = step(events, workspace, open("child", "s")).events;
    events = step(events, workspace, read("a.txt")).events;
    events = step(events, workspace, close("C1.1", "confirmed")).events;
    expect(step(events, workspace, closeGoal("achieved")).text).toContain("open_predicate");
    events = step(events, workspace, close("C1", "confirmed")).events;
    expect(step(events, workspace, closeGoal("achieved", "final")).text).toContain("close_goal achieved");
  });

  it("offers the surface for the active mode", async () => {
    const seen: string[][] = [];
    let stepNo = 0;
    const propose = async (
      _messages: ModelMessage[],
      options?: { signal?: AbortSignal; allowedTools?: readonly string[] },
    ): Promise<Proposals> => {
      seen.push([...(options?.allowedTools ?? [])]);
      stepNo += 1;
      if (stepNo === 1) return { thought: "", actions: [open("root", "s")] };
      if (stepNo === 2) return { thought: "", actions: [open("child", "s")] };
      if (stepNo === 3) return { thought: "", actions: [read("a.txt")] };
      if (stepNo === 4) return { thought: "", actions: [close("C1.1", "confirmed")] };
      if (stepNo === 5) return { thought: "", actions: [close("C1", "confirmed")] };
      if (stepNo === 6) return { thought: "", actions: [closeGoal("achieved", "final")] };
      throw new Error("the engine must not call the model after the goal closes");
    };
    const result = await runInquiryUnit(
      { propose, workspace, maxTurns: 10 },
      { request: { id: "r1", text: "t" } },
    );
    expect(result.done).toBe(true);
    expect(seen[0]).toEqual(["open_hypothesis", "close_goal"]);
    expect(seen[1]).toContain("open_hypothesis");
    expect(seen[1]).not.toContain("close_hypothesis");
    expect(seen[3]).toContain("close_hypothesis");
    expect(seen[3]).not.toContain("open_hypothesis");
    expect(seen[4]).toEqual(["open_hypothesis", "close_hypothesis"]);
    expect(seen[5]).toEqual(["open_hypothesis", "close_goal"]);
  });

  it("enforces the open state and a non-empty summary", () => {
    let events = seedInquiry({ id: "r1", text: "t" });
    events = step(events, workspace, open("p", "s")).events;
    events = step(events, workspace, read("a.txt")).events;

    const notOpen = step(events, workspace, close("C9", "confirmed"));
    expect(notOpen.text).toContain("not_open");
    expect(notOpen.text).toContain("Open: C1");

    const empty = step(events, workspace, close("C1", "confirmed", "   "));
    expect(empty.text).toContain("bad_summary");

    const closed = step(events, workspace, close("C1", "confirmed"));
    expect(closed.text).toContain("close_hypothesis C1 confirmed");

    const again = step(closed.events, workspace, close("C1", "confirmed"));
    expect(again.text).toContain("already closed");
  });

  it("scopes repeated actions to the current hypothesis", () => {
    let events = seedInquiry({ id: "r1", text: "t" });
    events = step(events, workspace, open("first", "f")).events;
    events = step(events, workspace, read("a.txt")).events;
    events = step(events, workspace, close("C1", "confirmed")).events;
    events = step(events, workspace, open("second", "s")).events;

    const secondRead = step(events, workspace, read("a.txt"));
    expect(secondRead.text).not.toContain("repeated_action");
    const repeated = step(secondRead.events, workspace, read("a.txt"));
    expect(repeated.text).toContain("repeated_action");
  });

  it("records cited hypotheses as references on the opening", () => {
    let events = seedInquiry({ id: "r1", text: "t" });
    events = step(events, workspace, open("first", "a")).events;
    events = step(events, workspace, read("a.txt")).events;
    events = step(events, workspace, close("C1", "confirmed")).events;
    const cited: Action = {
      operator: "open_hypothesis",
      label: "second",
      suppose: "b",
      ifTrue: "y",
      ifFalse: "n",
      followsFrom: ["C1", "C9"],
    };
    events = step(events, workspace, cited).events;

    const state = fold(events);
    expect(hypothesisPayloadOf(state, "C2")?.followsFrom).toEqual(["C1", "C9"]);
    expect([...state.edges.values()].some((edge) => edge.kind === "follows_from")).toBe(true);
    const tape = inquiryMessages(state, { id: "r1", text: "t" }).map(textOf).join("\n");
    expect(tape).toContain("Follows from: C1, C9");
  });

  it("keeps a successful open and close on the tape", () => {
    let events = seedInquiry({ id: "r1", text: "t" });
    events = step(events, workspace, open("root", "make a.txt change")).events;
    events = step(events, workspace, read("a.txt")).events;
    events = step(events, workspace, close("C1", "confirmed")).events;

    const all = inquiryMessages(fold(events), { id: "r1", text: "t" }).map(textOf).join("\n");
    expect(all).toContain("Opening hypothesis C1: root.");
    expect(all).toContain("Closing hypothesis C1: confirmed.");
    expect(all).toContain("Summary: summary of the work");
    expect(all).not.toContain("All hypotheses are closed");
    expect(all).not.toContain('"hypothesis_id"');
    expect(all).not.toContain("w:hypothesis");
    expect(all).not.toContain("[obs:");
  });

  it("closes the goal and uses its summary as the final answer", async () => {
    let stepNo = 0;
    const propose = async (): Promise<Proposals> => {
      stepNo += 1;
      if (stepNo === 1) return { thought: "", actions: [open("root", "p")] };
      if (stepNo === 2) return { thought: "", actions: [read("a.txt")] };
      if (stepNo === 3) return { thought: "", actions: [close("C1", "confirmed", "the cause")] };
      if (stepNo === 4) return { thought: "", actions: [closeGoal("achieved", "the root report")] };
      throw new Error("the engine must not call the model after the goal closes");
    };
    const result = await runInquiryUnit(
      { propose, workspace, maxTurns: 10 },
      { request: { id: "r1", text: "t" } },
    );
    expect(result.final).toBe("the root report");
    expect(result.done).toBe(true);
    expect(result.stopReason).toBe("achieved");
    expect(result.unresolved).toEqual([]);
  });

  it("closes the goal as not achieved after a refuted hypothesis", async () => {
    let stepNo = 0;
    const propose = async (): Promise<Proposals> => {
      stepNo += 1;
      if (stepNo === 1) return { thought: "", actions: [open("H", "the cause")] };
      if (stepNo === 2) return { thought: "", actions: [read("a.txt")] };
      if (stepNo === 3) return { thought: "", actions: [close("C1", "refuted", "not the cause")] };
      if (stepNo === 4) {
        return { thought: "", actions: [closeGoal("not_achieved", "ruled out: a.txt is not the cause")] };
      }
      throw new Error("the engine must not call the model after the goal closes");
    };
    const result = await runInquiryUnit(
      { propose, workspace, maxTurns: 10 },
      { request: { id: "r1", text: "t" } },
    );
    expect(result.final).toBe("ruled out: a.txt is not the cause");
    expect(result.done).toBe(true);
    expect(result.stopReason).toBe("not_achieved");
    expect(result.unresolved).toEqual([]);
  });

  it("validates close_goal", () => {
    let events = seedInquiry({ id: "r1", text: "t" });
    events = step(events, workspace, open("p", "s")).events;
    expect(step(events, workspace, closeGoal("achieved")).text).toContain("open_predicate");

    events = step(events, workspace, read("a.txt")).events;
    events = step(events, workspace, close("C1", "confirmed")).events;
    expect(step(events, workspace, closeGoal("achieved", "   ")).text).toContain("bad_summary");
    const ok = step(events, workspace, closeGoal("achieved", "final"));
    expect(ok.text).toContain("close_goal achieved");
  });

  it("refuses an action after the hypothesis closes", () => {
    let events = seedInquiry({ id: "r1", text: "t" });
    events = step(events, workspace, open("p", "s")).events;
    events = step(events, workspace, read("a.txt")).events;
    events = step(events, workspace, close("C1", "confirmed")).events;
    expect(step(events, workspace, bash("echo hi")).text).toContain("no_open");
  });

  it("rejects a reply that mixes a hypothesis tool with other calls", async () => {
    let stepNo = 0;
    const propose = async (): Promise<Proposals> => {
      stepNo += 1;
      if (stepNo === 1) return { thought: "", actions: [open("H", "the cause"), read("a.txt")] };
      if (stepNo === 2) return { thought: "", actions: [open("H", "the cause")] };
      if (stepNo === 3) return { thought: "", actions: [read("a.txt")] };
      if (stepNo === 4) return { thought: "", actions: [close("C1", "confirmed", "the cause held")] };
      if (stepNo === 5) {
        return { thought: "", actions: [closeGoal("achieved", "the cause held")] };
      }
      throw new Error("the engine must not call the model after the goal closes");
    };
    const result = await runInquiryUnit(
      { propose, workspace, maxTurns: 10 },
      { request: { id: "r1", text: "t" } },
    );
    expect(result.final).toBe("the cause held");
    expect(result.stopReason).toBe("achieved");
    const tape = inquiryMessages(fold(result.events), { id: "r1", text: "t" })
      .map(textOf)
      .join("\n");
    expect(tape).toContain("hypothesis_tool_alone");
  });

  it("treats a reply without tool calls while a hypothesis is open as an error", async () => {
    let stepNo = 0;
    const propose = async (): Promise<Proposals> => {
      stepNo += 1;
      if (stepNo === 1) return { thought: "", actions: [open("p", "unknown")] };
      return { thought: "cannot resolve", actions: [] };
    };
    const result = await runInquiryUnit(
      { propose, workspace, maxTurns: 10 },
      { request: { id: "r1", text: "t" } },
    );
    expect(result.final).toBe("");
    expect(result.done).toBe(false);
    expect(result.stopReason).toBe("no_close");
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.id).toBe("C1");
  });

  it("treats a reply without tool calls while no hypothesis is open as an error", async () => {
    let stepNo = 0;
    const propose = async (): Promise<Proposals> => {
      stepNo += 1;
      if (stepNo === 1) return { thought: "", actions: [open("p", "s")] };
      if (stepNo === 2) return { thought: "", actions: [read("a.txt")] };
      if (stepNo === 3) return { thought: "", actions: [close("C1", "confirmed", "done")] };
      return { thought: "stop", actions: [] };
    };
    const result = await runInquiryUnit(
      { propose, workspace, maxTurns: 10 },
      { request: { id: "r1", text: "t" } },
    );
    expect(result.final).toBe("");
    expect(result.done).toBe(false);
    expect(result.stopReason).toBe("no_goal");
    expect(result.unresolved).toEqual([]);
  });
});
