import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";

import type { Context, TapeMessage } from "../ir/project";
import type { Proposal } from "../llm/schemas";
import { invokeTools } from "../llm/structured";
import { BASE_PROMPT, NODE_INSTRUCTIONS } from "./prompt";

export type Proposer = (context: Context) => Promise<Proposal>;

export { BASE_PROMPT };

const messageText = (message: BaseMessage): string =>
  typeof message.content === "string" ? message.content : JSON.stringify(message.content);

function toMessage(message: TapeMessage): BaseMessage {
  if (message.role === "assistant") return new AIMessage(message.text);
  if (message.role === "user") return new HumanMessage(message.text);
  // The engine captures the tool result as a bounded body; render it as a role-tagged turn.
  return new HumanMessage(`OBSERVATION\n${message.text}`);
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
