import { REVISION_BASE_PROMPT } from "../llm/revision";
import { runGeneralAgent, type GeneralDeps, type GeneralInput, type GeneralResult } from "./general";

// The revision unit carries out a change a request describes: it edits existing files and runs
// the commands the change needs. It is request-anchored like `general`/`document` — one goal,
// no `move` — and reuses the general runner with its own prompt, tool surface and label. It is
// mutable by design: unlike `general`, there is no read-only snapshot or restore.

export type RevisionDeps = GeneralDeps;
export type RevisionResult = GeneralResult;

export type RevisionInput = Omit<
  GeneralInput,
  "unitType" | "agent" | "basePrompt" | "stateLabel" | "finalInstruction"
>;

export const REVISION_STATE = "revision";

const REVISION_FINAL_INSTRUCTION =
  "The turn limit is reached. Report what changed as text from what you have already done. Use only that material: do not invent results, paths or numbers. Do not inspect anything else; the engine records your text as the answer.";

export function runRevisionUnit(
  deps: GeneralDeps,
  input: RevisionInput,
): Promise<GeneralResult> {
  return runGeneralAgent(deps, {
    ...input,
    unitType: "revision",
    agent: "revision",
    basePrompt: REVISION_BASE_PROMPT,
    stateLabel: REVISION_STATE,
    finalInstruction: REVISION_FINAL_INSTRUCTION,
  });
}
