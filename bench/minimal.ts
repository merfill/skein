import type { ModelMessage } from "ai";

import { loadSettings } from "../src/config/settings";
import { ISLANDS } from "../src/ir/islands";
import { workspaceBrief } from "../src/ir/material";
import { probeBrief } from "../src/ir/session";
import { createChatModel } from "../src/llm/client";
import type { Action, Apply } from "../src/llm/schemas";
import { invokeTools } from "../src/llm/structured";
import { toolDescriptionsFor, toolNamesFor } from "../src/llm/tools";
import { probeSession } from "../src/loop/probe";
import { BASE_BLOCKS } from "../src/loop/prompt";
import { containerWorkspace } from "../tests/sandbox/container";
import { cleanupContainers, dockerWorkspace } from "../tests/sandbox/docker";
import { materializeTask } from "../tests/sandbox/harness";
import { TASKS } from "../tests/sandbox/tasks/registry";
import { cleanupSandboxes } from "../tests/sandbox/workspace";
import { TurnMeter } from "./metrics";

const OLD_L_INSTRUCTION = `Find the target in the material — the file, record, image, or function — and name its coordinates or extent. Before inspecting, think about what the code is supposed to do from the user's request, the workspace map (filesystem facts), the environment (available tools), and the filenames; use that to choose which files and symbols to inspect. For shell work, use only the tools the environment lists; missing ones are unavailable. Distinguish it from its siblings by shape, code, or signature. Name the target, say why the siblings are not it, and name a suspected cause: the expression, step, or encoding that looks wrong and the rule or invariant it breaks. Mark the cause unverified. Do not change the target.`;

const OLD_L_HINT = `Start from the workspace map (filesystem facts) and the environment (available tools). Think about what the code is supposed to do from the filenames and the directory structure: list the relevant directories and choose the candidate files by name — the implementation and the definitions or headers it uses — then inspect those. Compare the target with the sibling that performs the same traversal or operation — the neighbouring loop or function — and use its pattern as the reference. A suspected cause is enough to stop — do not look for a different bug. what: the changed sweeping/run-length-compression code in /app/ocaml criterion: "the target is named — the file, record, image, or function — with the coordinates or extent that identify it; its siblings are ruled out; and a suspected cause is named — the expression, step, or encoding that looks wrong and the rule or invariant it breaks — marked unverified".`;

const B2_FULL = BASE_BLOCKS.find((block) => block.id === "B2")?.text ?? "";
const B2_PARAGRAPHS = B2_FULL.split("\n\n");
const B2 =
  process.env.MINIMAL_B2 === "no-first"
    ? B2_PARAGRAPHS.filter((p) => !p.startsWith("Understand before acting")).join("\n\n")
    : process.env.MINIMAL_B2 === "no-external"
      ? B2_PARAGRAPHS.filter((p) => !p.startsWith("The source is the only reference")).join("\n\n")
      : B2_FULL;

const truncate = (text: string): string =>
  text.length > 8000 ? `${text.slice(0, 8000)}\n… (truncated)` : text;

function nativeArgs(
  action: Action,
): { name: string; args: Record<string, unknown> } | undefined {
  if (action.operator === "stop") return { name: "stop", args: { why: action.why } };
  if (action.operator !== "apply") return undefined;
  const apply = action.action;
  switch (apply.tool) {
    case "bash":
      return {
        name: "bash",
        args: {
          command: apply.command,
          ...(apply.workdir !== undefined ? { workdir: apply.workdir } : {}),
          ...(apply.timeout !== undefined ? { timeout: apply.timeout } : {}),
        },
      };
    case "read":
      return {
        name: "read",
        args: {
          filePath: apply.path,
          ...(apply.start !== undefined ? { offset: apply.start } : {}),
          ...(apply.end !== undefined ? { limit: apply.end } : {}),
        },
      };
    case "grep":
      return {
        name: "grep",
        args: {
          pattern: apply.pattern,
          ...(apply.path !== undefined ? { path: apply.path } : {}),
          ...(apply.include !== undefined ? { include: apply.include } : {}),
          ...(apply.exclude !== undefined ? { exclude: apply.exclude } : {}),
        },
      };
    case "list":
      return {
        name: "list",
        args: {
          ...(apply.path !== undefined ? { path: apply.path } : {}),
          ...(apply.include !== undefined ? { include: apply.include } : {}),
          ...(apply.exclude !== undefined ? { exclude: apply.exclude } : {}),
        },
      };
    default:
      return undefined;
  }
}

