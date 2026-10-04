import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadSettings } from "../../src/config/settings";
import { achievedWithoutCheck, structuralCycle, unboundGoals } from "../invariants";
import { branchesOf, cleanupRuns, mutationsOf, refutedChecks, repeatsOf, runScenario, type ScenarioRun } from "./harness";
import { scenarios, type Scenario } from "./scenarios";
import { workingSetStats } from "../workset";

const settings = loadSettings();
const filter = (process.env.SKEIN_SCENARIOS ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name.length > 0);
const selected = filter.length > 0 ? scenarios.filter((s) => filter.includes(s.name)) : scenarios;

afterEach(cleanupRuns);

function prefixOf(run: ScenarioRun, noMutation: boolean): string[] {
  return noMutation ? [""] : ["test/"];
}

function assertUnchanged(run: ScenarioRun, prefixes: string[]): void {
  for (const [path, content] of run.before) {
    if (!prefixes.some((prefix) => path.startsWith(prefix))) continue;
    const now = existsSync(join(run.root, path)) ? readFileSync(join(run.root, path), "utf8") : "";
    expect(now, `${path} must be unchanged`).toBe(content);
  }
}

function report(run: ScenarioRun, missing: string[], repeat = 0): void {
  const chars = run.turns.map((turn) => turn.contextChars);
  const first = chars[0] ?? 0;
  const peak = chars.reduce((max, value) => Math.max(max, value), 0);
  const used = [...branchesOf(run.turns)];
  const needs = run.turns
    .filter((turn) => turn.need.length > 0)
    .map((turn) => `#${turn.turn}:${turn.need.length}`);
  const ws = workingSetStats(
    run.turns.map((turn) => ({
      shown: turn.context.shown,
      requested: [
        ...turn.need,
        ...(turn.action.operator === "query" && turn.action.id !== undefined ? [turn.action.id] : []),
      ],
    })),
  );
  const parts = [
    `turns=${run.result.turns}`,
    `stop=${run.result.stopReason}`,
    `check=${run.check.code}`,
    `ctx=${first}->${peak}`,
    `ws=${ws.peakCount}/${ws.peakChars}`,
    `reacq=${ws.reacquired}`,
    `repeats=${repeatsOf(run.result.events).length}`,
    `refuted=${refutedChecks(run.result.events).length}`,
    `mutations=${mutationsOf(run.result.events).length}`,
    `branches=[${used.join(",")}]`,
  ];
  if (needs.length > 0) parts.push(`need=${needs.join(" ")}`);
  if (missing.length > 0) parts.push(`MISSING(soft)=[${missing.join(",")}]`);
  const tag = repeat > 0 ? `#${repeat + 1} ` : "";
  console.log(`[scenario ${tag}${run.name}] ${parts.join(" ")}`);
}

const repeats = Math.max(1, Number(process.env.SKEIN_SCENARIO_REPEATS ?? "1") || 1);

function assertRun(scenario: Scenario, run: ScenarioRun, repeat: number): void {
  const where = repeats > 1 ? ` (repeat ${repeat + 1}/${repeats})` : "";
  const used = branchesOf(run.turns);
  const missing = (scenario.expect.uses ?? []).filter((branch) => !used.has(branch));
  report(run, missing, repeat);

  if (scenario.expect.solved !== false) {
    expect(run.check.code, `${scenario.name}${where} check failed: ${run.check.stdout}${run.check.stderr}`).toBe(0);
  }
  if (scenario.expect.addressed === true) {
    expect(
      run.result.stopReason,
      `${scenario.name}${where} did not close the request (turns=${run.result.turns})`,
    ).toBe("request_addressed");
  }
  if (scenario.expect.stopReason !== undefined) {
    expect(run.result.stopReason, `${scenario.name}${where}`).toBe(scenario.expect.stopReason);
  }
  if (scenario.expect.maxRepeats !== undefined) {
    expect(repeatsOf(run.result.events).length, `${scenario.name}${where}`).toBeLessThanOrEqual(
      scenario.expect.maxRepeats,
    );
  }
  if (scenario.expect.noMutation === true) {
    expect(mutationsOf(run.result.events), `${scenario.name}${where}`).toEqual([]);
  }
  assertUnchanged(run, scenario.expect.unchanged ?? prefixOf(run, scenario.expect.noMutation === true));
  expect(achievedWithoutCheck(run.result.events), `${scenario.name}${where}`).toEqual([]);
  expect(unboundGoals(run.result.events), `${scenario.name}${where}`).toEqual([]);
  expect(structuralCycle(run.result.events), `${scenario.name}${where}`).toBe(false);
}

describe.skipIf(!settings.live)("live scenarios", () => {
  for (const scenario of selected) {
    it(
      scenario.name,
      async () => {
        // Stability: run the scenario `repeats` times (SKEIN_SCENARIO_REPEATS, default 1)
        // and collect every failure, so a flaky prompt shows a pass-rate, not a single draw.
        const failures: string[] = [];
        for (let repeat = 0; repeat < repeats; repeat++) {
          const run = await runScenario(scenario.name, {
            ...(scenario.constraints !== undefined ? { constraints: scenario.constraints } : {}),
            ...(scenario.maxTurns !== undefined ? { maxTurns: scenario.maxTurns } : {}),
            ...(scenario.check !== undefined ? { check: scenario.check } : {}),
          });
          try {
            assertRun(scenario, run, repeat);
          } catch (error) {
            failures.push(`repeat ${repeat + 1}/${repeats}: ${(error as Error).message.split("\n")[0]}`);
          }
        }
        expect(failures, failures.join("\n")).toEqual([]);
      },
      300_000 * repeats,
    );
  }
});
