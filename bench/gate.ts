import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { compareRun, runFromMetrics, type Baseline, type RawMetrics } from "./compare";

function loadBaseline(): Baseline {
  return JSON.parse(readFileSync(join(import.meta.dirname, "baseline.json"), "utf8")) as Baseline;
}

function resolveMetricsPath(input: string): string {
  const target = resolve(input);
  const inside = join(target, "metrics.json");
  return existsSync(inside) ? inside : target;
}

function main(): void {
  const arg = process.argv[2];
  if (arg === undefined) {
    console.error("usage: npm run bench:gate -- <runDir|metrics.json>");
    process.exit(2);
  }
  const metricsPath = resolveMetricsPath(arg);
  if (!existsSync(metricsPath)) {
    console.error(`no metrics file at ${metricsPath}`);
    process.exit(2);
  }

  const baseline = loadBaseline();
  const run = runFromMetrics(JSON.parse(readFileSync(metricsPath, "utf8")) as RawMetrics);
  const result = compareRun(baseline, run);

  console.log(`case=${result.case} ${result.ok ? "PASS" : "FAIL"}`);
  for (const [name, delta] of Object.entries(result.deltas)) {
    console.log(`  ${name}: ${delta.run} vs ${delta.baseline} (x${delta.ratio.toFixed(2)})`);
  }
  for (const violation of result.violations) console.log(`  ! ${violation}`);
  process.exit(result.ok ? 0 : 1);
}

main();
