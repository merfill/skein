import { afterEach, describe, expect, it } from "vitest";

import { ISLANDS } from "../src/ir/islands";
import type { Event } from "../src/ir/events";
import { fold } from "../src/ir/graph";
import { project, type Context } from "../src/ir/project";
import type { Action } from "../src/llm/schemas";
import { modelCall } from "../src/llm/schemas";
import { BASE_PROMPT, buildMessages } from "../src/loop/propose";
import {
  NODE_INSTRUCTIONS,
  REQUEST_INSTRUCTION,
  planInstruction,
  turnInstruction,
} from "../src/loop/prompt";
import type { Workspace } from "../src/tools/workspace";
import {
  DEFAULT_FILES,
  applyTool,
  classification,
  cleanupWorkspaces,
  edit,
  exec,
  execAll,
  fetchUrl,
  grep,
  makeWorkspace,
  move,
  patch,
  read,
  recall,
  request,
  run,
  search,
  withGoal,
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
  // Strip the leading system prefix (base + one message per constraint) and the appended
  // situation prompt: `request`/`transition` a system turn, `plan`/`working` the per-turn tail,
  // `terminal` the End instruction. A state's entry (Start marker, brief, instruction) is on
  // the tape and must stay.
  const all = compact(await wire(buildMessages(context)));
  const start = 1 + context.constraints.length;
  let end = all.length;
  const appended =
    context.situation === "request"
      ? REQUEST_INSTRUCTION
      : context.situation === "plan"
        ? planInstruction(context.island, context.done, context.what)
        : context.situation === "working"
          ? turnInstruction(context.island, context.done, context.what)
          : context.situation === "terminal"
            ? NODE_INSTRUCTIONS.terminal
            : undefined;
  if (appended !== undefined && end > start && all[end - 1]?.content === appended) end -= 1;
  if (context.situation === "transition" && end > start && all[end - 1]?.role === "system") end -= 1;
  return all.slice(start, end);
}

const kinds = (res: ReturnType<typeof exec>): (string | undefined)[] =>
  res.outcome.events.filter((e) => e.type === "add_node").map((e) => e.node.kind);

const ws = () => makeWorkspace(DEFAULT_FILES).ws;
// A state plus its first plan item: the shape every state-level op starts from.
const opened = (w: Workspace) =>
  execAll([move("orientation", "do it"), run("true")], [request()], w);

// before/after/nodes for an op applied to an existing state.
function goalStep(op: Action, w: Workspace) {
  const first = opened(w);
  const before = project(first.state);
  // The first plan item ran on turn 0; the op is the NEXT turn, so it is a separate move (a
  // batch would share one turn).
  const res = exec(op, first.events, w, 1);
  return { before, after: project(res.state), nodes: kinds(res), res };
}

const REQ = { role: "user", content: "solve the task" };

// The tape of `request` + `move("orientation","do it")` + its first plan item (`true`):
// the state every state-level op starts from. The request leads the tape; a state is a
// `Start state` marker, the state's instruction and the goal as a `user` turn; the plan items
// are native call/result pairs.
const GOAL_PREFIX = [
  REQ,
  { role: "system", content: "Start state Orientation" },
  { role: "system", content: ISLANDS.orientation.instruction },
  { role: "user", content: "what: name the workspace root, its top-level entries, the repository status, and the acceptance the request declares" },
  { role: "assistant", call: { name: "bash", args: { command: "true" } } },
  {
    role: "tool",
    content: expect.stringMatching(/^\[obs:\d+\] exit 0$/),
    tool_call_id: expect.stringMatching(/^w:action:\d+$/),
  },
];

