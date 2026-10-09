import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import type { Context } from "../src/ir/project";
import { PROPOSAL_TOOLS } from "../src/llm/tools";
import { PROMPT_BLOCKS, SYSTEM_PROMPT as ASSEMBLED } from "../src/loop/prompt";
import { buildMessages, renderTranscript, SYSTEM_PROMPT } from "../src/loop/propose";

// The prompt is assembled from named behavior blocks (docs/system_prompt_ru.md). These
// tests guard the assembly contract: one block is one behavior, ids are stable, and the
// exported prompt is exactly the concatenation of the blocks.

describe("system prompt: block assembly", () => {
  it("has unique, non-empty block ids", () => {
    const ids = PROMPT_BLOCKS.map((block) => block.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const block of PROMPT_BLOCKS) {
      expect(block.id).not.toBe("");
      expect(block.text.length).toBeGreaterThan(0);
    }
  });

  it("exposes the prompt as the concatenation of blocks", () => {
    expect(ASSEMBLED).toBe(PROMPT_BLOCKS.map((block) => block.text).join("\n\n"));
    expect(SYSTEM_PROMPT).toBe(ASSEMBLED);
  });
});

// The tool contract is single-sourced from the registry: the prompt names the flat tools
// by name and must not drift back to the old nested `apply { action: { tool } }` form.
describe("system prompt: tool contract", () => {
  it("names every registered tool by its callable name", () => {
    for (const tool of PROPOSAL_TOOLS) {
      expect(SYSTEM_PROMPT).toContain(tool.function.name);
    }
  });

  it("does not describe a non-existent `apply` wrapper or nested tool objects", () => {
    expect(SYSTEM_PROMPT).not.toContain("apply {");
    expect(SYSTEM_PROMPT).not.toContain("{ tool:");
  });

  it("keeps stream discipline in its own block (B14)", () => {
    const b14 = PROMPT_BLOCKS.find((block) => block.id === "B14");
    expect(b14?.text).toMatch(/NEVER merge/);
  });

  it("keeps the stop condition in its own block (B15)", () => {
    const b15 = PROMPT_BLOCKS.find((block) => block.id === "B15");
    expect(b15?.text).toMatch(/only once its criterion has passed/i);
  });

  // A refuted option (a goal, or a request's interpretation) must not be re-proposed with
  // the same `what`; the guard is `repeat_hypothesis` and the model must be told, in the
  // prompt and in the create_goal description (Phase 5, docs/system_prompt_ru.md §4).
  it("warns against re-proposing a refuted option (repeat_hypothesis)", () => {
    expect(SYSTEM_PROMPT).toContain("repeat_hypothesis");
    const createGoal = PROPOSAL_TOOLS.find((tool) => tool.function.name === "create_goal");
    expect(createGoal?.function.description).toContain("repeat_hypothesis");
  });
});

// The engine captures stdout and stderr separately, so the prompt must stop the model
// from merging them with a shell redirect (docs/tools.md §4.3): a merged command hides
// which stream carried the failure.

describe("system prompt: stream discipline", () => {
  it("categorically forbids merging stdout and stderr", () => {
    expect(SYSTEM_PROMPT).toMatch(/NEVER merge/);
    expect(SYSTEM_PROMPT).toContain("2>&1");
    expect(SYSTEM_PROMPT).toContain("&>");
  });

  it("tells the model that lastResult carries output and error separately", () => {
    expect(SYSTEM_PROMPT).toMatch(/"output" is stdout and "error" is stderr/);
  });

  it("keeps the no-pipe rule (the exit code must survive)", () => {
    expect(SYSTEM_PROMPT).toMatch(/never pipe them through `tail`\/`head`/i);
  });

  it("requires objective commands to be runnable from the workspace root", () => {
    expect(SYSTEM_PROMPT).toMatch(/WORKSPACE ROOT/);
    expect(SYSTEM_PROMPT).toContain("cd <dir> &&");
  });

  it("reacts to a missing path as a wrong working directory, not bad code", () => {
    expect(SYSTEM_PROMPT).toMatch(/WRONG WORKING DIRECTORY/);
    expect(SYSTEM_PROMPT).toContain("No such file or directory");
  });

  // A missing build output is a DIFFERENT cause from a wrong directory: the tree is not
  // configured/built — setup, not the defect (a live run read `No rule to make target
  // '../Makefile.build_config'` as a directory error and never ran `./configure && make`).
  it("separates an unbuilt tree (setup) from a wrong directory", () => {
    expect(SYSTEM_PROMPT).toMatch(/SETUP, not the defect/);
    expect(SYSTEM_PROMPT).toMatch(/configure && make/);
    expect(SYSTEM_PROMPT).toMatch(/Makefile\.build_config|Makefile\.config/);
  });

  // The named-suspect trigger: a live run kept re-reading one unchanged file for 17 turns
  // after a (noisy) reference diff already isolated the defect. The prompt must say edit
  // is the next action once the suspect is named, and that a reference diff is a lead.
  it("tells the model to edit once the suspect is named (localize -> edit)", () => {
    expect(SYSTEM_PROMPT).toMatch(/NEXT action is edit/);
    expect(SYSTEM_PROMPT).toMatch(/LOCALIZED once you can point at the exact expression/);
    expect(SYSTEM_PROMPT).toMatch(/LEAD, not a checklist/);
  });
});

