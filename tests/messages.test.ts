import { describe, expect, it } from "vitest";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Event } from "../src/ir/events";
import { fold } from "../src/ir/graph";
import { project } from "../src/ir/project";
import { buildMessages } from "../src/loop/propose";
import { executeAction } from "../src/tools";
import { fsWorkspace } from "../src/tools/workspace";
import type { Edge, EdgeKind, Node, NodeKind, Provenance } from "../src/ir/types";
import { wire } from "./wire";

// The exact wire messages the provider receives, produced by the real code path
// (`buildMessages` → `ChatOpenAI` message conversion). The transport is a stub `fetch` that
// captures the request body — no network, deterministic. This pins the native tool-calling
// contract (docs/ir_semantics §7): assistant moves are `assistant.tool_calls`, results are
// `tool` messages with `tool_call_id`, and only the request is a `user` turn.

const llm: Provenance = { kind: "llm" };
const node = (id: string, kind: NodeKind, label: string, seq: number, payload?: unknown): Event => ({
  type: "add_node",
  node: { id, space: "work", kind, label, ...(payload !== undefined ? { payload } : {}), seq } as Node,
});
const edge = (id: string, from: string, to: string, kind: EdgeKind): Event => ({
  type: "add_edge",
  edge: { id, from, to, kind, provenance: llm } as Edge,
});

const BIG = `edit failed: find not found in ocaml/x.c\n--- current content of ocaml/x.c ---\n${"X".repeat(500)}`;

function journal(): Event[] {
  return [
    { type: "add_node", node: { id: "r1", space: "work", kind: "request", label: "fix", payload: { text: "fix the bug" }, seq: 0 } },
    node("g1", "goal", "green", 1, { what: "green", call: { name: "create_goal", args: { what: "green", command: "ls" } } }),
    edge("eg", "r1", "g1", "goal"),
    node("a1", "action", "ls", 2, { command: "ls", call: { name: "bash", args: { command: "ls" } } }),
    node("o1", "observation", "ls", 3, { command: "ls", exitCode: 0, output: "ocaml\n" }),
    edge("ro1", "a1", "o1", "result"),
    node("p1", "plan", "plan", 4),
    edge("hp", "g1", "p1", "plan"),
    edge("it1", "p1", "i1", "items"),
    edge("it2", "p1", "i2", "items"),
    node("i1", "item", "step", 5),
    edge("al1", "i1", "a1", "alts"),
    node("i2", "item", "step", 6),
    edge("al2", "i2", "a2", "alts"),
    edge("al3", "i2", "a3", "alts"),
    node("a2", "action", "edit ocaml/x.c", 7, { command: "edit ocaml/x.c", call: { name: "edit", args: { filePath: "ocaml/x.c", oldString: "a", newString: "b" } } }),
    node("o2", "observation", "edit failed", 8, { failed: true, output: BIG }),
    edge("ro2", "a2", "o2", "result"),
    node("a3", "action", "read ocaml/x.c", 9, { command: "read ocaml/x.c", call: { name: "read", args: { filePath: "ocaml/x.c" } } }),
    node("o3", "observation", "read", 10, { ref: "file:ocaml/x.c", version: "v1", bytes: 40, start: 1, end: 3, total: 100, output: "int x;\nint y;\n" }),
    edge("ro3", "a3", "o3", "result"),
  ];
}

