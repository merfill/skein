import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { inquiryMessages, runInquiryUnit, seedInquiry, type InquiryDeps } from "../src/inquiry";
import type { Event } from "../src/ir/events";
import { fold } from "../src/ir/graph";
import type { Action, Proposals } from "../src/llm/schemas";
import { executeAction } from "../src/tools";
import { fsWorkspace, type Workspace } from "../src/tools/workspace";

function open(
  kind: "probe" | "change",
  label: string,
  suppose: string,
  ifTrue = "yes",
  ifFalse = "no",
): Action {
  return { operator: "claim_open", kind, label, suppose, ifTrue, ifFalse };
}

function close(
  id: string,
  verdict: "confirmed" | "refuted" | "done" | "dropped",
  grounds: string[],
): Action {
  return { operator: "claim_close", id, verdict, grounds };
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
  const outcome = executeAction(action, state, workspace, turn, undefined, { claimRules: true });
  return { events: [...events, ...outcome.events], text: outcome.turn.text };
}

function payloadOfKind(events: readonly Event[], kind: string): unknown {
  for (const event of events) {
    if (event.type === "add_node" && event.node.kind === kind) return event.node.payload;
  }
  return undefined;
}

function observationId(events: readonly Event[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "add_node" || event.node.kind !== "observation") continue;
    if ((event.node.payload as { failed?: unknown } | undefined)?.failed === true) continue;
    return event.node.id;
  }
  throw new Error("no observation");
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

