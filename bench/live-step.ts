// The real engine, one turn at a time, on a ported terminal-bench task.
//
// The engine (`runAgent`) runs on the HOST; only the tool calls execute in the task's
// long-lived container. The process opens the task once and keeps the workspace and the
// container alive across turns, so there is no sequence replay and no second projection:
// every turn is a `seed`/`startTurn` continuation of the same journal, with the engine's own
// transitions, refusals, revert and reasoning-on-the-tape.
//
//   npx tsx bench/live-step.ts <task-id> [--turn N] [--auto] [--net on|off]
//                               [--dir <trace-dir>] [--signal <file>]
//
// After each turn it prints the turn's calls, tool results, token breakdown, cost and the
// workspace diff since the initial (post-setup) tree, writes the tape to
// `<dir>/contexts/tNNN.txt`, and waits for `<signal>` (default `<dir>/continue`) before the
// next turn. `--auto` runs without waiting; `--turn N` stops after that absolute turn.
//
// This is the single step-by-step driver. The old replay harness (`bench/step.ts`) executed
// actions directly and bypassed `executeNode`, so its journal carried no reasoning and its
// transitions/revert were the harness's, not the engine's. This driver keeps the engine.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { TurnMeter } from "./metrics";
import { loadSettings } from "../src/config/settings";
import type { Event } from "../src/ir/events";
import { fold } from "../src/ir/graph";
import type { Context, TapeMessage } from "../src/ir/project";
import { project } from "../src/ir/project";
import type { Proposals } from "../src/llm/schemas";
import { createChatModel } from "../src/llm/client";
import { runAgent, type AgentResult } from "../src/loop/graph";
import { probeSession } from "../src/loop/probe";
import { buildMessages, promptText, propose as proposeModel } from "../src/loop/propose";
import { cleanupContainers } from "../tests/sandbox/docker";
import { openTaskWorkspace } from "../tests/sandbox/harness";
import { startAllowlistProxy, type AllowlistProxy } from "../tests/sandbox/proxy";
import { TASKS } from "../tests/sandbox/tasks/registry";
import { cleanupSandboxes } from "../tests/sandbox/workspace";

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const taskId = process.argv[2]?.startsWith("--") === false ? (process.argv[2] as string) : "fix-ocaml-gc";
const stopTurn = Number(arg("--turn", "0"));
const auto = process.argv.includes("--auto");
const net = arg("--net", "on") === "off" ? "off" : "on";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = arg("--dir", join("bench", "runs", "sandbox-tasks", `${stamp}-${taskId}-live-step`));
const signal = arg("--signal", join(dir, "continue"));
mkdirSync(join(dir, "contexts"), { recursive: true });

const render = (messages: ReturnType<typeof buildMessages>): string =>
  messages
    .map((message) => {
      const lines = [`===== ${message.role} =====`];
      if (typeof message.content === "string") {
        if (message.content !== "") lines.push(message.content);
      } else {
        for (const part of message.content) {
          if (part.type === "text" || part.type === "reasoning") {
            if (part.text !== "") lines.push(part.text);
          } else if (part.type === "tool-call") {
            lines.push(`-> call ${part.toolName}(${JSON.stringify(part.input)}) [id ${part.toolCallId}]`);
          } else if (part.type === "tool-result") {
            lines.push(`(answers ${part.toolCallId})`);
            const value = (part.output as { value?: unknown } | undefined)?.value;
            if (typeof value === "string" && value !== "") lines.push(value);
          }
        }
      }
      return lines.join("\n");
    })
    .join("\n\n");

const callName = (action: Proposals["actions"][number]): string =>
  action.operator === "apply" ? action.action.tool : action.operator;