describe("message wrappers: the wire JSON of the tape", () => {
  it("moves are assistant.tool_calls, results are tool messages, the request is user", async () => {
    const msgs = await wire(buildMessages(project(fold(journal()))));

    expect(msgs.map((m) => m.role)).toEqual([
      "system", "system", "user",
      "assistant", "tool", // create_goal
      "assistant", "tool", // run (the seeded first command)
      "assistant", "tool", // edit
      "assistant", "tool", // read
    ]);
    // No `tool`-result is smuggled in as a `user` message (the old role bug).
    expect(msgs.every((m) => m.role !== "user" || m.content === "fix the bug")).toBe(true);
    // A native call keeps its content empty (the call is in `tool_calls`).
    const callMsgs = msgs.filter((m) => m.role === "assistant" && m.tool_calls !== undefined);
    expect(callMsgs.every((m) => m.content === "")).toBe(true);

    expect(msgs[2]).toMatchObject({ role: "user", content: "fix the bug" });

    // create_goal: its own native call and its own result.
    expect(msgs[3]?.tool_calls?.[0]).toMatchObject({ id: "g1", type: "function" });
    expect(msgs[3]?.tool_calls?.[0]?.function.name).toBe("create_goal");
    expect(JSON.parse(msgs[3]?.tool_calls?.[0]?.function.arguments ?? "{}")).toEqual({ what: "green", command: "ls" });
    expect(msgs[4]).toMatchObject({ role: "tool", tool_call_id: "g1" });
    expect(String(msgs[4]?.content)).toContain("goal created: green");

    // The seeded first command is a separate `run` call + its observation.
    expect(msgs[5]?.tool_calls?.[0]?.function.name).toBe("bash");
    expect(msgs[5]?.tool_calls?.[0]?.id).toBe("a1");
    expect(msgs[6]).toMatchObject({ role: "tool", tool_call_id: "a1" });
    expect(String(msgs[6]?.content)).toContain("[o1] exit 0");

    // A plain command move is its own tool call.
    expect(msgs[7]?.tool_calls?.[0]?.function.name).toBe("edit");
    expect(msgs[7]?.tool_calls?.[0]?.id).toBe("a2");
    expect(msgs[8]).toMatchObject({ role: "tool", tool_call_id: "a2" });
    expect(String(msgs[8]?.content)).toContain("edit failed: find not found");

    // The alternative is a plain native call: no marker, and the failure body rides only in
    // its own `tool` result (never duplicated into an assistant message).
    expect(msgs[9]?.tool_calls?.[0]?.function.name).toBe("read");
    expect(msgs[9]?.tool_calls?.[0]?.id).toBe("a3");
    const tape = msgs.slice(2);
    const tapeText = tape.map((m) => String(m.content)).join("\n");
    expect(tapeText).not.toContain("alternative to step");
    expect(tapeText.split("--- current content of ocaml/x.c").length - 1).toBe(1);
    expect(msgs[10]).toMatchObject({ role: "tool", tool_call_id: "a3" });
  });

  it("a refused structural move is an assistant call + a tool reason", async () => {
    const state = fold([
      { type: "add_node", node: { id: "r1", space: "work", kind: "request", label: "x", payload: { text: "x" }, seq: 0 } },
    ]);
    const context = project(state, {
      rejection: { text: "rejected stop: not_addressed", name: "stop", args: {} },
    });
    const msgs = await wire(buildMessages(context));
    const tail = msgs.slice(-2);
    expect(tail[0]?.role).toBe("assistant");
    expect(tail[0]?.tool_calls?.[0]?.function.name).toBe("stop");
    expect(tail[1]).toMatchObject({ role: "tool", content: "rejected stop: not_addressed" });
    expect(tail[1]?.tool_call_id).toBe(tail[0]?.tool_calls?.[0]?.id);
  });

  it("a recall/search result is an assistant call + a tool result", async () => {
    const state = fold([
      { type: "add_node", node: { id: "r1", space: "work", kind: "request", label: "x", payload: { text: "x" }, seq: 0 } },
    ]);
    const context = project(state, {
      retrieval: { call: "recall { id: obs:5 }", name: "recall", args: { id: "obs:5" }, output: "the body" },
    });
    const msgs = await wire(buildMessages(context));
    const tail = msgs.slice(-2);
    expect(tail[0]?.tool_calls?.[0]?.function.name).toBe("recall");
    expect(tail[1]).toMatchObject({ role: "tool", content: "the body" });
    expect(tail[1]?.tool_call_id).toBe(tail[0]?.tool_calls?.[0]?.id);
  });

  it("a seeded first command is a native bash call + tool result (no OBSERVATION turn)", async () => {
    const workspace = fsWorkspace(mkdtempSync(join(tmpdir(), "skein-seed-")));
    const req: Event = {
      type: "add_node",
      node: { id: "r1", space: "work", kind: "request", label: "fix", payload: { text: "fix the bug" }, seq: 0 },
    };
    // Run create_goal for real: it seeds and executes the first command.
    const outcome = executeAction(
      { operator: "create_goal", what: "green", state: "reconnaissance", action: { tool: "bash", command: "echo hi" } },
      fold([req]),
      workspace,
      0,
    );
    const msgs = await wire(buildMessages(project(fold([req, ...outcome.events]))));
    // No result is smuggled in as a user turn (the removed OBSERVATION hack).
    expect(msgs.some((m) => m.role === "user" && String(m.content).startsWith("OBSERVATION"))).toBe(
      false,
    );
    // The seeded command is a native `bash` call whose result is a matching `tool` message.
    const bash = msgs.find((m) => m.tool_calls?.[0]?.function.name === "bash");
    expect(bash).toBeDefined();
    const bashId = bash?.tool_calls?.[0]?.id;
    expect(msgs.some((m) => m.role === "tool" && m.tool_call_id === bashId)).toBe(true);
  });
});
