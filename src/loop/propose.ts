import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";

import type { Context, ResultView } from "../ir/project";
import type { Proposal } from "../llm/schemas";
import { invokeTools } from "../llm/structured";
import { SYSTEM_PROMPT } from "./prompt";

export type Proposer = (context: Context) => Promise<Proposal>;

export { SYSTEM_PROMPT };

export function renderContext(context: Context): string {
  return JSON.stringify(context, null, 2);
}

// The two context packagings under A/B (docs/plans/step_reduction_plan_ru.md §4):
// - json: one message with the whole projection (the original).
// - transcript: the projection laid out as a role-tagged history, so a turn appends to a
//   stable prefix instead of re-serializing one changing blob.
export type ContextFormat = "json" | "transcript";

export function contextFormat(): ContextFormat {
  return process.env.SKEIN_CONTEXT_FORMAT === "transcript" ? "transcript" : "json";
}

const messageText = (message: BaseMessage): string =>
  typeof message.content === "string" ? message.content : JSON.stringify(message.content);

// The immutable per-run brief: the raw request plus the invariants. A role message, so it
// sits in the cacheable prefix and never changes.
function brief(context: Context): string {
  const request = context.path.find((node) => node.kind === "request");
  return JSON.stringify(
    { request: request?.text ?? "", constraints: context.constraints },
    null,
    2,
  );
}

// The result of one step: the body when it is in view (the working set / latest result),
// else the outcome note with the id, so a long body stays retrievable with `query`.
function stepResult(view: ResultView | undefined, call: Context["calls"][number]): string {
  const parts: string[] = [];
  if (view?.output !== undefined && view.output !== "") parts.push(view.output);
  if (view?.error !== undefined && view.error !== "") parts.push(`[stderr]\n${view.error}`);
  if (parts.length > 0) return parts.join("\n");
  const note = call.note !== undefined && call.note !== "" ? ` — ${call.note}` : "";
  const id = call.id !== undefined ? ` [id ${call.id}]` : "";
  return `${call.status}${note}${id}`;
}

// The volatile tail: everything not narrated as history (the branch with its plan and
// alternative markers, the call index for ids/counts, the frontier and the budget).
function board(context: Context): string {
  return JSON.stringify(
    {
      path: context.path,
      constraints: context.constraints,
      calls: context.calls,
      applicable: context.applicable,
      checkReady: context.checkReady,
      ...(context.nextAction !== undefined ? { nextAction: context.nextAction } : {}),
      budget: context.budget,
    },
    null,
    2,
  );
}

// Render the projection as a role-tagged history. History is the current branch's call
// index (already scoped to the chosen interpretation, so a failed alternative's steps are
// not expanded — only its marker in `path` shows). The request/constraints lead and the
// volatile board trails, so a new step appends after a stable prefix.
export function renderTranscript(context: Context): BaseMessage[] {
  const bodies = new Map<string, ResultView>();
  for (const view of context.shown) {
    if (view.id !== undefined) bodies.set(view.id, view);
  }
  if (context.lastResult?.id !== undefined) bodies.set(context.lastResult.id, context.lastResult);

  const messages: BaseMessage[] = [
    new SystemMessage(SYSTEM_PROMPT),
    new HumanMessage(`BRIEF\n${brief(context)}`),
  ];
  // `calls` is newest-first; the transcript reads oldest-first (chronological).
  for (const call of [...context.calls].reverse()) {
    const view = call.id !== undefined ? bodies.get(call.id) : undefined;
    messages.push(new AIMessage(`CALL ${call.action}`));
    messages.push(new HumanMessage(`RESULT ${stepResult(view, call)}`));
  }
  messages.push(new HumanMessage(`BOARD\n${board(context)}`));
  return messages;
}

export function buildMessages(context: Context): BaseMessage[] {
  return contextFormat() === "transcript"
    ? renderTranscript(context)
    : [new SystemMessage(SYSTEM_PROMPT), new HumanMessage(renderContext(context))];
}

// The actual prompt payload sent for a turn (both packagings), so the bench can report the
// real context size rather than the JSON projection size.
export function promptText(context: Context): string {
  return buildMessages(context).map(messageText).join("\n\n");
}

export async function propose(model: BaseChatModel, context: Context): Promise<Proposal> {
  return invokeTools(model, buildMessages(context));
}

export function modelProposer(model: BaseChatModel): Proposer {
  return (context) => propose(model, context);
}
