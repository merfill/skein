import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadSettings } from "../../src/config/settings";
import type { CommandResult } from "../../src/tools/workspace";
import { containerWorkspace } from "./container";
import { dockerWorkspace, type DockerWorkspace } from "./docker";
import { materializeTask } from "./harness";
import { parseOpenCodeStream, type OpenCodeMetric } from "./opencode-metrics";
import { startAllowlistProxy } from "./proxy";
import type { SandboxTask } from "./task";

// A live run of a ported terminal-bench task with the reference agent, opencode, inside the
// task's own image — the same Docker sandbox the engine uses (`harness.ts`), so the two are
// compared on identical environments. opencode is mounted from the host; the container is
// put on a bridge network (the model API is remote) and, in `off` mode, egress is forced
// through a host allowlist proxy that permits only the API host — so the agent has no
// internet for `curl`/`git`, yet opencode still reaches the model.
//
//   npx tsx tests/sandbox/opencode-run.ts <task-id> [--net on|off]
//
// Cost discipline: docs/testing.md §3.6.

const DEFAULT_MODEL = "routerai/~deepseek/deepseek-v4-flash-latest";
const DEFAULT_OPENCODE_BIN = join(homedir(), ".opencode", "bin", "opencode");
// The only host the `off` proxy lets through: the model API opencode must reach.
const API_HOST = "routerai.ru";

export interface OpenCodeOptions {
  // `on`: direct internet (the agent may fetch an upstream reference). `off`: egress only to
  // the model API (the agent must localize without the network).
  network: "on" | "off";
  model?: string;
  // opencode's reasoning variant (--variant); "low" keeps the comparison with Skein's low.
  reasoningEffort?: string;
  // Wall-clock cap for the agent run (opencode's own loop has no turn cap).
  maxSeconds?: number;
  dir?: string;
  quiet?: boolean;
}

export interface OpenCodeResult {
  task: string;
  network: "on" | "off";
  reward: number;
  check: CommandResult;
  metric: OpenCodeMetric;
  elapsedMs: number;
  dir: string;
  run: CommandResult;
}

export async function runOpenCodeTask(
  task: SandboxTask,
  options: OpenCodeOptions,
): Promise<OpenCodeResult> {
  if (task.image === undefined) {
    throw new Error(`opencode adapter needs a Docker image; task ${task.id} has none`);
  }
  const settings = loadSettings();
  const model = options.model ?? DEFAULT_MODEL;
  const variant = options.reasoningEffort ?? "low";
  const maxSeconds = options.maxSeconds ?? 2400;
  const opencodeBin = process.env.OPENCODE_BIN ?? DEFAULT_OPENCODE_BIN;
  if (!existsSync(opencodeBin)) {
    throw new Error(`opencode binary not found: ${opencodeBin} (set OPENCODE_BIN)`);
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dir =
    options.dir ??
    join("bench", "runs", "sandbox-tasks", `${ts}-${task.id}-opencode-${options.network}`);
  mkdirSync(dir, { recursive: true });

  const { root, request, check } = materializeTask(task);
  writeFileSync(join(root, ".skein", "instruction.txt"), request);

  // opencode config (passed with OPENCODE_CONFIG, so the host's global config is ignored).
  const config = {
    $schema: "https://opencode.ai/config.json",
    model,
    provider: {
      routerai: {
        npm: "@ai-sdk/openai-compatible",
        name: "RouterAI",
        options: { baseURL: settings.apiUrl, apiKey: settings.apiKey },
        models: {
          [model.replace(/^routerai\//, "")]: { name: "DeepSeek V4 Flash", reasoningEffort: variant },
        },
      },
    },
  };
  writeFileSync(join(root, ".skein", "opencode.json"), JSON.stringify(config, null, 2));

  const proxy =
    options.network === "off"
      ? await startAllowlistProxy([API_HOST], "host.docker.internal")
      : undefined;

  const ws: DockerWorkspace = dockerWorkspace(root, {
    image: task.image,
    ...(task.mountPoint !== undefined ? { mountPoint: task.mountPoint } : {}),
    ...(task.workdir !== undefined ? { workdir: task.workdir } : {}),
    // The model is remote, so the container is always on the bridge; `off` mode narrows
    // egress to the API host with the proxy env on the opencode process only (below), so
    // the curl install (setup) can still reach apt.
    network: "bridge",
    mounts: [{ host: opencodeBin, dest: "/usr/local/bin/opencode", readOnly: true }],
    extraHosts: ["host.docker.internal:host-gateway"],
    env: { HOME: "/root" },
  });

  try {
    const provision = ws.exec("apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq curl >/dev/null 2>&1", 300_000);
    if (provision.code !== 0) {
      throw new Error(`curl install failed (exit ${provision.code}): ${provision.stderr.trim()}`);
    }

    const configEnv = "OPENCODE_CONFIG=/app/.skein/opencode.json";
    // Warm up the provider cache while the network is unrestricted: opencode installs any
    // npm provider package on first use, which the `off` proxy would otherwise block.
    ws.exec(`${configEnv} opencode run --format json -m ${model} "reply with: ready"`, 180_000);

    const proxyEnv =
      proxy === undefined
        ? ""
        : `HTTP_PROXY=${proxy.url} HTTPS_PROXY=${proxy.url} ALL_PROXY=${proxy.url} ` +
          "NO_PROXY=localhost,127.0.0.1,host.docker.internal ";
    const command =
      `${proxyEnv}${configEnv} opencode run --auto --format json --variant ${variant} ` +
      `-m ${model} "$(cat /app/.skein/instruction.txt)"`;

    const started = Date.now();
    const run = ws.exec(command, maxSeconds * 1000);
    const elapsedMs = Date.now() - started;

    writeFileSync(join(dir, "opencode.txt"), run.stdout);
    writeFileSync(join(dir, "opencode.err.txt"), run.stderr);
    const metric = parseOpenCodeStream(run.stdout);

    // The same pre-verifier rebuild and verifier as the engine harness.
    if (task.checkSetup !== undefined) ws.run(task.checkSetup);
    const checker = task.checkIn === "host" ? containerWorkspace(root) : ws;
    const checked = checker.run(check);
    const reward = checked.code === 0 ? 1 : 0;

    writeFileSync(join(dir, "reward.txt"), `${reward}\n`);
    writeFileSync(
      join(dir, "metrics.json"),
      JSON.stringify(
        { task: task.id, agent: "opencode", network: options.network, model, variant, reward, check: checked, metric, elapsedMs },
        null,
        2,
      ),
    );
    if (options.quiet !== true) {
      console.info(
        `[${task.id}/opencode-${options.network}] reward=${reward} steps=${metric.steps} ` +
          `tools=${metric.toolCalls} in=${metric.inputTokens} out=${metric.outputTokens} ` +
          `(visible ${metric.visibleOutput} + reason ${metric.reasoningTokens}) cacheR=${metric.cacheRead}`,
      );
    }
    return { task: task.id, network: options.network, reward, check: checked, metric, elapsedMs, dir, run };
  } finally {
    await proxy?.close();
  }
}
