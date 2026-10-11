import { afterEach, describe, expect, it } from "vitest";

import type { Event } from "../src/ir/events";
import { fold } from "../src/ir/graph";
import { project, type Context } from "../src/ir/project";
import type { Action } from "../src/llm/schemas";
import { modelCall } from "../src/llm/schemas";
import { BASE_PROMPT, buildMessages } from "../src/loop/propose";
import { NODE_INSTRUCTIONS } from "../src/loop/prompt";
import type { Workspace } from "../src/tools/workspace";
import {
  DEFAULT_FILES,
  applyTool,
  classification,
  cleanupWorkspaces,
  edit,
  exec,
  fetchUrl,
  grep,
  interpretation,
  makeWorkspace,
  patch,
  read,
  recall,
  request,
  run,
  search,
  write,
} from "./ops/helpers";
import { assertTapeContract } from "./tape_invariant";
import { compact, wire } from "./wire";

// End-to-end tape contract, in three explicit steps per case (docs/ir_semantics.md §7):
//
//   1. IR_before = fold(events)              -> projection(IR_before)  = tape BEFORE
//   2. op = executeAction(op, IR_before)     -> `nodes` = IR delta, then fold
//   3. projection(IR_after)                  -> tape AFTER
//
// Most ops APPEND a call/result pair (after = before + delta); `stop` is a non-monotone CUT
// (its internals vanish, only the closure stays) and `create_goal` also flips the situation.
// The tape is asserted in the FINAL provider JSON (buildMessages → the real ChatOpenAI
// conversion), and every tape is validated by `assertTapeContract` (pairing/roles).

afterEach(cleanupWorkspaces);

async function tapeOf(context: Context): Promise<ReturnType<typeof compact>> {
  assertTapeContract(context.history);
  return compact(await wire(buildMessages(context))).slice(2 + context.constraints.length);
}

const kinds = (res: ReturnType<typeof exec>): (string | undefined)[] =>
  res.outcome.events.filter((e) => e.type === "add_node").map((e) => e.node.kind);

const ws = () => makeWorkspace(DEFAULT_FILES).ws;
const opened = (w: Workspace) => exec(interpretation("do it", "true"), [request()], w);

// before/after/nodes for an op applied to an existing goal.
function goalStep(op: Action, w: Workspace) {
  const first = opened(w);
  const before = project(first.state);
  // The seed command ran on turn 0 (inside create_goal); the op is the NEXT turn, so it is a
  // separate move (a batch would share one turn).
  const res = exec(op, first.events, w, 1);
  return { before, after: project(res.state), nodes: kinds(res), res };
}

const REQ = { role: "user", content: "solve the task" };

// The tape of `request` + `create_goal("do it","true")` + its executed seed: the state every
// goal-level op starts from.
const GOAL_PREFIX = [
  REQ,
  { role: "assistant", call: { name: "create_goal", args: { what: "do it", command: "true" } } },
  {
    role: "tool",
    content: expect.stringMatching(/^\[w:goal:\d+\] goal created: do it$/),
    tool_call_id: expect.stringMatching(/^w:goal:\d+$/),
  },
  { role: "assistant", call: { name: "bash", args: { command: "true" } } },
  {
    role: "tool",
    content: expect.stringMatching(/^\[obs:\d+\] exit 0$/),
    tool_call_id: expect.stringMatching(/^w:action:\d+$/),
  },
];

