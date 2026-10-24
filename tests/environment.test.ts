import { describe, expect, it } from "vitest";

import { environmentBrief, type EnvironmentFact } from "../src/ir/environment";
import type { Event } from "../src/ir/events";
import { fold } from "../src/ir/graph";
import { workspaceBrief, type MaterialFact } from "../src/ir/material";
import { project } from "../src/ir/project";
import { SESSION_PROBE_ID, probeBrief, type SessionProbe } from "../src/ir/session";
import { probeMaterial } from "../src/loop/material";
import { parseProbe, probeSession } from "../src/loop/probe";
import type { CommandResult, Workspace } from "../src/tools/workspace";

const environment: EnvironmentFact = {
  root: "/app",
  found: [
    { name: "git", group: "vcs", path: "/usr/bin/git", version: "2.39.2" },
    { name: "make", group: "build", path: "/usr/bin/make", version: "4.3" },
    { name: "gcc", group: "compilers", path: "/usr/bin/gcc", version: "13.2.0" },
    { name: "python3", group: "interpreters", path: "/usr/bin/python3", version: "3.11.5" },
    { name: "perl", group: "interpreters", path: "/usr/bin/perl", version: "5.38.2" },
    { name: "pytest", group: "test", path: "/usr/bin/pytest", version: "8.2.0" },
    { name: "npm", group: "pkg", path: "/usr/bin/npm", version: "10.2.0" },
    { name: "openssl", group: "crypto", path: "/usr/bin/openssl", version: "3.0.17" },
    { name: "jq", group: "core", path: "/usr/bin/jq" },
    { name: "sqlite3", group: "data", path: "/usr/bin/sqlite3", version: "3.45.1" },
  ],
  missing: [
    { name: "python", group: "interpreters" },
    { name: "xxd", group: "core" },
    { name: "7z", group: "archive" },
  ],
};

const material: MaterialFact = {
  root: "/app",
  repos: [
    {
      kind: "git",
      root: "/app/ocaml",
      branch: "main",
      head: "abc1234",
      dirty: 2,
      commits: [{ hash: "abc1234", subject: "fix sweep" }],
    },
  ],
  entries: [
    { name: "ocaml", kind: "dir", files: 20 },
    { name: "README.md", kind: "file" },
  ],
  paths: ["README.md", "ocaml/Makefile", "ocaml/src/a.c"],
  files: 20,
};

function request(): Event {
  return {
    type: "add_node",
    node: { id: "r1", space: "work", kind: "request", label: "task", payload: { text: "task" }, seq: 0 },
  };
}

function probeEvent(probe: SessionProbe): Event {
  return {
    type: "add_node",
    node: { id: SESSION_PROBE_ID, space: "work", kind: "fact", label: "session", payload: probe, seq: 1 },
  };
}

function move(state: "orientation" | "research" | "localization" | "patch" | "recovery" | "construction", id = "m1", from = "r1", seq = 2): Event[] {
  return [
    {
      type: "add_node",
      node: { id, space: "work", kind: "move", label: state, payload: { state, what: "" }, seq },
    },
    {
      type: "add_edge",
      edge: { id: `e:${id}`, from, to: id, kind: "move", provenance: { kind: "llm" } },
    },
  ];
}

function stop(moveId: string, seq: number): Event[] {
  const id = `s:${moveId}`;
  return [
    {
      type: "add_node",
      node: { id, space: "work", kind: "stop", label: "done", seq },
    },
    {
      type: "add_edge",
      edge: { id: `e:${id}`, from: moveId, to: id, kind: "stop", provenance: { kind: "llm" } },
    },
  ];
}

function fakeWorkspace(overrides: Partial<Workspace>): Workspace {
  const fail = (): never => {
    throw new Error("not implemented");
  };
  return {
    root: "/repo",
    read: fail,
    version: () => "",
    signature: () => "",
    write: () => {},
    exists: () => false,
    list: () => [],
    grep: () => [],
    listFiles: () => [],
    run: () => ({ code: 0, stdout: "", stderr: "" }),
    startJob: fail,
    pollJob: () => undefined,
    fetchTo: fail,
    applyPatch: () => {},
    ...overrides,
  };
}

