import { afterEach, describe, expect, it } from "vitest";

import { fold } from "../src/ir/graph";
import type { Context } from "../src/ir/project";
import type { Proposals } from "../src/llm/schemas";
import { runAgent } from "../src/loop/graph";
import type { Proposer } from "../src/loop/propose";
import {
  cancelTurn,
  resumeTurn,
  runSessionTurn,
  type SessionTurnDeps,
} from "../src/session/driver";
import { runRepl } from "../src/session/repl";
import {
  defaultObserverTools,
  runRequestObserver,
  type RequestObserver,
} from "../src/session/observer";
import { attentionOf, createSession } from "../src/session/session";
import { createSessionTools, type SessionAgent } from "../src/session/session_agent";
import { memoryTelemetry } from "../src/session/telemetry";
import type { Trigger } from "../src/session/types";
import { cleanupWorkspaces, makeWorkspace, move, read, request, write } from "./ops/helpers";

afterEach(cleanupWorkspaces);

const START: SessionAgent = async () => ({
  operation: { kind: "start", text: "edit src/app.txt" },
});

// The task writes once, then aborts before the next action. The write is committed by the
// turn's `progress`; the abort is honoured at the following step boundary.
function pausingProposer(controller: AbortController): Proposer {
  let phase = 0;
  return async (context: Context): Promise<Proposals> => {
    if (context.situation === "request") {
      return { thought: "", actions: [move("construction", "edit the file")] };
    }
    if (context.situation === "plan") {
      return { thought: "", actions: [read("src/app.txt")] };
    }
    if (context.situation === "working") {
      if (phase === 0) {
        phase = 1;
        return { thought: "", actions: [write("src/app.txt", "new")] };
      }
      controller.abort();
      return { thought: "", actions: [{ operator: "stop", why: "done" }] };
    }
    if (context.situation === "transition") {
      return { thought: "", actions: [move("end", "finish")] };
    }
    return { thought: "", actions: [{ operator: "stop", why: "done" }] };
  };
}

function taskDeps(proposer: Proposer, workspace: SessionTurnDeps["task"]["workspace"]): SessionTurnDeps {
  return {
    sessionAgent: { agent: START, tools: createSessionTools() },
    task: { propose: proposer, workspace, maxTurns: 20 },
  };
}

describe("task pause, resume and cancel", () => {
  it("pauses before the next action, resumes from the committed journal, and keeps the work", async () => {
    const { ws } = makeWorkspace({ "src/app.txt": "old\n" }, { checkpoints: true });
    const controller = new AbortController();
    const deps = taskDeps(pausingProposer(controller), ws);
    const session = createSession();

    const first = await runSessionTurn(deps, session, "edit it", { signal: controller.signal });
    expect(first.paused?.agent).toBe("task");
    expect(first.task?.unitId).toBe("r1");
    expect(ws.read("src/app.txt")).toBe("new");
    expect(session.units.get("r1")?.checkpoint).toBeDefined();

    const resumeController = new AbortController();
    const resumed = await resumeTurn(deps, session, first.paused!, {
      signal: resumeController.signal,
    });
    expect(resumed.paused).toBeUndefined();
    expect(resumed.task?.result.done).toBe(true);
    expect(ws.read("src/app.txt")).toBe("new");
    expect(session.units.get("r1")?.journal.some((event) => event.type === "rollback")).toBe(false);
  });

  it("cancel restores the entry snapshot, records the rollback fact, and meters the run", async () => {
    const { ws } = makeWorkspace({ "src/app.txt": "old\n" }, { checkpoints: true });
    const controller = new AbortController();
    const deps = taskDeps(pausingProposer(controller), ws);
    const telemetry = memoryTelemetry();
    deps.telemetry = telemetry.sink;
    deps.task.telemetry = telemetry.sink;
    deps.sessionAgent.telemetry = telemetry.sink;
    const session = createSession();

    const first = await runSessionTurn(deps, session, "edit it", { signal: controller.signal });
    expect(first.paused?.agent).toBe("task");
    expect(ws.read("src/app.txt")).toBe("new");

    const cancelled = cancelTurn(ws, session, first.paused!, telemetry.sink);
    expect(cancelled.warning).toBeUndefined();
    expect(ws.read("src/app.txt")).toBe("old\n");
    const task = session.units.get("r1");
    expect(task?.journal.some((event) => event.type === "rollback")).toBe(true);
    expect(session.stack.some((ref) => ref.unitId === "r1")).toBe(false);

    expect(telemetry.events.some((event) => event.type === "pause")).toBe(true);
    const cancelEvent = telemetry.events.find((event) => event.type === "cancel");
    expect(cancelEvent?.type === "cancel" ? cancelEvent.rollback : undefined).toBe("ok");
    expect(
      telemetry.events.some((event) => event.type === "model_call" && event.agent === "task"),
    ).toBe(true);
    expect(
      telemetry.events.some((event) => event.type === "tool_call" && event.agent === "task"),
    ).toBe(true);
  });

  it("warns and keeps the changes when the workspace has no snapshot store", async () => {
    const { ws } = makeWorkspace({ "src/app.txt": "old\n" });
    const controller = new AbortController();
    const deps = taskDeps(pausingProposer(controller), ws);
    const session = createSession();

    const first = await runSessionTurn(deps, session, "edit it", { signal: controller.signal });
    expect(first.paused?.agent).toBe("task");
    expect(session.units.get("r1")?.checkpoint).toBeUndefined();

    const cancelled = cancelTurn(ws, session, first.paused!);
    expect(cancelled.warning).toContain("rollback unavailable");
    expect(ws.read("src/app.txt")).toBe("new");
    expect(session.units.get("r1")?.journal.some((event) => event.type === "rollback")).toBe(false);
  });
});

