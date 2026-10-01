import { forbiddenPatterns, matchesPath } from "../ir/constraints";
import type { Event } from "../ir/events";
import type { State } from "../ir/graph";
import { invalidatedClaimIds, type Turn } from "../ir/project";
import type { Edge, Node, Status, WitnessEntry } from "../ir/types";
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

function excerpt(text: string, ref: string, limit = OUTPUT_LIMIT): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit / 2);
  const tail = limit - head;
  const omitted = text.length - limit;
  return `${text.slice(0, head)}\n…[${omitted} chars omitted; full output: ${ref}]…\n${text.slice(-tail)}`;
}

const QUERY_LIMIT = 50;

function runQuery(state: State, action: Extract<Action, { tool: "query" }>): string {
  const statusOf = (id: string): Status | undefined =>
    state.statuses.get(id) ?? state.edgeStatuses.get(id);
  const invalidated = invalidatedClaimIds(state);
  const nodeRow = (node: Node) => ({
    id: node.id,
    kind: node.kind,
    label: node.label,
    status: statusOf(node.id),
    ...(node.payload !== undefined ? { payload: node.payload } : {}),
    ...(invalidated.has(node.id) ? { invalidated: true } : {}),
  });
  const edgeRow = (edge: Edge) => ({
    id: edge.id,
    kind: edge.kind,
    from: edge.from,
    to: edge.to,
    status: state.edgeStatuses.get(edge.id),
  });

  const nodes: ReturnType<typeof nodeRow>[] = [];
  const edges: ReturnType<typeof edgeRow>[] = [];

  if (action.verdictOf !== undefined) {
    const claimId = action.verdictOf;
    for (const edge of state.edges.values()) {
      if (edge.kind !== "verifies" || edge.to !== claimId) continue;
      edges.push(edgeRow(edge));
      const check = state.nodes.get(edge.from);
      if (check) nodes.push(nodeRow(check));
    }
  } else if (action.edgesOf !== undefined) {
    const target = action.edgesOf;
    for (const edge of state.edges.values()) {
      if (edge.from !== target && edge.to !== target) continue;
      if (action.edgeKind !== undefined && edge.kind !== action.edgeKind) continue;
      edges.push(edgeRow(edge));
    }
  } else if (action.id !== undefined) {
    const target = action.id;
    const node = state.nodes.get(target);
    if (node) nodes.push(nodeRow(node));
    for (const edge of state.edges.values()) {
      if (edge.from === target || edge.to === target) edges.push(edgeRow(edge));
    }
  } else if (action.kind !== undefined || action.status !== undefined) {
    for (const node of state.nodes.values()) {
      if (action.kind !== undefined && node.kind !== action.kind) continue;
      if (action.status !== undefined && statusOf(node.id) !== action.status) continue;
      if (action.status === "verified" && invalidated.has(node.id)) continue;
      nodes.push(nodeRow(node));
    }
  } else {
    return "(no selector: pass id, kind, status, edgesOf, or verdictOf)";
  }

  if (nodes.length === 0 && edges.length === 0) {
    return "(nothing matches)";
  }

  const payload: Record<string, unknown> = {};
  if (nodes.length > 0) payload.nodes = nodes.slice(0, QUERY_LIMIT);
  if (edges.length > 0) payload.edges = edges.slice(0, QUERY_LIMIT);
  return JSON.stringify(payload, null, 2);
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

function signatureMap(workspace: Workspace): Map<string, string> {
  const signatures = new Map<string, string>();
  for (const path of workspace.list()) {
    try {
      signatures.set(path, workspace.signature(path));
    } catch {
      // A build can delete a temporary file between listing and stat.
    }
  }
  return signatures;
}

function witnessOfWorkspace(workspace: Workspace): WitnessEntry[] {
  const witness: WitnessEntry[] = [];
  for (const path of workspace.list()) {
    try {
      witness.push({ ref: `file:${path}`, version: workspace.version(path) });
    } catch {
      // A build can delete a temporary file between listing and hashing.
    }
  }
  return witness;
}

function changedMutations(
  workspace: Workspace,
  before: Map<string, string>,
  after: Map<string, string>,
  excluded: ReadonlySet<string>,
): WitnessEntry[] {
  const changed = new Set<string>();
  for (const [path, signature] of after) {
    if (before.get(path) !== signature) changed.add(path);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changed.add(path);
  }
  for (const path of excluded) changed.delete(path);

  const mutations: WitnessEntry[] = [];
  for (const path of changed) {
    let version: string;
    try {
      version = workspace.version(path);
    } catch {
      version = "absent";
    }
    mutations.push({ ref: `file:${path}`, version });
  }
  return mutations;
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

  const recordMutations = (mutations: WitnessEntry[], command: string): void => {
    if (mutations.length === 0) return;
    const actionId = `act:${next()}`;
    events.push({
      type: "add_node",
      node: {
        id: actionId,
        space: "work",
        kind: "action",
        label: `run ${command}`,
        payload: { command, changed: mutations.map((entry) => entry.ref) },
        seq: next(),
      },
    });
    for (const entry of mutations) {
      events.push({ type: "mutate", ref: entry.ref, version: entry.version, actionId });
    }
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
      let version: string;
      let content: string;
      try {
        version = workspace.version(action.path);
        content = sliceLines(workspace.read(action.path), action.start, action.end);
      } catch {
        return {
          events,
          turn: proposalTurn(`read failed: ${action.path} disappeared`),
          done: false,
          stopReason: null,
        };
      }
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
      let original: string;
      try {
        original = workspace.read(action.path);
      } catch {
        return {
          events,
          turn: proposalTurn(`edit failed: ${action.path} disappeared`),
          done: false,
          stopReason: null,
        };
      }
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
      const readIfPresent = (path: string): string | undefined => {
        try {
          return workspace.read(path);
        } catch {
          return undefined;
        }
      };

      const guards = new Map<string, { pattern: string; content: string }>();
      for (const pattern of forbiddenPatterns(state)) {
        for (const path of workspace.list()) {
          if (guards.has(path) || !matchesPath(pattern, path)) continue;
          const content = readIfPresent(path);
          if (content !== undefined) guards.set(path, { pattern, content });
        }
      }

      const before = signatureMap(workspace);
      const result = workspace.run(action.command);

      const violated = [...guards.entries()].filter(([path, guard]) => {
        const content = readIfPresent(path);
        return content === undefined || content !== guard.content;
      });
      for (const [path, guard] of violated) workspace.write(path, guard.content);

      const after = signatureMap(workspace);
      const mutations = changedMutations(
        workspace,
        before,
        after,
        new Set(violated.map(([path]) => path)),
      );

      if (violated.length > 0) {
        const paths = violated.map(([path]) => path).join(", ");
        const first = violated[0];
        const pattern = first ? first[1].pattern : "constraint";
        const label = `constraint violation (${pattern}): reverted ${paths}`;
        events.push({
          type: "add_node",
          node: {
            id: `obs:${next()}`,
            space: "work",
            kind: "observation",
            label,
            payload: { pattern, paths: violated.map(([path]) => path), reverted: true },
            seq: next(),
          },
        });
        recordMutations(mutations, action.command);
        return { events, turn: proposalTurn(label), done: false, stopReason: null };
      }

      const verdict = result.code === 0 ? "pass" : "fail";
      const claims =
        action.claims && action.claims.length > 0 ? action.claims : openClaimIds(state);
      const truncated = result.output.length > OUTPUT_LIMIT;
      const outputRef = truncated ? `.skein/logs/run-${turn}.log` : undefined;
      if (outputRef !== undefined) workspace.write(outputRef, result.output);
      const output =
        outputRef !== undefined ? excerpt(result.output, outputRef) : result.output;
      const text = `$ ${action.command}\nexit ${result.code}\n${output}`;
      recordMutations(mutations, action.command);

      if (claims.length === 0) {
        events.push({
          type: "add_node",
          node: {
            id: `obs:${next()}`,
            space: "work",
            kind: "observation",
            label: `run ${action.command}`,
            payload: {
              command: action.command,
              verdict,
              output,
              ...(outputRef !== undefined ? { outputRef } : {}),
            },
            seq: next(),
          },
        });
        return { events, turn: proposalTurn(clip(text)), done: false, stopReason: null };
      }

      events.push({
        type: "record_check",
        command: action.command,
        verdict,
        output,
        ...(outputRef !== undefined ? { outputRef } : {}),
        actor: "arbiter",
        witness: witnessOfWorkspace(workspace),
        claimIds: claims,
      });
      return { events, turn: proposalTurn(clip(text)), done: false, stopReason: null };
    }

    case "decompose": {
      const id = `w:subgoal:${next()}`;
      events.push({
        type: "add_node",
        node: {
          id,
          space: "work",
          kind: "subgoal",
          label: action.label,
          seq: next(),
        },
      });
      events.push({
        type: "add_edge",
        edge: {
          id: `e:${next()}`,
          from: action.parent,
          to: id,
          kind: "decomposes",
          provenance: { kind: "llm" },
          status: "open",
        },
      });
      return {
        events,
        turn: proposalTurn(`decomposed: ${action.label}`),
        done: false,
        stopReason: null,
      };
    }

    case "decide": {
      const alternatives = [...new Set(action.alternatives ?? [])].filter(
        (alternative) => alternative !== action.label,
      );
      const chosenId = `w:decision:${next()}`;
      events.push({
        type: "add_node",
        node: {
          id: chosenId,
          space: "work",
          kind: "decision",
          label: action.label,
          payload: {
            options: [action.label, ...alternatives],
            chosen: action.label,
            rationale: action.rationale,
          },
          seq: next(),
        },
      });
      events.push({
        type: "add_edge",
        edge: {
          id: `e:${next()}`,
          from: chosenId,
          to: action.parent,
          kind: "justifies",
          provenance: { kind: "llm" },
          status: "open",
        },
      });
      const findDecision = (key: string): string | undefined => {
        for (const node of state.nodes.values()) {
          if (node.kind === "decision" && node.id === key) return node.id;
        }
        for (const node of state.nodes.values()) {
          if (node.kind === "decision" && node.label === key) return node.id;
        }
        return undefined;
      };
      const targets = new Set<string>();
      for (const alternative of alternatives) {
        let targetId = findDecision(alternative);
        if (targetId === undefined) {
          targetId = `w:decision:${next()}`;
          events.push({
            type: "add_node",
            node: {
              id: targetId,
              space: "work",
              kind: "decision",
              label: alternative,
              seq: next(),
            },
          });
        }
        if (targets.has(targetId)) continue;
        targets.add(targetId);
        events.push({
          type: "add_edge",
          edge: {
            id: `e:${next()}`,
            from: chosenId,
            to: targetId,
            kind: "chosen_over",
            provenance: { kind: "llm" },
            status: "open",
          },
        });
      }
      return {
        events,
        turn: proposalTurn(`decided: ${action.label}`),
        done: false,
        stopReason: null,
      };
    }

    case "track": {
      if (action.kind === "constraint") {
        const id = `w:constraint:${next()}`;
        events.push({
          type: "add_node",
          node: {
            id,
            space: "work",
            kind: "constraint",
            label: action.label,
            payload: { forbid: action.forbid ?? [] },
            seq: next(),
          },
        });
        return {
          events,
          turn: proposalTurn(`tracked constraint: ${action.label}`),
          done: false,
          stopReason: null,
        };
      }
      const id = `w:claim:${next()}`;
      events.push({
        type: "add_node",
        node: {
          id,
          space: "work",
          kind: "claim",
          label: action.label,
          payload: { rationale: action.rationale ?? "" },
          seq: next(),
        },
      });
      if (action.parent !== undefined) {
        events.push({
          type: "add_edge",
          edge: {
            id: `e:${next()}`,
            from: id,
            to: action.parent,
            kind: "supports",
            provenance: { kind: "llm" },
            status: "open",
          },
        });
      }
      return {
        events,
        turn: proposalTurn(`tracked claim: ${action.label}`),
        done: false,
        stopReason: null,
      };
    }

    case "query": {
      return {
        events,
        turn: proposalTurn(clip(runQuery(state, action))),
        done: false,
        stopReason: null,
      };
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
