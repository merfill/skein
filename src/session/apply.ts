import type { Event } from "../ir/events";
import type { State } from "../ir/graph";
import type { Reaction } from "./types";

export type ApplyResult =
  | { ok: true; events: Event[] }
  | { ok: false; reason: string };

export interface ApplyInput {
  state: State;
  reaction: Reaction;
  sourceUnit: string;
}

const MAX_TEXT = 800;

function validate(input: ApplyInput): string | undefined {
  const { state, reaction } = input;
  if (reaction.kind === "halt") return "halt is not a task event";
  if (reaction.text.trim() === "") return "empty advisory text";
  if (reaction.text.length > MAX_TEXT) return "advisory text too long";
  if (reaction.evidence.length === 0) return "evidence is required";
  for (const id of reaction.evidence) {
    if (!state.nodes.has(id)) return `unknown evidence: ${id}`;
    const node = state.nodes.get(id);
    if (node?.kind === "hint" || node?.kind === "memo") {
      return `evidence must be task material: ${id}`;
    }
  }
  if (reaction.kind === "hint") {
    if (!state.nodes.has(reaction.state)) return `unknown state: ${reaction.state}`;
    if (state.nodes.get(reaction.state)?.kind !== "move") {
      return `hint state is not a move: ${reaction.state}`;
    }
  }
  return undefined;
}

export function applyReaction(input: ApplyInput): ApplyResult {
  const invalid = validate(input);
  if (invalid !== undefined) return { ok: false, reason: invalid };
  if (input.reaction.kind === "halt") return { ok: false, reason: "halt is not a task event" };

  const { state, reaction, sourceUnit } = input;
  const seq = state.seq + 1;
  const id = `w:${reaction.kind}:${seq}`;
  const payload =
    reaction.kind === "hint"
      ? {
          text: reaction.text,
          evidence: reaction.evidence,
          origin: "observer",
          sourceUnit,
          scope: "state",
          state: reaction.state,
        }
      : {
          text: reaction.text,
          evidence: reaction.evidence,
          origin: "observer",
          sourceUnit,
          scope: "unit",
        };

  return {
    ok: true,
    events: [
      {
        type: "add_node",
        node: {
          id,
          space: "work",
          kind: reaction.kind,
          label: reaction.text,
          payload,
          seq,
        },
      },
    ],
  };
}