async function main(): Promise<void> {
  const task = TASKS["fix-ocaml-gc"];
  if (task === undefined) throw new Error("unknown task fix-ocaml-gc");
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
  const model = createChatModel(settings);

  try {
    const probe = probeSession(workspace);
    const map = probe?.material !== undefined ? workspaceBrief(probe.material, "Workspace map") : "";
    const environment = probe !== undefined ? probeBrief(probe, "localization") : "";
    const brief = [map, environment].filter((part) => part !== "").join("\n\n");

    const messages: ModelMessage[] = [
      {
        role: "system",
        content:
          "You are a software engineering agent. Your job is to solve software development tasks and help the developer.",
      },
      ...(B2 !== "" ? [{ role: "system" as const, content: B2 }] : []),
      { role: "user", content: request },
      ...(brief !== "" ? [{ role: "system" as const, content: brief }] : []),
      { role: "system", content: OLD_L_INSTRUCTION },
      { role: "system", content: OLD_L_HINT },
    ];

    const allowedTools = toolNamesFor({
      move: false,
      apply: true,
      stop: true,
      decline: false,
      applies: ["read", "grep", "list", "bash"],
    });
    const toolDescriptions = toolDescriptionsFor();
    const cap = Number(process.env.MINIMAL_TURNS ?? "12");
    let total = 0;

    for (let turn = 1; turn <= cap; turn += 1) {
      const meter = new TurnMeter();
      const reasoning: string[] = [];
      const proposals = await invokeTools(model, messages, {
        settings,
        usageHandlers: [meter],
        onResponse: (response) => {
          const raw = (response as { reasoning?: unknown }).reasoning;
          if (typeof raw === "string" && raw !== "") reasoning.push(raw);
        },
        allowedTools,
        toolDescriptions,
      });
      total += meter.costRub;

      const calls = proposals.actions.map((action, index) => ({
        action,
        id: `call_${turn}_${index}`,
        ...nativeArgs(action),
      }));

      console.log(
        `\n=== turn ${turn} in=${meter.inputTokens} out=${meter.outputTokens} reason=${meter.reasoningTokens} cost=${meter.costRub.toFixed(4)}₽ total=${total.toFixed(4)}₽`,
      );
      for (const call of calls) {
        console.log(`-> ${call.name ?? "unsupported"}(${JSON.stringify(call.args ?? call.action)})`);
      }
      console.log("thought:", proposals.thought.replace(/\s+/g, " ").trim().slice(0, 4000));
      console.log(
        "reasoning:",
        reasoning.join(" ").replace(/\s+/g, " ").trim().slice(0, 4000),
      );

      const toolCalls = calls.filter(
        (call): call is typeof call & { name: string; args: Record<string, unknown> } =>
          call.name !== undefined && call.args !== undefined,
      );
      messages.push({
        role: "assistant",
        content: [
          ...(reasoning.length > 0 ? [{ type: "reasoning" as const, text: reasoning.join("\n") }] : []),
          ...toolCalls.map((call) => ({
            type: "tool-call" as const,
            toolCallId: call.id,
            toolName: call.name,
            input: call.args,
          })),
        ],
      });

      let stopped = false;
      for (const call of toolCalls) {
        if (call.action.operator === "stop") {
          console.log("STOP:", call.action.why);
          stopped = true;
          continue;
        }
        if (call.action.operator !== "apply") {
          console.log("unsupported action:", JSON.stringify(call.action));
          continue;
        }
        const apply: Apply = call.action.action;
        let result: string;
        try {
          switch (apply.tool) {
            case "bash": {
              const run = workspace.run(apply.command ?? "", {
                ...(apply.workdir !== undefined ? { workdir: apply.workdir } : {}),
                ...(apply.timeout !== undefined ? { timeoutMs: apply.timeout } : {}),
              });
              result = truncate(
                `exit ${run.code}${run.signal !== undefined ? ` signal ${run.signal}` : ""}${
                  run.timedOut === true ? " (timed out)" : ""
                }\n${run.stdout}${run.stderr !== "" ? `\n[stderr]\n${run.stderr}` : ""}`,
              );
              break;
            }
            case "read": {
              const text = workspace.read(apply.path);
              const lines = text.split("\n");
              const from = Math.max(1, apply.start ?? 1);
              const to = Math.min(lines.length, apply.end ?? lines.length);
              const body = lines
                .slice(from - 1, to)
                .map((line, index) => `${from + index}: ${line}`)
                .join("\n");
              result = truncate(`${apply.path} [${from}-${to}]\n${body}`);
              break;
            }
            case "grep": {
              const matches = workspace.grep(apply.pattern, {
                ...(apply.path !== undefined ? { path: apply.path } : {}),
                ...(apply.include !== undefined ? { include: apply.include } : {}),
                ...(apply.exclude !== undefined ? { exclude: apply.exclude } : {}),
              });
              const count = apply.count ?? 100;
              result = truncate(
                `${matches
                  .slice(0, count)
                  .map((match) => `${match.path}:${match.line}: ${match.text}`)
                  .join("\n")}${matches.length > count ? `\n… (${matches.length} matches)` : ""}`,
              );
              break;
            }
            case "list": {
              const files = workspace.listFiles({
                ...(apply.path !== undefined ? { path: apply.path } : {}),
                ...(apply.include !== undefined ? { include: apply.include } : {}),
                ...(apply.exclude !== undefined ? { exclude: apply.exclude } : {}),
              });
              const from = Math.max(1, apply.from ?? 1);
              const limit = apply.limit ?? 200;
              const shown = files.slice(from - 1, from - 1 + limit);
              result = truncate(
                `${shown.join("\n")}${
                  files.length > from - 1 + limit ? `\n… (${files.length} files)` : ""
                }`,
              );
              break;
            }
            default:
              result = `tool ${apply.tool} is not available in this experiment`;
              break;
          }
        } catch (error) {
          result = `error: ${error instanceof Error ? error.message : String(error)}`;
        }
        console.log(`<- ${call.name}: ${result.slice(0, 700).replace(/\s+/g, " ")}`);
        messages.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: call.id,
              toolName: call.name,
              output: { type: "text", value: result },
            },
          ],
        });
      }
      if (stopped) break;
    }
  } finally {
    cleanupContainers();
    cleanupSandboxes();
  }
}

process.on("exit", () => cleanupContainers());
void main();