describe("environment probe", () => {
  it("parses the tab-separated probe output", () => {
    const parsed = parseProbe(
      [
        "ROOT\t/app",
        "git\tvcs\t/usr/bin/git\tgit version 2.39.2",
        "python3\tinterpreters\t/usr/bin/python3\tPython 3.11.5",
        "xxd\tcore\t-\t",
      ].join("\n"),
    );
    expect(parsed.root).toBe("/app");
    expect(parsed.found.find((tool) => tool.name === "git")?.version).toBe("2.39.2");
    expect(parsed.found.find((tool) => tool.name === "python3")?.version).toBe("3.11.5");
    expect(parsed.missing.map((tool) => tool.name)).toContain("xxd");
  });

  it("does not turn an error message into a version", () => {
    const parsed = parseProbe("cmake\tbuild\t/usr/bin/cmake\tTraceback (most recent call last)\n");
    expect(parsed.found[0]?.name).toBe("cmake");
    expect(parsed.found[0]?.version).toBeUndefined();
  });

  it("gives Orientation no environment block", () => {
    expect(environmentBrief(environment, "orientation")).toBe("");
    expect(environmentBrief(environment)).toBe("");
  });

  it("selects a different subset for the states that need tools", () => {
    const research = environmentBrief(environment, "research");
    expect(research).toContain("Environment");
    expect(research).not.toContain("root:");
    expect(research).not.toContain("version-control tools");
    expect(research).toContain("interpreters:");
    expect(research).toContain("tools:");
    expect(research).toContain("sqlite3");
    expect(research).toContain("missing:");
    expect(research).toContain("7z");

    const recovery = environmentBrief(environment, "recovery");
    expect(recovery).toContain("root: /app");
    expect(recovery).toContain("tools:");
    expect(recovery).not.toContain("version-control tools");

    // Patch edits an existing artifact: it gets the material map, not the toolchain.
    expect(environmentBrief(environment, "patch")).toBe("");

    const construction = environmentBrief(environment, "construction");
    expect(construction).toContain("build tools:");
    expect(construction).toContain("test tools:");
    expect(construction).toContain("package managers:");

    const verification = environmentBrief(environment, "verification");
    expect(verification).toContain("build tools:");
    expect(verification).toContain("test tools:");
    expect(verification).not.toContain("interpreters:");

    const localization = environmentBrief(environment, "localization");
    expect(localization).toContain("Environment");
    expect(localization).toContain("version-control tools: git 2.39.2");
    expect(localization).toContain("interpreters:");
    expect(localization).toContain("tools: jq");
    expect(localization).not.toContain("root:");
    expect(environmentBrief(environment, "end")).toBe("");
  });

  it("shows the agent's network policy with the environment", () => {
    expect(environmentBrief({ ...environment, network: "off" }, "construction")).toContain("network: off");
    expect(environmentBrief({ ...environment, network: "off" }, "construction")).toContain("package installs");
    expect(environmentBrief({ ...environment, network: "on" }, "construction")).toContain("network: on");
  });

  it("marks a timed-out probe as partial", () => {
    const brief = environmentBrief({ ...environment, partial: true }, "research");
    expect(brief).toContain("partial");
    expect(brief).toContain("time budget");
  });

  it("keeps the environment probe separate from the Orientation result", () => {
    const probe: SessionProbe = { environment, material };
    expect(probeBrief(probe, "orientation")).toBe("");
    expect(probeBrief(probe, "research")).toContain("Environment");
    expect(probeBrief(probe, "localization")).toContain("Environment");
  });
});

