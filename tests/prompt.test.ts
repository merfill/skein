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

  it("gives the request and goal situations their own instructions", () => {
    expect(NODE_INSTRUCTIONS.request.length).toBeGreaterThan(0);
    expect(NODE_INSTRUCTIONS.goal.length).toBeGreaterThan(0);
    expect(NODE_INSTRUCTIONS.request).not.toBe(NODE_INSTRUCTIONS.goal);
    expect(NODE_INSTRUCTIONS.request).toMatch(/interpret/i);
    expect(NODE_INSTRUCTIONS.goal).toMatch(/stop/i);
  });
});

// The tool contract is single-sourced from the registry: the base prompt names the flat
// tools by name and must not drift back to the old nested `apply { action: { tool } }` form.
describe("system prompt: tool contract", () => {
  it("names every registered tool by its callable name", () => {
    for (const tool of PROPOSAL_TOOLS) {
      expect(BASE_PROMPT).toContain(tool.function.name);
    }
  });

  it("does not describe a non-existent `apply` wrapper or nested tool objects", () => {
    expect(BASE_PROMPT).not.toContain("apply {");
    expect(BASE_PROMPT).not.toContain("{ tool:");
  });

  it("keeps stream discipline in its own block (B14)", () => {
    const b14 = PROMPT_BLOCKS.find((block) => block.id === "B14");
    expect(b14?.text).toMatch(/stdout and stderr SEPARATELY/i);
  });

  it("keeps the stop condition in the goal instruction (B7): a goal closes by stop, no criterion", () => {
    const b7 = PROMPT_BLOCKS.find((block) => block.id === "B7");
    expect(b7?.text).toMatch(/stop \{ why\? \} closes the goal/i);
    expect(b7?.text).toMatch(/no criterion/i);
    expect(NODE_INSTRUCTIONS.goal).toContain(b7?.text ?? "");
  });

  // A live run backgrounded every build and then spent turns polling it; a foreground run
  // blocks and finishes in one turn. The run tool description says to run builds in the foreground.
  it("tells the model to run builds in the foreground (in the bash tool description)", () => {
    const run = PROPOSAL_TOOLS.find((tool) => tool.function.name === "bash");
    expect(run?.function.description).toMatch(/FOREGROUND/);
  });

  it("exposes the reduced goal vocabulary and no removed fields", () => {
    const createGoal = PROPOSAL_TOOLS.find((tool) => tool.function.name === "create_goal");
    const description = createGoal?.function.description ?? "";
    expect(description).not.toContain("sketch");
    expect(description).toContain("command");
    const prompt = `${BASE_PROMPT}\n${NODE_INSTRUCTIONS.request}\n${NODE_INSTRUCTIONS.goal}`;
    for (const removed of ["done_when", "checkReady", "nextAction", "revises"]) {
      expect(prompt, `prompt must not mention ${removed}`).not.toContain(removed);
      expect(description, `create_goal must not mention ${removed}`).not.toContain(removed);
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
        "create_goal",
        "decline",
        "edit",
        "webfetch",
        "grep",
        "list",
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
    const prompt = `${BASE_PROMPT}\n${NODE_INSTRUCTIONS.request}\n${NODE_INSTRUCTIONS.goal}`;
    for (const tool of PROPOSAL_TOOLS) {
      expect(tool.function.description, `${tool.function.name} mentions 'query'`).not.toMatch(
        /\bquery\b/i,
      );
    }
    expect(prompt).not.toMatch(/\bquery\b/i);
  });
});

describe("system prompt: stream discipline", () => {
  it("tells the model to keep stdout and stderr separate", () => {
    expect(BASE_PROMPT).toMatch(/SEPARATELY/);
    expect(BASE_PROMPT).toContain("2>&1");
    expect(BASE_PROMPT).toContain("&>");
  });

  it("allows pipes but warns that a pipe hides the exit code", () => {
    expect(BASE_PROMPT).toMatch(/pipefail/);
    expect(BASE_PROMPT).toMatch(/hides the exit code/i);
  });

  it("requires objective commands to be runnable from the workspace root", () => {
    expect(NODE_INSTRUCTIONS.request).toMatch(/WORKSPACE ROOT/);
    expect(NODE_INSTRUCTIONS.request).toContain("cd <dir> &&");
  });

  it("states the workspace-root/cd rule in the create_goal description", () => {
    const createGoal = PROPOSAL_TOOLS.find((tool) => tool.function.name === "create_goal");
    expect(createGoal?.function.description).toMatch(/WORKSPACE ROOT/);
    expect(createGoal?.function.description).toContain("cd <dir> &&");
  });

  it("carries no failure-diagnosis playbook (the log and the tools carry it)", () => {
    expect(NODE_INSTRUCTIONS.goal).not.toMatch(/WRONG WORKING DIRECTORY/);
    expect(NODE_INSTRUCTIONS.goal).not.toMatch(/SETUP, not the defect/);
    expect(NODE_INSTRUCTIONS.goal).not.toMatch(/From a failure to its cause/);
  });

  it("keeps the stale-read safety but no localize->edit trigger", () => {
    expect(NODE_INSTRUCTIONS.goal).toMatch(/never edit on top of a stale read/);
    expect(NODE_INSTRUCTIONS.goal).not.toMatch(/LOCALIZED|NAMED SUSPECT/);
  });

  it("no longer carries the external-reference / diff playbook", () => {
    const prompt = `${BASE_PROMPT}\n${NODE_INSTRUCTIONS.goal}`;
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
    situation: "goal",
    constraints: [{ id: "k1", forbid: ["secret"] }],
  };

  it("lays the context out as a system prefix then the tape", () => {
    const messages = buildMessages(context);
    expect(messages[0]).toBeInstanceOf(SystemMessage);
    expect(String(messages[0]?.content)).toBe(BASE_PROMPT);
    expect(messages[1]).toBeInstanceOf(SystemMessage);
    expect(String(messages[1]?.content)).toBe(NODE_INSTRUCTIONS.goal);
    expect(messages[2]).toBeInstanceOf(SystemMessage);
    expect(String(messages[2]?.content)).toContain("k1");
    expect(messages[3]).toBeInstanceOf(HumanMessage);
    expect(String(messages[3]?.content)).toContain("fix the failing test");
    // A move is a native `assistant.tool_calls`; its result is a `tool` message answering it —
    // never a result smuggled in as a `user` turn (the old OBSERVATION hack, removed).
    expect(messages[4]).toBeInstanceOf(AIMessage);
    expect((messages[4] as AIMessage).tool_calls?.[0]?.name).toBe("bash");
    expect(messages[5]).toBeInstanceOf(ToolMessage);
    expect((messages[5] as ToolMessage).tool_call_id).toBe("c1");
    expect(String(messages[5]?.content)).toContain("boom");
  });

  it("rejects a tool turn without a callId instead of faking a user turn", () => {
    expect(() => buildMessages({ ...context, history: [{ role: "tool", text: "x" }] })).toThrow(
      /without a callId/,
    );
  });

  it("prepends the request instruction on a fresh request", () => {
    const messages = buildMessages({ ...context, history: [], situation: "request" });
    expect(String(messages[1]?.content)).toBe(NODE_INSTRUCTIONS.request);
  });
});
