import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";

import {
  executePlan,
  resumeTurn,
  runSessionTurn,
  type PausedState,
  type SessionTurnDeps,
} from "../src/session/driver";
import {
  runDocumentUnit,
  type DocumentDeps,
  type DocumentPlanReply,
  type DocumentTextReply,
} from "../src/session/document";
import { planFinished, planItemStatus } from "../src/session/plan";
import type { PlannerDraft, PlannerReply } from "../src/session/planner";
import { createSession } from "../src/session/session";
import type { SessionAgent, SessionTools } from "../src/session/session_agent";
import type { SessionOperation } from "../src/session/types";
import { cleanupWorkspaces, makeWorkspace } from "./ops/helpers";

afterEach(cleanupWorkspaces);

const tools: SessionTools = { unit: (_session, id) => `UNIT ${id}` };

function lastUserText(messages: readonly ModelMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    return message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n");
  }
  return "";
}

function outline(path: string, titles: string[]): DocumentPlanReply {
  return {
    calls: [
      {
        name: "submit_plan",
        args: {
          path,
          items: titles.map((title) => ({ title, brief: `Write ${title}.` })),
        },
        callId: "outline",
      },
    ],
    thought: "",
  };
}

function bodyByHint(bodies: Record<string, string>, summary = "Summary.") {
  return async (messages: ModelMessage[]): Promise<DocumentTextReply> => {
    const text = lastUserText(messages);
    const match = /Write item (\d+) of/.exec(text);
    if (match !== null) {
      const key = match[1] as string;
      return { text: bodies[key] ?? `body ${key}`, finishReason: "stop" };
    }
    return { text: summary, finishReason: "stop" };
  };
}

function documentDeps(
  ws: DocumentDeps["workspace"],
  plan: DocumentDeps["plan"],
  write: DocumentDeps["write"],
): DocumentDeps {
  return { plan, write, workspace: ws, maxTurns: 20, maxPlanTurns: 4 };
}

function operations(items: SessionOperation[]): SessionAgent {
  let index = 0;
  return async () => ({ operation: items[index++] });
}

function plannerFor(draft: PlannerDraft) {
  return {
    agent: async (): Promise<PlannerReply> => ({
      calls: [{ name: "submit_plan", args: { ...draft }, callId: "planner:submit" }],
      thought: "",
    }),
  };
}

