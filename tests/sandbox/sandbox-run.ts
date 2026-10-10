import { cleanupContainers } from "./docker";
import { runLiveTask } from "./live";
import { TASKS } from "./tasks/registry";
import { cleanupSandboxes } from "./workspace";

// Live run of a ported terminal-bench task (no Harbor):
//   npx tsx tests/sandbox/sandbox-run.ts <task-id> [--turns N]
// Writes bench/runs/sandbox-tasks/<ts>-<id>/ and prints the token breakdown.
// For all tasks in parallel, use sandbox-smoke.ts. Cost discipline: docs/testing.md §3.6.

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

async function main(): Promise<void> {
  const id = process.argv[2]?.startsWith("--") === false ? (process.argv[2] as string) : "regex-log";
  const task = TASKS[id];
  if (task === undefined) throw new Error(`unknown task ${id}; known: ${Object.keys(TASKS).join(", ")}`);

  const turns = arg("--turns", "");
  // An explicit `--turns` wins; otherwise the task's own budget (a build-heavy task may
  // need more than the 24-turn default), else 24.
  const result = await runLiveTask(task, {
    maxTurns: turns === "" ? (task.maxTurns ?? 24) : Number(turns),
  });
  const t = result.summary?.totals;
  if (t === undefined) throw new Error(`no metrics for ${task.id}`);
  console.info(
    `\n=== ${task.id} ===\nreward=${result.reward} stop=${result.stopReason} turns=${t.turns} ` +
      `llm=${t.llmCalls} toolcalls=${t.toolCalls} (ok ${t.accepted}/refused ${t.refused}) ` +
      `in=${t.inputTokens} (fresh ${t.freshInput} + cacheR ${t.cacheRead}, hit ${((t.cacheHitRatio ?? 0) * 100).toFixed(0)}%) ` +
      `out=${t.outputTokens} (visible ${t.visibleOutput} + reason ${t.reasoningTokens}) ` +
      `cost=${t.costRub?.toFixed(3) ?? "n/a"}₽ chars ${t.contextChars.first}→${t.contextChars.last} (peak ${t.contextChars.peak})`,
  );
  if (result.error !== undefined) console.info(`error: ${result.error}`);
  console.info(`trace: ${result.dir}`);
  cleanupContainers();
  cleanupSandboxes();
}

process.on("exit", () => cleanupContainers());
void main();