function lastObservationInMessages(messages: readonly ModelMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const match = textOf(messages[index] as ModelMessage).match(/\[(obs:\d+)\]/);
    if (match?.[1] !== undefined) return match[1];
  }
  throw new Error("no observation id in messages");
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

  it("runs a hypothesis to a grounded stop through the model loop", async () => {
    let stepNo = 0;
    const propose = async (
      messages: ModelMessage[],
      options?: { final?: boolean },
    ): Promise<Proposals> => {
      if (options?.final === true) return { thought: "budget", actions: [] };
      stepNo += 1;
      if (stepNo === 1) {
        return { thought: "", actions: [open("probe", "file", "a.txt exists")] };
      }
      if (stepNo === 2) {
        return { thought: "", actions: [read("a.txt")] };
      }
      if (stepNo === 3) {
        return {
          thought: "",
          actions: [close("C1", "confirmed", [lastObservationInMessages(messages)])],
        };
      }
      return { thought: "done", actions: [] };
    };
    const deps: InquiryDeps = { propose, workspace, maxTurns: 10 };
    const result = await runInquiryUnit(deps, {
      request: { id: "r1", text: "check a.txt" },
    });

    expect(result.final).toBe("done");
    expect(result.done).toBe(true);
    expect(result.stopReason).toBe("answered");
    expect(result.unresolved).toEqual([]);
    const claim = result.events.find(
      (event) => event.type === "add_node" && event.node.kind === "claim",
    );
    expect(claim).toBeDefined();
    const verdict = result.events.find(
      (event) =>
        event.type === "add_node" &&
        event.node.kind === "claim_verdict" &&
        (event.node.payload as { verdict?: string }).verdict === "confirmed",
    );
    expect(verdict).toBeDefined();
  });

  it("refuses side effects without a claim and writes without a change", () => {
    let events = seedInquiry({ id: "r1", text: "t" });
    const noClaim = step(events, workspace, bash("echo hi"));
    expect(noClaim.text).toContain("no_open");

    events = step(events, workspace, open("probe", "p", "s")).events;
    const probeWrite = step(events, workspace, write("c.txt", "x"));
    expect(probeWrite.text).toContain("not_a_change");

    const emptyExpectation = step(events, workspace, open("probe", "q", "s", "", ""));
    expect(emptyExpectation.text).toContain("bad_expectation");
  });

  it("enforces grounds and verdicts for a change", () => {
    let events = seedInquiry({ id: "r1", text: "t" });
    events = step(events, workspace, open("probe", "p", "s")).events;
    const readStep = step(events, workspace, read("a.txt"));
    events = readStep.events;
    const obs = observationId(readStep.events);

    const noGrounds = step(events, workspace, close("C1", "confirmed", []));
    expect(noGrounds.text).toContain("bad_grounds");

    const badVerdict = step(events, workspace, close("C1", "done", [obs]));
    expect(badVerdict.text).toContain("bad_verdict");

    const notOpen = step(events, workspace, close("C9", "confirmed", [obs]));
    expect(notOpen.text).toContain("not_open");

    const closed = step(events, workspace, close("C1", "confirmed", [obs]));
    expect(closed.text).toContain("close_hypothesis C1 confirmed");

    let change = seedInquiry({ id: "r2", text: "t" });
    change = step(change, workspace, open("change", "c", "change it")).events;
    const changeRead = step(change, workspace, read("a.txt"));
    change = changeRead.events;
    const changeObs = observationId(changeRead.events);

    const written = step(change, workspace, write("a.txt", "changed\n"));
    expect(written.text).toContain("wrote a.txt");
    const done = step(written.events, workspace, close("C1", "done", [changeObs]));
    expect(done.text).toContain("close_hypothesis C1 done");
  });

  it("names valid grounds and the recall bridge", () => {
    let events = seedInquiry({ id: "r1", text: "t" });
    const before = step(events, workspace, read("a.txt"));
    events = before.events;
    const beforeObs = observationId(before.events);
    events = step(events, workspace, open("probe", "p", "s")).events;
    const bad = step(events, workspace, close("C1", "confirmed", [beforeObs]));
    expect(bad.text).toContain("was recorded before C1 opened");
    expect(bad.text).toContain(`recall ${beforeObs} by id`);
    expect(bad.text).toContain("Valid grounds under C1:");
  });

  it("does not close a parent while a child is open", () => {
    let events = seedInquiry({ id: "r1", text: "t" });
    events = step(events, workspace, open("probe", "parent", "p")).events;
    events = step(events, workspace, open("probe", "child", "c")).events;
    const childRead = step(events, workspace, read("a.txt"));
    events = childRead.events;
    const obs = observationId(childRead.events);

    const openBlock = inquiryMessages(fold(events), { id: "r1", text: "t" })
      .map(textOf)
      .find((text) => text.startsWith("OPEN")) ?? "";
    const c1Line = openBlock.split("\n").find((line) => line.startsWith("C1 ")) ?? "";
    const c2Line = openBlock.split("\n").find((line) => line.startsWith("C2 ")) ?? "";
    expect(c1Line).not.toContain("[ACTIVE]");
    expect(c2Line).toContain("[ACTIVE]");

    const parent = step(events, workspace, close("C1", "confirmed", [obs]));
    expect(parent.text).toContain("children_open");
    expect(parent.text).toContain("close the active C2 first");
    expect(parent.text).toContain("C1 > C2");

    const child = step(events, workspace, close("C2", "confirmed", [obs]));
    expect(child.text).toContain("close_hypothesis C2 confirmed");
    const parentAfter = step(child.events, workspace, close("C1", "confirmed", [obs]));
    expect(parentAfter.text).toContain("close_hypothesis C1 confirmed");
  });

  it("scopes repeated actions to the current hypothesis", () => {
    let events = seedInquiry({ id: "r1", text: "t" });
    events = step(events, workspace, open("probe", "first", "f")).events;
    const firstRead = step(events, workspace, read("a.txt"));
    events = firstRead.events;
    const firstObs = observationId(firstRead.events);
    events = step(events, workspace, close("C1", "confirmed", [firstObs])).events;

    events = step(events, workspace, open("probe", "second", "s")).events;
    const secondRead = step(events, workspace, read("a.txt"));
    expect(secondRead.text).not.toContain("repeated_action");
    const repeated = step(secondRead.events, workspace, read("a.txt"));
    expect(repeated.text).toContain("repeated_action");
  });

  it("keeps a child verdict out of the parent summary", () => {
    let events = seedInquiry({ id: "r1", text: "t" });
    events = step(events, workspace, open("change", "parent", "alpha")).events;
    const parentRead = step(events, workspace, read("a.txt"));
    events = parentRead.events;
    const parentObs = observationId(parentRead.events);
    events = step(events, workspace, open("probe", "child", "beta")).events;
    const childRead = step(events, workspace, read("b.txt"));
    events = childRead.events;
    const childObs = observationId(childRead.events);
    events = step(events, workspace, close("C2", "confirmed", [childObs])).events;
    events = step(events, workspace, write("a.txt", "alpha2\n")).events;
    events = step(events, workspace, close("C1", "done", [parentObs])).events;

    const state = fold(events);
    const messages = inquiryMessages(state, { id: "r1", text: "t" });
    const closed = messages.map(textOf).find((text) => text.startsWith("CLOSED"));
    expect(closed).toBeDefined();
    const lines = (closed ?? "").split("\n");
    const parentLine = lines.find((line) => line.trimStart().startsWith("C1 ")) ?? "";
    const childLine = lines.find((line) => line.trimStart().startsWith("C2 ")) ?? "";
    expect(parentLine).toContain("a.txt");
    expect(parentLine).not.toContain("b.txt");
    expect(childLine).toContain("b.txt");
  });

  it("records an unresolved hypothesis at a text stop", async () => {
    let stepNo = 0;
    const propose = async (): Promise<Proposals> => {
      stepNo += 1;
      if (stepNo === 1) {
        return { thought: "", actions: [open("probe", "p", "unknown")] };
      }
      return { thought: "cannot resolve", actions: [] };
    };
    const result = await runInquiryUnit(
      { propose, workspace, maxTurns: 10 },
      { request: { id: "r1", text: "t" } },
    );
    expect(result.final).toBe("cannot resolve");
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.id).toBe("C1");
    expect(
      (payloadOfKind(result.events, "stop") as { unresolved?: unknown[] } | undefined)?.unresolved,
    ).toHaveLength(1);
  });
});
