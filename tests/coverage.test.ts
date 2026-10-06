import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// The coverage contract: every spec ID in docs/ir_operations.md must be cited by at
// least one test title as `[ID]`, so the document and the tests cannot drift apart.
const DOC = join(import.meta.dirname, "..", "docs", "ir_operations.md");
const TESTS = join(import.meta.dirname, "..", "tests");

const ID = "(?:OP-CG-\\d+|OP-AP-[A-Z]+-\\d+|OP-CP-\\d+|OP-QR-\\d+|TR-\\d+|DER-[A-Z]+-\\d+|REF-[A-Z][A-Z-]*)";

function registryIds(): string[] {
  const doc = readFileSync(DOC, "utf8");
  // Only the specification body (§1–§4); the matrix (§5) uses range shorthand.
  const body = doc.split("## 5. Coverage matrix")[0]!;
  const matches = body.match(new RegExp("`(" + ID + ")`", "g")) ?? [];
  return [...new Set(matches.map((m) => m.slice(1, -1)))];
}

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...testFiles(full));
    } else if (entry.name.endsWith(".test.ts") && entry.name !== "coverage.test.ts") {
      out.push(full);
    }
  }
  return out;
}

function citedIds(): Set<string> {
  const cited = new Set<string>();
  const re = new RegExp("\\b" + ID + "\\b", "g");
  for (const file of testFiles(TESTS)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.match(re) ?? []) cited.add(match);
  }
  return cited;
}

describe("IR operations coverage", () => {
  it("[PRJ-gate] every spec ID is cited by at least one test", () => {
    const registry = registryIds();
    expect(registry.length).toBeGreaterThan(50);
    const cited = citedIds();
    const missing = registry.filter((id) => !cited.has(id));
    expect(missing, `spec IDs with no test: ${missing.join(", ")}`).toEqual([]);
  });

  it("has no stale citations: every cited ID exists in the registry", () => {
    const registry = new Set(registryIds());
    const stale = [...citedIds()].filter((id) => !registry.has(id));
    expect(stale, `cited IDs not in the registry: ${stale.join(", ")}`).toEqual([]);
  });
});
