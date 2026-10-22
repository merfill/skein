// One live turn of a task, driven from an accumulated action sequence — the building block of
// the step-by-step state testing (docs/state_testing_ru.md). The prompt is built and the model
// is called on the HOST; the sequence's commands are replayed in the task's CONTAINER, so the
// observations the tape shows are real.
//
//   TAPE_DIR=<dir> npx tsx bench/step.ts <task-id> <seq.json>
//
// `EXTRA_SYSTEM` appends a system message to the built context for this one call (a one-step
// counterfactual, like `bench/turn.ts --append-system`); it is not written back to the seq.
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

import type { ModelMessage } from "ai";

import { loadSettings } from "../src/config/settings";
import { SESSION_PROBE_ID } from "../src/ir/session";
import type { Event } from "../src/ir/events";
import { fold } from "../src/ir/graph";
import { ISLANDS } from "../src/ir/islands";
import { project, type Context, type TapeMessage } from "../src/ir/project";
import { createChatModel } from "../src/llm/client";
import { invokeTools } from "../src/llm/structured";
import { toolDescriptionsFor, toolNamesFor } from "../src/llm/tools";
import { buildMessages, propose } from "../src/loop/propose";
import { probeSession } from "../src/loop/probe";
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

const renderMessages = (messages: ModelMessage[]): string =>
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
            lines.push(`-> call ${part.toolName}(${JSON.stringify(part.input)})`);
          } else if (part.type === "tool-result") {
            const output = (part as { output?: { value?: unknown } }).output;
            const value =
              typeof output?.value === "string" ? output.value : JSON.stringify(output?.value ?? "");
            lines.push(`(answers ${part.toolCallId}) ${value}`);
          }
        }
      }
      return lines.join("\n");
    })
    .join("\n\n");

const render = (ctx: Context): string => renderMessages(buildMessages(ctx));