describe("create_goal: before [request] -> delta goal/plan/item/action/observation -> after", () => {
  it("interprets the request (situation flips request -> goal)", async () => {
    const w = ws();
    const before = project(fold([request()]));
    const res = exec(interpretation("green", "echo hi"), [request()], w);
    const after = project(res.state);

    expect(before.situation).toBe("request");
    expect(await tapeOf(before)).toEqual([REQ]);
    expect(kinds(res)).toEqual(["goal", "plan", "item", "action", "observation"]);
    expect(after.situation).toBe("goal");
    expect(await tapeOf(after)).toEqual([
      REQ,
      { role: "assistant", call: { name: "create_goal", args: { what: "green", command: "echo hi" } } },
      {
        role: "tool",
        content: expect.stringMatching(/^\[w:goal:\d+\] goal created: green$/),
        tool_call_id: expect.stringMatching(/^w:goal:\d+$/),
      },
      { role: "assistant", call: { name: "bash", args: { command: "echo hi" } } },
      {
        role: "tool",
        content: expect.stringMatching(/^\[obs:\d+\] exit 0\nhi\n$/),
        tool_call_id: expect.stringMatching(/^w:action:\d+$/),
      },
    ]);
  });

  it("renders a failing seeded command (exit code, no output)", async () => {
    const w = ws();
    const res = exec(interpretation("green", "exit 3"), [request()], w);
    const after = await tapeOf(project(res.state));
    expect(after.slice(-2)).toEqual([
      { role: "assistant", call: { name: "bash", args: { command: "exit 3" } } },
      {
        role: "tool",
        content: expect.stringMatching(/^\[obs:\d+\] exit 3$/),
        tool_call_id: expect.stringMatching(/^w:action:\d+$/),
      },
    ]);
  });

  it("decomposes an open goal: the sub-goal is a native create_goal call", async () => {
    const w = ws();
    // The parent's seed FAILS so its item stays unfulfilled (decomposable).
    const first = exec(interpretation("do it", "false"), [request()], w);
    const before = await tapeOf(project(first.state));
    expect(before.at(-2)).toEqual({ role: "assistant", call: { name: "bash", args: { command: "false" } } });
    const res = exec(interpretation("sub", "echo sub"), first.events, w);
    expect(kinds(res)).toEqual(["goal", "plan", "item", "action", "observation"]);
    const after = await tapeOf(project(res.state));
    expect(after.slice(-4)).toEqual([
      { role: "assistant", call: { name: "create_goal", args: { what: "sub", command: "echo sub" } } },
      {
        role: "tool",
        content: expect.stringMatching(/^\[w:goal:\d+\] goal created: sub$/),
        tool_call_id: expect.stringMatching(/^w:goal:\d+$/),
      },
      { role: "assistant", call: { name: "bash", args: { command: "echo sub" } } },
      {
        role: "tool",
        content: expect.stringMatching(/^\[obs:\d+\] exit 0\nsub\n$/),
        tool_call_id: expect.stringMatching(/^w:action:\d+$/),
      },
    ]);
  });
});