describe("workspace map", () => {
  it("renders the workspace lines under the requested title", () => {
    const workspace = workspaceBrief(material, "Workspace map");
    expect(workspace).toContain("Workspace map");
    expect(workspace).toContain("root: /app");
    expect(workspace).toContain("repo: git at /app/ocaml");
    expect(workspace).toContain("entries: ocaml/ (20 files), README.md");
    expect(workspace).toContain("paths: README.md, ocaml/Makefile, ocaml/src/a.c");
    expect(workspace).toContain("files: 20");
  });

  it("states the scope when there is no repository", () => {
    const workspace = workspaceBrief({ ...material, repos: [] }, "Workspace map");
    expect(workspace).toContain("repo: none (no .git/.hg/.svn under /app)");
  });

  it("shows the shell cwd only when it differs from the root", () => {
    expect(workspaceBrief({ ...material, cwd: "/app/ocaml" }, "Workspace map")).toContain("cwd: /app/ocaml");
    expect(workspaceBrief({ ...material, cwd: "/app" }, "Workspace map")).not.toContain("cwd:");
  });
});

describe("material probe", () => {
  const files = ["src/a.ts", "src/b.ts", "README.md", "package.json", "Makefile", ".env"];

  it("maps entries and paths without contents or secrets", () => {
    const workspace = fakeWorkspace({ list: () => files });
    const map = probeMaterial(workspace);
    expect(map).toBeDefined();
    expect(map?.root).toBe("/repo");
    expect(map?.entries).toEqual([
      { name: "Makefile", kind: "file" },
      { name: "README.md", kind: "file" },
      { name: "package.json", kind: "file" },
      { name: "src", kind: "dir", files: 2 },
    ]);
    expect(map?.paths).toEqual(["Makefile", "README.md", "package.json", "src/a.ts", "src/b.ts"]);
    expect(map?.files).toBe(5);
    expect(map?.paths.some((path) => path === ".env")).toBe(false);
  });

  it("records a git repository without executing the project", () => {
    const commands: string[] = [];
    const run = (command: string): CommandResult => {
      commands.push(command);
      const stdout = command === "pwd"
        ? ""
        : command.includes("rev-parse --show-toplevel")
          ? "/repo\n"
          : command.includes("rev-parse --abbrev-ref HEAD")
            ? "main\n"
            : command.includes("rev-parse --short HEAD")
              ? "abc1234\n"
              : command.includes("status --porcelain")
                ? " M a\n?? b\n?? .skein/\n"
                : command.includes("log -n")
                  ? "abc1234\tfix sweep\n"
                  : "";
      return { code: 0, stdout, stderr: "" };
    };
    const workspace = fakeWorkspace({
      list: () => ["src/a.c", "Makefile"],
      exists: (path) => path === "/repo/.git",
      run,
    });
    const map = probeMaterial(workspace);
    expect(map?.repos).toEqual([
      {
        kind: "git",
        root: "/repo",
        branch: "main",
        head: "abc1234",
        dirty: 2,
        commits: [{ hash: "abc1234", subject: "fix sweep" }],
      },
    ]);
    // The engine's own `.skein` scaffolding does not count as a changed file, and `status`
    // must not refresh (write) the index.
    expect(commands).toContain("GIT_OPTIONAL_LOCKS=0 git -C '/repo' status --porcelain");
    expect(map?.entries).toEqual([
      { name: "Makefile", kind: "file" },
      { name: "src", kind: "dir", files: 1 },
    ]);
  });

  it("records the shell cwd when the workspace workdir differs from the root", () => {
    const workspace = fakeWorkspace({
      list: () => ["README.md"],
      run: (command) =>
        command === "pwd"
          ? { code: 0, stdout: "/repo/sub\n", stderr: "" }
          : { code: 0, stdout: "", stderr: "" },
    });
    expect(probeMaterial(workspace)?.cwd).toBe("/repo/sub");
  });

  it("is deterministic", () => {
    const workspace = fakeWorkspace({ list: () => [...files] });
    expect(probeMaterial(workspace)).toEqual(probeMaterial(workspace));
  });
});