describe("session pause and resume", () => {
  it("keeps the completed tool turns and resumes the same unit", async () => {
    const { ws } = makeWorkspace({ "a.txt": "x\n" });
    const controller = new AbortController();
    const session = createSession();
    let calls = 0;
    const agent: SessionAgent = async () => {
      calls += 1;
      if (calls === 1) {
        return { toolCalls: [{ name: "list", args: {}, callId: "l1" }] };
      }
      if (calls === 2) {
        controller.abort();
        return { operation: { kind: "respond", text: "lost" } };
      }
      return { operation: { kind: "respond", text: "done" } };
    };
    const deps: SessionTurnDeps = {
      sessionAgent: { agent, tools: createSessionTools() },
      task: {
        propose: async () => ({ thought: "", actions: [] }),
        workspace: ws,
        maxTurns: 5,
      },
    };

    const first = await runSessionTurn(deps, session, "look around", {
      signal: controller.signal,
    });
    expect(first.paused?.agent).toBe("session");
    expect(attentionOf(session, "session:1")).toBe("active");
    expect(session.units.get("session:1")?.journal.some((event) => event.type === "add_node")).toBe(true);

    const resumeController = new AbortController();
    const resumed = await resumeTurn(deps, session, first.paused!, {
      signal: resumeController.signal,
    });
    expect(resumed.paused).toBeUndefined();
    expect(resumed.reply).toBe("done");
    expect(attentionOf(session, "session:1")).toBe("completed");
  });
});

describe("REPL pause menu", () => {
  it("pauses, resumes on 'r', and prints the answer", async () => {
    const { ws } = makeWorkspace({ "a.txt": "x\n" });
    const session = createSession();
    let current: AbortController | undefined;
    let calls = 0;
    const agent: SessionAgent = async () => {
      calls += 1;
      if (calls === 1) {
        current?.abort();
        return { toolCalls: [{ name: "list", args: {}, callId: "l1" }] };
      }
      return { operation: { kind: "respond", text: "done" } };
    };
    const deps: SessionTurnDeps = {
      sessionAgent: { agent, tools: createSessionTools() },
      task: {
        propose: async () => ({ thought: "", actions: [] }),
        workspace: ws,
        maxTurns: 5,
      },
    };
    const output: string[] = [];
    await runRepl(
      (async function* () {
        yield "look";
        yield "r";
        yield "exit";
      })(),
      deps,
      (line) => output.push(line),
      session,
      {
        createSignal: () => {
          current = new AbortController();
          return current.signal;
        },
      },
    );
    expect(output.some((line) => line.startsWith("paused:"))).toBe(true);
    expect(output.some((line) => line.includes("answer:"))).toBe(true);
    expect(output.some((line) => line.includes("done"))).toBe(true);
  });
});

