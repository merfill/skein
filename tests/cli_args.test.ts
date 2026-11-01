import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveCliDir } from "../src/cli";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "skein-cli-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("resolveCliDir", () => {
  it("expands a leading ~ to the home directory", () => {
    expect(resolveCliDir("~")).toBe(homedir());
    expect(resolveCliDir("~/")).toBe(homedir());
    expect(resolveCliDir("~/dev")).toBe(join(homedir(), "dev"));
  });

  it("resolves a relative path against the current directory", () => {
    expect(resolveCliDir(".")).toBe(process.cwd());
  });

  it("keeps an existing absolute directory", () => {
    const root = makeRoot();
    expect(resolveCliDir(root)).toBe(root);
  });

  it("rejects a missing directory", () => {
    const missing = join(makeRoot(), "missing");
    expect(() => resolveCliDir(missing)).toThrow(`workspace not found: ${missing}`);
  });

  it("rejects a file", () => {
    const file = join(makeRoot(), "file.txt");
    writeFileSync(file, "x\n");
    expect(() => resolveCliDir(file)).toThrow(`workspace is not a directory: ${file}`);
  });
});
