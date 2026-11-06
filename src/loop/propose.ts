import type { AssistantModelMessage, LanguageModel, ModelMessage, ToolModelMessage } from "ai";

import type { Context, TapeMessage } from "../ir/project";
import type { Proposals } from "../llm/schemas";
import { invokeTools, type ToolsOptions } from "../llm/structured";
import { toolDescriptionsFor, toolNamesFor } from "../llm/tools";
import {
  BASE_PROMPT,
  REQUEST_INSTRUCTION,
  transitionInstruction,
  workingInstruction,
} from "./prompt";

export type Proposer = (
  context: Context,
  options?: { signal?: AbortSignal },
) => Promise<Proposals>;

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
// message answering it. Only the request is a `user` turn — no result is ever smuggled in as a
// user message.
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

export function historyMessages(history: readonly TapeMessage[]): ModelMessage[] {
  const names = toolNames(history);
  return history.map((message) => toMessage(message, names));
}

// The context the model sees is the tape, assembled as: the stable base prompt, the constraints,
// the tape itself, then the situation's prompt. An open state carries only its `Start state`
// marker, brief and turns; buildMessages appends one `user` working prompt (goal, criterion,
// plan, request reference) after the turns. The base prompt is only the contract; the state
// map/moves live in the request/transition prompts (docs/ir_semantics §7).
export function buildMessages(context: Context): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: "system", content: BASE_PROMPT }];
  for (const constraint of context.constraints) {
    messages.push({
      role: "system",
      content: `Constraint (${constraint.id}): never touch paths matching ${constraint.forbid.join(", ")}.`,
    });
  }
  messages.push(...historyMessages(context.history));
  // The transition rule is a `system` turn: it is the engine's rule for choosing the next
  // state, not a user request. The tape already ends with the finished state's `Finish` line,
  // so the rule follows it as another system turn (docs/ir_semantics §7). The request's route
  // and an open state's working prompt are `user` turns: the choice/goal must be the last thing
  // the model reads, with the original request marked as reference, not the goal.
  if (context.situation === "request") {
    messages.push({ role: "user", content: REQUEST_INSTRUCTION });
  } else if (context.situation === "transition") {
    messages.push({ role: "system", content: transitionInstruction(context.island) });
  } else if (context.situation === "working" && context.island !== undefined) {
    const working = workingInstruction(context.island, context.what, context.done);
    if (working !== "") messages.push({ role: "user", content: working });
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
  // A text reply is the state's closure. It is accepted only where the engine can record it:
  // inside an open state or at End. At the request and at a transition the doxa must still
  // choose a state (`move`/`decline`), so a text reply gets the tool repair.
  const closesOnText = context.situation === "working" || context.situation === "terminal";
  return invokeTools(model, buildMessages(context), {
    ...options,
    allowText: options.allowText ?? closesOnText,
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    toolDescriptions: toolDescriptionsFor(context.island),
  });
}

export function modelProposer(model: LanguageModel, defaults: ToolsOptions = {}): Proposer {
  return (context, options = {}) =>
    propose(model, context, {
      ...defaults,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
}
