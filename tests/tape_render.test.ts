import { afterEach, describe, expect, it } from "vitest";

import { fold } from "../src/ir/graph";
import { project, type Context, type TapeMessage } from "../src/ir/project";
import { BASE_PROMPT, buildMessages } from "../src/loop/propose";
import { NODE_INSTRUCTIONS } from "../src/loop/prompt";
import {
  DEFAULT_FILES,
  cleanupWorkspaces,
  exec,
  execAll,
  makeWorkspace,
  read,
  request,
  withGoal,
} from "./ops/helpers";
import { compact, wire } from "./wire";

// The render contract, tested in two independent hops so "right role, right format" is
// pinned per node kind rather than inferred from a single trajectory:
//
//   hop 1: IR node kind  -> TapeMessage (role/shape)        [project]
//   hop 2: TapeMessage   -> provider wire JSON (role/shape)  [buildMessages -> ChatOpenAI]
//
// docs/ir_semantics.md §7.

afterEach(cleanupWorkspaces);

const shape = (m: TapeMessage) => ({
  role: m.role,
  ...(m.call !== undefined ? { call: m.call.name } : {}),
  ...(m.callId !== undefined ? { answers: true } : {}),
  ...(m.call === undefined && m.callId === undefined ? { text: m.text } : {}),
});

// hop 2 helper: build a synthetic tape and read back the provider JSON (system prefix sliced).
async function wireTape(history: TapeMessage[], constraints: Context["constraints"] = []) {
  return compact(await wire(buildMessages({ history, situation: "working", constraints }))).slice(
    2 + constraints.length,
  );
}

describe("hop 1 — IR node kind -> TapeMessage role", () => {
  it("request -> a single user turn", () => {
    expect(project(fold([request()])).history.map(shape)).toEqual([{ role: "user", text: "solve the task" }]);
  });

  it("move + create_goal and action/observation -> assistant.call + tool pairs", () => {
    const w = makeWorkspace(DEFAULT_FILES).ws;
    const first = execAll(withGoal("do it", "true"), [request()], w);
    const ctx = project(exec(read("src/sum.mjs"), first.events, w, 1).state);
    // The move and each plan item are native calls + tool results.
    expect(ctx.history.map((m) => [m.role, m.call?.name ?? null, Boolean(m.callId)])).toEqual([
      ["user", null, false],
      ["assistant", "move", false],
      ["tool", null, true],
      ["assistant", "bash", false],
      ["tool", null, true],
      ["assistant", "read", false],
      ["tool", null, true],
    ]);
  });

  it("stop -> a terminal assistant text with no call", () => {
    const w = makeWorkspace(DEFAULT_FILES).ws;
    const first = execAll(withGoal("do it", "true"), [request()], w);
    const ctx = project(exec({ operator: "stop", why: "done" }, first.events, w).state);
    expect(ctx.history.map(shape)).toEqual([
      { role: "user", text: "solve the task" },
      { role: "assistant", call: "move" },
      { role: "tool", answers: true },
      { role: "assistant", text: "stopped: done" },
    ]);
  });

  it("unactionable(decline) -> a terminal assistant text", () => {
    const w = makeWorkspace(DEFAULT_FILES).ws;
    const ctx = project(exec({ operator: "decline", why: "chat" }, [request()], w).state);
    expect(ctx.history.map(shape)).toEqual([
      { role: "user", text: "solve the task" },
      { role: "assistant", text: "declined: chat" },
    ]);
  });

  it("plan / item / file nodes contribute structure, not messages", () => {
    const w = makeWorkspace(DEFAULT_FILES).ws;
    const first = execAll(withGoal("do it", "true"), [request()], w);
    const res = exec(read("src/sum.mjs"), first.events, w);
    // The op added plan?/item/file nodes...
    const added = res.outcome.events
      .filter((e) => e.type === "add_node")
      .map((e) => e.node.kind);
    expect(added).toContain("item");
    expect(added).toContain("file");
    // ...but the tape has exactly one assistant.tool_calls per move (goal + seed + read),
    // never a message tagged `item`/`file`/`plan`.
    expect(new Set(project(res.state).history.map((m) => m.role))).toEqual(
      new Set(["user", "assistant", "tool"]),
    );
  });
});

describe("hop 2 — TapeMessage -> provider wire role/format", () => {
  it("user -> role user", async () => {
    expect(await wireTape([{ role: "user", text: "hi" }])).toEqual([{ role: "user", content: "hi" }]);
  });

  it("assistant text -> role assistant with content and no tool_calls", async () => {
    const ctx: Context = { history: [{ role: "assistant", text: "done" }], situation: "working", constraints: [] };
    const raw = await wire(buildMessages(ctx));
    const message = raw[2]!;
    expect(message.role).toBe("assistant");
    expect(message.content).toBe("done");
    expect(message.tool_calls).toBeUndefined();
    expect(await wireTape([{ role: "assistant", text: "done" }])).toEqual([
      { role: "assistant", content: "done" },
    ]);
  });

  it("assistant call -> role assistant, empty content, a well-formed tool_call", async () => {
    const ctx: Context = {
      history: [{ role: "assistant", text: "", call: { id: "c1", name: "bash", args: { command: "ls" } } }],
      situation: "working",
      constraints: [],
    };
    const message = (await wire(buildMessages(ctx)))[2]!;
    expect(message.role).toBe("assistant");
    expect(message.content).toBe("");
    expect(message.tool_calls?.[0]).toEqual({
      id: "c1",
      type: "function",
      function: { name: "bash", arguments: '{"command":"ls"}' },
    });
  });

  it("tool with callId -> role tool, tool_call_id, content", async () => {
    const ctx: Context = { history: [{ role: "tool", text: "ok", callId: "c1" }], situation: "working", constraints: [] };
    expect((await wire(buildMessages(ctx)))[2]).toMatchObject({
      role: "tool",
      tool_call_id: "c1",
      content: "ok",
    });
  });

  it("tool without callId -> throws (never a user turn)", () => {
    const ctx: Context = { history: [{ role: "tool", text: "orphan" }], situation: "working", constraints: [] };
    expect(() => buildMessages(ctx)).toThrow(/without a callId/);
  });

  it("the system prefix is base + node instruction + one per constraint", async () => {
    const context: Context = {
      history: [{ role: "user", text: "fix" }],
      situation: "working",
      constraints: [{ id: "k1", forbid: ["secret"] }],
    };
    const msgs = await wire(buildMessages(context));
    expect(msgs.map((m) => m.role)).toEqual(["system", "system", "system", "user"]);
    expect(msgs[0]?.content).toBe(BASE_PROMPT);
    expect(msgs[1]?.content).toBe(NODE_INSTRUCTIONS.working);
    expect(String(msgs[2]?.content)).toContain("k1");
  });
});
