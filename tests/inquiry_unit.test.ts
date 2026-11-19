import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { inquiryMessages, runInquiryUnit, seedInquiry, type InquiryDeps } from "../src/inquiry";
import type { Event } from "../src/ir/events";
import { fold, hypothesisPayloadOf } from "../src/ir/graph";
import { INQUIRY_TOOLS, INQUIRY_WORK_TOOL_NAMES } from "../src/llm/inquiry";
import type { Action, Proposals } from "../src/llm/schemas";
import { toProposal } from "../src/llm/tools";
import { executeAction } from "../src/tools";
import { fsWorkspace, type Workspace } from "../src/tools/workspace";

function open(claim: string, done = "the claim is decided"): Action {
  return { operator: "open_hypothesis", claim, done };
}

function close(
  verdict: "confirmed" | "refuted" | "dropped",
  summary = "summary of the work",
  observed = "observed fact",
): Action {
  return { operator: "close_hypothesis", verdict, observed, summary };
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

function textClose(
  verdict: "confirmed" | "refuted" | "dropped" = "confirmed",
  observed = "observed fact",
  summary = "summary of the work",
): Proposals {
  return { thought: JSON.stringify({ verdict, observed, summary }), actions: [] };
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

  it("requires done in the open tool schema", () => {
    const schema = INQUIRY_TOOLS["open_hypothesis"]!.schema;
    expect(
      schema.safeParse({ claim: "s", follows_from: [] }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ claim: "s", done: "s is observed", follows_from: [] }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        claim: "s",
        done: "s is observed",
        follows_from: ["the user reports a crash"],
      }).success,
    ).toBe(false);
  });

  it("requires the observed field in the close tool schema", () => {
    const schema = INQUIRY_TOOLS["close_hypothesis"]!.schema;
    expect(
      schema.safeParse({ verdict: "confirmed", summary: "s" }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ verdict: "confirmed", observed: "o", summary: "s" })
        .success,
    ).toBe(true);
  });

  it("runs a hypothesis and closes the goal with its summary", async () => {
    let stepNo = 0;
    const propose = async (): Promise<Proposals> => {
      stepNo += 1;
      if (stepNo === 1) return { thought: "", actions: [open("a.txt exists")] };
      if (stepNo === 2) return { thought: "", actions: [read("a.txt")] };
      if (stepNo === 3) return { thought: "", actions: [close("confirmed", "a.txt exists")] };
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
    expect(tape).toContain("Opening hypothesis H1.");
    expect(tape).toContain("Closing hypothesis H1: confirmed");
    expect(tape).toContain("Closing formula H: achieved.");
    expect(tape).toContain("Summary: the final report");
    expect(tape).not.toContain("step under");
  });

  it("closes a hypothesis by text JSON and wipes its work from the tape", async () => {
    let stepNo = 0;
    const propose = async (): Promise<Proposals> => {
      stepNo += 1;
      if (stepNo === 1) return { thought: "", actions: [open("a.txt exists")] };
      if (stepNo === 2) return { thought: "", actions: [read("a.txt")] };
      if (stepNo === 3) {
        return {
          thought: JSON.stringify({
            verdict: "confirmed",
            observed: "a.txt contains alpha",
            summary: "checked a.txt",
          }),
          actions: [],
        };
      }
      if (stepNo === 4) return { thought: "", actions: [closeGoal("achieved", "the final report")] };
      throw new Error("unexpected turn");
    };
    const result = await runInquiryUnit(
      { propose, workspace, maxTurns: 10 },
      { request: { id: "r1", text: "check a.txt" } },
    );
    expect(result.done).toBe(true);
    expect(result.unresolved).toEqual([]);
    const tape = inquiryMessages(fold(result.events), { id: "r1", text: "check a.txt" })
      .map(textOf)
      .join("\n");
    expect(tape).toContain("Opening hypothesis H1.");
    expect(tape).toContain("Closing hypothesis H1: confirmed.");
    expect(tape).toContain("Observed: a.txt contains alpha");
    expect(tape).not.toContain("Claim: a.txt exists");
    expect(tape).not.toContain("Done when:");
    expect(tape).not.toContain("[obs:");
  });

  it("repairs an invalid close JSON, then closes", async () => {
    let stepNo = 0;
    let repairSeen = false;
    const propose = async (messages: ModelMessage[]): Promise<Proposals> => {
      stepNo += 1;
      if (stepNo === 1) return { thought: "", actions: [open("a.txt exists")] };
      if (stepNo === 2) return { thought: "", actions: [read("a.txt")] };
      if (stepNo === 3) return { thought: "not the close JSON", actions: [] };
      if (stepNo === 4) {
        const last = messages[messages.length - 1];
        repairSeen = last !== undefined && last.role === "user" && textOf(last).includes("JSON");
        return {
          thought: JSON.stringify({
            verdict: "confirmed",
            observed: "a.txt contains alpha",
            summary: "checked a.txt",
          }),
          actions: [],
        };
      }
      if (stepNo === 5) return { thought: "", actions: [closeGoal("achieved", "the final report")] };
      throw new Error("unexpected turn");
    };
    const result = await runInquiryUnit(
      { propose, workspace, maxTurns: 10 },
      { request: { id: "r1", text: "check a.txt" } },
    );
    expect(repairSeen).toBe(true);
    expect(result.done).toBe(true);
    expect(result.unresolved).toEqual([]);
  });

  it("refuses a malformed open_hypothesis instead of throwing", () => {
    const events = seedInquiry({ id: "r1", text: "t" });
    const proposal = toProposal("open_hypothesis", { claim: "s" }, "");
    const outcome = executeAction(proposal.action, fold(events), workspace, 0, undefined, {
      hypothesisRules: true,
    });
    expect(outcome.turn.text).toContain("bad_hypothesis");

    const empty = step(events, workspace, open(""));
    expect(empty.text).toContain("bad_hypothesis");

    const noDone = step(events, workspace, open("s", ""));
    expect(noDone.text).toContain("bad_hypothesis");

    const badFollow = step(events, workspace, {
      operator: "open_hypothesis",
      claim: "s",
      done: "s is observed",
      followsFrom: ["the user reports a crash"],
    });
    expect(badFollow.text).toContain("bad_hypothesis");
  });

  it("records done and renders it on the open tape", () => {
    const events = step(
      seedInquiry({ id: "r1", text: "t" }),
      workspace,
      open("a.txt exists", "a.txt contains alpha"),
    ).events;
    const state = fold(events);
    expect(hypothesisPayloadOf(state, "H1")?.done).toBe("a.txt contains alpha");
    const tape = inquiryMessages(state, { id: "r1", text: "t" }).map(textOf).join("\n");
    expect(tape).toContain("Done when: a.txt contains alpha.");
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

    events = step(events, workspace, open("s")).events;
    const written = step(events, workspace, write("c.txt", "x"));
    expect(written.text).toContain("wrote c.txt");
  });

  it("fixes a hypothesis's mode by its first child and refuses mixing", () => {
    let events = seedInquiry({ id: "r1", text: "t" });
    events = step(events, workspace, open("s")).events;
    events = step(events, workspace, read("a.txt")).events;
    expect(step(events, workspace, open("s")).text).toContain("not_formula");

    let nested = seedInquiry({ id: "r1", text: "t" });
    nested = step(nested, workspace, open("s")).events;
    nested = step(nested, workspace, open("s")).events;
    nested = step(nested, workspace, read("a.txt")).events;
    nested = step(nested, workspace, close("confirmed")).events;
    expect(step(nested, workspace, bash("echo hi")).text).toContain("not_leaf");
  });

  it("closes a derived claim with no child", () => {
    let events = seedInquiry({ id: "r1", text: "t" });
    events = step(events, workspace, open("s")).events;
    const closed = step(events, workspace, close("confirmed", "derived from earlier work"));
    expect(closed.text).toContain("close_hypothesis H1 confirmed");
    const tape = inquiryMessages(fold(closed.events), { id: "r1", text: "t" }).map(textOf).join("\n");
    expect(tape).toContain("Closing hypothesis H1: confirmed.");
    expect(tape).not.toContain("Claim: s");
  });

  it("nests hypotheses with hierarchical ids and closes the active one", () => {
    let events = seedInquiry({ id: "r1", text: "t" });
    events = step(events, workspace, open("s")).events;
    events = step(events, workspace, open("s")).events;
    events = step(events, workspace, read("a.txt")).events;

    const tape = inquiryMessages(fold(events), { id: "r1", text: "t" }).map(textOf).join("\n");
    expect(tape).toContain("Opening hypothesis H1.");
    expect(tape).toContain("Opening hypothesis H1.1.");

    events = step(events, workspace, close("confirmed", "child done")).events;

    // The parent is now a formula and takes sub-hypotheses, not actions.
    expect(step(events, workspace, bash("echo hi")).text).toContain("not_leaf");
    events = step(events, workspace, close("confirmed", "formula done")).events;

    // A new root takes the next root id.
    events = step(events, workspace, open("s")).events;
    const tape2 = inquiryMessages(fold(events), { id: "r1", text: "t" }).map(textOf).join("\n");
    expect(tape2).toContain("Opening hypothesis H2.");
  });

  it("requires the open formula to be closed before the goal", () => {
    let events = seedInquiry({ id: "r1", text: "t" });
    events = step(events, workspace, open("s")).events;
    events = step(events, workspace, open("s")).events;
    events = step(events, workspace, read("a.txt")).events;
    events = step(events, workspace, close("confirmed")).events;
    expect(step(events, workspace, closeGoal("achieved")).text).toContain("open_predicate");
    events = step(events, workspace, close("confirmed")).events;
    expect(step(events, workspace, closeGoal("achieved", "final")).text).toContain("close_goal achieved");
  });

  it("passes the exact tool surface for every step type", async () => {
    const WORK = [...INQUIRY_WORK_TOOL_NAMES];
    for (const name of [
      "read",
      "grep",
      "list",
      "edit",
      "write",
      "apply_patch",
      "bash",
      "webfetch",
      "recall",
      "search",
    ]) {
      expect(WORK).toContain(name);
    }
    expect(WORK).not.toContain("close_hypothesis");
    const seen: string[][] = [];
    let stepNo = 0;
    const propose = async (
      _messages: ModelMessage[],
      options?: { signal?: AbortSignal; allowedTools?: readonly string[] },
    ): Promise<Proposals> => {
      seen.push([...(options?.allowedTools ?? [])]);
      stepNo += 1;
      // No active hypothesis: open the first claim or close the goal.
      if (stepNo === 1) return { thought: "", actions: [open("s")] };
      // The root is undecided: work tools appear, plus open.
      if (stepNo === 2) return { thought: "", actions: [open("s")] };
      // The child is undecided: work tools plus open.
      if (stepNo === 3) return { thought: "", actions: [read("a.txt")] };
      // The child is a work leaf: only the work tools; close by text.
      if (stepNo === 4) return textClose("confirmed", "child done", "child done");
      // The root is a formula with its child closed: only open (or close by text).
      if (stepNo === 5) return textClose("confirmed", "formula done", "formula done");
      // No active again: open or close the goal.
      if (stepNo === 6) return { thought: "", actions: [closeGoal("achieved", "final")] };
      throw new Error("the engine must not call the model after the goal closes");
    };
    const result = await runInquiryUnit(
      { propose, workspace, maxTurns: 10 },
      { request: { id: "r1", text: "t" } },
    );
    expect(result.done).toBe(true);
    expect(seen[0]).toEqual(["open_hypothesis"]);
    expect(seen[1]).toEqual(["open_hypothesis", ...WORK]);
    expect(seen[2]).toEqual(["open_hypothesis", ...WORK]);
    expect(seen[3]).toEqual(WORK);
    expect(seen[4]).toEqual(["open_hypothesis"]);
    expect(seen[5]).toEqual(["open_hypothesis", "close_goal"]);
    for (const surface of seen) expect(surface).not.toContain("close_hypothesis");
  });

  it("passes the work surface again on the repair call", async () => {
    const WORK = [...INQUIRY_WORK_TOOL_NAMES];
    const seen: string[][] = [];
    let repairSeen = false;
    let stepNo = 0;
    const propose = async (
      messages: ModelMessage[],
      options?: { signal?: AbortSignal; allowedTools?: readonly string[] },
    ): Promise<Proposals> => {
      seen.push([...(options?.allowedTools ?? [])]);
      stepNo += 1;
      if (stepNo === 1) return { thought: "", actions: [open("s")] };
      if (stepNo === 2) return { thought: "", actions: [read("a.txt")] };
      if (stepNo === 3) return { thought: "not the close JSON", actions: [] };
      if (stepNo === 4) {
        const last = messages[messages.length - 1];
        repairSeen = last !== undefined && last.role === "user" && textOf(last).includes("JSON");
        return textClose("confirmed", "a.txt read", "read a.txt");
      }
      if (stepNo === 5) return { thought: "", actions: [closeGoal("achieved", "final")] };
      throw new Error("unexpected turn");
    };
    const result = await runInquiryUnit(
      { propose, workspace, maxTurns: 10 },
      { request: { id: "r1", text: "t" } },
    );
    expect(repairSeen).toBe(true);
    expect(result.done).toBe(true);
    expect(seen[2]).toEqual(WORK);
    expect(seen[3]).toEqual(WORK);
    expect(seen[4]).toEqual(["open_hypothesis", "close_goal"]);
  });

  it("enforces the open state and a non-empty summary", () => {
    let events = seedInquiry({ id: "r1", text: "t" });
    events = step(events, workspace, open("s")).events;
    events = step(events, workspace, read("a.txt")).events;

    const notOpen = step(seedInquiry({ id: "r1", text: "t" }), workspace, close("confirmed"));
    expect(notOpen.text).toContain("not_open");

    const empty = step(events, workspace, close("confirmed", "   "));
    expect(empty.text).toContain("bad_summary");

    const noObservation = step(events, workspace, close("confirmed", "summary", "  "));
    expect(noObservation.text).toContain("bad_observation");

    const closed = step(events, workspace, close("confirmed"));
    expect(closed.text).toContain("close_hypothesis H1 confirmed");

    const again = step(closed.events, workspace, close("confirmed"));
    expect(again.text).toContain("not_open");
  });

  it("scopes repeated actions to the current hypothesis", () => {
    let events = seedInquiry({ id: "r1", text: "t" });
    events = step(events, workspace, open("f")).events;
    events = step(events, workspace, read("a.txt")).events;
    events = step(events, workspace, close("confirmed")).events;
    events = step(events, workspace, open("s")).events;

    const secondRead = step(events, workspace, read("a.txt"));
    expect(secondRead.text).not.toContain("repeated_action");
    const repeated = step(secondRead.events, workspace, read("a.txt"));
    expect(repeated.text).toContain("repeated_action");
  });

  it("records cited hypotheses as references on the opening", () => {
    let events = seedInquiry({ id: "r1", text: "t" });
    events = step(events, workspace, open("a")).events;
    events = step(events, workspace, read("a.txt")).events;
    events = step(events, workspace, close("confirmed")).events;
    const cited: Action = {
      operator: "open_hypothesis",
      claim: "b",
      done: "b is decided",
      followsFrom: ["H1", "H9"],
    };
    events = step(events, workspace, cited).events;

    const state = fold(events);
    expect(hypothesisPayloadOf(state, "H2")?.followsFrom).toEqual(["H1", "H9"]);
    expect([...state.edges.values()].some((edge) => edge.kind === "follows_from")).toBe(true);
    const tape = inquiryMessages(state, { id: "r1", text: "t" }).map(textOf).join("\n");
    expect(tape).toContain("Follows from: H1, H9");
  });

  it("keeps a successful open and close on the tape", () => {
    let events = seedInquiry({ id: "r1", text: "t" });
    events = step(events, workspace, open("make a.txt change")).events;
    events = step(events, workspace, read("a.txt")).events;
    events = step(events, workspace, close("confirmed")).events;

    const all = inquiryMessages(fold(events), { id: "r1", text: "t" }).map(textOf).join("\n");
    expect(all).toContain("Opening hypothesis H1.");
    expect(all).toContain("Closing hypothesis H1: confirmed.");
    expect(all).toContain("Observed: observed fact");
    expect(all).toContain("Summary: summary of the work");
    expect(all).not.toContain("All hypotheses are closed");
    expect(all).not.toContain('"hypothesis_id"');
    expect(all).not.toContain("w:hypothesis");
    expect(all).not.toContain("[obs:");
  });

  it("renders a verdict from an older journal without observed", () => {
    let events = seedInquiry({ id: "r1", text: "t" });
    events = step(events, workspace, open("make a.txt change")).events;
    events = step(events, workspace, read("a.txt")).events;
    events = step(events, workspace, close("confirmed")).events;

    const legacy = JSON.parse(JSON.stringify(events)) as Event[];
    for (const event of legacy) {
      if (event.type === "add_node" && event.node.kind === "hypothesis_verdict") {
        delete (event.node.payload as { observed?: string }).observed;
      }
    }

    const tape = inquiryMessages(fold(legacy), { id: "r1", text: "t" }).map(textOf).join("\n");
    expect(tape).toContain("Closing hypothesis H1: confirmed.");
    expect(tape).toContain("(no observation recorded)");
  });

  it("closes the goal and uses its summary as the final answer", async () => {
    let stepNo = 0;
    const propose = async (): Promise<Proposals> => {
      stepNo += 1;
      if (stepNo === 1) return { thought: "", actions: [open("p")] };
      if (stepNo === 2) return { thought: "", actions: [read("a.txt")] };
      if (stepNo === 3) return { thought: "", actions: [close("confirmed", "the cause")] };
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
      if (stepNo === 1) return { thought: "", actions: [open("the cause")] };
      if (stepNo === 2) return { thought: "", actions: [read("a.txt")] };
      if (stepNo === 3) return { thought: "", actions: [close("refuted", "not the cause")] };
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
    events = step(events, workspace, open("s")).events;
    expect(step(events, workspace, closeGoal("achieved")).text).toContain("open_predicate");

    events = step(events, workspace, read("a.txt")).events;
    events = step(events, workspace, close("confirmed")).events;
    expect(step(events, workspace, closeGoal("achieved", "   ")).text).toContain("bad_summary");
    const ok = step(events, workspace, closeGoal("achieved", "final"));
    expect(ok.text).toContain("close_goal achieved");
  });

  it("refuses an action after the hypothesis closes", () => {
    let events = seedInquiry({ id: "r1", text: "t" });
    events = step(events, workspace, open("s")).events;
    events = step(events, workspace, read("a.txt")).events;
    events = step(events, workspace, close("confirmed")).events;
    expect(step(events, workspace, bash("echo hi")).text).toContain("no_open");
  });

  it("rejects a reply that mixes a hypothesis tool with other calls", async () => {
    let stepNo = 0;
    const propose = async (): Promise<Proposals> => {
      stepNo += 1;
      if (stepNo === 1) return { thought: "", actions: [open("the cause"), read("a.txt")] };
      if (stepNo === 2) return { thought: "", actions: [open("the cause")] };
      if (stepNo === 3) return { thought: "", actions: [read("a.txt")] };
      if (stepNo === 4) return { thought: "", actions: [close("confirmed", "the cause held")] };
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

  it("repairs a text reply that is not the close JSON, then stops when it still is not", async () => {
    let stepNo = 0;
    const propose = async (): Promise<Proposals> => {
      stepNo += 1;
      if (stepNo === 1) return { thought: "", actions: [open("unknown")] };
      return { thought: "cannot resolve", actions: [] };
    };
    const result = await runInquiryUnit(
      { propose, workspace, maxTurns: 10 },
      { request: { id: "r1", text: "t" } },
    );
    expect(result.final).toBe("");
    expect(result.done).toBe(false);
    expect(result.stopReason).toBe("bad_close");
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.id).toBe("H1");
  });

  it("treats a reply without tool calls while no hypothesis is open as an error", async () => {
    let stepNo = 0;
    const propose = async (): Promise<Proposals> => {
      stepNo += 1;
      if (stepNo === 1) return { thought: "", actions: [open("s")] };
      if (stepNo === 2) return { thought: "", actions: [read("a.txt")] };
      if (stepNo === 3) return { thought: "", actions: [close("confirmed", "done")] };
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
