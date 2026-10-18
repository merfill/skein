import type { AssistantModelMessage, LanguageModel, ModelMessage, ToolModelMessage } from "ai";

import type { Context, TapeMessage } from "../ir/project";
import type { Proposals } from "../llm/schemas";
import { invokeTools, type ToolsOptions } from "../llm/structured";
import { toolDescriptionsFor, toolNamesFor } from "../llm/tools";
import { BASE_PROMPT, NODE_INSTRUCTIONS, REQUEST_INSTRUCTION, transitionInstruction, turnInstruction } from "./prompt";

export type Proposer = (context: Context) => Promise<Proposals>;

export { BASE_PROMPT };

function callsOf(message: TapeMessage): { id: string; name: string; args: Record<string, unknown> }[] {
  return message.calls ?? (message.call !== undefined ? [message.call] : []);
}

// The tool name behind a call id. The AI SDK's tool-result part requires it; the provider's
// wire body does not use it (only `tool_call_id`), so a synthetic tape may omit the pair.
function toolNames(history: readonly TapeMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of history) {
    if (message.role !== "assistant") continue;
    for (const call of callsOf(message)) names.set(call.id, call.name);
  }
  return names;
}

// The tape renders the model's own history as a native tool-calling transcript: an assistant
// move is an `assistant` message carrying `tool-call` parts, a command result is a `tool`
// message answering it. Only the request and the situation's transition are `user` turns — no
// result is ever smuggled in as a user message.
function toMessage(message: TapeMessage, names: Map<string, string>): ModelMessage {
  if (message.role === "assistant") {
    const calls = callsOf(message);
    if (calls.length > 0) {
      // The turn's reasoning rides as a `reasoning` part; the provider serializes it to its
      // own field (`reasoning_content` for RouterAI), never a visible answer.
      const reasoning = message.reasoning ?? message.text;
      const content: AssistantModelMessage["content"] = [
        ...(reasoning !== "" ? [{ type: "reasoning" as const, text: reasoning }] : []),
        ...calls.map((call) => ({
          type: "tool-call" as const,
          toolCallId: call.id,
          toolName: call.name,
          input: call.args,
        })),
      ];
      return { role: "assistant", content };
    }
    return { role: "assistant", content: message.text };
  }
  if (message.role === "user") return { role: "user", content: message.text };
  // A `system` turn on the tape (e.g. a state's description, shown once when it is entered).
  if (message.role === "system") return { role: "system", content: message.text };
  // Every tool result answers an assistant tool_call; a tool turn without a callId would
  // desync the transcript, so it is an invariant violation, not a user turn.
  if (message.callId === undefined) {
    throw new Error(`tape tool message without a callId: ${message.text.slice(0, 80)}`);
  }
  const result: ToolModelMessage = {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: message.callId,
        toolName: names.get(message.callId) ?? "tool",
        output: { type: "text", value: message.text },
      },
    ],
  };
  return result;
}

// The context the model sees is the tape, assembled as: the stable base prompt, the constraints,
// the tape itself. No instruction is appended per turn: the base prompt carries the contract and
// the tape carries the state (a clean transcript, like a plain coding agent; docs/ir_semantics §7).
export function buildMessages(context: Context): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: "system", content: BASE_PROMPT }];
  for (const constraint of context.constraints) {
    messages.push({
      role: "system",
      content: `Constraint (${constraint.id}): never touch paths matching ${constraint.forbid.join(", ")}.`,
    });
  }
  const names = toolNames(context.history);
  for (const message of context.history) messages.push(toMessage(message, names));
  // The situation instruction is appended last, per turn (never stored). The transition one is
  // a `user` turn: a provider treats a trailing assistant text (the closed state's `Finish`
  // line) followed only by a `system` message as a prefix/prefill and refuses the `move`
  // function call; a `user` turn after it clears that rule (docs/ir_semantics §7).
  if (context.situation === "request") {
    messages.push({ role: "system", content: REQUEST_INSTRUCTION });
  } else if (context.situation === "plan") {
    messages.push({ role: "system", content: NODE_INSTRUCTIONS.plan });
  } else if (context.situation === "working") {
    messages.push({ role: "system", content: turnInstruction(context.island, context.done) });
  } else if (context.situation === "transition") {
    messages.push({ role: "user", content: transitionInstruction(context.island) });
  } else if (context.situation === "terminal") {
    messages.push({ role: "system", content: NODE_INSTRUCTIONS.terminal });
  }
  return messages;
}

function partText(part: unknown): string {
  if (typeof part !== "object" || part === null) return "";
  const value = part as Record<string, unknown>;
  if (value.type === "text" || value.type === "reasoning") {
    return typeof value.text === "string" ? value.text : "";
  }
  if (value.type === "tool-call") {
    return `-> call ${String(value.toolName)}(${JSON.stringify(value.input)}) [id ${String(value.toolCallId)}]`;
  }
  if (value.type === "tool-result") {
    const output = value.output as { value?: unknown } | undefined;
    return `(answers ${String(value.toolCallId)}) ${typeof output?.value === "string" ? output.value : JSON.stringify(output?.value ?? "")}`;
  }
  return "";
}

function messageText(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map(partText).join("\n");
}

// The actual prompt payload sent for a turn, so the bench can report the real context size.
export function promptText(context: Context): string {
  return buildMessages(context).map(messageText).join("\n\n");
}

export async function propose(
  model: LanguageModel,
  context: Context,
  options: ToolsOptions = {},
): Promise<Proposals> {
  const allowedTools =
    context.applicable !== undefined ? toolNamesFor(context.applicable) : undefined;
  return invokeTools(model, buildMessages(context), {
    ...options,
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    toolDescriptions: toolDescriptionsFor(context.island),
  });
}

export function modelProposer(model: LanguageModel): Proposer {
  return (context) => propose(model, context);
}
