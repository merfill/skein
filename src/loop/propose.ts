import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";

import type { Context, TapeMessage } from "../ir/project";
import type { Proposals } from "../llm/schemas";
import { invokeTools, type ToolsOptions } from "../llm/structured";
import { toolNamesFor } from "../llm/tools";
import { BASE_PROMPT, NODE_INSTRUCTIONS } from "./prompt";

export type Proposer = (context: Context) => Promise<Proposals>;

export { BASE_PROMPT };

const messageText = (message: BaseMessage): string =>
  typeof message.content === "string" ? message.content : JSON.stringify(message.content);

// The tape renders the model's own history as a native tool-calling transcript: an assistant
// move is an `assistant.tool_calls` message, a command result is a `tool` message answering
// it. Only the request is a `user` turn — no result is ever smuggled in as a user message.
function toMessage(message: TapeMessage): BaseMessage {
  if (message.role === "assistant") {
    const calls =
      message.calls ?? (message.call !== undefined ? [message.call] : []);
    if (calls.length > 0) {
      return new AIMessage({
        content: message.text,
        tool_calls: calls.map((call) => ({ name: call.name, args: call.args, id: call.id, type: "tool_call" })),
      });
    }
    return new AIMessage(message.text);
  }
  if (message.role === "user") return new HumanMessage(message.text);
  // A `system` turn on the tape (e.g. a state's description, shown once when it is entered).
  if (message.role === "system") return new SystemMessage(message.text);
  // Every tool result answers an assistant tool_call; a tool turn without a callId would
  // desync the transcript, so it is an invariant violation, not a user turn.
  if (message.callId === undefined) {
    throw new Error(`tape tool message without a callId: ${message.text.slice(0, 80)}`);
  }
  return new ToolMessage({ content: message.text, tool_call_id: message.callId });
}

// The context the model sees is the tape, assembled as: the stable base prompt, the constraints,
// the tape itself, then — appended AT THE END — the instruction for the current situation. That
// instruction is temporary: it is not part of the history (it is re-derived from the situation
// each turn, it never accumulates). docs/ir_semantics §7.
export function buildMessages(context: Context): BaseMessage[] {
  const messages: BaseMessage[] = [new SystemMessage(BASE_PROMPT)];
  // A soft attractor on a stalled goal: the projection nudges the doxa to decide (§2.8).
  if (context.nudge !== undefined) {
    messages.push(new SystemMessage(context.nudge));
  }
  for (const constraint of context.constraints) {
    messages.push(
      new SystemMessage(
        `Constraint (${constraint.id}): never touch paths matching ${constraint.forbid.join(", ")}.`,
      ),
    );
  }
  for (const message of context.history) messages.push(toMessage(message));
  // The observation step: right after a tool result, tell the model to read it and decide.
  if (context.result !== undefined) messages.push(new SystemMessage(context.result));
  // The situation's instruction, appended last (temporary — never stored in the history).
  messages.push(new SystemMessage(NODE_INSTRUCTIONS[context.situation]));
  return messages;
}

// The actual prompt payload sent for a turn, so the bench can report the real context size.
export function promptText(context: Context): string {
  return buildMessages(context).map(messageText).join("\n\n");
}

export async function propose(
  model: BaseChatModel,
  context: Context,
  options: ToolsOptions = {},
): Promise<Proposals> {
  const allowedTools =
    context.applicable !== undefined ? toolNamesFor(context.applicable) : undefined;
  return invokeTools(model, buildMessages(context), {
    ...options,
    ...(allowedTools !== undefined ? { allowedTools } : {}),
  });
}

export function modelProposer(model: BaseChatModel): Proposer {
  return (context) => propose(model, context);
}
