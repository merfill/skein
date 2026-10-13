import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import type { Context } from "../src/ir/project";
import { PROPOSAL_TOOLS } from "../src/llm/tools";
import { BASE_BLOCKS, BASE_PROMPT, NODE_INSTRUCTIONS, PROMPT_BLOCKS } from "../src/loop/prompt";
import { buildMessages } from "../src/loop/propose";

// The system part is assembled from named behavior blocks (docs/system_prompt_ru.md): a
// stable base (true on any move) and node instructions (a fresh request / an open goal).
// These tests guard the assembly and the tool contract.

describe("system prompt: base + node assembly", () => {
  it("has unique, non-empty block ids", () => {
    const ids = PROMPT_BLOCKS.map((block) => block.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const block of PROMPT_BLOCKS) {
      expect(block.id).not.toBe("");
      expect(block.text.length).toBeGreaterThan(0);
    }
  });

  it("assembles the base prompt as the concatenation of the base blocks", () => {
    expect(BASE_PROMPT).toBe(BASE_BLOCKS.map((block) => block.text).join("\n\n"));
  });

  it("carries the state-machine preamble and the state graph", () => {
    expect(BASE_PROMPT).toContain("implemented as a state machine");
    expect(BASE_PROMPT).toContain("Reconnaissance");
    expect(BASE_PROMPT).toContain("Verification");
  });

  it("states the state-change mechanism, Start and conditioned Transitions once in the base", () => {
    expect(BASE_PROMPT).toMatch(/`move \{ state, what \}` declares the state/);
    expect(BASE_PROMPT).toContain("a state IS its goal");
    expect(BASE_PROMPT).not.toContain("create_goal");
    expect(BASE_PROMPT).toContain("Start —");
    expect(BASE_PROMPT).toContain("Transitions —");
    // A transition carries its precondition, not just a target.
    expect(BASE_PROMPT).toMatch(/Localization — the cause is findable by reading/);
    expect(BASE_PROMPT).toMatch(/Hand-off is terminal/);
  });

  it("gives the request and goal situations their own instructions", () => {
    expect(NODE_INSTRUCTIONS.request.length).toBeGreaterThan(0);
    expect(NODE_INSTRUCTIONS.working.length).toBeGreaterThan(0);
    expect(NODE_INSTRUCTIONS.request).not.toBe(NODE_INSTRUCTIONS.working);
    expect(NODE_INSTRUCTIONS.request).toMatch(/move \{ state|decline/);
    expect(NODE_INSTRUCTIONS.working).toMatch(/stop/i);
    expect(NODE_INSTRUCTIONS.plan).toMatch(/first step/i);
    expect(NODE_INSTRUCTIONS.transition).toMatch(/move \{ state/);
    expect(NODE_INSTRUCTIONS.terminal).toMatch(/stop/i);
  });
});

// The tool contract is single-sourced from the registry: the base prompt must not repeat the
// tool descriptions (they ship in the request's `tools`) nor drift back to the old nested
// `apply { action: { tool } }` form.
describe("system prompt: tool contract", () => {
  it("does not repeat the tool descriptions (they ship in the request's `tools`)", () => {
    for (const tool of PROPOSAL_TOOLS) {
      expect(BASE_PROMPT).not.toContain(`- ${tool.function.name}: ${tool.function.description}`);
      expect(BASE_PROMPT).not.toContain(tool.function.description);
    }
  });

  it("does not describe a non-existent `apply` wrapper or nested tool objects", () => {
    expect(BASE_PROMPT).not.toContain("apply {");
    expect(BASE_PROMPT).not.toContain("{ tool:");
  });

  it("keeps stream discipline in the `bash` tool description (single source)", () => {
    const bash = PROPOSAL_TOOLS.find((tool) => tool.function.name === "bash");
    expect(bash?.function.description).toMatch(/stdout and stderr are captured SEPARATELY/i);
    expect(bash?.function.description).toMatch(/pipefail/i);
  });

  it("keeps the stop condition in the goal instruction (B8): a goal closes by stop, no criterion", () => {
    const b8 = PROMPT_BLOCKS.find((block) => block.id === "B8");
    expect(b8?.text).toMatch(/stop/i);
    expect(b8?.text).toMatch(/only closure|no criterion/i);
    expect(NODE_INSTRUCTIONS.working).toContain(b8?.text ?? "");
  });

  // A live run backgrounded every build and then spent turns polling it; a foreground run
  // blocks and finishes in one turn. The run tool description says to run builds in the foreground.
  it("tells the model to run builds in the foreground (in the bash tool description)", () => {
    const run = PROPOSAL_TOOLS.find((tool) => tool.function.name === "bash");
    expect(run?.function.description).toMatch(/FOREGROUND/);
  });

  it("exposes the move vocabulary and no removed fields", () => {
    const move = PROPOSAL_TOOLS.find((tool) => tool.function.name === "move");
    const description = move?.function.description ?? "";
    expect(description).not.toContain("sketch");
    expect(description).toContain("command");
    const prompt = `${BASE_PROMPT}\n${NODE_INSTRUCTIONS.request}\n${NODE_INSTRUCTIONS.working}`;
    for (const removed of ["done_when", "checkReady", "nextAction", "revises"]) {
      expect(prompt, `prompt must not mention ${removed}`).not.toContain(removed);
      expect(description, `move must not mention ${removed}`).not.toContain(removed);
    }
  });

  it("does not promise a parameter the tool schema lacks", () => {
    const props = (name: string) =>
      ((PROPOSAL_TOOLS.find((tool) => tool.function.name === name)?.function.parameters ?? {}) as {
        properties?: Record<string, unknown>;
      }).properties ?? {};
    const description = (name: string) =>
      PROPOSAL_TOOLS.find((tool) => tool.function.name === name)?.function.description ?? "";
    // A description may only mention parameters the native schema actually accepts, so a
    // promised `recall { id, start, end }` / `search { id, pattern }` cannot silently drop a key.
    for (const promised of ["id", "start", "end"]) {
      if (description("recall").includes(promised)) {
        expect(props("recall"), `recall must expose '${promised}'`).toHaveProperty(promised);
      }
    }
    for (const promised of ["id", "pattern", "before", "after"]) {
      if (description("search").includes(promised)) {
        expect(props("search"), `search must expose '${promised}'`).toHaveProperty(promised);
      }
    }
  });
});

describe("tool surface: no drift to a removed tool", () => {
  it("exposes exactly the current operator set", () => {
    const names = PROPOSAL_TOOLS.map((tool) => tool.function.name).sort();
    expect(names).toEqual(
      [
        "apply_patch",
        "decline",
        "edit",
        "webfetch",
        "grep",
        "list",
        "move",
        "read",
        "recall",
        "bash",
        "search",
        "stop",
        "write",
      ].sort(),
    );
  });

  it("keeps webfetch a plain reference (no diff/localization steering)", () => {
    const webfetch = PROPOSAL_TOOLS.find((tool) => tool.function.name === "webfetch");
    const description = webfetch?.function.description ?? "";
    // webfetch only acquires read-only reference evidence; the localization/diff playbook was
    // removed as a crutch that steered the model into a wrong-version whole-file diff.
    expect(description).toMatch(/reference evidence/i);
    expect(description).not.toMatch(/diff|localiz|same version|drift/i);
  });

  it("mentions no removed tool anywhere the model reads", () => {
    // `query` was split into `recall`/`search`; the old name must not survive in a tool
    // description or the prompt, or the model will call a tool that does not exist.
    const prompt = `${BASE_PROMPT}\n${NODE_INSTRUCTIONS.request}\n${NODE_INSTRUCTIONS.working}`;
    for (const tool of PROPOSAL_TOOLS) {
      expect(tool.function.description, `${tool.function.name} mentions 'query'`).not.toMatch(
        /\bquery\b/i,
      );
    }
    expect(prompt).not.toMatch(/\bquery\b/i);
  });
});

describe("system prompt: stream discipline", () => {
  const bashDescription = PROPOSAL_TOOLS.find((tool) => tool.function.name === "bash")?.function
    .description;

  it("tells the model to keep stdout and stderr separate", () => {
    expect(bashDescription).toMatch(/stdout and stderr are captured SEPARATELY/i);
    expect(bashDescription).toContain("2>&1");
  });

  it("allows pipes but warns that a pipe hides the exit code", () => {
    expect(bashDescription).toMatch(/pipefail/);
    expect(bashDescription).toMatch(/hides the left side's exit code/i);
  });

  it("requires objective commands to be runnable from the workspace root", () => {
    expect(NODE_INSTRUCTIONS.request).toMatch(/WORKSPACE ROOT/);
    expect(NODE_INSTRUCTIONS.request).toContain("cd <dir> &&");
  });

  it("states the workspace-root/cd rule in the move description", () => {
    const move = PROPOSAL_TOOLS.find((tool) => tool.function.name === "move");
    expect(move?.function.description).toMatch(/WORKSPACE ROOT/);
    expect(move?.function.description).toContain("cd <dir> &&");
  });

  it("carries no failure-diagnosis playbook (the log and the tools carry it)", () => {
    expect(NODE_INSTRUCTIONS.working).not.toMatch(/WRONG WORKING DIRECTORY/);
    expect(NODE_INSTRUCTIONS.working).not.toMatch(/SETUP, not the defect/);
    expect(NODE_INSTRUCTIONS.working).not.toMatch(/From a failure to its cause/);
  });

  it("keeps the stale-read safeguard in the edit/write descriptions, no localize->edit trigger", () => {
    const edit = PROPOSAL_TOOLS.find((tool) => tool.function.name === "edit")?.function.description;
    const write = PROPOSAL_TOOLS.find((tool) => tool.function.name === "write")?.function.description;
    expect(edit).toMatch(/stale_base/);
    expect(write).toMatch(/stale_base/);
    const prompt = `${BASE_PROMPT}\n${NODE_INSTRUCTIONS.working}`;
    expect(prompt).not.toMatch(/LOCALIZED|NAMED SUSPECT/);
  });

  it("no longer carries the external-reference / diff playbook", () => {
    const prompt = `${BASE_PROMPT}\n${NODE_INSTRUCTIONS.working}`;
    expect(prompt).not.toMatch(/External reference/i);
    expect(prompt).not.toMatch(/LEAD, not a checklist/i);
  });
});

// The context the model sees is the tape: a stable system prefix (base + the situation's
// instruction + constraints) and then the history as role-tagged turns (docs/ir_revision.md §5).
describe("context format: tape", () => {
  const context: Context = {
    history: [
      { role: "user", text: "fix the failing test" },
      { role: "assistant", text: "", call: { id: "c1", name: "bash", args: { command: "node --test" } } },
      { role: "tool", text: "exit 1\nboom", callId: "c1" },
    ],
    situation: "working",
    constraints: [{ id: "k1", forbid: ["secret"] }],
  };

  it("lays the context out as a stable prefix, the tape, then the situation instruction", () => {
    const messages = buildMessages(context);
    expect(messages[0]).toBeInstanceOf(SystemMessage);
    expect(String(messages[0]?.content)).toBe(BASE_PROMPT);
    expect(messages[1]).toBeInstanceOf(SystemMessage);
    expect(String(messages[1]?.content)).toContain("k1");
    expect(messages[2]).toBeInstanceOf(HumanMessage);
    expect(String(messages[2]?.content)).toContain("fix the failing test");
    // A move is a native `assistant.tool_calls`; its result is a `tool` message answering it —
    // never a result smuggled in as a `user` turn (the old OBSERVATION hack, removed).
    expect(messages[3]).toBeInstanceOf(AIMessage);
    expect((messages[3] as AIMessage).tool_calls?.[0]?.name).toBe("bash");
    expect(messages[4]).toBeInstanceOf(ToolMessage);
    expect((messages[4] as ToolMessage).tool_call_id).toBe("c1");
    expect(String(messages[4]?.content)).toContain("boom");
    // The situation's instruction is appended LAST (temporary — re-derived each turn).
    expect(messages.at(-1)).toBeInstanceOf(SystemMessage);
    expect(String(messages.at(-1)?.content)).toBe(NODE_INSTRUCTIONS.working);
  });

  it("rejects a tool turn without a callId instead of faking a user turn", () => {
    expect(() => buildMessages({ ...context, history: [{ role: "tool", text: "x" }] })).toThrow(
      /without a callId/,
    );
  });

  it("renders the observation instruction when the projection carries a result", () => {
    const withResult: Context = {
      ...context,
      result:
        "A tool call just returned — read its result above, then decide exactly one: if this state's criterion now holds, `stop`; else the next action.",
    };
    const msgs = buildMessages(withResult);
    // The situation's instruction is last; the observation instruction sits just before it.
    expect(msgs.at(-1)).toBeInstanceOf(SystemMessage);
    expect(String(msgs.at(-1)?.content)).toBe(NODE_INSTRUCTIONS.working);
    const observation = msgs.at(-2);
    expect(observation).toBeInstanceOf(SystemMessage);
    expect(String(observation?.content)).toMatch(/read its result/i);
    expect(String(observation?.content)).toMatch(/`stop`/);
    // Not shown when nothing just returned (a fresh request).
    const request = buildMessages({ ...context, history: [], situation: "request" });
    expect(request.some((message) => /read its result/i.test(String(message.content)))).toBe(false);
  });

  it("appends the request instruction last on a fresh request", () => {
    const messages = buildMessages({ ...context, history: [], situation: "request" });
    expect(String(messages.at(-1)?.content)).toBe(NODE_INSTRUCTIONS.request);
  });
});
