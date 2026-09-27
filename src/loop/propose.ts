import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

import type { Context } from "../ir/project";
import { proposalSchema, type Proposal } from "../llm/schemas";

export type Proposer = (context: Context) => Promise<Proposal>;

export const SYSTEM_PROMPT = `You are the proposing part of a coding agent. You never own truth: you propose exactly one action per turn, and a deterministic engine decides whether it is accepted.

The context is a projection of the agent's IR, not a conversation. It contains:
- header.goal: the user's objective;
- header.constraints: invariants you must not violate (their payload.forbid lists regexes of forbidden paths);
- frontier.claims: open beliefs you proposed; a claim is verified only by a passing check;
- frontier.decisions / frontier.recent: what is already settled and what just happened;
- artifacts: an index of known files (no contents).

Reply with a short "thought" (it is shown but not stored in the IR) and exactly one action:
- read { path }: read a file;
- grep { pattern }: search the workspace;
- edit { path, find, replace }: replace the first occurrence of find with replace;
- run { command, claims? }: run a shell command in the workspace; a command with exit code 0 is a passing check and verifies the listed claims (default: all open claims);
- track { kind, label, rationale?, forbid? }: propose a claim, decision, or constraint;
- query { selector }: look up a node id or node kind in the IR;
- finish { summary }: stop and hand the result to the witness.

Do not change files that constraints forbid — neither with edit nor through a run command. Do not claim a fix before a check confirms it.`;

export function renderContext(context: Context): string {
  return JSON.stringify(context, null, 2);
}

export function buildMessages(context: Context): [SystemMessage, HumanMessage] {
  return [new SystemMessage(SYSTEM_PROMPT), new HumanMessage(renderContext(context))];
}

export async function propose(model: BaseChatModel, context: Context): Promise<Proposal> {
  const structured = model.withStructuredOutput(proposalSchema);
  const result = await structured.invoke(buildMessages(context));
  return proposalSchema.parse(result);
}

export function modelProposer(model: BaseChatModel): Proposer {
  return (context) => propose(model, context);
}
