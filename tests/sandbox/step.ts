import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { TurnMeter } from "../../bench/metrics";
import { loadSettings } from "../../src/config/settings";
import { ISLANDS, type IslandId } from "../../src/ir/islands";
import type { Context } from "../../src/ir/project";
import { createChatModel } from "../../src/llm/client";
import type { Action, Proposals } from "../../src/llm/schemas";
import { runAgent } from "../../src/loop/graph";
import { BASE_PROMPT, buildMessages, propose as proposeModel, promptText, type Proposer } from "../../src/loop/propose";
import { containerWorkspace } from "./container";
import { cleanupContainers, dockerWorkspace } from "./docker";
import { materializeTask } from "./harness";
import { TASKS } from "./tasks/registry";
import { cleanupSandboxes } from "./workspace";

// Step-through a ported task against its REAL environment, one turn at a time:
//   - the prompt is built and the model is called on the HOST;
//   - every command runs in the task's CONTAINER (a long-lived `docker exec` workspace);
//   - the run stops as soon as it leaves the target island (default `orientation`), so a
//     single state can be inspected without paying for the rest of the task — no verifier,
//     no `checkSetup` build.
//
// Usage:
//   npx tsx tests/sandbox/step.ts <task-id> [--stop-after orientation] [--turns N] [--auto]
//                                 [--dir <trace-dir>] [--no-dump]
//
// `--auto` skips the per-turn "press Enter". Each turn's full model-facing context is written
// to <dir>/contexts/tNNN.txt. Cost discipline: one live model call per turn (docs/testing.md).

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const label = (action: Action): string =>
  action.operator === "apply" ? `apply:${action.action.tool}` : action.operator;

const argsOf = (actions: Action[]): string =>
  actions
    .map((action) => (action.operator === "apply" ? JSON.stringify(action.action) : JSON.stringify(action)))
    .join("\n");

// End-of-scope sentinel: the proposer throws when the run has moved past the target island;
// the engine catches it as `llm_error` and stops, keeping every event so far.
const STOP = "step: out of scope";