// The transcript packaging (SKEIN_CONTEXT_FORMAT=transcript) renders the projection as a
// role-tagged history: brief first, the branch's steps as call/result pairs
// chronologically, and the volatile board last (docs/plans/step_reduction_plan_ru.md §4).
describe("context format: transcript", () => {
  const context: Context = {
    path: [
      { id: "r1", kind: "request", state: "open", text: "fix the failing test" },
      {
        id: "w:goal:1",
        kind: "goal",
        state: "open",
        what: "green",
        done_when: "node --test",
      },
    ],
    constraints: [{ id: "k1", forbid: ["secret"] }],
    // Newest-first, as the projection keeps them.
    calls: [
      { id: "obs:2", action: "edit src/a.mjs", status: "ok", count: 1 },
      { id: "obs:1", action: "node --test", status: "fail", note: "boom", count: 1 },
    ],
    shown: [{ id: "obs:2", kind: "action", label: "edit src/a.mjs", output: "applied" }],
    lastResult: {
      id: "obs:1",
      kind: "observation",
      command: "node --test",
      exitCode: 1,
      output: "",
      error: "boom",
    },
    applicable: ["apply"],
    checkReady: true,
    budget: { turn: 2, maxTurns: 10, remaining: 8 },
  };

  it("lays the branch out as roles: brief, chronological steps, board last", () => {
    const messages = renderTranscript(context);
    expect(messages).toHaveLength(7);
    expect(messages[0]).toBeInstanceOf(SystemMessage);
    expect(messages[1]).toBeInstanceOf(HumanMessage);
    expect(String(messages[1]?.content)).toContain("BRIEF");
    expect(String(messages[1]?.content)).toContain("fix the failing test");
    expect(String(messages[1]?.content)).toContain("k1");
    // Oldest first: the failing run, then the edit.
    expect(messages[2]).toBeInstanceOf(AIMessage);
    expect(String(messages[2]?.content)).toContain("node --test");
    expect(String(messages[3]?.content)).toContain("boom");
    expect(String(messages[4]?.content)).toContain("edit src/a.mjs");
    expect(String(messages[5]?.content)).toContain("applied");
    const board = String(messages[6]?.content);
    expect(messages[6]).toBeInstanceOf(HumanMessage);
    expect(board).toContain("BOARD");
    expect(board).toContain("w:goal:1");
    expect(board).toContain("checkReady");
  });

  it("is selected by SKEIN_CONTEXT_FORMAT and falls back to the JSON projection", () => {
    const previous = process.env.SKEIN_CONTEXT_FORMAT;
    try {
      process.env.SKEIN_CONTEXT_FORMAT = "transcript";
      expect(buildMessages(context)).toHaveLength(renderTranscript(context).length);
      process.env.SKEIN_CONTEXT_FORMAT = "json";
      const json = buildMessages(context);
      expect(json).toHaveLength(2);
      expect(String(json[1]?.content)).toContain('"path"');
    } finally {
      if (previous === undefined) delete process.env.SKEIN_CONTEXT_FORMAT;
      else process.env.SKEIN_CONTEXT_FORMAT = previous;
    }
  });
});
