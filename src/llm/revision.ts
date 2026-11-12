import type { LanguageModel, ModelMessage } from "ai";

import { invokeTools } from "./structured";
import type { Settings } from "../config/settings";
import type { Proposals } from "./schemas";

export type RevisionProposer = (
  messages: ModelMessage[],
  options?: { signal?: AbortSignal; final?: boolean },
) => Promise<Proposals>;

export interface RevisionModelOptions {
  settings?: Settings;
}

// The revision unit carries out a change a request already describes: it edits existing files
// and runs the commands the change needs (add a dependency, update the lock, install a package).
// The request is the goal; the unit closes on a text reply. Positive form only — the completion
// condition names the result, there is no prohibition list (docs/en/sessions.md).
export const REVISION_BASE_PROMPT = [
  "You carry out the change a request describes in a workspace.",
  "Read what the change touches, make the edits, and run the commands it needs: add the dependency, update the lock, install the package. Read the result back. When the workspace matches the request, reply with what changed as text only; your reply is the result and is shown to the user as-is. Reply in the language of the request. Write clearly and as concisely as the result allows: what changed and anything the user must act on; go into detail — files, steps, background — only when the request asks for it.",
].join("\n\n");

// The revision unit has the workspace tools the task registry already defines, including the
// side-effecting `bash`, so it can install packages and update lockfiles. It does not get the
// task protocol tools (`move`, `decline`): the unit is request-anchored and closes on text.
const REVISION_TOOLS: readonly string[] = [
  "read",
  "grep",
  "list",
  "edit",
  "write",
  "apply_patch",
  "bash",
  "webfetch",
  "recall",
  "search",
];

export function modelRevisionProposer(
  model: LanguageModel,
  options: RevisionModelOptions = {},
): RevisionProposer {
  return (messages, callOptions) =>
    invokeTools(model, messages, {
      ...(options.settings !== undefined ? { settings: options.settings } : {}),
      allowedTools: [...REVISION_TOOLS],
      allowText: true,
      ...(callOptions?.signal !== undefined ? { signal: callOptions.signal } : {}),
    });
}
