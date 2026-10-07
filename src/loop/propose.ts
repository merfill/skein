import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

import type { Context } from "../ir/project";
import type { Proposal } from "../llm/schemas";
import { invokeTools } from "../llm/structured";
import { SYSTEM_PROMPT } from "./prompt";

export type Proposer = (context: Context) => Promise<Proposal>;

export { SYSTEM_PROMPT };

export function renderContext(context: Context): string {
  return JSON.stringify(context, null, 2);
}

export function buildMessages(context: Context): [SystemMessage, HumanMessage] {
  return [new SystemMessage(SYSTEM_PROMPT), new HumanMessage(renderContext(context))];
}

export async function propose(model: BaseChatModel, context: Context): Promise<Proposal> {
  return invokeTools(model, buildMessages(context));
}

export function modelProposer(model: BaseChatModel): Proposer {
  return (context) => propose(model, context);
}