describe("move: before [request] -> delta -> after", () => {
  it("declares a state, then the first plan item (situation flips request -> working)", async () => {
    const w = ws();
    const before = project(fold([request()]));
    const res = execAll(withGoal("green", "echo hi"), [request()], w);
    const after = project(res.state);

    expect(before.situation).toBe("request");
    expect(await tapeOf(before)).toEqual([REQ]);
    expect(kinds(res)).toEqual(["action", "plan", "item", "observation"]);
    expect(after.situation).toBe("working");
    expect(await tapeOf(after)).toEqual([
      REQ,
      { role: "system", content: "Start state Orientation" },
      { role: "system", content: ISLANDS.orientation.instruction },
      { role: "user", content: "what: name the workspace root, its top-level entries, the repository status, and the acceptance the request declares" },
      { role: "assistant", call: { name: "bash", args: { command: "echo hi" } } },
      {
        role: "tool",
        content: expect.stringMatching(/^\[obs:\d+\] exit 0\nhi\n$/),
        tool_call_id: expect.stringMatching(/^w:action:\d+$/),
      },
    ]);
  });

  it("renders a failing first command (exit code, no output)", async () => {
    const w = ws();
    const res = execAll(withGoal("green", "exit 3"), [request()], w);
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

  it("stops a state and moves on: the finished state's turns collapse to one line", async () => {
    const w = ws();
    const first = execAll([move("localization", "do it"), run("false")], [request()], w);
    const stopped = exec({ operator: "stop", why: "the line is named" }, first.events, w);
    expect(kinds(stopped)).toEqual(["stop"]);
    const moved = exec(move("patch", "apply the fix"), stopped.events, w);
    const after = await tapeOf(project(moved.state));
    // The finished state's plan and its command have left the tape; only the closure marker,
    // in the finished state's triple, remains.
    const texts = after.map((entry) => entry.content ?? "").join("\n");
    expect(texts).toContain("Finish state Localization — the line is named");
    expect(texts).not.toContain("false");
    expect(
      after.find(
        (entry) => entry.content === "Finish state Localization — the line is named",
      ),
    ).toEqual({
      role: "system",
      content: "Finish state Localization — the line is named",
    });
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

describe("recall / search: they leave a node on the state's tape", () => {
  it("a recall renders as an action + observation on the state's tape", async () => {
    const w = ws();
    const first = opened(w);
    const r = exec(run("echo hi"), first.events, w, 1);
    const obs = r.outcome.turn.nodeId as string;
    const rec = exec(recall(obs), r.events, w, 2);
    const after = await tapeOf(project(rec.state));
    expect(after.slice(-2)).toEqual([
      { role: "assistant", call: { name: "recall", args: { id: obs } } },
      {
        role: "tool",
        content: expect.stringMatching(new RegExp(`"id": "${obs}"`)),
        tool_call_id: expect.stringMatching(/^w:action:\d+$/),
      },
    ]);
  });

  it("a search renders as an action + observation", async () => {
    const w = ws();
    const first = opened(w);
    const r = exec(run("printf 'MATCH one\\nMATCH two\\n'"), first.events, w, 1);
    const obs = r.outcome.turn.nodeId as string;
    const sr = exec(search(obs, "MATCH"), r.events, w, 2);
    const after = await tapeOf(project(sr.state));
    expect(after.at(-2)).toEqual({
      role: "assistant",
      call: { name: "search", args: { id: obs, pattern: "MATCH" } },
    });
    expect(after.at(-1)?.content).toContain("MATCH one");
  });

  it("refusals carry the reason: stop at the request, and a malformed move", async () => {
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
        content: expect.stringMatching(/^rejected stop: not_addressed: not admissible here/),
        tool_call_id: "call:rejected",
      },
    ]);
    const bad = { operator: "move", state: "atlantis" } as unknown as Action;
    const badCls = classification(bad, [req]);
    expect(badCls.accept).toBe(false);
    const badCall = modelCall(bad);
    expect(
      (
        await tapeOf(
          project(fold([req]), {
            rejection: { text: `rejected ${badCall.name}: ${badCls.reason}`, name: badCall.name, args: badCall.args },
          }),
        )
      ).at(-1)?.content,
    ).toMatch(/^rejected move: empty_state/);
  });
});

describe("stop / decline: non-monotone cut and terminal turn", () => {
  it("stop collapses the state's plan turns to its closure line", async () => {
    const s = goalStep({ operator: "stop", why: "done" }, ws());
    expect(await tapeOf(s.before)).toEqual(GOAL_PREFIX);
    expect(s.nodes).toEqual(["stop"]);
    expect(await tapeOf(s.after)).toEqual([
      REQ,
      { role: "system", content: "Start state Orientation" },
      { role: "system", content: "Finish state Orientation — done" },
    ]);
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
      { type: "add_node", node: { id: "m1", space: "work", kind: "move", label: "orientation", payload: { state: "orientation", what: "green", call: { name: "move", args: { state: "orientation", what: "green" } } }, seq: 1 } },
      { type: "add_edge", edge: { id: "em", from: "r1", to: "m1", kind: "move", provenance: llm } },
      { type: "add_node", node: { id: "p1", space: "work", kind: "plan", label: "plan", seq: 3 } },
      { type: "add_edge", edge: { id: "hp", from: "m1", to: "p1", kind: "plan", provenance: llm } },
      { type: "add_node", node: { id: "i1", space: "work", kind: "item", label: "step", seq: 4 } },
      { type: "add_edge", edge: { id: "it", from: "p1", to: "i1", kind: "items", provenance: llm } },
      { type: "add_node", node: { id: "a1", space: "work", kind: "action", label: "crash", payload: { command: "crash", call: { name: "bash", args: { command: "crash" } } }, seq: 5 } },
      { type: "add_edge", edge: { id: "al", from: "i1", to: "a1", kind: "alts", provenance: llm } },
      { type: "add_node", node: { id: "o1", space: "work", kind: "observation", label: "crash", payload: { command: "crash", signal: "SIGSEGV", core: "core.1", backtrace: "#0 boom" }, seq: 6 } },
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
    const res = execAll(withGoal("crash", "kill -SEGV $$"), [request()], w);
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
    expect(msgs[1]?.role).toBe("system");
    expect(String(msgs[1]?.content)).toContain("k1");
    expect(msgs[2]).toMatchObject({ role: "user", content: "fix" });
    // The request-step instruction is appended after the request (it scopes the first move's goal).
    expect(msgs.at(-1)).toMatchObject({ role: "system", content: REQUEST_INSTRUCTION });
  });
});