function callArgs(action: Proposals["actions"][number]): string {
  if (action.operator !== "apply") return "";
  const input = { ...action.action } as Record<string, unknown>;
  delete input.tool;
  return JSON.stringify(input);
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

function diffLines(stdout: string | undefined, stderr: string | undefined, code: number | null): string[] {
  if (code !== null && code > 1) {
    return [`diff failed: ${(stderr ?? "").trim() || `exit ${code}`}`];
  }
  return (stdout ?? "").split("\n").filter((line) => line !== "").slice(0, 40);
}

// The workspace changes since the initial snapshot, as `diff -rq` lines (bounded).
function treeChanges(initial: string, current: string): string[] {
  const result = spawnSync(
    "diff",
    ["-rq", "--exclude=.skein", "--exclude=.env", "--exclude=.env.*", initial, current],
    { encoding: "utf8" },
  );
  if (result.error !== undefined) return [`diff failed: ${String(result.error)}`];
  return diffLines(result.stdout, result.stderr, result.status);
}

// The container-native form: both the initial snapshot and the live tree are container paths,
// so `diff` must run there too.
function containerTreeChanges(
  exec: (command: string) => { code: number; stdout: string; stderr: string },
  initial: string,
  current: string,
): string[] {
  const result = exec(
    `diff -rq --exclude=.skein --exclude=.env --exclude='.env.*' ${shellQuote(initial)} ${shellQuote(current)}`,
  );
  return diffLines(result.stdout, result.stderr, result.code);
}

async function main(): Promise<void> {
  const task = TASKS[taskId];
  if (task === undefined) throw new Error(`unknown task ${taskId}; known: ${Object.keys(TASKS).join(", ")}`);

  const settings = loadSettings();
  if (settings.apiKey === "") throw new Error("SKEIN_API_KEY is empty; set it in .env");
  let proxy: AllowlistProxy | undefined;
  if (net === "off") {
    const apiHost = new URL(settings.apiUrl).hostname;
    proxy = await startAllowlistProxy([apiHost], "127.0.0.1");
    process.env.HTTP_PROXY = proxy.url;
    process.env.HTTPS_PROXY = proxy.url;
    process.env.ALL_PROXY = proxy.url;
  }

  console.info(
    `[live-step] opening ${task.id}: ` +
      (task.image !== undefined
        ? "starting the task container (rootless; /app stays in the container), "
        : "extracting the image into a host tree, ") +
      "running setup and the initial checkpoint…",
  );
  const openedAt = Date.now();
  // `--net` gates the HOST's fetch/run through the allowlist proxy; the task container keeps
  // its own network mode (`task.network`, default `none`).
  const opened = openTaskWorkspace(task);
  const { workspace, request } = opened;
  // The diff compares the initial checkpoint tree with the agent-visible live tree. For
  // rootless Docker both are container paths (`/tmp/.skein/trees/0` and `/app`); the host
  // root is only the empty interface dir.
  const treeRoot = opened.rootless === true ? (workspace.displayRoot ?? opened.root) : opened.root;
  const initialTree = join(opened.checkpoint.dir, opened.checkpoint.snapshots[0]!.tree);
  console.info(
    `[live-step] ready in ${((Date.now() - openedAt) / 1000).toFixed(1)}s: ` +
      `root=${treeRoot} container=${(workspace as { name?: string }).name ?? "(none)"}`,
  );
  rmSync(signal, { force: true });

  const model = createChatModel(settings);
  const rebuild = (maxTokens: number, opts?: { reasoningOff?: boolean }) =>
    createChatModel({
      ...settings,
      maxTokens,
      ...(opts?.reasoningOff === true ? { reasoningEffort: "none" } : {}),
    });

  let events: Event[] | undefined;
  let startTurn = 0;
  let proposal: Proposals | undefined;
  let usage: TurnMeter | undefined;

  const propose = async (context: Context): Promise<Proposals> => {
    const meter = new TurnMeter();
    const inferTurn = startTurn;
    const messages = buildMessages(context);
    writeFileSync(join(dir, "contexts", `t${String(inferTurn).padStart(3, "0")}.txt`), render(messages));
    writeFileSync(
      join(dir, "contexts.ndjson"),
      `${JSON.stringify({
        turn: inferTurn,
        chars: promptText(context).length,
        situation: context.situation,
        island: context.island,
        what: context.what,
        done: context.done,
        history: context.history,
      })}\n`,
      { flag: "a" },
    );
    const started = Date.now();
    console.info(`[live-step] t${inferTurn} proposing (chars=${promptText(context).length})…`);
    const reply = await proposeModel(model, context, {
      settings,
      rebuild,
      usageHandlers: [meter],
      onResponse: (response) => {
        const reasoning = (response as { reasoning?: unknown }).reasoning;
        if (typeof reasoning === "string" && reasoning !== "") {
          writeFileSync(
            join(dir, "reasoning.ndjson"),
            `${JSON.stringify({ turn: inferTurn, reasoning })}\n`,
            { flag: "a" },
          );
        }
      },
    });
    console.info(
      `[live-step] t${inferTurn} model returned in ${((Date.now() - started) / 1000).toFixed(1)}s ` +
        `(${reply.actions.map(callName).join(", ")})`,
    );
    proposal = reply;
    usage = meter;
    return reply;
  };

  try {
    while (!existsSync(join(dir, "quit"))) {
      const run: AgentResult = await runAgent(
        {
          propose,
          workspace,
          maxTurns: startTurn + 1,
          probe: probeSession,
        },
        events === undefined
          ? { request: { id: "r1", text: request } }
          : { request: { id: "r1", text: request }, seed: events, startTurn },
      );
      events = run.events;
      const turn = startTurn;
      startTurn = run.turns;

      const context = project(fold(events));
      const toolTail = lastToolTail(context.history);
      const meter = usage as TurnMeter | undefined;
      const actions = proposal?.actions ?? [];
      const chars = promptText(context).length;

      console.info(
        `\n=== t${turn} ${context.situation}/${context.island ?? "(none)"} in=${meter?.inputTokens ?? 0} ` +
          `out=${meter?.outputTokens ?? 0} reason=${meter?.reasoningTokens ?? 0} ` +
          `cache=${meter?.cacheRead ?? 0}/${meter?.cacheWrite ?? 0} ` +
          `cost=${meter?.costCalls ? `${meter?.costRub.toFixed(4)}₽` : "?"} chars=${chars}`,
      );
      for (const action of actions) console.info(`  call ${callName(action)} ${callArgs(action)}`);
      for (const line of toolTail) console.info(`  out  ${line}`);
      const changed =
        opened.rootless === true && opened.container !== undefined
          ? containerTreeChanges((command) => opened.container!.exec(command), initialTree, treeRoot)
          : treeChanges(initialTree, treeRoot);
      console.info(
        changed.length > 0
          ? `  tree ${changed.length} change${changed.length === 1 ? "" : "s"}:\n    ${changed.join("\n    ")}`
          : "  tree no changes",
      );
      console.info(`  tape ${join(dir, "contexts", `t${String(turn).padStart(3, "0")}.txt`)}`);
      writeFileSync(
        join(dir, "turns.ndjson"),
        `${JSON.stringify({
          turn,
          situation: context.situation,
          island: context.island,
          actions,
          reasoning: "",
          inputTokens: meter?.inputTokens ?? 0,
          outputTokens: meter?.outputTokens ?? 0,
          reasoningTokens: meter?.reasoningTokens ?? 0,
          cacheRead: meter?.cacheRead ?? 0,
          cacheWrite: meter?.cacheWrite ?? 0,
          cost: meter?.costCalls ? meter?.costRub : null,
          stopReason: run.stopReason,
        })}\n`,
        { flag: "a" },
      );
      writeFileSync(join(dir, "journal.ndjson"), `${JSON.stringify({ turn, events: run.events })}\n`, {
        flag: "a",
      });

      const finished = run.done && run.stopReason !== "max_turns";
      if (finished) {
        console.info(`\nfinished: stop=${run.stopReason} turns=${run.turns}`);
        break;
      }
      if (stopTurn > 0 && run.turns >= stopTurn) {
        console.info(`\nstopped at turn ${run.turns} (--turn ${stopTurn})`);
        break;
      }
      if (!auto) {
        console.info(`\nwaiting: touch ${signal} for the next turn, or ${join(dir, "quit")} to stop`);
        while (!existsSync(signal) && !existsSync(join(dir, "quit"))) await sleep(250);
        rmSync(signal, { force: true });
      }
    }
  } finally {
    await proxy?.close();
    cleanupContainers();
    cleanupSandboxes();
  }
}

// The observations of the turn just executed: the tool messages that follow the last
// assistant call in the projected tape.
function lastToolTail(history: readonly TapeMessage[]): string[] {
  let index = -1;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.role === "assistant") {
      index = i;
      break;
    }
  }
  if (index < 0) return [];
  const out: string[] = [];
  for (const message of history.slice(index + 1)) {
    if (message.role !== "tool" || message.text === undefined) continue;
    const lines = message.text.split("\n").filter((line) => line !== "");
    const head = lines.slice(0, 6).join("\n       ");
    out.push(head.length > 900 ? `${head.slice(0, 900)}…` : head);
  }
  return out;
}

process.on("exit", () => cleanupContainers());
void main();
