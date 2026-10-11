import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";

import type { Context, TapeMessage } from "../ir/project";
import type { Proposal } from "../llm/schemas";
import { invokeTools } from "../llm/structured";
import { BASE_PROMPT, NODE_INSTRUCTIONS } from "./prompt";

export type Proposer = (context: Context) => Promise<Proposal>;

export { BASE_PROMPT };

const messageText = (message: BaseMessage): string =>
  typeof message.content === "string" ? message.content : JSON.stringify(message.content);

// The tape renders the model's own history as a native tool-calling transcript: an assistant
// move is an `assistant.tool_calls` message, a command result is a `tool` message answering
// it. Only the request is a `user` turn — no result is ever smuggled in as a user message.
function toMessage(message: TapeMessage): BaseMessage {
  if (message.role === "assistant") {
    if (message.call !== undefined) {
      return new AIMessage({
        content: message.text,
        tool_calls: [
          { name: message.call.name, args: message.call.args, id: message.call.id, type: "tool_call" },
        ],
      });
    }
    return new AIMessage(message.text);
  }
  if (message.role === "user") return new HumanMessage(message.text);
  // Every tool result answers an assistant tool_call; a tool turn without a callId would
  // desync the transcript, so it is an invariant violation, not a user turn.
  if (message.callId === undefined) {
    throw new Error(`tape tool message without a callId: ${message.text.slice(0, 80)}`);
  }
  return new ToolMessage({ content: message.text, tool_call_id: message.callId });
}

// The context the model sees is the tape, assembled from the node-scoped instruction and the
// history: a stable base prompt, the instruction for the current situation, the constraints,
// then the tape itself (docs/ir_revision.md §5–6).
export function buildMessages(context: Context): BaseMessage[] {
  const messages: BaseMessage[] = [
    new SystemMessage(BASE_PROMPT),
    new SystemMessage(NODE_INSTRUCTIONS[context.situation]),
  ];
  for (const constraint of context.constraints) {
    messages.push(
      new SystemMessage(
        `Constraint (${constraint.id}): never touch paths matching ${constraint.forbid.join(", ")}.`,
      ),
    );
  }
  for (const message of context.history) messages.push(toMessage(message));
  return messages;
}

// The actual prompt payload sent for a turn, so the bench can report the real context size.
export function promptText(context: Context): string {
  return buildMessages(context).map(messageText).join("\n\n");
}

export async function propose(model: BaseChatModel, context: Context): Promise<Proposal> {
  return invokeTools(model, buildMessages(context));
}

export function modelProposer(model: BaseChatModel): Proposer {
  return (context) => propose(model, context);
}
