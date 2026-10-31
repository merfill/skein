import { describe, expect, it } from "vitest";

import type { EnvironmentFact } from "../src/ir/environment";
import type { SessionProbe } from "../src/ir/session";
import {
  createSessionTools,
  runSessionAgent,
  type SessionAgent,
} from "../src/session/session_agent";
import { createSession } from "../src/session/session";
import type { SessionWorkspace } from "../src/session/session_workspace";
import { grepText, listText, probeText } from "../src/session/session_workspace";
import type { GrepMatch } from "../src/tools/workspace";

const FILES = new Map<string, string>([
  ["src/a.ts", "export function alpha() {}\nconst beta = 1;\n"],
  ["src/b.ts", "// beta again\nexport const gamma = 2;\n"],
  ["tests/a.test.ts", "import { alpha } from \"../src/a\";\n"],
]);

const environment: EnvironmentFact = {
  root: "/app",
  found: [
    { name: "git", group: "vcs", path: "/usr/bin/git", version: "2.43.0" },
    { name: "npm", group: "pkg", path: "/usr/bin/npm", version: "10.0.0" },
    { name: "node", group: "interpreters", path: "/usr/bin/node", version: "20.0.0" },
    { name: "pytest", group: "test", path: "/usr/bin/pytest", version: "8.0.0" },
    { name: "grep", group: "core", path: "/usr/bin/grep" },
  ],
  missing: [{ name: "rustc", group: "compilers" }],
};

const material = {
  root: "/app",
  repos: [],
  entries: [{ name: "src", kind: "dir" as const, files: 2 }],
  paths: ["src/a.ts", "src/b.ts"],
  files: 3,
};

function fakeWorkspace(): SessionWorkspace {
  return {
    read: (path) => {
      const text = FILES.get(path);
      if (text === undefined) throw new Error(`no such file: ${path}`);
      return { text, version: "v1", bytes: text.length, lines: text.split("\n").length };
    },
    listFiles: () => [...FILES.keys()],
    grep: (pattern) => {
      const regex = new RegExp(pattern);
      const matches: GrepMatch[] = [];
      for (const [path, content] of FILES) {
        content.split("\n").forEach((text, index) => {
          if (regex.test(text)) matches.push({ path, line: index + 1, text });
        });
      }
      return matches;
    },
    probe: () => ({ environment, material }),
  };
}

describe("grepText and listText: bounded windows with a cursor", () => {
  it("renders path:line matches and pages a large window", () => {
    const many = Array.from({ length: 105 }, (_, index) => ({
      path: "src/a.ts",
      line: index + 1,
      text: `line ${index + 1}`,
    }));
    const page = grepText(many);
    expect(page).toContain("src/a.ts:1: line 1");
    expect(page).toContain("[showing 100 of 105 matches; continue from 101]");

    const rest = grepText(many, 101);
    expect(rest).toContain("src/a.ts:101: line 101");
    expect(rest).not.toContain("continue from");

    expect(grepText([], 1)).toBe("no matches");
  });

  it("renders a JSON file window with next", () => {
    const files = Array.from({ length: 205 }, (_, index) => `src/f${index}.ts`);
    const page = listText(files, { root: "src" });
    expect(page).toContain("\"total\": 205");
    expect(page).toContain("\"next\": 201");

    const tail = listText(files, { root: "src", from: 201 });
    expect(tail).toContain("src/f200.ts");
    expect(tail).not.toContain("\"next\"");
    expect(listText([], {})).toBe("no files");
  });
});

describe("probeText: one fact by kind", () => {
  const probe: SessionProbe = { environment, material };

  it("filters the environment by group", () => {
    expect(probeText(probe, "packages")).toContain("package managers: npm 10.0.0");
    expect(probeText(probe, "packages")).not.toContain("node");
    expect(probeText(probe, "interpreters")).toContain("interpreters: node 20.0.0");
    expect(probeText(probe, "environment")).toContain("root: /app");
  });

  it("returns the workspace map and reports a missing probe", () => {
    expect(probeText(probe, "material")).toContain("Workspace map");
    expect(probeText(probe, "material")).toContain("entries: src/ (2 files)");
    expect(probeText(undefined, "environment")).toBe("probe unavailable");
  });
});

describe("session tools: grep/list/probe over the live workspace", () => {
  it("uses grep without opening a task", async () => {
    const workspace = fakeWorkspace();
    const session = createSession();
    let calls = 0;
    const agent: SessionAgent = async () => {
      calls += 1;
      return calls === 1
        ? { toolCalls: [{ name: "grep", args: { pattern: "beta" }, callId: "c1" }] }
        : { operation: { kind: "respond", text: "beta is in src/a.ts and src/b.ts" } };
    };

    const result = await runSessionAgent(
      { agent, tools: createSessionTools(workspace.read), workspace },
      session,
      "where is beta used?",
    );

    expect(result.operation?.kind).toBe("respond");
    expect([...session.units.keys()]).toEqual(["session:1"]);
    const observed = result.journal.find(
      (event) =>
        event.type === "add_node" &&
        event.node.kind === "observation" &&
        String((event.node.payload as { result?: unknown }).result).includes("src/a.ts:2: const beta = 1;"),
    );
    expect(observed).toBeDefined();
  });

  it("lists files and probes the toolchain", async () => {
    const workspace = fakeWorkspace();
    const session = createSession();
    let calls = 0;
    const agent: SessionAgent = async () => {
      calls += 1;
      if (calls === 1) {
        return { toolCalls: [{ name: "list", args: {}, callId: "c1" }] };
      }
      if (calls === 2) {
        return { toolCalls: [{ name: "probe", args: { kind: "packages" }, callId: "c2" }] };
      }
      return { operation: { kind: "respond", text: "npm is available" } };
    };

    const result = await runSessionAgent(
      { agent, tools: createSessionTools(workspace.read), workspace },
      session,
      "what package manager is available?",
    );

    const results = result.journal.flatMap((event) =>
      event.type === "add_node" && event.node.kind === "observation"
        ? [String((event.node.payload as { result?: unknown }).result)]
        : [],
    );
    expect(results.some((text) => text.includes("src/a.ts"))).toBe(true);
    expect(results.some((text) => text.includes("package managers: npm 10.0.0"))).toBe(true);
  });

  it("reports a tool as unavailable without a workspace", async () => {
    const session = createSession();
    let calls = 0;
    const agent: SessionAgent = async () => {
      calls += 1;
      return calls === 1
        ? { toolCalls: [{ name: "grep", args: { pattern: "x" }, callId: "c1" }] }
        : { operation: { kind: "respond", text: "no workspace" } };
    };

    const result = await runSessionAgent(
      { agent, tools: createSessionTools() },
      session,
      "search",
    );

    const observed = result.journal.find(
      (event) =>
        event.type === "add_node" &&
        event.node.kind === "observation" &&
        String((event.node.payload as { result?: unknown }).result) === "tool unavailable: grep",
    );
    expect(observed).toBeDefined();
  });
});