function oldLLayout(history: TapeMessage[]): TapeMessage[] {
  const index = history.findIndex(
    (message) =>
      message.role === "system" &&
      message.text !== undefined &&
      message.text.startsWith("Start state Localization\nGoal:"),
  );
  if (index < 0) return history;
  const start = history[index];
  const text = start?.text ?? "";
  const lines = text.split("\n");
  const label = lines[0] ?? "Start state Localization";
  const instruction = text.split("\n\n").slice(1).join("\n\n");
  const brief = history.find(
    (message) =>
      message.role === "system" &&
      message.text !== undefined &&
      message.text.startsWith("Workspace map"),
  );
  const hint = history.find(
    (message) => message.role === "system" && message.text === ISLANDS.localization.hint,
  );
  const plan = history.filter(
    (message) => message.role === "assistant" || message.role === "tool",
  );
  return [
    ...history.slice(0, index),
    { role: "system", text: label },
    ...(brief !== undefined ? [brief] : []),
    ...(instruction !== "" ? [{ role: "system" as const, text: instruction }] : []),
    ...(process.env.SKEIN_L_USER === "none"
      ? []
      : [
          {
            role: "user" as const,
            text: "Find the error. Report its location and what is wrong. Do not change the material.",
          },
        ]),
    ...(hint !== undefined ? [hint] : []),
    ...plan,
  ];
}

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
  const model = createChatModel(settings);

  const seed: Event[] = [
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
    // The same session probe the engine records at request start (src/loop/graph.ts), so a
    // step-by-step tape sees the same facts the live run does.
    // A/B switch for the probe on the step tape (the engine always probes).
    const probe = process.env.SKEIN_ENV_PROBE === "false" ? undefined : probeSession(workspace);
    if (probe !== undefined) {
      seed.push({
        type: "add_node",
        node: {
          id: SESSION_PROBE_ID,
          space: "work",
          kind: "fact",
          label: "session",
          payload: probe,
          seq: 1,
        },
      });
    }
    const events: unknown[] = [...seed];
    for (const entry of seq) {
      const applied = executeAction(entry.action as never, fold(events as never), workspace, entry.turn);
      events.push(...applied.events);
    }

    const context = project(fold(events as never));
    const extraSystem = process.env.EXTRA_SYSTEM;
    const isMinimal = process.env.SKEIN_MINIMAL_TAPE === "true";
    const roleMessage: TapeMessage = {
      role: "system",
      text: "You are a software engineering agent. Your job is to solve software development tasks and help the developer.",
    };
    const requestMessage = context.history.find((message) => message.role === "user");
    const briefMessage = context.history.find(
      (message) => message.role === "system" && message.text.startsWith("Workspace map"),
    );
    const hintMessage = context.history.find(
      (message) => message.role === "system" && message.text === ISLANDS.localization.hint,
    );
    const planMessages = context.history.filter(
      (message) => message.role === "assistant" || message.role === "tool",
    );
    const minimalHistory = [roleMessage, requestMessage, briefMessage, hintMessage, ...planMessages]
      .filter((message): message is TapeMessage => message !== undefined);
    const minimalContext: Context = { ...context, history: minimalHistory };
    const injected: Context =
      extraSystem !== undefined && extraSystem !== ""
        ? { ...context, history: [...context.history, { role: "system", text: extraSystem }] }
        : context;
    const cleaned: Context =
      process.env.SKEIN_STRIP_FINISH === "true"
        ? {
            ...injected,
            history: injected.history.map((message) =>
              message.role === "system" &&
              message.text !== undefined &&
              message.text.startsWith("Finish state Orientation —")
                ? {
                    ...message,
                    text: "Finish state Orientation — Workspace root /app, single top-level entry ocaml/ (4623 files); no VCS repository.",
                  }
                : message,
            ),
          }
        : injected;
    const oldContext: Context =
      process.env.SKEIN_OLD_L_LAYOUT === "true"
        ? { ...cleaned, history: oldLLayout(cleaned.history) }
        : cleaned;
    const fullContext: Context =
      process.env.SKEIN_SPLIT_START === "true"
        ? {
            ...oldContext,
            history: oldContext.history.flatMap((message): TapeMessage[] => {
              const text = message.text;
              if (
                message.role === "system" &&
                text !== undefined &&
                text.startsWith("Start state ") &&
                text.includes("\nGoal:")
              ) {
                const [first, ...rest] = text.split("\n");
                return [{ ...message, text: first ?? "" }, { ...message, text: rest.join("\n") }];
              }
              return [message];
            }),
          }
        : oldContext;
    const proposeContext: Context =
      process.env.SKEIN_NO_WEBFETCH === "true" && fullContext.applicable !== undefined
        ? {
            ...fullContext,
            applicable: {
              ...fullContext.applicable,
              applies: fullContext.applicable.applies?.filter((tool) => tool !== "webfetch"),
            },
          }
        : fullContext;
    const tapeContext = isMinimal ? minimalContext : fullContext;
    const tapeMessages = isMinimal
      ? buildMessages(minimalContext).slice(1)
      : buildMessages(fullContext);
    const turn = seq.length > 0 ? Math.max(...seq.map((entry) => entry.turn)) + 1 : 0;
    const path = join(dir, "contexts", `t${String(turn).padStart(3, "0")}.txt`);
    writeFileSync(path, renderMessages(tapeMessages));
    console.log(`\nturn ${turn}: situation=${tapeContext.situation} island=${tapeContext.island ?? "(none)"}  → ${path}`);

    reasoning.length = 0;
    const meter = new TurnMeter();
    let replyAttempt = 0;
    const onResponse = (response: unknown) => {
      const raw = (response as { reasoning?: unknown }).reasoning;
      if (typeof raw === "string" && raw !== "") reasoning.push(raw);
      if (process.env.DUMP_REPLY === "true") {
        replyAttempt += 1;
        const reply = response as {
          text?: unknown;
          reasoning?: unknown;
          toolCalls?: unknown;
          finishReason?: unknown;
          response?: unknown;
          usage?: unknown;
        };
        const dump = {
          text: reply.text,
          reasoning: reply.reasoning,
          toolCalls: reply.toolCalls,
          finishReason: reply.finishReason,
          response: reply.response,
          usage: reply.usage,
        };
        const dumpPath = join(
          dir,
          `reply-t${String(turn).padStart(3, "0")}-a${replyAttempt}.json`,
        );
        try {
          writeFileSync(dumpPath, JSON.stringify(dump, null, 2));
        } catch (error) {
          writeFileSync(dumpPath, `dump failed: ${String(error)}\n${String(reply)}`);
        }
        console.log("reply dump →", dumpPath);
      }
    };
    const minimalFrontier = context.applicable ?? {
      move: false,
      apply: true,
      stop: true,
      decline: false,
      applies: ISLANDS.localization.applies,
    };
    const proposals = isMinimal
      ? await invokeTools(model, tapeMessages, {
          settings,
          usageHandlers: [meter],
          onResponse,
          allowedTools: toolNamesFor(minimalFrontier),
          toolDescriptions: toolDescriptionsFor("localization"),
        })
      : await propose(model, proposeContext, {
          settings,
          usageHandlers: [meter],
          onResponse,
        });
    writeFileSync(
      join(dir, "turns.ndjson"),
      `${JSON.stringify({ turn, situation: context.situation, island: context.island, thought: proposals.thought, actions: proposals.actions, reasoning: reasoning.join("\n"), cacheRead: meter.cacheRead, cacheWrite: meter.cacheWrite, usage: meter.usage })}\n`,
      { flag: "a" },
    );
    writeFileSync(join(dir, "next-actions.json"), JSON.stringify(proposals.actions, null, 2));
    console.log("actions:", JSON.stringify(proposals.actions, null, 2));
    console.log("thought:", proposals.thought.replace(/\s+/g, " ").trim().slice(0, 2000));
    console.log("reasoning:", reasoning.join(" ").replace(/\s+/g, " ").trim().slice(0, 2000));
    console.log(
      `usage: llm=${meter.calls} in=${meter.inputTokens} out=${meter.outputTokens} reason=${meter.reasoningTokens} cache=${meter.cacheRead}/${meter.cacheWrite} cost=${meter.costCalls > 0 ? `${meter.costRub.toFixed(4)}₽` : "?"}`,
    );
    console.log("tape →", path);
  } finally {
    cleanupContainers();
    cleanupSandboxes();
  }
}

process.on("exit", () => cleanupContainers());
void main();
