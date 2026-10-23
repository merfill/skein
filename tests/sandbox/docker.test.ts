import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { cleanupContainers, dockerAvailable, dockerImageAvailable, dockerWorkspace } from "./docker";
import { cleanupSandboxes, newSandboxRoot } from "./workspace";

// Rootless Docker workspace: the container is the only filesystem, so the parity-sensitive
// pieces (fetch bytes, file selection) are checked directly. The small `regex-log` image is
// enough; no model, no network.
const IMAGE = "alexgshaw/regex-log:20251031";
const ready = dockerAvailable() && dockerImageAvailable(IMAGE);

afterEach(() => {
  cleanupContainers();
  cleanupSandboxes();
}, 120_000);

describe.skipIf(!ready)("rootless docker workspace", () => {
  it("fetches a file:// URL into the container byte-for-byte", () => {
    const workspace = dockerWorkspace(newSandboxRoot("skein-docker-"), { image: IMAGE, rootless: true });
    const bytes = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253, 254, 255, 10, 13, 0]);
    const source = join(newSandboxRoot("skein-fetch-"), "payload.bin");
    writeFileSync(source, bytes);
    const expected = createHash("sha256").update(bytes).digest("hex");

    const fetched = workspace.fetchTo(pathToFileURL(source).href, "/app/fetched.bin");
    expect(fetched.bytes).toBe(bytes.length);
    const hash = workspace.exec("sha256sum /app/fetched.bin");
    expect(hash.code).toBe(0);
    expect(hash.stdout.trim().split(/\s+/)[0]).toBe(expected);
  }, 120_000);

  it("skips build/VCS dirs and dot entries in list/grep/listFiles", () => {
    const workspace = dockerWorkspace(newSandboxRoot("skein-docker-"), { image: IMAGE, rootless: true });
    workspace.write("src/a.c", "needle\n");
    workspace.write("src/a.h", "needle\n");
    workspace.write("build/out.c", "needle\n");
    workspace.write(".git/config", "needle\n");
    workspace.write(".hidden.c", "needle\n");

    // `list()` mirrors `fsWorkspace`: VCS/build dirs are pruned, dot files stay.
    expect(workspace.list()).toContain("src/a.c");
    expect(workspace.list()).toContain(".hidden.c");
    expect(workspace.list()).not.toContain("build/out.c");
    expect(workspace.list()).not.toContain(".git/config");

    // `listFiles`/`grep` also skip dot entries, apply include/exclude, and return paths
    // relative to the workspace root, like the host fast path.
    expect(workspace.listFiles({ path: "/app/src" }).sort()).toEqual(["src/a.c", "src/a.h"]);
    expect(workspace.listFiles({ path: "/app", include: "*.c" }).sort()).toEqual(["src/a.c"]);
    const matches = workspace.grep("needle");
    expect(matches.map((match) => match.path).sort()).toEqual(["src/a.c", "src/a.h"]);
    // The returned paths must be readable by the file tools (relative to the workdir).
    for (const match of matches) expect(workspace.read(match.path)).toContain("needle");
  }, 120_000);
});
