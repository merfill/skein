import { popUnit, recordOperation, sessionFocus, setPending } from "./session";
import type { SessionOperation, SessionState } from "./types";

// The SessionAgent's operations (docs/session_concepts.md §4.3): the doxa proposes one, logos
// checks the preconditions and applies it as a session event. No task journal is touched.
// The vocabulary is `respond` and `start`; resume/cancel strategies and `revise` are deferred.

const MAX_RESPOND_TEXT = 2000;
const MAX_START_TEXT = 4000;

export type OperationResult =
  | { ok: true; operation: SessionOperation }
  | { ok: false; reason: string };

export interface ApplyOperationInput {
  session: SessionState;
  operation: SessionOperation;
  turn: number;
  // The session unit that proposed the operation; the committed decision is recorded in the
  // session journal under this unit id.
  sourceUnit: string;
  // The model's hidden reasoning for the decision, recorded with the event and shown in L0.
  reasoning?: string;
}

function textProblem(text: string, max: number): string | undefined {
  if (text.trim() === "") return "empty text";
  if (text.length > max) return `text too long (max ${max})`;
  return undefined;
}

export function validateOperation(
  _session: SessionState,
  operation: SessionOperation,
): string | undefined {
  switch (operation.kind) {
    case "respond":
      return textProblem(operation.text, MAX_RESPOND_TEXT);
    case "start":
      return textProblem(operation.text, MAX_START_TEXT);
  }
}

export function applyOperation(input: ApplyOperationInput): OperationResult {
  const { session, operation, turn, sourceUnit, reasoning } = input;
  if (!session.units.has(sourceUnit)) {
    return { ok: false, reason: `unknown source unit: ${sourceUnit}` };
  }
  const invalid = validateOperation(session, operation);
  if (invalid !== undefined) return { ok: false, reason: invalid };

  switch (operation.kind) {
    case "respond":
      recordOperation(session, sourceUnit, turn, operation, reasoning);
      return { ok: true, operation };
    case "start": {
      // Starting a new task takes the focus: the previous unit is popped and becomes a trace,
      // still suspended/completed by its own journal. Nothing is written to its journal.
      const focus = sessionFocus(session);
      if (focus !== undefined) popUnit(session);
      setPending(session, operation.text);
      recordOperation(session, sourceUnit, turn, operation, reasoning);
      return { ok: true, operation };
    }
  }
}
