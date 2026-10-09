// Reasoning-token breakdown for a sandbox live run, from its `metrics.json` perTurn:
// where the hidden reasoning goes, by phase, with the biggest spikes and the post-edit
// segment. No model calls — pure offline analysis.
//
//   npx tsx bench/reasoning-breakdown.ts <run-dir> [<run-dir> ...]
//
// A run dir is `bench/runs/sandbox-tasks/<timestamp>-<task>` (Skein) or an opencode run.
import { readFileSync } from "node:fs";
import { basename } from "node:path";

import type { TurnMetric } from "../tests/sandbox/metrics";

interface RunMetrics {
  task?: string;
  reward?: number;
  stopReason?: string;
  turns?: number;
  totals?: { reasoningTokens?: number; visibleOutput?: number; outputTokens?: number; refused?: number };
  perTurn?: TurnMetric[];
}

function readRun(dir: string): RunMetrics {
  return JSON.parse(readFileSync(`${dir}/metrics.json`, "utf8")) as RunMetrics;
}

// Map a turn to its phase from the operator/tool it called (the perTurn record carries no
// action body, so a criterion `run {target}` and an exploratory `run` both read as "run").
function phaseOf(turn: TurnMetric): string {
  if (turn.operator === "stop") return "close";
  if (turn.operator === "query") return "query";
  if (turn.operator === "create_goal") return turn.refused ? "plan(refused)" : "plan";
  if (turn.operator === "apply") {
    if (turn.tool === "edit" || turn.tool === "write" || turn.tool === "apply_patch") return "edit";
    if (turn.tool === "run") return "run";
    if (turn.tool === "read" || turn.tool === "grep" || turn.tool === "list" || turn.tool === "fetch")
      return "explore";
    return turn.tool;
  }
  return turn.operator;
}

const PHASE_ORDER = ["plan", "plan(refused)", "explore", "edit", "run", "query", "close"];

interface PhaseBucket {
  turns: number;
  reasoning: number;
  refused: number;
}

function buckets(perTurn: readonly TurnMetric[]): Map<string, PhaseBucket> {
  const out = new Map<string, PhaseBucket>();
  for (const turn of perTurn) {
    const key = phaseOf(turn);
    const bucket = out.get(key) ?? { turns: 0, reasoning: 0, refused: 0 };
    bucket.turns += 1;
    bucket.reasoning += turn.reasoningTokens;
    if (turn.refused) bucket.refused += 1;
    out.set(key, bucket);
  }
  return out;
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return "0.0%";
  return `${((100 * part) / whole).toFixed(1)}%`;
}

function column(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function report(dir: string): { name: string; total: number; byPhase: Map<string, PhaseBucket> } {
  const run = readRun(dir);
  const perTurn = run.perTurn ?? [];
  const total = run.totals?.reasoningTokens ?? perTurn.reduce((sum, turn) => sum + turn.reasoningTokens, 0);
  const output = run.totals?.outputTokens ?? 0;
  const refused = run.totals?.refused ?? 0;
  console.info(
    `\n${basename(dir)}  task=${run.task ?? "?"} reward=${run.reward ?? "?"} turns=${run.turns ?? perTurn.length} ` +
      `reasoning=${total} (${pct(total, output)} of output) refused=${refused}`,
  );

  const byPhase = buckets(perTurn);
  console.info(`  ${column("phase", 14)}${column("turns", 7)}${column("reasoning", 11)}share`);
  for (const key of PHASE_ORDER) {
    const bucket = byPhase.get(key);
    if (bucket === undefined) continue;
    console.info(
      `  ${column(key, 14)}${column(String(bucket.turns), 7)}${column(String(bucket.reasoning), 11)}${pct(bucket.reasoning, total)}`,
    );
  }
  for (const [key, bucket] of byPhase) {
    if (PHASE_ORDER.includes(key)) continue;
    console.info(
      `  ${column(key, 14)}${column(String(bucket.turns), 7)}${column(String(bucket.reasoning), 11)}${pct(bucket.reasoning, total)}`,
    );
  }

  const spikes = [...perTurn].sort((a, b) => b.reasoningTokens - a.reasoningTokens).slice(0, 12);
  const topSum = spikes.reduce((sum, turn) => sum + turn.reasoningTokens, 0);
  console.info(`  top-12 turns = ${topSum} (${pct(topSum, total)}):`);
  for (const turn of spikes) {
    console.info(
      `    t${column(String(turn.turn), 4)} ${column(phaseOf(turn), 14)}${column(String(turn.reasoningTokens), 8)}` +
        `${turn.refused ? " REFUSED" : ""}`,
    );
  }

  const firstEdit = perTurn.findIndex((turn) => phaseOf(turn) === "edit");
  if (firstEdit >= 0) {
    const after = perTurn.slice(firstEdit + 1);
    const afterReasoning = after.reduce((sum, turn) => sum + turn.reasoningTokens, 0);
    const afterGoals = after.filter((turn) => turn.operator === "create_goal").length;
    const afterRuns = after.filter((turn) => turn.operator === "apply" && turn.tool === "run").length;
    console.info(
      `  after first edit (t${perTurn[firstEdit]?.turn}): ${after.length} turns, ` +
        `${afterReasoning} reasoning (${pct(afterReasoning, total)}), ${afterGoals} create_goal, ${afterRuns} run`,
    );
  }
  return { name: basename(dir), total, byPhase };
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("usage: npx tsx bench/reasoning-breakdown.ts <run-dir> [<run-dir> ...]");
  process.exit(1);
}

const reports = dirs.map(report);
if (reports.length > 1) {
  console.info(`\ncomparison (reasoning by phase):`);
  const keys = new Set<string>();
  for (const r of reports) for (const key of r.byPhase.keys()) keys.add(key);
  const header = `  ${column("phase", 14)}${reports.map((r) => column(r.name.slice(0, 18), 20)).join("")}`;
  console.info(header);
  for (const key of PHASE_ORDER) {
    if (![...keys].some((k) => k === key)) continue;
    const cells = reports
      .map((r) => column(String(r.byPhase.get(key)?.reasoning ?? 0), 20))
      .join("");
    console.info(`  ${column(key, 14)}${cells}`);
  }
  console.info(`  ${column("TOTAL", 14)}${reports.map((r) => column(String(r.total), 20)).join("")}`);
}