describe("abort classification", () => {
  it("turns an aborted model call into a pause, not llm_error", async () => {
    const { ws } = makeWorkspace();
    const controller = new AbortController();
    controller.abort();
    const result = await runAgent(
      {
        propose: () => Promise.reject(new Error("aborted")),
        workspace: ws,
        maxTurns: 5,
      },
      { request: { id: "r1", text: "x" }, signal: controller.signal },
    );
    expect(result.paused).toBe(true);
    expect(result.done).toBe(true);
    expect(result.stopReason).toBeNull();
  });
});

const COMPLETE: Proposer = async (context: Context): Promise<Proposals> => {
  if (context.situation === "request") {
    return { thought: "", actions: [move("construction", "edit the file")] };
  }
  if (context.situation === "plan") {
    return { thought: "", actions: [read("src/app.txt")] };
  }
  if (context.situation === "working") {
    return { thought: "", actions: [{ operator: "stop", why: "done" }] };
  }
  if (context.situation === "transition") {
    return { thought: "", actions: [move("end", "finish")] };
  }
  return { thought: "", actions: [{ operator: "stop", why: "done" }] };
};

describe("observer pause inside a task", () => {
  it("keeps the observer unit, resumes it, applies the reaction, and continues the task", async () => {
    const { ws } = makeWorkspace({ "src/app.txt": "old\n" }, { checkpoints: true });
    const controller = new AbortController();
    let calls = 0;
    const decision = { kind: "memo" as const, text: "keep it short", evidence: ["e"] };
    const observer: RequestObserver = async () => {
      calls += 1;
      if (calls === 1) {
        controller.abort();
        return { toolCalls: [{ name: "outline", args: {}, callId: "o1" }] };
      }
      return { decision };
    };
    const deps: SessionTurnDeps = {
      sessionAgent: { agent: START, tools: createSessionTools() },
      task: {
        propose: COMPLETE,
        workspace: ws,
        maxTurns: 4,
        observer: { agent: observer, tools: defaultObserverTools },
      },
    };
    const session = createSession();

    const first = await runSessionTurn(deps, session, "edit it", { signal: controller.signal });
    expect(first.paused?.agent).toBe("observer");
    const observerId = first.paused!.unitId;
    expect(observerId.startsWith("observer:")).toBe(true);
    expect(session.stack.at(-1)?.unitId).toBe(observerId);

    const resumeController = new AbortController();
    const resumed = await resumeTurn(deps, session, first.paused!, {
      signal: resumeController.signal,
    });
    expect(resumed.paused).toBeUndefined();
    expect(resumed.task).toBeDefined();
    expect(session.stack.some((ref) => ref.unitId === observerId)).toBe(false);
    expect(
      session.journal.some((event) => event.type === "reaction" && event.unitId === "r1"),
    ).toBe(true);
  });
});

describe("observer loop pause and resume", () => {
  it("keeps the survey turn and resumes to one decision", async () => {
    const controller = new AbortController();
    let calls = 0;
    const decision = { kind: "hint" as const, text: "h", evidence: ["e"], state: "patch" };
    const agent: RequestObserver = async () => {
      calls += 1;
      if (calls === 1) return { toolCalls: [{ name: "outline", args: {}, callId: "o1" }] };
      if (calls === 2) {
        controller.abort();
        return { decision };
      }
      return { decision };
    };
    const trigger: Trigger = {
      id: "t",
      kind: "state_long",
      anchor: "patch",
      evidence: [],
      epoch: 0,
      turn: 0,
    };
    const state = fold([request("do it")]);

    const first = await runRequestObserver({
      trigger,
      state,
      tools: defaultObserverTools,
      agent,
      signal: controller.signal,
    });
    expect(first.paused).toBe(true);
    expect(first.decision).toBeUndefined();

    const resumeController = new AbortController();
    const resumed = await runRequestObserver({
      trigger,
      state,
      tools: defaultObserverTools,
      agent,
      journal: first.journal,
      startTurn: first.turns,
      signal: resumeController.signal,
    });
    expect(resumed.paused).toBeUndefined();
    expect(resumed.decision).toEqual(decision);
  });
});
