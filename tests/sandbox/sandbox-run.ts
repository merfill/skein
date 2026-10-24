import { loadSettings } from "../../src/config/settings";
import { cleanupContainers } from "./docker";
import { runLiveTask } from "./live";
import { startAllowlistProxy, type AllowlistProxy } from "./proxy";
import { TASKS } from "./tasks/registry";
import { parseNetworkMode } from "./network";
import { cleanupSandboxes } from "./workspace";

// Live run of a ported terminal-bench task (no Harbor):
//   npx tsx tests/sandbox/sandbox-run.ts <task-id> [--turns N] [--net on|off]
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
  const net = parseNetworkMode(arg("--net", "on"));
  // `off` removes the network from the agent container and, for the engine's host-side
  // tools (`fetch`, background `run`), routes their `curl` through an allowlist proxy that
  // permits only the model API. The verifier keeps its own network: every task's `test.sh`
  // bootstraps its runtime there (see `network.ts`). The model call is permitted either way —
  // undici ignores the env proxy or, if not, the host is allowlisted.
  let proxy: AllowlistProxy | undefined;
  if (net === "off") {
    const apiHost = new URL(loadSettings().apiUrl).hostname;
    proxy = await startAllowlistProxy([apiHost], "127.0.0.1");
    process.env.HTTP_PROXY = proxy.url;
    process.env.HTTPS_PROXY = proxy.url;
    process.env.ALL_PROXY = proxy.url;
  }
  try {
    // An explicit `--turns` wins; otherwise the task's own budget (a build-heavy task may
    // need more than the 24-turn default), else 24.
    const result = await runLiveTask(task, {
      maxTurns: turns === "" ? (task.maxTurns ?? 24) : Number(turns),
      network: net,
    });
    const t = result.summary?.totals;
    if (t === undefined) throw new Error(`no metrics for ${task.id}`);
    console.info(
      `\n=== ${task.id} (net=${net}) ===\nreward=${result.reward} stop=${result.stopReason} turns=${t.turns} ` +
        `llm=${t.llmCalls} toolcalls=${t.toolCalls} (ok ${t.accepted}/refused ${t.refused}) ` +
        `in=${t.inputTokens} (fresh ${t.freshInput} + cacheR ${t.cacheRead}, hit ${((t.cacheHitRatio ?? 0) * 100).toFixed(0)}%) ` +
        `out=${t.outputTokens} (visible ${t.visibleOutput} + reason ${t.reasoningTokens}) ` +
        `cost=${t.costRub?.toFixed(3) ?? "n/a"}₽ chars ${t.contextChars.first}→${t.contextChars.last} (peak ${t.contextChars.peak})`,
    );
    if (result.error !== undefined) console.info(`error: ${result.error}`);
    console.info(`trace: ${result.dir}`);
  } finally {
    await proxy?.close();
    cleanupContainers();
    cleanupSandboxes();
  }
}

process.on("exit", () => cleanupContainers());
void main();
