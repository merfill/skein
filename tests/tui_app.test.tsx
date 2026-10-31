import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import type { SessionTurnDeps } from "../src/session/driver";
import { memoryTelemetry } from "../src/session/telemetry";
import { TuiApp } from "../src/tui/app";

function deps(): SessionTurnDeps {
  return {
    sessionAgent: {
      agent: async () => ({ toolCalls: [] }),
      tools: {} as never,
    },
    task: {
      propose: async () => ({ actions: [] }),
      workspace: {} as never,
      maxTurns: 4,
    },
  } as unknown as SessionTurnDeps;
}

describe("TUI app", () => {
  it("renders the shell without a task", async () => {
    const telemetry = memoryTelemetry();
    const app = render(
      <TuiApp deps={deps()} telemetry={telemetry} workspace="/tmp/project" model="test-model" />,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("skein");
    expect(frame).toContain("test-model");
    expect(frame).toContain("Current task");
    expect(frame).toContain("no task yet");
    expect(frame).toContain("Ctrl-T history");
    app.unmount();
  });

  it("accepts typing and opens the task history overlay", async () => {
    const telemetry = memoryTelemetry();
    const app = render(
      <TuiApp deps={deps()} telemetry={telemetry} workspace="/tmp/project" model="test-model" />,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    app.stdin.write("hello");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(app.lastFrame()).toContain("hello");
    app.stdin.write("\u0014");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(app.lastFrame()).toContain("Task history");
    app.unmount();
  });
});