describe("session probe projection", () => {
  it("renders the workspace map as a system brief inside Orientation, not the environment", () => {
    const probe: SessionProbe = { environment, material };
    const context = project(fold([request(), probeEvent(probe), ...move("orientation")]));
    expect(context.history[0]).toMatchObject({ role: "user", text: "task" });
    const start = context.history.find(
      (message) => message.role === "system" && message.text.includes("Start state Orientation"),
    );
    expect(start?.text).toBe("Start state Orientation");
    const brief = context.history.find(
      (message) => message.role === "system" && message.text.includes("Workspace map"),
    );
    expect(brief?.text).toContain("Workspace map");
    expect(brief?.text).not.toContain("Environment");
  });

  it("carries the Orientation result into Localization and Research", () => {
    const probe: SessionProbe = { environment, material };
    const localization = project(fold([request(), probeEvent(probe), ...move("localization")]));
    const localizationBrief = localization.history.find(
      (message) => message.role === "system" && message.text.includes("Workspace map"),
    );
    expect(localizationBrief?.text).toContain("Workspace map");
    expect(localizationBrief?.text).toContain("Environment");
    expect(localizationBrief?.text).toContain("interpreters:");

    const research = project(fold([request(), probeEvent(probe), ...move("research")]));
    const researchBrief = research.history.find(
      (message) => message.role === "system" && message.text.includes("Workspace map"),
    );
    expect(researchBrief?.text).toContain("Workspace map");
    expect(researchBrief?.text).toContain("Environment");
    expect(researchBrief?.text).toContain("interpreters:");
  });

  it("gives other states the probe only, not the Orientation result", () => {
    const probe: SessionProbe = { environment, material };
    const recovery = project(fold([request(), probeEvent(probe), ...move("recovery")]));
    const brief = recovery.history.find(
      (message) => message.role === "system" && message.text.startsWith("Environment"),
    );
    expect(brief?.text).toContain("Environment");
    expect(brief?.text).not.toContain("Workspace map");
  });

  it("gives Patch the material map, not the toolchain", () => {
    const probe: SessionProbe = { environment, material };
    const patch = project(fold([request(), probeEvent(probe), ...move("patch")]));
    const brief = patch.history.find(
      (message) => message.role === "system" && message.text.includes("Workspace map"),
    );
    expect(brief?.text).toContain("Workspace map");
    expect(brief?.text).toContain("repo: git at /app/ocaml");
    expect(brief?.text).toContain("entries:");
    expect(brief?.text).not.toContain("Environment");
    expect(brief?.text).not.toContain("compilers:");
    expect(brief?.text).not.toContain("interpreters:");
  });

  it("has no workspace or probe on the request turn", () => {
    const probe: SessionProbe = { environment, material };
    const context = project(fold([request(), probeEvent(probe)]));
    expect(context.history).toEqual([{ role: "user", text: "task" }]);
  });

  it("elides the blocks from older closed states", () => {
    const probe: SessionProbe = { environment, material };
    const events = [
      request(),
      probeEvent(probe),
      ...move("orientation", "m1", "r1", 2),
      ...stop("m1", 3),
      ...move("research", "m2", "r1", 4),
    ];
    const context = project(fold(events));
    const results = context.history.filter(
      (message) => message.role === "system" && message.text.includes("Workspace map"),
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.text).not.toContain("what:");
    const start = context.history.find(
      (message) => message.role === "system" && message.text.includes("Start state Research"),
    );
    expect(start?.text).toBe("Start state Research");
  });
});

describe("session probe", () => {
  it("combines the environment and the material", () => {
    const workspace = fakeWorkspace({
      root: "/app",
      list: () => ["README.md", "Makefile"],
      run: () => ({
        code: 0,
        stdout: [
          "ROOT\t/app",
          "git\tvcs\t/usr/bin/git\tgit version 2.39.2",
          "python3\tinterpreters\t/usr/bin/python3\tPython 3.11.5",
        ].join("\n"),
        stderr: "",
      }),
    });
    const probe = probeSession(workspace, { network: "off" });
    expect(probe?.environment?.root).toBe("/app");
    expect(probe?.environment?.network).toBe("off");
    expect(probe?.environment?.found.map((tool) => tool.name)).toEqual(["git", "python3"]);
    expect(probe?.material?.files).toBe(2);
    expect(workspaceBrief(probe?.material as MaterialFact, "Workspace map")).toContain("Workspace map");
  });
});
