import { describe, expect, it } from "vitest";

import type { EnvironmentFact } from "../src/ir/environment";
import type { SessionProbe } from "../src/ir/session";
import { grepText, listText, probeText } from "../src/session/session_workspace";

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