async function main(): Promise<void> {
  const id = process.argv[2]?.startsWith("--") === false ? (process.argv[2] as string) : "fix-ocaml-gc";
  const task = TASKS[id];
  if (task === undefined) throw new Error(`unknown task ${id}; known: ${Object.keys(TASKS).join(", ")}`);

  const stopAfter = (flag("--stop-after") ?? "orientation") as IslandId;
  const auto = process.argv.includes("--auto");
  const dump = !process.argv.includes("--no-dump");
  const maxTurns = Number(flag("--turns") ?? String(task.maxTurns ?? 40));
  const dir = flag("--dir") ?? join("bench", "runs", "sandbox-tasks", `${new Date().toISOString().replace(/[:.]/g, "-")}-${id}-step`);
  mkdirSync(join(dir, "contexts"), { recursive: true });
  writeFileSync(join(dir, "base.txt"), BASE_PROMPT);

  const settings = loadSettings();

  const { root, request } = materializeTask(task);
  const workspace =
    task.image !== undefined
      ? dockerWorkspace(root, {
          image: task.image,
          ...(task.mountPoint !== undefined ? { mountPoint: task.mountPoint } : {}),
          ...(task.workdir !== undefined ? { workdir: task.workdir } : {}),
          network: task.network ?? "none",
        })
      : containerWorkspace(root, {
          ...(task.mountPoint !== undefined ? { mountPoint: task.mountPoint } : {}),
        });
  for (const command of task.setup ?? []) {
    const result = workspace.run(command);
    if (result.code !== 0) throw new Error(`setup failed (exit ${result.code}): ${command}\n${result.stderr}`);
  }

  const reasoning: string[] = [];
  const capture = (text: string): void => {
    if (text !== "") {
      reasoning.push(text);
      writeFileSync(join(dir, "reasoning.ndjson"), `${JSON.stringify({ reasoning: text })}\n`, { flag: "a" });
    }
  };
  const model = createChatModel(settings);
  const rebuild = (maxTokens: number, opts?: { reasoningOff?: boolean }) =>
    createChatModel({
      ...settings,
      maxTokens,
      ...(opts?.reasoningOff === true ? { reasoningEffort: "none" } : {}),
    });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const interactive = !auto && process.stdin.isTTY === true;
  const meter = new TurnMeter();
  let turn = 0;

  const render = (message: ReturnType<typeof buildMessages>[number]): string => {
    const type = message.role === "user" ? "human" : message.role === "assistant" ? "ai" : message.role;
    const lines = [`===== ${type} =====`];
    if (typeof message.content === "string") {
      if (message.content !== "") lines.push(message.content);
    } else {
      for (const part of message.content) {
        if (part.type === "text" || part.type === "reasoning") {
          if (part.text !== "") lines.push(part.text);
        } else if (part.type === "tool-call") {
          lines.push(`-> call ${part.toolName}(${JSON.stringify(part.input)})`);
        } else if (part.type === "tool-result") {
          lines.push(`(answers ${part.toolCallId})`);
        }
      }
    }
    return lines.join("\n");
  };

  const show = (context: Context): void => {
    const messages = buildMessages(context);
    const path = join(dir, "contexts", `t${String(turn).padStart(3, "0")}.txt`);
    writeFileSync(path, messages.map(render).join("\n\n"));
    const island = context.island !== undefined ? ISLANDS[context.island].label : "(none)";
    console.info(`\n── t${turn}  situation=${context.situation}  island=${island}  chars=${promptText(context).length}  → ${path}`);
    if (dump) {
      // What the model just received, minus the stable base prompt (written to base.txt once).
      const tail = messages.slice(1).map(render).join("\n\n");
      console.info(tail.length > 4000 ? `…(truncated)…\n${tail.slice(-4000)}` : tail);
    }
  };

  const propose: Proposer = async (context) => {
    if (context.island !== undefined && context.island !== stopAfter) {
      throw new Error(`${STOP} (next island: ${ISLANDS[context.island].label})`);
    }
    show(context);
    if (interactive) await rl.question("   ⏎ call the model… ");
    reasoning.length = 0;
    const proposals: Proposals = await proposeModel(model, context, {
      settings,
      rebuild,
      usageHandlers: [meter],
      onResponse: (response) => {
        const text = (response as { reasoning?: unknown }).reasoning;
        if (typeof text === "string") capture(text);
      },
      onError: (error) => console.error(`[step] llm call failed: ${error instanceof Error ? error.message : String(error)}`),
    });
    console.info(`   → ${proposals.actions.map(label).join(" + ")}`);
    if (argsOf(proposals.actions) !== "") console.info(`     ${argsOf(proposals.actions)}`);
    const text = reasoning.join(" ").replace(/\s+/g, " ").trim();
    if (text !== "") console.info(`     reasoning: ${text.slice(-1200)}`);
    turn += 1;
    return proposals;
  };

  try {
    console.info(`[step] task=${id} image=${task.image ?? "(bwrap)"} stop-after=${stopAfter} maxTurns=${maxTurns}`);
    console.info(`[step] trace → ${dir}`);
    if (interactive) console.info("[step] interactive: press Enter before each model call (--auto to disable)\n");
    const result = await runAgent(
      { propose, workspace, maxTurns },
      { request: { id: "r1", text: request } },
    );
    const moves = result.events
      .filter((event) => event.type === "add_node" && event.node.kind === "move")
      .map((event) => (event as { node: { payload?: { state?: string } } }).node.payload?.state ?? "?");
    const outOfScope = result.stopReason === "llm_error" && (result.stopText ?? "").includes(STOP);
    console.info(
      `\n[step] done: ${outOfScope ? `left ${stopAfter} — stopping` : (result.stopReason ?? "?")}  ` +
        `turn(s)=${result.turns}  states=[${moves.join(" → ")}]`,
    );
    console.info(
      `[step] llm=${meter.calls} in=${meter.inputTokens} out=${meter.outputTokens} ` +
        `reason=${meter.reasoningTokens} cost=${meter.costCalls > 0 ? `${meter.costRub.toFixed(3)}₽` : "?"}`,
    );
  } finally {
    rl.close();
    cleanupContainers();
    cleanupSandboxes();
  }
}

process.on("exit", () => cleanupContainers());
void main();
