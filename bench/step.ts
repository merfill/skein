// One live turn of a task, driven from an accumulated action sequence — the building block of
// the step-by-step state testing (docs/state_testing_ru.md). The prompt is built and the model
// is called on the HOST; the sequence's commands are replayed in the task's CONTAINER, so the
// observations the tape shows are real.
//
//   TAPE_DIR=<dir> npx tsx bench/step.ts <task-id> <seq.json>
//
// seq.json = [{ "turn": N, "action": <Action> }, …]: every action is applied with
// `executeAction` in order (so `bash`/`read`/`grep` run against the container), then the IR is
// projected, `buildMessages` renders the tape, and `propose` makes ONE model call for the next
// turn. Results are written to <dir>/contexts/tNNN.txt (the tape), <dir>/turns.ndjson (the
// action + reasoning), and <dir>/next-actions.json (the model's proposal, to append to seq for
// the next turn).
//
// Cost discipline: one live model call per run, plus one container replay of the whole seq
// (a task whose seq contains `configure`/`make` re-runs the build each turn).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadSettings } from "../src/config/settings";
import { fold } from "../src/ir/graph";
import { project, type Context } from "../src/ir/project";
import { createChatModel } from "../src/llm/client";
import { buildMessages, propose } from "../src/loop/propose";
import { executeAction } from "../src/tools";
import { containerWorkspace } from "../tests/sandbox/container";
import { cleanupContainers, dockerWorkspace } from "../tests/sandbox/docker";
import { materializeTask } from "../tests/sandbox/harness";
import { TASKS } from "../tests/sandbox/tasks/registry";
import { cleanupSandboxes } from "../tests/sandbox/workspace";
import { TurnMeter } from "./metrics";

const taskId = process.argv[2]?.startsWith("--") === false ? (process.argv[2] as string) : "fix-ocaml-gc";
const seqPath = process.argv[3] ?? "bench/runs/seq.json";
const seq = JSON.parse(readFileSync(seqPath, "utf8")) as { turn: number; action: unknown }[];
const dir = process.env.TAPE_DIR ?? join("bench", "runs", "sandbox-tasks", `${taskId}-step`);
mkdirSync(join(dir, "contexts"), { recursive: true });

const render = (ctx: Context): string =>
  buildMessages(ctx)
    .map((message) => {
      const calls = (message as { tool_calls?: { name: string; args: unknown }[] }).tool_calls;
      const callId = (message as { tool_call_id?: string }).tool_call_id;
      const lines = [`===== ${message.getType()} =====`];
      if (typeof message.content === "string" && message.content !== "") lines.push(message.content);
      for (const call of calls ?? []) lines.push(`-> call ${call.name}(${JSON.stringify(call.args)})`);
      if (callId !== undefined) lines.push(`(answers ${callId})`);
      return lines.join("\n");
    })
    .join("\n\n");

async function main(): Promise<void> {
  const task = TASKS[taskId];
  if (task === undefined) throw new Error(`unknown task ${taskId}; known: ${Object.keys(TASKS).join(", ")}`);
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

  const settings = loadSettings();
  const reasoning: string[] = [];
  const model = createChatModel(settings, {
    onResponseBody: (body: unknown) => {
      const message = (body as { choices?: { message?: { reasoning?: unknown } }[] }).choices?.[0]?.message;
      if (typeof message?.reasoning === "string" && message.reasoning !== "") reasoning.push(message.reasoning);
    },
  });

  const seed = [
    {
      type: "add_node",
      node: {
        id: "r1",
        space: "work",
        kind: "request",
        label: request.replace(/\s+/g, " ").trim().slice(0, 120),
        payload: { text: request },
        seq: 0,
      },
    },
  ];

  try {
    const events: unknown[] = [...seed];
    for (const entry of seq) {
      const applied = executeAction(entry.action as never, fold(events as never), workspace, entry.turn);
      events.push(...applied.events);
    }

    const context = project(fold(events as never));
    const turn = seq.length > 0 ? Math.max(...seq.map((entry) => entry.turn)) + 1 : 0;
    const path = join(dir, "contexts", `t${String(turn).padStart(3, "0")}.txt`);
    writeFileSync(path, render(context));
    console.log(`\nturn ${turn}: situation=${context.situation} island=${context.island ?? "(none)"}  → ${path}`);

    reasoning.length = 0;
    const meter = new TurnMeter();
    const proposals = await propose(model, context, { settings, callbacks: [meter] });
    writeFileSync(
      join(dir, "turns.ndjson"),
      `${JSON.stringify({ turn, situation: context.situation, island: context.island, actions: proposals.actions, reasoning: reasoning.join("\n") })}\n`,
      { flag: "a" },
    );
    writeFileSync(join(dir, "next-actions.json"), JSON.stringify(proposals.actions, null, 2));
    console.log("actions:", JSON.stringify(proposals.actions, null, 2));
    console.log("reasoning:", reasoning.join(" ").replace(/\s+/g, " ").trim().slice(0, 2000));
    console.log(
      `usage: llm=${meter.calls} in=${meter.inputTokens} out=${meter.outputTokens} reason=${meter.reasoningTokens} cost=${meter.costCalls > 0 ? `${meter.costRub.toFixed(4)}₽` : "?"}`,
    );
    console.log("tape →", path);
  } finally {
    cleanupContainers();
    cleanupSandboxes();
  }
}

process.on("exit", () => cleanupContainers());
void main();
