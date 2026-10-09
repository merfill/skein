import { cleanupContainers } from "./docker";
import { runOpenCodeTask } from "./opencode";
import { TASKS } from "./tasks/registry";
import { cleanupSandboxes } from "./workspace";

// Live run of a ported terminal-bench task with opencode (the reference agent):
//   npx tsx tests/sandbox/opencode-run.ts <task-id> [--net on|off] [--seconds N]
// Writes bench/runs/sandbox-tasks/<ts>-<id>-opencode-<net>/ and prints the token breakdown.
// `--net off` still reaches the model API but denies the agent the rest of the internet
// (docs/testing.md §3.6).

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

async function main(): Promise<void> {
  const id = process.argv[2]?.startsWith("--") === false ? (process.argv[2] as string) : "fix-ocaml-gc";
  const task = TASKS[id];
  if (task === undefined) throw new Error(`unknown task ${id}; known: ${Object.keys(TASKS).join(", ")}`);
  const network = arg("--net", "on") === "off" ? "off" : "on";
  const seconds = Number(arg("--seconds", "2400"));

  const result = await runOpenCodeTask(task, {
    network,
    reasoningEffort: arg("--variant", "low"),
    maxSeconds: Number.isFinite(seconds) ? seconds : 2400,
  });
  const m = result.metric;
  console.info(
    `\n=== ${id} (opencode, net=${network}) ===\nreward=${result.reward} steps=${m.steps} ` +
      `tools=${m.toolCalls} in=${m.inputTokens} out=${m.outputTokens} ` +
      `(visible ${m.visibleOutput} + reason ${m.reasoningTokens}) cacheR=${m.cacheRead} ` +
      `elapsed=${(result.elapsedMs / 1000).toFixed(0)}s`,
  );
  console.info(`byTool: ${JSON.stringify(m.byTool)}`);
  console.info(`trace: ${result.dir}`);
  cleanupContainers();
  cleanupSandboxes();
}

process.on("exit", () => cleanupContainers());
void main();
