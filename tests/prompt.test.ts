import { describe, expect, it } from "vitest";

import { ISLANDS } from "../src/ir/islands";
import type { Context } from "../src/ir/project";
import { PROPOSAL_TOOLS, toolDescriptionsFor } from "../src/llm/tools";
import {
  BASE_BLOCKS,
  BASE_PROMPT,
  NODE_INSTRUCTIONS,
  PROMPT_BLOCKS,
  REQUEST_INSTRUCTION,
  planInstruction,
  transitionInstruction,
  turnInstruction,
} from "../src/loop/prompt";
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
    expect(BASE_PROMPT).toContain("exactly one state");
    expect(BASE_PROMPT).toContain("Orientation");
    expect(BASE_PROMPT).toContain("Research");
    expect(BASE_PROMPT).toContain("Recovery");
    expect(BASE_PROMPT).toContain("Construction");
    expect(BASE_PROMPT).toContain("Verification");
  });

  it("states the state-change mechanism, the States and conditioned Transitions once in the base", () => {
    expect(BASE_PROMPT).toContain("the state is its goal");
    expect(BASE_PROMPT).not.toContain("create_goal");
    expect(BASE_PROMPT).toContain("States:");
    // The map lists each state's kind of work; the criterion is delivered per turn, not here.
    expect(BASE_PROMPT).toMatch(/- Orientation — .+\./);
    expect(BASE_PROMPT).not.toMatch(/- Orientation — .*Done:/);
    expect(BASE_PROMPT).toContain("Transitions —");
    expect(BASE_PROMPT).toMatch(/- Localization → Patch — the target is named and a cause is suspected/);
    expect(BASE_PROMPT).toMatch(/- Localization → Research — the work is a situation, not a code defect to locate/);
    expect(BASE_PROMPT).toMatch(/- Research → Localization — the work is a code defect to locate/);
    expect(BASE_PROMPT).toMatch(/- Orientation → Research — the request is a situation: not an error in code and not a fully specified new artifact/);
    expect(BASE_PROMPT).toMatch(/- Orientation → Construction — the request fully specifies the new artifact — it can be written now/);
    expect(BASE_PROMPT).toMatch(/End is terminal/);
  });

  it("gives the request situation its own instruction", () => {
    expect(REQUEST_INSTRUCTION.length).toBeGreaterThan(0);
    expect(REQUEST_INSTRUCTION).toMatch(/move \{ state|decline/);
    expect(REQUEST_INSTRUCTION).toContain("- Orientation —");
    expect(REQUEST_INSTRUCTION).not.toContain("- Localization —");
    expect(REQUEST_INSTRUCTION).not.toMatch(/previous message/i);
    expect(transitionInstruction("orientation")).toMatch(/move to the next state/i);
  });

  it("at a transition, points at the finished state's `Finish` line as the source of what/done", () => {
    const fromOrientation = transitionInstruction("orientation");
    expect(fromOrientation).toContain("Localization"); // a reachable candidate
    expect(fromOrientation).toContain("Finish state Orientation"); // the source line, by label
    expect(fromOrientation).not.toContain("Patch"); // only the focused state's `next` targets
    expect(fromOrientation).toContain("find an error in existing code or files");
    expect(fromOrientation).toContain("Otherwise move to Research");
    expect(fromOrientation).toContain("Next states: Localization, Research, Construction.");
    expect(fromOrientation).toContain("Construction");
    expect(fromOrientation).toMatch(/`what`.*`done`/i);
    expect(fromOrientation).toContain("Choose the next state only");
    expect(fromOrientation).toContain("Call `move` alone");
    expect(fromOrientation).not.toContain("notes");
    expect(REQUEST_INSTRUCTION).not.toContain("notes");
    const fromVerification = transitionInstruction("verification");
    expect(fromVerification).toContain("Finish state Verification");
    expect(fromVerification).toContain("Localization"); // the corrective edge
    const fromLocalization = transitionInstruction("localization");
    expect(fromLocalization).toContain("Finish state Localization");
    expect(fromLocalization).toMatch(/target is named and a cause is suspected/);
    // The corrective edge: Research is offered only for a situation, not as a routine exit.
    expect(fromLocalization).toContain("Research");
    expect(fromLocalization).toMatch(
      /Choose Research only when the work is a situation, not a code defect to locate/,
    );
    const fromResearch = transitionInstruction("research");
    expect(fromResearch).toContain("Finish state Research");
    expect(fromResearch).toMatch(/Choose Localization when the work is a code defect to locate/);
    const fromRecovery = transitionInstruction("recovery");
    expect(fromRecovery).toContain("Finish state Recovery");
    expect(fromRecovery).toMatch(/matches what the material contains/);
    expect(fromRecovery).toContain("Research");
    const fromConstruction = transitionInstruction("construction");
    expect(fromConstruction).toContain("Finish state Construction");
    expect(fromConstruction).toMatch(/specification or the material's behaviour/);
    expect(fromConstruction).toContain("Research");
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

  it("keeps the mechanical stream contract in the `bash` tool description", () => {
    const bash = PROPOSAL_TOOLS.find((tool) => tool.function.name === "bash");
    expect(bash?.function.description).toMatch(/stdout and stderr are captured separately/i);
  });

  it("scopes the tool contract to the state's work", () => {
    // `bash` carries no state-specific read-only rule: inspection states get the global
    // description, so the state's own instruction decides what the work needs.
    const research = toolDescriptionsFor("research");
    expect(research.bash).not.toMatch(/Inspection only/);
    expect(research.bash).not.toMatch(/read-only commands/i);
    expect(research.write).toBeUndefined();

    const recovery = toolDescriptionsFor("recovery");
    expect(recovery.bash).toMatch(/you may create and modify files/i);
    expect(recovery.bash).toMatch(/keep the material read-only/i);
    expect(recovery.write).toMatch(/do not overwrite the material/i);
    expect(recovery.edit).toBeUndefined();

    const construction = toolDescriptionsFor("construction");
    expect(construction.bash).toMatch(/builds a new artifact/i);
    expect(construction.write).toMatch(/do not overwrite the material/i);
    expect(construction.webfetch).toMatch(/declared input or reference/i);

    const verification = toolDescriptionsFor("verification");
    expect(verification.bash).not.toMatch(/Inspection only/);

  });

  it("keeps Recovery's prompt minimal", () => {
    const text = `${ISLANDS.recovery.instruction} ${ISLANDS.recovery.hint}`;
    expect(text).not.toMatch(/source check|accept a candidate|negative control|script|container|Research/i);
    expect(text).toMatch(/do not fabricate/i);
    expect(text).toMatch(/keep the material read-only/i);
    expect(ISLANDS.recovery.criterion).toMatch(/matches what the material contains/i);
    expect(toolDescriptionsFor("recovery").bash ?? "").not.toMatch(/script/i);
    expect(toolDescriptionsFor("recovery").write ?? "").not.toMatch(/script/i);
  });

  it("keeps `stop` generic: a stop tool with a bounded, detailed why", () => {
    const stop = PROPOSAL_TOOLS.find((tool) => tool.function.name === "stop");
    expect(stop?.function.description).toMatch(/stop/i);
    expect(stop?.function.description).toMatch(/why/i);
    expect(stop?.function.description).toMatch(/this state's criterion holds/i);
    expect(stop?.function.description).toMatch(/50 words/i);
    expect(stop?.function.description).not.toMatch(/localization|patch/i);
    const required = (stop?.function.parameters as { required?: string[] }).required ?? [];
    expect(required).toContain("why");
  });

  it("numbers the base blocks B1..B4 in system-prompt order and names the request prompt", () => {
    expect(BASE_BLOCKS.map((block) => block.id)).toEqual(["B1", "B2", "B3", "B4"]);
    expect(PROMPT_BLOCKS.map((block) => block.id)).toEqual(["B1", "B2", "B3", "B4", "request"]);
  });

  it("exposes the move vocabulary and no removed fields", () => {
    const move = PROPOSAL_TOOLS.find((tool) => tool.function.name === "move");
    const description = move?.function.description ?? "";
    expect(description).not.toContain("sketch");
    expect(description).toContain("never batch");
    expect(description).not.toContain("notes");
    const properties = ((move?.function.parameters ?? {}) as { properties?: Record<string, unknown> })
      .properties ?? {};
    expect(properties).not.toHaveProperty("notes");
    const prompt = `${BASE_PROMPT}\n${REQUEST_INSTRUCTION}\n${transitionInstruction("localization")}`;
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

  it("keeps webfetch a plain read-only file (no diff/localization/reference steering)", () => {
    const webfetch = PROPOSAL_TOOLS.find((tool) => tool.function.name === "webfetch");
    const description = webfetch?.function.description ?? "";
    // webfetch only acquires a read-only file; every diff/localization/reference-evidence
    // heuristic was removed as a crutch that steered the model into a wrong-version diff.
    expect(description).toMatch(/read-only file/i);
    expect(description).not.toMatch(/diff|localiz|reference evidence|same version|drift/i);
  });

  it("mentions no removed tool anywhere the model reads", () => {
    // `query` was split into `recall`/`search`; the old name must not survive in a tool
    // description or the prompt, or the model will call a tool that does not exist.
    const prompt = `${BASE_PROMPT}\n${REQUEST_INSTRUCTION}\n${transitionInstruction("localization")}`;
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

  it("states the mechanical working-directory contract in the bash description", () => {
    const bash = PROPOSAL_TOOLS.find((tool) => tool.function.name === "bash");
    expect(bash?.function.description).toMatch(/WORKSPACE ROOT/);
    expect(bash?.function.description).toMatch(/workdir/);
  });

  it("carries no failure-diagnosis playbook (the log and the tools carry it)", () => {
    expect(BASE_PROMPT).not.toMatch(/WRONG WORKING DIRECTORY/);
    expect(BASE_PROMPT).not.toMatch(/SETUP, not the defect/);
    expect(BASE_PROMPT).not.toMatch(/From a failure to its cause/);
  });

  it("keeps the stale-read safeguard in the edit/write descriptions, no localize->edit trigger", () => {
    const edit = PROPOSAL_TOOLS.find((tool) => tool.function.name === "edit")?.function.description;
    const write = PROPOSAL_TOOLS.find((tool) => tool.function.name === "write")?.function.description;
    expect(edit).toMatch(/stale_base/);
    expect(write).toMatch(/stale_base/);
    const prompt = BASE_PROMPT;
    expect(prompt).not.toMatch(/LOCALIZED|NAMED SUSPECT/);
  });

  it("no longer carries the external-reference / diff playbook", () => {
    const prompt = BASE_PROMPT;
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

  it("lays the context out as a stable prefix, the constraints, then the tape", () => {
    const messages = buildMessages(context);
    expect(messages[0]).toMatchObject({ role: "system", content: BASE_PROMPT });
    expect(messages[1]?.role).toBe("system");
    expect(String(messages[1]?.content)).toContain("k1");
    expect(messages[2]).toMatchObject({ role: "user", content: "fix the failing test" });
    // A move is a native `tool-call` part; its result is a `tool` message answering it —
    // never a result smuggled in as a `user` turn (the old OBSERVATION hack, removed).
    const assistant = messages[3]!;
    expect(assistant.role).toBe("assistant");
    const parts = Array.isArray(assistant.content) ? assistant.content : [];
    expect(parts.find((part) => part.type === "tool-call")).toMatchObject({
      toolName: "bash",
      toolCallId: "c1",
      input: { command: "node --test" },
    });
    const tool = messages[4]!;
    expect(tool.role).toBe("tool");
    const result = Array.isArray(tool.content) ? tool.content[0] : undefined;
    expect(result).toMatchObject({ type: "tool-result", toolCallId: "c1" });
    expect((result as { output?: { value?: string } }).output?.value).toContain("boom");
    // A hand-built context without an island still gets the generic per-turn tail.
    expect(messages.at(-1)).toMatchObject({ role: "system" });
    expect(String((messages.at(-1) as { content: string }).content)).toContain(
      "Done when its goal holds.",
    );
    expect(messages).toHaveLength(6);
  });

  it("appends the focused state's per-turn tail last on plan and working, never storing it", () => {
    for (const situation of ["plan", "working"] as const) {
      const withIsland: Context = { ...context, situation, island: "localization" };
      const messages = buildMessages(withIsland);
      const expected =
        situation === "plan"
          ? planInstruction("localization")
          : turnInstruction("localization");
      expect(messages.at(-1)).toMatchObject({ role: "system", content: expected });
      expect(String((messages.at(-1) as { content: string }).content)).toContain(
        ISLANDS.localization.hint,
      );
      expect(String((messages.at(-1) as { content: string }).content)).not.toContain("what:");
      expect(String((messages.at(-1) as { content: string }).content)).toContain(
        "Done when:",
      );
      expect(String((messages.at(-1) as { content: string }).content)).toContain(
        "When it holds, `stop` — and nothing else.",
      );
      // The tail is derived: the projected history itself carries no extra message, so the
      // next turn's tape is rebuilt without it.
      expect(withIsland.history.at(-1)).toMatchObject({ role: "tool" });
      expect(messages).toHaveLength(withIsland.history.length + 3);
    }
  });

  it("keeps the request/transition prompts and the terminal instruction", () => {
    const request = buildMessages({ ...context, situation: "request", island: "localization" }).at(-1);
    expect(request).toMatchObject({ role: "system", content: REQUEST_INSTRUCTION });
    const transition = buildMessages({ ...context, situation: "transition", island: "localization" }).at(-1);
    expect(transition).toMatchObject({
      role: "system",
      content: transitionInstruction("localization"),
    });
    const terminal = buildMessages({ ...context, situation: "terminal", island: "end" }).at(-1);
    expect(terminal).toMatchObject({ role: "system", content: NODE_INSTRUCTIONS.terminal });
  });

  it("rejects a tool turn without a callId instead of faking a user turn", () => {
    expect(() => buildMessages({ ...context, history: [{ role: "tool", text: "x" }] })).toThrow(
      /without a callId/,
    );
  });

  it("appends the request instruction after the request (scopes the first move's goal)", () => {
    const messages = buildMessages({ ...context, history: [], situation: "request" });
    expect(messages.at(-1)).toMatchObject({ role: "system", content: REQUEST_INSTRUCTION });
  });

  it("appends the transition instruction, naming the focused state's reachable next states", () => {
    const transition: Context = {
      history: [
        { role: "assistant", text: "Start state Orientation" },
        { role: "user", text: "Learn the layout\nDone when: the layout is known." },
        { role: "assistant", text: "Finish state Orientation — layout known" },
        { role: "user", text: "fix the failing test" },
      ],
      situation: "transition",
      island: "orientation",
      constraints: [],
    };
    const messages = buildMessages(transition);
    // The transition rule is an engine `system` instruction, not a user request.
    expect(messages.at(-1)).toMatchObject({
      role: "system",
      content: transitionInstruction("orientation"),
    });
    expect(String((messages.at(-1) as { content: string }).content)).toContain("Localization");
  });
});