describe("apply — inspection: before GOAL_PREFIX -> delta -> after", () => {
  it("read success appends one call/result pair", async () => {
    const s = goalStep(read("src/sum.mjs"), ws());
    expect(await tapeOf(s.before)).toEqual(GOAL_PREFIX);
    expect(s.nodes).toEqual(["action", "item", "file", "observation"]);
    expect(await tapeOf(s.after)).toEqual([
      ...GOAL_PREFIX,
      { role: "assistant", call: { name: "read", args: { filePath: "src/sum.mjs" } } },
      {
        role: "tool",
        content: expect.stringMatching(
          /^\[obs:\d+\] src\/sum\.mjs lines 1-4 of 4\nexport function sum\(a, b\) \{\n  return a - b;\n\}\n$/,
        ),
        tool_call_id: expect.stringMatching(/^w:action:\d+$/),
      },
    ]);
  });

  it("read missing / escape: a fail observation, still a tool turn", async () => {
    const missing = goalStep(read("nope.txt"), ws());
    expect(await tapeOf(missing.before)).toEqual(GOAL_PREFIX);
    expect(kinds(missing.res)).toEqual(["action", "item", "observation"]);
    expect((await tapeOf(missing.after)).at(-1)).toMatchObject({
      role: "tool",
      content: expect.stringMatching(/^\[obs:\d+\] read failed: nope\.txt does not exist$/),
      tool_call_id: expect.stringMatching(/^w:action:\d+$/),
    });

    const escape = goalStep(read("/etc/hostname"), ws());
    expect((await tapeOf(escape.after)).at(-1)).toMatchObject({
      role: "tool",
      content: expect.stringMatching(/^\[obs:\d+\] read failed: path escapes workspace: \/etc\/hostname$/),
    });
  });

  it("read repeat: the second read appends a refusal that names the stored id", async () => {
    const w = ws();
    const first = opened(w);
    const r1 = exec(read("src/sum.mjs"), first.events, w, 1);
    const before = await tapeOf(project(r1.state));
    expect(before.slice(-2)).toEqual([
      { role: "assistant", call: { name: "read", args: { filePath: "src/sum.mjs" } } },
      {
        role: "tool",
        content: expect.stringMatching(/^\[obs:\d+\] src\/sum\.mjs lines 1-4 of 4/),
        tool_call_id: expect.stringMatching(/^w:action:\d+$/),
      },
    ]);
    const r2 = exec(read("src/sum.mjs"), r1.events, w, 2);
    expect(await tapeOf(project(r2.state))).toEqual([
      ...before,
      { role: "assistant", call: { name: "read", args: { filePath: "src/sum.mjs" } } },
      {
        role: "tool",
        content: expect.stringMatching(
          /^\[obs:\d+\] repeated_action: obs:\d+ already has it; retrieve it by id \(recall\), do not repeat$/,
        ),
        tool_call_id: expect.stringMatching(/^w:action:\d+$/),
      },
    ]);
  });

  it("grep hits and no-match", async () => {
    const s = goalStep(grep("sum", "src"), ws());
    expect(await tapeOf(s.before)).toEqual(GOAL_PREFIX);
    expect(s.nodes).toEqual(["action", "item", "observation"]);
    expect((await tapeOf(s.after)).at(-1)?.content).toMatch(
      /^\[obs:\d+\] src\/sum\.mjs:1:export function sum\(a, b\) \{/,
    );
    const none = goalStep(grep("zzzz", "src"), ws());
    expect((await tapeOf(none.after)).at(-1)).toMatchObject({
      role: "tool",
      content: expect.stringMatching(/^\[obs:\d+\] \(no matches\)$/),
    });
  });

  it("list: JSON window", async () => {
    const s = goalStep(applyTool({ tool: "list" }), ws());
    expect(await tapeOf(s.before)).toEqual(GOAL_PREFIX);
    expect((await tapeOf(s.after)).slice(-2)).toEqual([
      { role: "assistant", call: { name: "list", args: {} } },
      {
        role: "tool",
        content: expect.stringMatching(/^\[obs:\d+\] \{\n {2}"root": "\."/),
        tool_call_id: expect.stringMatching(/^w:action:\d+$/),
      },
    ]);
  });

  it("batch — two calls in one turn — is one assistant message with both calls", async () => {
    const w = ws();
    const first = opened(w);
    // Both calls run on the SAME turn, so they belong to one doxa move (a batch).
    const r1 = exec(read("src/sum.mjs"), first.events, w, 1);
    const r2 = exec(run("echo one"), r1.events, w, 1);
    const history = project(r2.state).history;
    assertTapeContract(history);
    const batch = history.find((message) => message.calls !== undefined);
    expect(batch?.calls?.map((call) => call.name)).toEqual(["read", "bash"]);
    // On the wire: one assistant message with two tool_calls, then two tool results.
    const wireMessages = await wire(buildMessages(project(r2.state)));
    const assistant = wireMessages.find((message) => (message.tool_calls?.length ?? 0) > 1);
    expect(assistant?.tool_calls?.map((call) => call.function.name)).toEqual(["read", "bash"]);
    expect(wireMessages.filter((message) => message.role === "tool").length).toBe(
      wireMessages.filter((message) => message.tool_calls !== undefined).flatMap((m) => m.tool_calls ?? []).length,
    );
  });
});

describe("apply — mutation: before GOAL_PREFIX -> delta -> after", () => {
  it("edit success: no observation node, the action answers itself", async () => {
    const s = goalStep(edit("src/sum.mjs", "return a - b;", "return a + b;"), ws());
    expect(await tapeOf(s.before)).toEqual(GOAL_PREFIX);
    expect(s.nodes).toEqual(["action", "item", "file"]);
    expect(await tapeOf(s.after)).toEqual([
      ...GOAL_PREFIX,
      {
        role: "assistant",
        call: { name: "edit", args: { filePath: "src/sum.mjs", oldString: "return a - b;", newString: "return a + b;" } },
      },
      {
        role: "tool",
        content: expect.stringMatching(/^\[w:action:\d+\] mutated src\/sum\.mjs$/),
        tool_call_id: expect.stringMatching(/^w:action:\d+$/),
      },
    ]);
  });

  it("edit not found: the current content is materialized in the tool result", async () => {
    const s = goalStep(edit("src/sum.mjs", "NOPE", "x"), ws());
    expect(s.nodes).toEqual(["action", "item", "observation"]);
    const after = (await tapeOf(s.after)).at(-1)?.content ?? "";
    expect(after).toMatch(/edit failed: find not found in src\/sum\.mjs/);
    expect(after).toContain("return a - b;");
  });

  it("write create / unread overwrite", async () => {
    const create = goalStep(write("new.txt", "hi"), ws());
    expect(kinds(create.res)).toEqual(["action", "item", "file"]);
    expect((await tapeOf(create.after)).at(-1)).toMatchObject({
      role: "tool",
      content: expect.stringMatching(/^\[w:action:\d+\] mutated new\.txt$/),
    });
    const unread = goalStep(write("src/sum.mjs", "x"), ws());
    expect((await tapeOf(unread.after)).at(-1)).toMatchObject({
      role: "tool",
      content: expect.stringMatching(
        /^\[obs:\d+\] write failed: src\/sum\.mjs exists; read it before overwriting \(use edit for a small change\)$/,
      ),
    });
  });

  it("webfetch success / failure (native name)", async () => {
    const base = ws();
    const ok = {
      ...base,
      fetchTo: (_u: string, p: string) => {
        base.write(p, "reference\n");
        return { path: p, bytes: 10 };
      },
    };
    const first = opened(ok);
    const res = exec(fetchUrl("http://x/y.c"), first.events, ok, 1);
    expect(kinds(res)).toEqual(["action", "item", "file", "observation"]);
    expect((await tapeOf(project(res.state))).slice(-2)).toEqual([
      { role: "assistant", call: { name: "webfetch", args: { url: "http://x/y.c" } } },
      {
        role: "tool",
        content: expect.stringMatching(/^\[obs:\d+\] \.skein\/ref\/[0-9a-f]+-y\.c$/),
        tool_call_id: expect.stringMatching(/^w:action:\d+$/),
      },
    ]);

    const fail = { ...ws(), fetchTo: () => { throw new Error("boom"); } };
    const ffirst = opened(fail);
    const fr = exec(fetchUrl("http://x/y.c"), ffirst.events, fail, 1);
    expect((await tapeOf(project(fr.state))).at(-1)).toMatchObject({
      role: "tool",
      content: expect.stringMatching(/^\[obs:\d+\] fetch failed: boom$/),
    });
  });

  it("apply_patch success / failure", async () => {
    const base = ws();
    const ok = { ...base, applyPatch: (p: string) => { base.write("patched.txt", p); } };
    const first = opened(ok);
    const res = exec(patch("--- a/x\n+++ b/x\n"), first.events, ok);
    expect(kinds(res)).toEqual(["action", "item", "file", "observation"]);
    expect((await tapeOf(project(res.state))).at(-1)).toMatchObject({
      role: "tool",
      content: expect.stringMatching(/^\[obs:\d+\] applied patch: patched\.txt$/),
    });
    const fail = { ...ws(), applyPatch: () => { throw new Error("does not apply"); } };
    const ffirst = opened(fail);
    const fr = exec(patch("--- a/x\n+++ b/x\n"), ffirst.events, fail);
    expect((await tapeOf(project(fr.state))).at(-1)).toMatchObject({
      role: "tool",
      content: expect.stringMatching(/^\[obs:\d+\] apply_patch failed: does not apply$/),
    });
  });
});

describe("apply — bash outcomes: before GOAL_PREFIX -> delta -> after", () => {
  it("exit 0 and exit 3", async () => {
    const ok = goalStep(run("echo hi"), ws());
    expect(await tapeOf(ok.before)).toEqual(GOAL_PREFIX);
    expect(kinds(ok.res)).toEqual(["action", "item", "observation"]);
    expect((await tapeOf(ok.after)).at(-1)?.content).toMatch(/^\[obs:\d+\] exit 0\nhi\n$/);
    const bad = goalStep(run("exit 3"), ws());
    expect((await tapeOf(bad.after)).at(-1)?.content).toMatch(/^\[obs:\d+\] exit 3$/);
  });

  it("timeout: no exit code, the command label is shown", async () => {
    const w = makeWorkspace(DEFAULT_FILES, { runTimeoutMs: 120 }).ws;
    const s = goalStep(run("sleep 5"), w);
    expect(s.nodes).toEqual(["action", "item", "observation"]);
    expect((await tapeOf(s.after)).at(-1)).toMatchObject({
      role: "tool",
      content: expect.stringMatching(/^\[obs:\d+\] sleep 5$/),
    });
  });
});

describe("transient turns: no IR delta, the before/after differ by the option", () => {
  it("a recall result is appended as an assistant call + tool, no node", async () => {
    const w = ws();
    const first = opened(w);
    const r = exec(run("echo hi"), first.events, w, 1);
    const obs = r.outcome.turn.nodeId as string;
    const rec = exec(recall(obs), r.events, w, 2);
    expect(rec.outcome.events.filter((e) => e.type === "add_node")).toHaveLength(0);
    const before = project(r.state);
    const retrieval = {
      call: rec.outcome.turn.call as string,
      name: rec.outcome.turn.callName as string,
      args: rec.outcome.turn.callArgs as Record<string, unknown>,
      output: rec.outcome.turn.text,
    };
    expect(await tapeOf(before)).toEqual([
      ...GOAL_PREFIX,
      { role: "assistant", call: { name: "bash", args: { command: "echo hi" } } },
      {
        role: "tool",
        content: expect.stringMatching(/^\[obs:\d+\] exit 0\nhi\n$/),
        tool_call_id: expect.stringMatching(/^w:action:\d+$/),
      },
    ]);
    expect(await tapeOf(project(r.state, { retrieval }))).toEqual([
      ...(await tapeOf(before)),
      { role: "assistant", content: `recall { id: ${obs} }`, call: { name: "recall", args: { id: obs } } },
      {
        role: "tool",
        content: expect.stringMatching(new RegExp(`"id": "${obs}"`)),
        tool_call_id: "call:retrieval",
      },
    ]);
  });

  it("a search result is appended as an assistant call + tool", async () => {
    const w = ws();
    const first = opened(w);
    const r = exec(run("printf 'MATCH one\\nMATCH two\\n'"), first.events, w);
    const obs = r.outcome.turn.nodeId as string;
    const sr = exec(search(obs, "MATCH"), r.events, w);
    const retrieval = {
      call: sr.outcome.turn.call as string,
      name: sr.outcome.turn.callName as string,
      args: sr.outcome.turn.callArgs as Record<string, unknown>,
      output: sr.outcome.turn.text,
    };
    const after = await tapeOf(project(r.state, { retrieval }));
    expect(after.at(-2)).toEqual({
      role: "assistant",
      content: `search { id: ${obs}, pattern: MATCH }`,
      call: { name: "search", args: { id: obs, pattern: "MATCH" } },
    });
    expect(after.at(-1)?.content).toContain("MATCH one");
    expect(after.at(-1)?.tool_call_id).toBe("call:retrieval");
  });

  it("a refused structural move is appended as an assistant call + tool reason", async () => {
    const w = ws();
    const first = opened(w);
    const r = exec(run("echo hi"), first.events, w, 1);
    const obs = r.outcome.turn.nodeId as string;
    const action = recall(obs);
    const cls = classification(action, r.events, [obs]);
    expect(cls.accept).toBe(false);
    const call = modelCall(action);
    const text = `rejected ${call.name}: ${cls.reason}`;
    const before = await tapeOf(project(r.state));
    const after = await tapeOf(project(r.state, { rejection: { text, name: call.name, args: call.args } }));
    expect(after).toEqual([
      ...before,
      { role: "assistant", call: { name: "recall", args: { id: obs } } },
      {
        role: "tool",
        content: expect.stringMatching(/^rejected recall: repeated_action: obs:\d+ was just recalled/),
        tool_call_id: "call:rejected",
      },
    ]);
  });

  it("refusals carry the reason: stop at the request, and an empty create_goal", async () => {
    const req = request();
    const stop = { operator: "stop" as const };
    const stopCls = classification(stop, [req]);
    expect(stopCls.accept).toBe(false);
    const stopCall = modelCall(stop);
    expect(
      await tapeOf(
        project(fold([req]), {
          rejection: { text: `rejected ${stopCall.name}: ${stopCls.reason}`, name: stopCall.name, args: stopCall.args },
        }),
      ),
    ).toEqual([
      REQ,
      { role: "assistant", call: { name: "stop", args: {} } },
      {
        role: "tool",
        content: expect.stringMatching(/^rejected stop: not_addressed: stop applies to a goal/),
        tool_call_id: "call:rejected",
      },
    ]);
    const empty = { operator: "create_goal" as const, what: "", command: "true" };
    const emptyCls = classification(empty, [req]);
    expect(emptyCls.accept).toBe(false);
    const emptyCall = modelCall(empty);
    expect(
      (
        await tapeOf(
          project(fold([req]), {
            rejection: { text: `rejected ${emptyCall.name}: ${emptyCls.reason}`, name: emptyCall.name, args: emptyCall.args },
          }),
        )
      ).at(-1)?.content,
    ).toMatch(/^rejected create_goal: empty_what$/);
  });
});

describe("stop / decline: non-monotone cut and terminal turn", () => {
  it("stop replaces the whole goal tape with its closure", async () => {
    const s = goalStep({ operator: "stop", why: "done" }, ws());
    expect(await tapeOf(s.before)).toEqual(GOAL_PREFIX);
    expect(s.nodes).toEqual(["stop"]);
    expect(await tapeOf(s.after)).toEqual([REQ, { role: "assistant", content: "stopped: done" }]);
  });

  it("decline: before [request] -> after the terminal assistant turn", async () => {
    const w = ws();
    const before = project(fold([request()]));
    const res = exec({ operator: "decline", why: "chat" }, [request()], w);
    expect(await tapeOf(before)).toEqual([REQ]);
    expect(kinds(res)).toEqual(["unactionable"]);
    expect(await tapeOf(project(res.state))).toEqual([REQ, { role: "assistant", content: "declined: chat" }]);
  });
});

describe("crash (mock node) and prefix", () => {
  it("a crash observation carries signal/core/backtrace in the IR and the tape", async () => {
    const llm = { kind: "llm" as const };
    const events: Event[] = [
      { type: "add_node", node: { id: "r1", space: "work", kind: "request", label: "fix", payload: { text: "fix" }, seq: 0 } },
      { type: "add_node", node: { id: "g1", space: "work", kind: "goal", label: "green", payload: { what: "green", call: { name: "create_goal", args: { what: "green", command: "crash" } } }, seq: 1 } },
      { type: "add_edge", edge: { id: "eg", from: "r1", to: "g1", kind: "goal", provenance: llm } },
      { type: "add_node", node: { id: "p1", space: "work", kind: "plan", label: "plan", seq: 2 } },
      { type: "add_edge", edge: { id: "hp", from: "g1", to: "p1", kind: "plan", provenance: llm } },
      { type: "add_node", node: { id: "i1", space: "work", kind: "item", label: "step", seq: 3 } },
      { type: "add_edge", edge: { id: "it", from: "p1", to: "i1", kind: "items", provenance: llm } },
      { type: "add_node", node: { id: "a1", space: "work", kind: "action", label: "crash", payload: { command: "crash", call: { name: "bash", args: { command: "crash" } } }, seq: 4 } },
      { type: "add_edge", edge: { id: "al", from: "i1", to: "a1", kind: "alts", provenance: llm } },
      { type: "add_node", node: { id: "o1", space: "work", kind: "observation", label: "crash", payload: { command: "crash", signal: "SIGSEGV", core: "core.1", backtrace: "#0 boom" }, seq: 5 } },
      { type: "add_edge", edge: { id: "ro", from: "a1", to: "o1", kind: "result", provenance: llm } },
    ];
    const state = fold(events);
    const payload = state.nodes.get("o1")?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ signal: "SIGSEGV", core: "core.1", backtrace: "#0 boom" });
    expect((await tapeOf(project(state))).at(-1)).toMatchObject({
      role: "tool",
      content: expect.stringMatching(/^\[o1\] killed by SIGSEGV \(core: core\.1\)\n#0 boom$/),
      tool_call_id: "a1",
    });
  });

  it("a real signal death omits the exit code and surfaces the signal", async () => {
    const w = ws();
    const res = exec(interpretation("crash", "kill -SEGV $$"), [request()], w);
    const obs = res.outcome.events
      .filter((e) => e.type === "add_node" && e.node.kind === "observation")
      .map((e) => (e as { node: { payload: Record<string, unknown> } }).node.payload)[0]!;
    expect(obs.signal).toBe("SIGSEGV");
    expect(obs.exitCode).toBeUndefined();
    expect((await tapeOf(project(res.state))).at(-1)?.content).toContain("killed by SIGSEGV");
  });

  it("prefix: base prompt, node instruction, and one system per constraint", async () => {
    const req: Event = { type: "add_node", node: { id: "r1", space: "work", kind: "request", label: "t", payload: { text: "fix" }, seq: 0 } };
    const constraint: Event = { type: "add_node", node: { id: "k1", space: "work", kind: "constraint", label: "k1", payload: { forbid: ["secret"] }, seq: 1 } };
    const context = project(fold([req, constraint]));
    expect(context.situation).toBe("request");
    const msgs = await wire(buildMessages(context));
    expect(msgs[0]).toMatchObject({ role: "system", content: BASE_PROMPT });
    expect(msgs[1]).toMatchObject({ role: "system", content: NODE_INSTRUCTIONS.request });
    expect(msgs[2]?.role).toBe("system");
    expect(String(msgs[2]?.content)).toContain("k1");
    expect(msgs[3]).toMatchObject({ role: "user", content: "fix" });
  });
});
