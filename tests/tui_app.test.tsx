import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionTurnDeps } from "../src/session/driver";
import { memoryTelemetry } from "../src/session/telemetry";
import { TuiApp } from "../src/tui/app";

beforeEach(() => {
  process.env.SKEIN_LOG = "off";
});

afterEach(() => {
  delete process.env.SKEIN_MOUSE;
  delete process.env.SKEIN_LOG;
});

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

  it("scrolls the trace when it is focused", async () => {
    const telemetry = memoryTelemetry();
    const text = Array.from({ length: 60 }, (_, index) => `row-${index}`).join("\n");
    const turnDeps = deps();
    turnDeps.sessionAgent.agent = async () => ({
      operation: { kind: "respond", text },
    });
    const app = render(
      <TuiApp deps={turnDeps} telemetry={telemetry} workspace="/tmp/project" model="test-model" />,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    app.stdin.write("hi");
    await new Promise((resolve) => setTimeout(resolve, 200));
    app.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(app.lastFrame()).not.toContain("> hi");
    expect(app.lastFrame()).toContain("row-59");

    app.stdin.write("\t");
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (let index = 0; index < 15; index += 1) app.stdin.write("\u001b[A");
    await new Promise((resolve) => setTimeout(resolve, 40));

    const frame = app.lastFrame() ?? "";
    expect(frame).not.toContain("row-59");
    expect(frame).toContain("row-");
    app.unmount();
  });

  it("scrolls the trace from the composer and marks the hidden part", async () => {
    const telemetry = memoryTelemetry();
    const text = Array.from({ length: 60 }, (_, index) => `row-${index}`).join("\n");
    const turnDeps = deps();
    turnDeps.sessionAgent.agent = async () => ({
      operation: { kind: "respond", text },
    });
    const app = render(
      <TuiApp deps={turnDeps} telemetry={telemetry} workspace="/tmp/project" model="test-model" />,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    app.stdin.write("hi");
    await new Promise((resolve) => setTimeout(resolve, 200));
    app.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(app.lastFrame()).toContain("row-59");

    app.stdin.write("\u001b[5~");
    await new Promise((resolve) => setTimeout(resolve, 60));

    const frame = app.lastFrame() ?? "";
    expect(frame).not.toContain("row-59");
    expect(frame).toContain("more · PgUp");
    app.unmount();
  });

  it("scrolls the trace with the mouse wheel over it", async () => {
    process.env.SKEIN_MOUSE = "true";
    const telemetry = memoryTelemetry();
    const text = Array.from({ length: 60 }, (_, index) => `row-${index}`).join("\n");
    const turnDeps = deps();
    turnDeps.sessionAgent.agent = async () => ({
      operation: { kind: "respond", text },
    });
    const app = render(
      <TuiApp deps={turnDeps} telemetry={telemetry} workspace="/tmp/project" model="test-model" />,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    app.stdin.write("hi");
    await new Promise((resolve) => setTimeout(resolve, 200));
    app.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(app.lastFrame()).toContain("row-59");

    app.stdin.write("\u001b[<64;10;5M");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(app.lastFrame()).not.toContain("row-59");
    expect(app.lastFrame()).toContain("more · PgUp");

    app.stdin.write("\u001b[<65;10;5M");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(app.lastFrame()).toContain("row-59");
    app.unmount();
  });

  it("shows five composer rows and scrolls them with the cursor", async () => {
    const telemetry = memoryTelemetry();
    const app = render(
      <TuiApp deps={deps()} telemetry={telemetry} workspace="/tmp/project" model="test-model" />,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    app.stdin.write("a0\na1\na2\na3\na4\na5");
    await new Promise((resolve) => setTimeout(resolve, 120));
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("a5");
    expect(frame).toContain("a1");
    expect(frame).not.toContain("a0");
    app.unmount();
  });

  it("toggles a message block on click", async () => {
    process.env.SKEIN_MOUSE = "true";
    const telemetry = memoryTelemetry();
    const text = Array.from({ length: 60 }, (_, index) => `row-${index}`).join("\n");
    const turnDeps = deps();
    turnDeps.sessionAgent.agent = async () => ({
      operation: { kind: "respond", text },
    });
    const app = render(
      <TuiApp deps={turnDeps} telemetry={telemetry} workspace="/tmp/project" model="test-model" />,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    app.stdin.write("hi");
    await new Promise((resolve) => setTimeout(resolve, 200));
    app.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(app.lastFrame()).toContain("row-59");

    const frameLines = (app.lastFrame() ?? "").split("\n");
    const row = frameLines.findIndex((line) => line.includes("row-59"));
    expect(row).toBeGreaterThan(0);
    app.stdin.write(`\u001b[<0;10;${row + 1}M`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const collapsed = app.lastFrame() ?? "";
    expect(collapsed).not.toContain("row-59");
    expect(collapsed).toContain("row-0");

    const previewRow = collapsed.split("\n").findIndex((line) => line.includes("row-0"));
    expect(previewRow).toBeGreaterThan(0);
    app.stdin.write(`\u001b[<0;10;${previewRow + 1}M`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(app.lastFrame()).toContain("row-59");
    app.unmount();
  });

  it("toggles the first visible block with Space when mouse capture is off", async () => {
    const telemetry = memoryTelemetry();
    const text = Array.from({ length: 60 }, (_, index) => `row-${index}`).join("\n");
    const turnDeps = deps();
    turnDeps.sessionAgent.agent = async () => ({
      operation: { kind: "respond", text },
    });
    const app = render(
      <TuiApp deps={turnDeps} telemetry={telemetry} workspace="/tmp/project" model="test-model" />,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    app.stdin.write("hi");
    await new Promise((resolve) => setTimeout(resolve, 200));
    app.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(app.lastFrame()).toContain("row-59");

    app.stdin.write("\t");
    await new Promise((resolve) => setTimeout(resolve, 20));
    app.stdin.write(" ");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(app.lastFrame()).not.toContain("row-59");
    app.unmount();
  });

  it("wraps a long composer line and scrolls the window with the cursor", async () => {
    const telemetry = memoryTelemetry();
    const app = render(
      <TuiApp deps={deps()} telemetry={telemetry} workspace="/tmp/project" model="test-model" />,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    app.stdin.write(`START-${"x".repeat(500)}-END`);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("-END");
    expect(frame).not.toContain("START-");
    app.unmount();
  });

  it("deletes the character before the cursor, not the one under it", async () => {
    const telemetry = memoryTelemetry();
    const app = render(
      <TuiApp deps={deps()} telemetry={telemetry} workspace="/tmp/project" model="test-model" />,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    app.stdin.write("xyz");
    await new Promise((resolve) => setTimeout(resolve, 80));
    app.stdin.write("\u007f");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(app.lastFrame()).toContain("xy");
    expect(app.lastFrame()).not.toContain("xyz");

    app.stdin.write("z");
    await new Promise((resolve) => setTimeout(resolve, 80));
    app.stdin.write("\u001b[D");
    await new Promise((resolve) => setTimeout(resolve, 80));
    app.stdin.write("\u007f");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(app.lastFrame()).toContain("x z");
    app.unmount();
  });

  it("recalls submitted messages with Up/Down in the composer", async () => {
    const telemetry = memoryTelemetry();
    const turnDeps = deps();
    turnDeps.sessionAgent.agent = async () => ({
      operation: { kind: "respond", text: "ok" },
    });
    const app = render(
      <TuiApp deps={turnDeps} telemetry={telemetry} workspace="/tmp/project" model="test-model" />,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    app.stdin.write("alpha-msg");
    await new Promise((resolve) => setTimeout(resolve, 120));
    app.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 200));
    app.stdin.write("beta-msg");
    await new Promise((resolve) => setTimeout(resolve, 120));
    app.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 200));

    app.stdin.write("\u001b[A");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(app.lastFrame()).toContain("│ > beta-msg");
    app.stdin.write("\u001b[A");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(app.lastFrame()).toContain("│ > alpha-msg");
    app.stdin.write("\u001b[B");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(app.lastFrame()).toContain("│ > beta-msg");
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

  it("opens a file picker for @ and inserts the path", async () => {
    const telemetry = memoryTelemetry();
    const turnDeps = deps();
    turnDeps.task.workspace = {
      listFiles: () => ["README.md", "src/app.ts", "src/deep/app.test.ts"],
    } as never;
    const app = render(
      <TuiApp deps={turnDeps} telemetry={telemetry} workspace="/tmp/project" model="test-model" />,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    app.stdin.write("@ap");
    await new Promise((resolve) => setTimeout(resolve, 60));
    const menu = app.lastFrame() ?? "";
    expect(menu).toContain("@ file");
    expect(menu).toContain("src/app.ts");
    app.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(app.lastFrame()).toContain("@src/app.ts");
    app.unmount();
  });

  it("runs a slash command and resets the session", async () => {
    const telemetry = memoryTelemetry();
    const turnDeps = deps();
    turnDeps.sessionAgent.agent = async () => ({
      operation: { kind: "respond", text: "hello-answer" },
    });
    const app = render(
      <TuiApp deps={turnDeps} telemetry={telemetry} workspace="/tmp/project" model="test-model" />,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    app.stdin.write("hi");
    await new Promise((resolve) => setTimeout(resolve, 40));
    app.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(app.lastFrame()).toContain("hello-answer");
    app.stdin.write("/new");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(app.lastFrame()).toContain("/ command");
    app.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 80));
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("session reset");
    expect(frame).not.toContain("hello-answer");
    app.unmount();
  });

  it("rejects an unknown slash command without sending it", async () => {
    const telemetry = memoryTelemetry();
    const app = render(
      <TuiApp deps={deps()} telemetry={telemetry} workspace="/tmp/project" model="test-model" />,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    app.stdin.write("/zzz");
    await new Promise((resolve) => setTimeout(resolve, 40));
    app.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(app.lastFrame()).toContain("unknown command: /zzz");
    app.unmount();
  });
});
