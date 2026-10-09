import { cleanupContainers } from "./docker";
import { runLiveTask, type LiveTaskResult } from "./live";
import { TASKS } from "./tasks/registry";
import { cleanupSandboxes } from "./workspace";

// Smoke the ported tasks with the live model, in parallel:
//   npx tsx tests/sandbox/sandbox-smoke.ts [task-ids…] [--concurrency N] [--turns N]
// Default: all registered tasks, 5 at a time. Writes a trace dir per task and prints a
// summary table (reward, calls, tokens, cost). Money: docs/testing.md §3.6.

// Parse `--flag value` pairs; everything else is a positional task id.
function parseArgs(argv: string[]): { flags: Map<string, string>; positional: string[] } {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (token.startsWith("--")) {
      flags.set(token, argv[i + 1] ?? "");
      i += 1;
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
}

function arg(flags: Map<string, string>, name: string, fallback: string): string {
  return flags.get(name) ?? fallback;
}

async function pool<T>(items: string[], limit: number, fn: (id: string) => Promise<T>): Promise<T[]> {
  const results: T[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as string);
    }
  });
  await Promise.all(workers);
  return results;
}

function errorResult(id: string, message: string, elapsedMs: number): LiveTaskResult {
  return { task: id, reward: -1, stopReason: "error", turns: 0, elapsedMs, dir: "", error: message };
}

async function main(): Promise<void> {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const ids = positional.length > 0 ? positional : Object.keys(TASKS);
  const concurrency = Number(arg(flags, "--concurrency", "5"));
  const turnsFlag = arg(flags, "--turns", "");
  const maxTurns = turnsFlag === "" ? undefined : Number(turnsFlag);
  console.info(`smoke: ${ids.length} tasks, concurrency ${concurrency}, maxTurns ${maxTurns ?? "per-task"}`);
  const started = Date.now();

  const results = await pool(ids, concurrency, async (id) => {
    const task = TASKS[id];
    if (task === undefined) {
      console.error(`[${id}] unknown task`);
      return errorResult(id, "unknown task", 0);
    }
    try {
      const result = await runLiveTask(task, { maxTurns: maxTurns ?? task.maxTurns ?? 24, quiet: true });
      console.info(`[${id}] done reward=${result.reward} stop=${result.stopReason} turns=${result.turns} ${(result.elapsedMs / 1000).toFixed(0)}s`);
      return result;
    } catch (error) {
      console.error(`[${id}] ERROR ${String(error)}`);
      return errorResult(id, String(error), 0);
    }
  });

  const k = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
  console.info("\n===== SMOKE RESULTS =====");
  let solved = 0;
  let totalCost = 0;
  for (const result of results) {
    const t = result.summary?.totals;
    if (result.reward === 1) solved += 1;
    totalCost += t?.costRub ?? 0;
    console.info(
      `${result.task.padEnd(26)} reward=${result.reward} stop=${(result.stopReason ?? "-").padEnd(17)} ` +
        `turns=${String(result.turns).padStart(2)} llm=${t?.llmCalls ?? "-"} tools=${t?.toolCalls ?? "-"} ` +
        `in=${t ? k(t.inputTokens) : "-"} out=${t ? k(t.outputTokens) : "-"} reason=${t ? k(t.reasoningTokens) : "-"} ` +
        `cost=${t?.costRub != null ? `${t.costRub.toFixed(2)}₽` : "-"} ${(result.elapsedMs / 1000).toFixed(0)}s`,
    );
  }
  console.info(
    `solved ${solved}/${results.length}  cost ~${totalCost.toFixed(2)}₽  wall ${((Date.now() - started) / 60000).toFixed(1)}min`,
  );
  cleanupContainers();
  cleanupSandboxes();
}

process.on("exit", () => cleanupContainers());
void main();
