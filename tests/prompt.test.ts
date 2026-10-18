import { describe, expect, it } from "vitest";

import { ISLANDS } from "../src/ir/islands";
import type { Context } from "../src/ir/project";
import { PROPOSAL_TOOLS, toolDescriptionsFor } from "../src/llm/tools";
import { BASE_BLOCKS, BASE_PROMPT, NODE_INSTRUCTIONS, PROMPT_BLOCKS, REQUEST_INSTRUCTION, transitionInstruction, turnInstruction } from "../src/loop/prompt";
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
    // A transition carries its precondition, not just a target.
    expect(BASE_PROMPT).toMatch(/- Localization → Patch — the artifact is named, its siblings are ruled out, and for a code defect the cause or violated invariant is stated/);
    expect(BASE_PROMPT).toMatch(/- Orientation → Research — the request is a situation or a method/);
    expect(BASE_PROMPT).toMatch(/Finish is terminal/);
  });

  it("gives the request and goal situations their own instructions", () => {
    expect(REQUEST_INSTRUCTION.length).toBeGreaterThan(0);
    expect(NODE_INSTRUCTIONS.working.length).toBeGreaterThan(0);
    expect(REQUEST_INSTRUCTION).not.toBe(NODE_INSTRUCTIONS.working);
    expect(REQUEST_INSTRUCTION).toMatch(/move \{ state|decline/);
    expect(REQUEST_INSTRUCTION).toContain("- Orientation —");
    expect(REQUEST_INSTRUCTION).not.toContain("- Localization —");
    expect(NODE_INSTRUCTIONS.working).toMatch(/stop/i);
    expect(NODE_INSTRUCTIONS.plan).toMatch(/call a tool/i);
    expect(transitionInstruction("orientation")).toMatch(/choose the next state/i);
    expect(NODE_INSTRUCTIONS.terminal).toMatch(/stop/i);
  });

  it("at a transition, points at the finished state's `Finish` line as the source of what/done", () => {
    const fromOrientation = transitionInstruction("orientation");
    expect(fromOrientation).toContain("Localization"); // a reachable candidate
    expect(fromOrientation).toContain("Finish state Orientation"); // the source line, by label
    expect(fromOrientation).not.toContain("Patch"); // only the focused state's `next` targets
    expect(fromOrientation).toMatch(/`what`.*`done`/i);
    const fromVerification = transitionInstruction("verification");
    expect(fromVerification).toContain("Finish state Verification");
    expect(fromVerification).toContain("Localization"); // the corrective edge
    const fromLocalization = transitionInstruction("localization");
    expect(fromLocalization).toContain("Finish state Localization");
    expect(fromLocalization).toMatch(/cause or violated invariant/);
    expect(fromLocalization).toContain("Research");
    const fromRecovery = transitionInstruction("recovery");
    expect(fromRecovery).toContain("Finish state Recovery");
    expect(fromRecovery).toMatch(/integrity\/consistency/);
    expect(fromRecovery).toContain("Research");
    const fromConstruction = transitionInstruction("construction");
    expect(fromConstruction).toContain("Finish state Construction");
    expect(fromConstruction).toMatch(/specification or the source's behaviour/);
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

  it("keeps stream discipline in the `bash` tool description (single source)", () => {
    const bash = PROPOSAL_TOOLS.find((tool) => tool.function.name === "bash");
    expect(bash?.function.description).toMatch(/stdout and stderr are captured SEPARATELY/i);
    expect(bash?.function.description).toMatch(/pipefail/i);
  });

  it("scopes the tool contract to the state's work", () => {
    const research = toolDescriptionsFor("research");
    expect(research.bash).toMatch(/Inspection only/);
    expect(research.write).toBeUndefined();

    const recovery = toolDescriptionsFor("recovery");
    expect(recovery.bash).toMatch(/you may create and modify files/i);
    expect(recovery.bash).toMatch(/keep the source read-only/i);
    expect(recovery.write).toMatch(/do not overwrite the source/i);
    expect(recovery.edit).toBeUndefined();

    const construction = toolDescriptionsFor("construction");
    expect(construction.bash).toMatch(/builds a new artifact/i);
    expect(construction.write).toMatch(/do not overwrite the source/i);
    expect(construction.webfetch).toMatch(/declared input or reference/i);

    const verification = toolDescriptionsFor("verification");
    expect(verification.bash).toMatch(/Inspection only/);
  });

  it("keeps `stop` about this state's criterion, with what it established as the record", () => {
    const stop = PROPOSAL_TOOLS.find((tool) => tool.function.name === "stop");
    expect(stop?.function.description).toMatch(/criterion/i);
    expect(stop?.function.description).toMatch(/established/i);
    expect(stop?.function.description).not.toMatch(/next state/i);
    const required = (stop?.function.parameters as { required?: string[] }).required ?? [];
    expect(required).toContain("why");
  });

  it("the working nudge names the done criterion and never a next state", () => {
    const nudge = turnInstruction("localization", "the cause is named with the file and the exact change");
    expect(nudge).toContain("the cause is named with the file and the exact change");
    expect(nudge).toMatch(/stop/i);
    expect(nudge).not.toMatch(/single next step/i);
    expect(nudge).not.toMatch(/next state/i);
  });

  it("places the per-state hint before the shared closure tail", () => {
    const orientation = turnInstruction("orientation", "the repository root is known");
    expect(orientation).toContain(ISLANDS.orientation.hint);
    expect(orientation).toMatch(/pwd/);
    expect(orientation).toMatch(/do not hunt the artifact/i);
    expect(orientation).toMatch(/environment facts/i);
    expect(orientation).toMatch(/observe them, do not assume them/i);
    expect(orientation).toMatch(/run the command that prints them/i);

    const localization = turnInstruction("localization", "the failure is located");
    expect(localization).toContain(ISLANDS.localization.hint);
    expect(localization).toMatch(/sibling material/i);
    expect(localization).toMatch(/cause or violated invariant/i);

    const research = turnInstruction("research", "the method is named");
    expect(research).toContain(ISLANDS.research.hint);
    expect(research).toMatch(/check the source itself provides/i);
    expect(research).toMatch(/not an integrity check/i);
    expect(research).toMatch(/probe\/parser/i);
    expect(research).toMatch(/do not walk offsets by hand/i);
    expect(research).toMatch(/do not start the recovery or construction/i);

    const patch = turnInstruction("patch", "the fix is applied");
    expect(patch).toContain(ISLANDS.patch.hint);
    expect(patch).toMatch(/do not relocate the artifact/i);
    expect(patch).toMatch(/Previous failed attempt/);
    expect(patch).toMatch(/do not repeat that change/i);

    const recovery = turnInstruction("recovery", "the output is derived");
    expect(recovery).toContain(ISLANDS.recovery.hint);
    expect(recovery).toMatch(/may create and change/i);
    expect(recovery).toMatch(/do not re-discover the source structure/i);
    expect(recovery).toMatch(/enumerate candidates/i);
    expect(recovery).toMatch(/negative control|wrong candidate/i);
    expect(recovery).toMatch(/do not fabricate/i);

    const construction = turnInstruction("construction", "the artifact passes");
    expect(construction).toContain(ISLANDS.construction.hint);
    expect(construction).toMatch(/specification or the source's behaviour/i);
    expect(construction).toMatch(/merely exists is not done/i);

    const verification = turnInstruction("verification", "the acceptance command passes");
    expect(verification).toContain(ISLANDS.verification.hint);
    expect(verification).toMatch(/choose the next state/i);
    expect(verification).toMatch(/patch/i);
    expect(verification).toMatch(/localization/i);
    expect(verification).toMatch(/wrong working directory/i);
    expect(verification).toMatch(/fix the environment and retry/i);
    expect(verification).toMatch(/literal retelling/i);
    expect(verification).toMatch(/Do not interpret the code/i);
    expect(verification).toMatch(/do not propose a fix/i);

    expect(NODE_INSTRUCTIONS.terminal).toContain(ISLANDS.finish.hint);
  });

  it("keeps the stop condition in the working instruction (B8): a state closes by stop", () => {
    const b8 = PROMPT_BLOCKS.find((block) => block.id === "B8");
    expect(b8?.text).toMatch(/stop/i);
    expect(b8?.text).toMatch(/do not re-check/i);
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
    expect(description).toContain("never batch");
    const prompt = `${BASE_PROMPT}\n${REQUEST_INSTRUCTION}\n${NODE_INSTRUCTIONS.working}`;
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
    const prompt = `${BASE_PROMPT}\n${REQUEST_INSTRUCTION}\n${NODE_INSTRUCTIONS.working}`;
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

  it("states the workspace-root/cd rule in the bash description (not in move)", () => {
    const bash = PROPOSAL_TOOLS.find((tool) => tool.function.name === "bash");
    expect(bash?.function.description).toMatch(/WORKSPACE ROOT/);
    expect(bash?.function.description).toContain("cd <dir> &&");
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

  it("lays the context out as a stable prefix, the constraints, the tape, then the open-state nudge", () => {
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
    // The open-state nudge is appended last (temporary — never in the history).
    expect(messages.at(-1)).toMatchObject({ role: "system", content: turnInstruction() });
    expect(messages).toHaveLength(6);
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
    // A `user` turn, not `system`: a trailing assistant text followed only by `system` is a
    // provider "prefix" and refuses the `move` function call.
    expect(messages.at(-1)).toMatchObject({
      role: "user",
      content: transitionInstruction("orientation"),
    });
    expect(String((messages.at(-1) as { content: string }).content)).toContain("Localization");
  });
});
