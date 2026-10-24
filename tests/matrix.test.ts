import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  aggregate,
  buildCells,
  cellDir,
  isSupported,
  median,
  normalizeMetrics,
  readCell,
  type CellResult,
} from "./sandbox/matrix";
import type { SandboxTask } from "./sandbox/task";

const task = (extra: Partial<SandboxTask> = {}): SandboxTask => ({ id: "regex-log", ...extra });

function result(overrides: Partial<CellResult>): CellResult {
  return {
    agent: "skein",
    network: "on",
    repeat: 1,
    dir: "",
    status: "ok",
    reward: 1,
    turns: 10,
    costRub: 1,
    elapsedMs: 60_000,
    inputTokens: 100_000,
    freshInput: 20_000,
    outputTokens: 10_000,
    reasoningTokens: 5_000,
    cacheRead: 80_000,
    ...overrides,
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "skein-matrix-test-"));
}

describe("matrix cells", () => {
  it("is the cartesian product of agent, network and repeat", () => {
    const cells = buildCells(["skein", "opencode"], ["on", "off"], 3);
    expect(cells).toHaveLength(12);
    expect(cells[0]).toEqual({ agent: "skein", network: "on", repeat: 1 });
    expect(cells.at(-1)).toEqual({ agent: "opencode", network: "off", repeat: 3 });
  });

  it("marks a network-requiring task's offline cells unsupported", () => {
    expect(isSupported(task(), "off")).toBe(true);
    expect(isSupported(task({ network: "bridge" }), "off")).toBe(false);
    expect(isSupported(task({ network: "bridge" }), "on")).toBe(true);
  });

  it("uses a deterministic cell directory", () => {
    expect(cellDir("out", { agent: "opencode", network: "off", repeat: 2 })).toBe(
      join("out", "cells", "opencode-netoff-r2"),
    );
  });
});

describe("matrix metrics", () => {
  it("reads the Skein totals shape", () => {
    const raw = {
      reward: 1,
      totals: { turns: 13, costRub: 1.84, inputTokens: 111_396, freshInput: 30_756, cacheRead: 80_640, outputTokens: 33_890, reasoningTokens: 31_292 },
    };
    expect(normalizeMetrics("skein", raw)).toEqual({
      reward: 1,
      turns: 13,
      costRub: 1.84,
      inputTokens: 111_396,
      freshInput: 30_756,
      outputTokens: 33_890,
      reasoningTokens: 31_292,
      cacheRead: 80_640,
    });
  });

  it("reads the opencode metric shape (no cost, fresh input derived)", () => {
    const raw = { reward: 0, metric: { steps: 17, inputTokens: 278_065, cacheRead: 257_920, outputTokens: 17_071, reasoningTokens: 12_552 } };
    expect(normalizeMetrics("opencode", raw)).toEqual({
      reward: 0,
      turns: 17,
      costRub: null,
      inputTokens: 278_065,
      freshInput: 20_145,
      outputTokens: 17_071,
      reasoningTokens: 12_552,
      cacheRead: 257_920,
    });
  });

  it("survives malformed input", () => {
    const empty = { reward: null, turns: null, costRub: null, inputTokens: null, freshInput: null, outputTokens: null, reasoningTokens: null, cacheRead: null };
    expect(normalizeMetrics("skein", null)).toEqual(empty);
    expect(normalizeMetrics("skein", { reward: "1" })).toEqual(empty);
    expect(normalizeMetrics("opencode", { reward: 1 })).toEqual({ ...empty, reward: 1 });
  });

  it("computes medians for odd and even samples", () => {
    expect(median([])).toBeNull();
    expect(median([13])).toBe(13);
    expect(median([13, 15, 11])).toBe(13);
    expect(median([10, 20])).toBe(15);
  });

  it("aggregates by agent and network", () => {
    const rows = aggregate([
      result({ agent: "skein", network: "off", repeat: 1, turns: 13, costRub: 1.8, elapsedMs: 120_000 }),
      result({ agent: "skein", network: "off", repeat: 2, turns: 15, costRub: 2.0, elapsedMs: 180_000 }),
      result({ agent: "skein", network: "off", repeat: 3, status: "timeout", reward: null, turns: null, costRub: null, elapsedMs: 30_000 }),
      result({ agent: "opencode", network: "on", status: "reward0", reward: 0, turns: 17, costRub: null }),
    ]);
    const skein = rows.find((row) => row.agent === "skein" && row.network === "off");
    expect(skein).toMatchObject({
      runs: 2,
      solved: 2,
      medianTurns: 14,
      medianCostRub: 1.9,
      medianElapsedMs: 150_000,
      medianInputTokens: 100_000,
      medianFreshInput: 20_000,
      medianOutputTokens: 10_000,
      medianReasoningTokens: 5_000,
      statuses: { ok: 2, timeout: 1 },
    });
    const opencode = rows.find((row) => row.agent === "opencode");
    expect(opencode).toMatchObject({ runs: 1, solved: 0, medianTurns: 17, medianCostRub: null });
  });
});

describe("matrix resume", () => {
  it("returns null when nothing was written", () => {
    const dir = tempDir();
    try {
      expect(readCell(dir, "skein")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a finished cell", () => {
    const dir = tempDir();
    try {
      writeFileSync(
        join(dir, "metrics.json"),
        JSON.stringify({ reward: 1, totals: { turns: 13, costRub: 1.5, inputTokens: 1000, freshInput: 400, cacheRead: 600, outputTokens: 300, reasoningTokens: 200 } }),
      );
      expect(readCell(dir, "skein")).toEqual({
        status: "ok",
        reward: 1,
        turns: 13,
        costRub: 1.5,
        inputTokens: 1000,
        freshInput: 400,
        outputTokens: 300,
        reasoningTokens: 200,
        cacheRead: 600,
      });
      writeFileSync(join(dir, "metrics.json"), JSON.stringify({ reward: 0, metric: { steps: 9, inputTokens: 1000, cacheRead: 600, outputTokens: 300, reasoningTokens: 200 } }));
      expect(readCell(dir, "opencode")).toEqual({
        status: "reward0",
        reward: 0,
        turns: 9,
        costRub: null,
        inputTokens: 1000,
        freshInput: 400,
        outputTokens: 300,
        reasoningTokens: 200,
        cacheRead: 600,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a timeout marker and a corrupt metrics file as unfinished", () => {
    const dir = tempDir();
    const empty = { reward: null, turns: null, costRub: null, inputTokens: null, freshInput: null, outputTokens: null, reasoningTokens: null, cacheRead: null };
    try {
      writeFileSync(join(dir, ".timeout"), "now");
      expect(readCell(dir, "skein")).toEqual({ status: "timeout", ...empty });

      mkdirSync(join(dir, "nested"));
      writeFileSync(join(dir, "metrics.json"), "{not json");
      expect(readCell(dir, "skein")).toEqual({ status: "timeout", ...empty });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