describe("document unit", () => {
  it("submits an outline, writes the sections, and summarizes", async () => {
    const { ws, root } = makeWorkspace();
    const deps = documentDeps(
      ws,
      async () => outline("docs/out.md", ["Intro", "Body"]),
      bodyByHint({ "1": "Hello intro.", "2": "Hello body." }, "Done."),
    );

    const run = await runDocumentUnit(deps, {
      request: { id: "d1", text: "create docs/out.md" },
    });

    expect(run.done).toBe(true);
    expect(run.stopReason).toBe("summarized");
    expect(run.outline?.items).toHaveLength(2);
    const file = readFileSync(join(root, "docs/out.md"), "utf8");
    expect(file).toContain("## Intro\n\nHello intro.");
    expect(file).toContain("## Body\n\nHello body.");
    expect(file.indexOf("## Intro")).toBeLessThan(file.indexOf("## Body"));
  });

  it("continues a section cut by the output limit instead of losing it", async () => {
    const { ws, root } = makeWorkspace();
    let continuation = 0;
    const deps = documentDeps(
      ws,
      async () => outline("docs/out.md", ["Only"]),
      async (messages) => {
        const text = lastUserText(messages);
        if (/Write item 1 of/.test(text)) return { text: "Part one ", finishReason: "length" };
        if (/Continue item 1/.test(text)) {
          continuation += 1;
          return { text: "part two.", finishReason: "stop" };
        }
        return { text: "Summary.", finishReason: "stop" };
      },
    );

    const run = await runDocumentUnit(deps, {
      request: { id: "d1", text: "create docs/out.md" },
    });

    expect(run.done).toBe(true);
    expect(continuation).toBe(1);
    const file = readFileSync(join(root, "docs/out.md"), "utf8");
    expect(file).toContain("Part one part two.");
  });

  it("runs as a plan item and closes the plan when the file is written", async () => {
    const { ws, root } = makeWorkspace();
    const draft: PlannerDraft = {
      items: [
        {
          title: "Write the document",
          detail: "Create docs/out.md with the requested sections.",
        },
      ],
    };
    const deps: SessionTurnDeps = {
      sessionAgent: {
        agent: operations([
          { kind: "plan", text: "plan the doc" },
          { kind: "document", text: "create docs/out.md" },
        ]),
        tools,
      },
      task: {
        propose: async () => ({ thought: "", actions: [] }),
        workspace: ws,
        maxTurns: 4,
      },
      planner: { ...plannerFor(draft), workspace: ws, maxTurns: 4 },
      document: documentDeps(
        ws,
        async () => outline("docs/out.md", ["Intro"]),
        bodyByHint({ "1": "Hello." }),
      ),
    };
    const session = createSession();
    await runSessionTurn(deps, session, "write the doc");

    const run = await executePlan(deps, session, "p1");
    expect(run.status).toBe("done");
    expect(run.completed).toBe(1);
    expect(planItemStatus(session, "p1:plan:body:item:1")).toBe("completed");
    expect(planFinished(session, "p1")).toEqual({ status: "done", completed: 1, total: 1 });
    expect(existsSync(join(root, "docs/out.md"))).toBe(true);
  });

  it("resumes from the first unwritten section without duplicating it", async () => {
    const { ws, root } = makeWorkspace();
    const session = createSession();
    const controller = new AbortController();
    let aborted = false;
    const deps: SessionTurnDeps = {
      sessionAgent: { agent: operations([]), tools },
      task: {
        propose: async () => ({ thought: "", actions: [] }),
        workspace: ws,
        maxTurns: 4,
      },
      document: documentDeps(
        ws,
        async () => outline("docs/out.md", ["Intro", "Body"]),
        async (messages) => {
          const text = lastUserText(messages);
          if (/Write item 1 of/.test(text)) {
            if (!aborted) {
              aborted = true;
              controller.abort();
            }
            return { text: "Hello intro.", finishReason: "stop" };
          }
          if (/Write item 2 of/.test(text)) return { text: "Hello body.", finishReason: "stop" };
          return { text: "Summary.", finishReason: "stop" };
        },
      ),
    };

    const first = await runDocumentUnit(deps.document!, {
      request: { id: "d1", text: "create docs/out.md" },
      session,
      open: true,
      signal: controller.signal,
    });
    expect(first.paused).toBe(true);
    expect(first.done).toBe(false);

    // The driver syncs the unit journal when the run returns; mirror it before resuming.
    const unit = session.units.get("d1");
    if (unit === undefined) throw new Error("document unit not opened");
    unit.journal.splice(0, unit.journal.length, ...first.events);
    unit.turn = first.turns;

    const paused: PausedState = {
      agent: "document",
      unitId: "d1",
      utterance: "create docs/out.md",
      utteranceTurn: 0,
      startTurn: first.turns,
    };
    const resumed = await resumeTurn(deps, session, paused);
    expect(resumed.document?.result.done).toBe(true);

    const file = readFileSync(join(root, "docs/out.md"), "utf8");
    expect(file.match(/## Intro/g)).toHaveLength(1);
    expect(file).toContain("Hello body.");
  });

  it("opens directly from a session `document` operation", async () => {
    const { ws, root } = makeWorkspace();
    const deps: SessionTurnDeps = {
      sessionAgent: {
        agent: operations([{ kind: "document", text: "create docs/out.md" }]),
        tools,
      },
      task: {
        propose: async () => ({ thought: "", actions: [] }),
        workspace: ws,
        maxTurns: 4,
      },
      document: documentDeps(
        ws,
        async () => outline("docs/out.md", ["Intro"]),
        bodyByHint({ "1": "Hello." }),
      ),
    };
    const session = createSession();

    const result = await runSessionTurn(deps, session, "write the doc");
    expect(result.document?.unitId).toBe("d1");
    expect(result.document?.result.done).toBe(true);
    expect(readFileSync(join(root, "docs/out.md"), "utf8")).toContain("Hello.");
  });
});
