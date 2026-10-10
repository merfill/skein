import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadSettings } from "../../src/config/settings";
import { achievedWithoutCheck, structuralCycle, unboundGoals } from "../invariants";
import { branchesOf, mutationsOf, refutedChecks, repeatsOf, runScenario, type ScenarioRun } from "./harness";
import { scenarios, type Scenario } from "./scenarios";
import { workingSetStats } from "../workset";

const settings = loadSettings();
const filter = (process.env.SKEIN_SCENARIOS ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name.length > 0);
const selected = filter.length > 0 ? scenarios.filter((s) => filter.includes(s.name)) : scenarios;

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
  // The context is the message tape: report its peak length (the old bounded working set
  // is gone; docs/ir_revision.md §5).
  const peakHistory = run.turns.reduce((max, turn) => Math.max(max, turn.context.history.length), 0);
  const parts = [
    `turns=${run.result.turns}`,
    `stop=${run.result.stopReason}`,
    `check=${run.check.code}`,
    `ctx=${first}->${peak}`,
    `tape=${peakHistory}`,
    `repeats=${repeatsOf(run.result.events).length}`,
    `refuted=${refutedChecks(run.result.events).length}`,
    `mutations=${mutationsOf(run.result.events).length}`,
    `branches=[${used.join(",")}]`,
  ];
  if (missing.length > 0) parts.push(`MISSING(soft)=[${missing.join(",")}]`);
  const tag = repeat > 0 ? `#${repeat + 1} ` : "";
  console.log(`[scenario ${tag}${run.name}] ${parts.join(" ")}`);
}

const repeats = Math.max(1, Number(process.env.SKEIN_SCENARIO_REPEATS ?? "1") || 1);

function runCommandsOf(run: ScenarioRun): string[] {
  return run.turns.flatMap((turn) =>
    turn.action.operator === "apply" && turn.action.action.tool === "run"
      ? [turn.action.action.command ?? ""]
      : [],
  );
}

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
  if (scenario.expect.commands !== undefined) {
    const commands = runCommandsOf(run);
    for (const rule of scenario.expect.commands) {
      const re = new RegExp(rule.match);
      const count = commands.filter((command) => re.test(command)).length;
      const min = rule.min ?? 0;
      const max = rule.max ?? Number.POSITIVE_INFINITY;
      const detail = `/${rule.match}/ count=${count} in [${min},${max === Number.POSITIVE_INFINITY ? "*" : max}] (${where})`;
      expect(count, `${scenario.name} run commands: ${detail}`).toBeGreaterThanOrEqual(min);
      expect(count, `${scenario.name} run commands: ${detail}`).toBeLessThanOrEqual(max);
    }
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
  // Scenarios are independent (each has its own temp workspace and run trace), so they
  // run concurrently; vitest's `maxConcurrency` (5) caps how many hit the provider at
  // once. Each test removes its own temp workspace, so no shared cleanup races.
  for (const scenario of selected) {
    it.concurrent(
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
          } finally {
            rmSync(run.root, { recursive: true, force: true });
          }
        }
        expect(failures, failures.join("\n")).toEqual([]);
      },
      300_000 * repeats,
    );
  }
});
