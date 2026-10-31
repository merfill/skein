import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Context } from "../src/ir/project";
import { runAgent } from "../src/loop/graph";
import type { Proposals } from "../src/llm/schemas";
import type { ProgressEvent } from "../src/session/progress";
import { fsWorkspace } from "../src/tools/workspace";

const dirs: string[] = [];

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "skein-tui-progress-"));
  dirs.push(root);
  return fsWorkspace(root);
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("TUI progress events", () => {
  it("reports turns, tools, states and added events while a task runs", async () => {
    let index = 0;
    const propose = async (_context: Context): Promise<Proposals> => {
      index += 1;
      if (index === 1) {
        return {
          thought: "",
          actions: [{ operator: "move", state: "orientation", what: "map the repo" }],
        };
      }
      if (index === 2) {
        return {
          thought: "",
          actions: [{ operator: "apply", action: { tool: "bash", command: "true" } }],
        };
      }
      if (index === 3) {
        return { thought: "", actions: [{ operator: "stop", why: "mapped" }] };
      }
      if (index === 4) {
        return { thought: "", actions: [{ operator: "move", state: "end", what: "" }] };
      }
      if (index === 5) {
        return { thought: "", actions: [{ operator: "stop", why: "done" }] };
      }
      return { thought: "", actions: [{ operator: "recall", id: "r1" }] };
    };

    const progress: ProgressEvent[] = [];
    const result = await runAgent(
      {
        propose,
        workspace: workspace(),
        maxTurns: 8,
        onProgress: (event) => progress.push(event),
      },
      { request: { id: "r1", text: "green" } },
    );

    expect(result.stopReason).toBe("request_addressed");
    expect(progress.some((event) => event.type === "turn_started")).toBe(true);
    expect(progress.some((event) => event.type === "model_call_started")).toBe(true);
    expect(progress.some((event) => event.type === "model_call_finished")).toBe(true);
    expect(
      progress.some(
        (event) => event.type === "tool_started" && event.tool === "bash" && event.agent === "task",
      ),
    ).toBe(true);
    expect(
      progress.some(
        (event) =>
          event.type === "tool_finished" &&
          event.tool === "bash" &&
          event.status === "ok" &&
          event.agent === "task",
      ),
    ).toBe(true);
    expect(
      progress.some(
        (event) => event.type === "state_changed" && event.state === "orientation" && !event.closed,
      ),
    ).toBe(true);
    expect(
      progress.some((event) => event.type === "state_changed" && event.state === "end" && event.closed),
    ).toBe(true);
    expect(progress.some((event) => event.type === "events_added" && event.events.length > 0)).toBe(
      true,
    );
    expect(progress.some((event) => event.type === "turn_finished")).toBe(true);
  });
});
