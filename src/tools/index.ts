import type { Event } from "../ir/events";
import type { State } from "../ir/graph";
import type { Turn } from "../ir/project";
import type { Action } from "../llm/schemas";
import type { Workspace } from "./workspace";

export interface ExecOutcome {
  events: Event[];
  turn: Turn;
  done: boolean;
  stopReason: string | null;
}

const OUTPUT_LIMIT = 8000;

function clip(text: string, limit = OUTPUT_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`;
}

function sliceLines(text: string, start?: number, end?: number): string {
  if (start === undefined && end === undefined) return text;
  const lines = text.split("\n");
  const from = start !== undefined && start > 0 ? start - 1 : 0;
  const to = end !== undefined && end > 0 ? end : lines.length;
  return lines.slice(from, to).join("\n");
}

function openClaimIds(state: State): string[] {
  const ids: string[] = [];
  for (const node of state.nodes.values()) {
    if (node.kind === "claim" && state.statuses.get(node.id) === "open") {
      ids.push(node.id);
    }
  }
  return ids;
}

export function executeAction(
  action: Action,
  state: State,
  workspace: Workspace,
  turn: number,
): ExecOutcome {
  let counter = state.seq;
  const next = (): number => {
    counter += 1;
    return counter;
  };

  const events: Event[] = [];
  const proposalTurn = (text: string): Turn => ({ seq: turn, kind: "tool", text });

  const ensureFile = (path: string, ref: string): void => {
    if (state.nodes.has(ref)) return;
    events.push({
      type: "add_node",
      node: { id: ref, space: "artifact", kind: "file", label: path, seq: next() },
    });
  };

  switch (action.tool) {
    case "read": {
      if (!workspace.exists(action.path)) {
        return {
          events,
          turn: proposalTurn(`read failed: ${action.path} does not exist`),
          done: false,
          stopReason: null,
        };
      }
      const ref = `file:${action.path}`;
      const version = workspace.version(action.path);
      const content = sliceLines(workspace.read(action.path), action.start, action.end);
      ensureFile(action.path, ref);
      const observationId = `obs:${next()}`;
      events.push({
        type: "add_node",
        node: {
          id: observationId,
          space: "work",
          kind: "observation",
          label: `read ${action.path}`,
          payload: { ref, version, bytes: content.length },
          seq: next(),
        },
      });
      events.push({
        type: "add_edge",
        edge: {
          id: `e:${next()}`,
          from: ref,
          to: observationId,
          kind: "locates",
          provenance: { kind: "read", ref, version },
          status: "believed",
        },
      });
      return { events, turn: proposalTurn(clip(content)), done: false, stopReason: null };
    }

    case "grep": {
      const matches = workspace.grep(action.pattern);
      const observationId = `obs:${next()}`;
      events.push({
        type: "add_node",
        node: {
          id: observationId,
          space: "work",
          kind: "observation",
          label: `grep ${action.pattern}`,
          payload: { count: matches.length },
          seq: next(),
        },
      });
      const text = matches
        .map((match) => `${match.path}:${match.line}: ${match.text}`)
        .join("\n");
      return {
        events,
        turn: proposalTurn(clip(text || "(no matches)")),
        done: false,
        stopReason: null,
      };
    }

    case "edit": {
      const ref = `file:${action.path}`;
      if (!workspace.exists(action.path)) {
        return {
          events,
          turn: proposalTurn(`edit failed: ${action.path} does not exist`),
          done: false,
          stopReason: null,
        };
      }
      const original = workspace.read(action.path);
      if (!original.includes(action.find)) {
        return {
          events,
          turn: proposalTurn(`edit failed: pattern not found in ${action.path}`),
          done: false,
          stopReason: null,
        };
      }
      const updated = original.replace(action.find, action.replace);
      workspace.write(action.path, updated);
      const version = workspace.version(action.path);
      ensureFile(action.path, ref);
      const actionId = `act:${next()}`;
      events.push({
        type: "add_node",
        node: {
          id: actionId,
          space: "work",
          kind: "action",
          label: `edit ${action.path}`,
          payload: { path: action.path, find: action.find, replace: action.replace },
          seq: next(),
        },
      });
      events.push({ type: "mutate", ref, version, actionId });
      return {
        events,
        turn: proposalTurn(`edited ${action.path}`),
        done: false,
        stopReason: null,
      };
    }

    case "run": {
      const result = workspace.run(action.command);
      const verdict = result.code === 0 ? "pass" : "fail";
      const claims =
        action.claims && action.claims.length > 0 ? action.claims : openClaimIds(state);
      const observationId = `obs:${next()}`;
      events.push({
        type: "add_node",
        node: {
          id: observationId,
          space: "work",
          kind: "observation",
          label: `run ${action.command}`,
          payload: { code: result.code, verdict },
          seq: next(),
        },
      });
      events.push({
        type: "record_check",
        command: action.command,
        verdict,
        output: clip(result.output),
        claimIds: claims,
      });
      for (const claimId of claims) {
        events.push({
          type: "add_edge",
          edge: {
            id: `e:${next()}`,
            from: observationId,
            to: claimId,
            kind: "verifies",
            provenance: { kind: "check", command: action.command, verdict },
            status: "open",
          },
        });
      }
      const text = `$ ${action.command}\nexit ${result.code}\n${result.output}`;
      return { events, turn: proposalTurn(clip(text)), done: false, stopReason: null };
    }

    case "track": {
      const id = `w:${action.kind}:${next()}`;
      const payload =
        action.kind === "constraint"
          ? { forbid: action.forbid ?? [] }
          : { rationale: action.rationale ?? "" };
      events.push({
        type: "add_node",
        node: { id, space: "work", kind: action.kind, label: action.label, payload, seq: next() },
      });
      return {
        events,
        turn: proposalTurn(`tracked ${action.kind}: ${action.label}`),
        done: false,
        stopReason: null,
      };
    }

    case "query": {
      const matches = [...state.nodes.values()].filter(
        (node) => node.id === action.selector || node.kind === action.selector,
      );
      const text = matches.length
        ? JSON.stringify(matches, null, 2)
        : `(nothing matches ${action.selector})`;
      return { events, turn: proposalTurn(clip(text)), done: false, stopReason: null };
    }

    case "finish": {
      const actionId = `w:finish:${next()}`;
      events.push({
        type: "add_node",
        node: {
          id: actionId,
          space: "work",
          kind: "action",
          label: `finish: ${action.summary}`,
          payload: { summary: action.summary },
          seq: next(),
        },
      });
      return {
        events,
        turn: proposalTurn(action.summary),
        done: true,
        stopReason: "finish",
      };
    }
  }
}
