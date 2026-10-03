import { forbiddenPatterns, matchesPath } from "../ir/constraints";
import type { Event } from "../ir/events";
import {
  alternativesOf,
  childrenOf,
  currentVersion,
  planOf,
  predicateOf,
  type State,
} from "../ir/graph";
import { currentGoalId, firstUnfulfilledItem, goalPayload } from "../ir/traversal";
import type { EdgeKind, GoalPayload, Node, Provenance, WitnessEntry } from "../ir/types";
import type { Action, Apply, GoalItem, PlanItem } from "../llm/schemas";
import type { GrepMatch, Workspace } from "./workspace";

export interface ExecOutcome {
  events: Event[];
  turn: { seq: number; kind: "proposal" | "tool"; text: string };
  done: boolean;
  stopReason: string | null;
}

const OUTPUT_LIMIT = 8000;
const MAX_READ_LINES = 400;
const MAX_GREP_MATCHES = 200;
const GREP_BEFORE_DEFAULT = 5;
const GREP_AFTER_DEFAULT = 5;
// A result body is kept in the node when small, otherwise in a temp file referenced by
// the node (docs/context_design_ru.md §8).
const MAX_INLINE_RESULT = 2000;

function clip(text: string, limit = OUTPUT_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`;
}

// A read window is capped at MAX_READ_LINES; the tool reports the window it
// returned so the model knows where to continue.
function readWindow(
  content: string,
  start: number | undefined,
  end: number | undefined,
): { text: string; start: number; end: number; total: number } {
  const lines = content.split("\n");
  const total = lines.length;
  if (total === 0) return { text: "", start: 0, end: 0, total: 0 };
  const from = start !== undefined && start > 0 ? start : 1;
  const requestedEnd = end !== undefined && end > 0 ? end : total;
  let to = Math.min(requestedEnd, total);
  if (to < from) to = from;
  if (to - from + 1 > MAX_READ_LINES) to = from + MAX_READ_LINES - 1;
  return { text: lines.slice(from - 1, to).join("\n"), start: from, end: to, total };
}

function excerpt(text: string, ref: string, limit = OUTPUT_LIMIT): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit / 2);
  const tail = limit - head;
  const omitted = text.length - limit;
  return `${text.slice(0, head)}\n…[${omitted} chars omitted; full output: ${ref}]…\n${text.slice(-tail)}`;
}

const QUERY_LIMIT = 50;

function runQuery(state: State, action: Extract<Action, { operator: "query" }>): string {
  const nodeRow = (node: Node) => ({
    id: node.id,
    kind: node.kind,
    label: node.label,
    predicate: predicateOf(state, node.id),
    ...(node.payload !== undefined ? { payload: node.payload } : {}),
  });
  const nodes: ReturnType<typeof nodeRow>[] = [];
  const edges: { id: string; kind: string; from: string; to: string }[] = [];

  if (action.edgesOf !== undefined) {
    for (const edge of state.edges.values()) {
      if (edge.from !== action.edgesOf && edge.to !== action.edgesOf) continue;
      edges.push({ id: edge.id, kind: edge.kind, from: edge.from, to: edge.to });
    }
  } else if (action.id !== undefined) {
    const node = state.nodes.get(action.id);
    if (node) nodes.push(nodeRow(node));
    for (const edge of state.edges.values()) {
      if (edge.from === action.id || edge.to === action.id) {
        edges.push({ id: edge.id, kind: edge.kind, from: edge.from, to: edge.to });
      }
    }
  } else if (action.kind !== undefined || action.predicate !== undefined) {
    for (const node of state.nodes.values()) {
      if (action.kind !== undefined && node.kind !== action.kind) continue;
      if (action.predicate !== undefined && predicateOf(state, node.id) !== action.predicate) {
        continue;
      }
      nodes.push(nodeRow(node));
    }
  } else {
    return "(no selector: pass id, kind, predicate, or edgesOf)";
  }

  if (nodes.length === 0 && edges.length === 0) return "(nothing matches)";

  const payload: Record<string, unknown> = {};
  if (nodes.length > 0) payload.nodes = nodes.slice(0, QUERY_LIMIT);
  if (edges.length > 0) payload.edges = edges.slice(0, QUERY_LIMIT);
  return JSON.stringify(payload, null, 2);
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

function descendTo(state: State, parent: string, node: string): Event[] {
  const stack = state.branch.length > 0 ? state.branch : state.rootId ? [state.rootId] : [];
  const index = stack.lastIndexOf(parent);
  const events: Event[] = [];
  for (let i = stack.length - 1; i > index; i--) events.push({ type: "return" });
  events.push({ type: "descend", node });
  return events;
}

export function commandOf(apply: Apply): string {
  switch (apply.tool) {
    case "read":
      // The range is part of the command: reading different windows of a file is a
      // different action, not a repeat (§2.7).
      return apply.start === undefined && apply.end === undefined
        ? `read ${apply.path}`
        : `read ${apply.path} [${apply.start ?? ""}-${apply.end ?? ""}]`;
    case "grep": {
      const before = apply.before ?? GREP_BEFORE_DEFAULT;
      const after = apply.after ?? GREP_AFTER_DEFAULT;
      return `grep ${apply.pattern} ${before}/${after}`;
    }
    case "edit":
      return `edit ${apply.path}`;
    case "run":
      return apply.command;
  }
}

// Render grep matches with context lines, merging overlapping windows, and report
// truncation when more than MAX_GREP_MATCHES matched.
function renderGrep(
  matches: GrepMatch[],
  reader: (path: string) => string | undefined,
  before: number,
  after: number,
): string {
  const out: string[] = [];
  if (matches.length > MAX_GREP_MATCHES) {
    out.push(`…[showing ${MAX_GREP_MATCHES} of ${matches.length} matches; narrow the pattern]`);
  }
  const byFile = new Map<string, number[]>();
  for (const match of matches.slice(0, MAX_GREP_MATCHES)) {
    const lines = byFile.get(match.path) ?? [];
    lines.push(match.line);
    byFile.set(match.path, lines);
  }
  for (const [path, lineNumbers] of byFile) {
    const content = reader(path);
    if (content === undefined) {
      out.push(`${path}: (unreadable)`);
      continue;
    }
    const lines = content.split("\n");
    const sorted = [...new Set(lineNumbers)].sort((a, b) => a - b);
    const windows: { from: number; to: number }[] = [];
    for (const line of sorted) {
      const from = Math.max(1, line - before);
      const to = Math.min(lines.length, line + after);
      const last = windows[windows.length - 1];
      if (last !== undefined && from <= last.to + 1) last.to = Math.max(last.to, to);
      else windows.push({ from, to });
    }
    for (const window of windows) {
      for (let i = window.from; i <= window.to; i += 1) {
        out.push(`${path}:${i}: ${lines[i - 1] ?? ""}`);
      }
      out.push("--");
    }
  }
  return out.join("\n");
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
  const proposalTurn = (text: string): ExecOutcome["turn"] => ({ seq: turn, kind: "tool", text });
  const fail = (text: string): ExecOutcome => {
    // A failure is knowledge too: materialize it as an observation with
    // verdict=fail so it enters the negative history (§2.8) and is never shadowed
    // by an accepted-looking turn.
    const seq = next();
    events.push({
      type: "add_node",
      node: {
        id: `obs:${seq}`,
        space: "work",
        kind: "observation",
        label: text,
        payload: { verdict: "fail", output: text },
        seq,
      },
    });
    return { events, turn: proposalTurn(text), done: false, stopReason: null };
  };

  const ensureFile = (path: string, ref: string): void => {
    if (state.nodes.has(ref)) return;
    events.push({
      type: "add_node",
      node: { id: ref, space: "artifact", kind: "file", label: path, seq: next() },
    });
  };

  // Keep a result body: small ones inline in the node, large ones in a temp file
  // referenced by the node, so the model can recall it by id (§8).
  const storeOutput = (id: string, text: string): { output?: string; outputRef?: string } => {
    if (text.length <= MAX_INLINE_RESULT) return { output: text };
    const ref = `.skein/observations/${id}.txt`;
    workspace.write(ref, text);
    return { outputRef: ref };
  };

  const ensurePlan = (goalId: string): string => {
    const existing = planOf(state, goalId);
    if (existing !== undefined) return existing;
    const planId = `w:plan:${next()}`;
    events.push({
      type: "add_node",
      node: { id: planId, space: "work", kind: "plan", label: `plan for ${goalId}`, seq: next() },
    });
    events.push({
      type: "add_edge",
      edge: {
        id: `e:${next()}`,
        from: goalId,
        to: planId,
        kind: "has_plan",
        provenance: { kind: "llm" },
      },
    });
    return planId;
  };

  const ensureAlternatives = (owner: string): string => {
    const existing = alternativesOf(state, owner);
    if (existing !== undefined) return existing;
    const altId = `w:alt:${next()}`;
    events.push({
      type: "add_node",
      node: {
        id: altId,
        space: "work",
        kind: "alternatives",
        label: `alternatives for ${owner}`,
        seq: next(),
      },
    });
    addEdge({ kind: "llm" }, owner, altId, "has_alternatives");
    return altId;
  };

  // The container a variant of `goalId` belongs to: the alternatives container it
  // is already an item of, else the goal's own alternatives container.
  const variantContainer = (goalId: string): string => {
    for (const [containerId, ids] of state.children) {
      if (!ids.includes(goalId)) continue;
      const container = state.nodes.get(containerId);
      if (container?.kind === "alternatives") return containerId;
    }
    return ensureAlternatives(goalId);
  };

  const buildGoal = (item: GoalItem): string => {
    const id = `w:goal:${next()}`;
    events.push({
      type: "add_node",
      node: {
        id,
        space: "work",
        kind: "goal",
        label: item.what,
        payload: { what: item.what, why: item.why, done_when: item.done_when },
        seq: next(),
      },
    });
    if (item.plan !== undefined && item.plan.length > 0) {
      const planId = ensurePlan(id);
      for (const child of item.plan) {
        const childId = child.kind === "goal" ? buildGoal(child) : buildActionItem(child.command, child.label);
        events.push({
          type: "add_edge",
          edge: {
            id: `e:${next()}`,
            from: planId,
            to: childId,
            kind: "item",
            provenance: { kind: "llm" },
          },
        });
      }
    }
    return id;
  };

  const buildActionItem = (command: string, label?: string, extra?: Record<string, unknown>): string => {
    const id = `w:action:${next()}`;
    events.push({
      type: "add_node",
      node: {
        id,
        space: "work",
        kind: "action",
        label: label ?? command,
        payload: { command, ...(extra ?? {}) },
        seq: next(),
      },
    });
    return id;
  };

  // Reuse an unexecuted action item of the current goal whose command matches.
  // Otherwise the logos branches the current unfulfilled item: the executed action
  // becomes its chosen alternative (append-only), so a bypassed planned command never
  // traps the plan (docs/context_design_ru.md).
  const ensureAction = (
    command: string,
    label: string,
    extra?: Record<string, unknown>,
  ): string => {
    const goalId = currentGoalId(state);
    if (goalId !== undefined) {
      const plan = planOf(state, goalId);
      if (plan !== undefined) {
        for (const itemId of childrenOf(state, plan)) {
          const node = state.nodes.get(itemId);
          if (node?.kind !== "action") continue;
          if (predicateOf(state, itemId) === "executed") continue;
          const itemCommand = (node.payload as { command?: unknown } | undefined)?.command;
          if (itemCommand === command) return itemId;
        }
      }
    }
    const id = buildActionItem(command, label, extra);
    if (goalId !== undefined) {
      const first = firstUnfulfilledItem(state, goalId);
      const firstNode = first !== undefined ? state.nodes.get(first) : undefined;
      if (first !== undefined && firstNode?.kind === "action") {
        const alt = ensureAlternatives(first);
        addEdge({ kind: "llm" }, alt, id, "item");
        addEdge({ kind: "llm" }, alt, id, "chosen");
        return id;
      }
      const plan = ensurePlan(goalId);
      events.push({
        type: "add_edge",
        edge: { id: `e:${next()}`, from: plan, to: id, kind: "item", provenance: { kind: "llm" } },
      });
    }
    return id;
  };

  const addEdge = (provenance: Provenance, from: string, to: string, kind: EdgeKind): void => {
    events.push({
      type: "add_edge",
      edge: { id: `e:${next()}`, from, to, kind, provenance },
    });
  };

  switch (action.operator) {
    case "query": {
      return { events, turn: proposalTurn(clip(runQuery(state, action))), done: false, stopReason: null };
    }

    case "create_goal": {
      const current = currentGoalId(state);
      if (current === undefined) return fail("create goal failed: no current goal");
      const currentNode = state.nodes.get(current);
      const id = buildGoal({
        kind: "goal",
        what: action.what,
        ...(action.why !== undefined ? { why: action.why } : {}),
        done_when: action.done_when,
        ...(action.plan !== undefined ? { plan: action.plan } : {}),
      });
      if (currentNode?.kind === "request") {
        const alt = ensureAlternatives(current);
        addEdge({ kind: "llm" }, alt, id, "item");
        addEdge({ kind: "llm" }, alt, id, "chosen");
      } else if (predicateOf(state, current) === "refuted") {
        const container = variantContainer(current);
        addEdge({ kind: "llm" }, container, id, "item");
        addEdge({ kind: "llm" }, container, id, "chosen");
      } else {
        const plan = ensurePlan(current);
        addEdge({ kind: "llm" }, plan, id, "item");
      }
      events.push(...descendTo(state, current, id));
      return {
        events,
        turn: proposalTurn(`created goal: ${action.what}`),
        done: false,
        stopReason: null,
      };
    }

    case "complete": {
      const goalId = action.goal ?? currentGoalId(state);
      if (goalId === undefined) return fail("complete failed: no goal");
      const goal = state.nodes.get(goalId);
      if (goal === undefined || goal.kind !== "goal") return fail(`complete failed: no goal ${goalId}`);
      const id = `w:complete:${next()}`;
      events.push({
        type: "add_node",
        node: {
          id,
          space: "work",
          kind: "complete",
          label: `complete ${goalId}`,
          payload: action.note !== undefined ? { note: action.note } : {},
          seq: next(),
        },
      });
      addEdge({ kind: "llm" }, id, goalId, "closes");
      if (action.under !== undefined) {
        for (const assumption of action.under) addEdge({ kind: "llm" }, id, assumption, "under");
      }
      return {
        events,
        turn: proposalTurn(`completed: ${goalId}`),
        done: false,
        stopReason: null,
      };
    }

    case "apply": {
      const apply = action.action;
      const current = currentGoalId(state);

      if (apply.tool === "read") {
        if (!workspace.exists(apply.path)) return fail(`read failed: ${apply.path} does not exist`);
        const ref = `file:${apply.path}`;
        let version: string;
        let raw: string;
        try {
          version = workspace.version(apply.path);
          raw = workspace.read(apply.path);
        } catch {
          return fail(`read failed: ${apply.path} disappeared`);
        }
        const window = readWindow(raw, apply.start, apply.end);
        ensureFile(apply.path, ref);
        const command = commandOf(apply);
        const actionId = ensureAction(command, command);
        const observationId = `obs:${next()}`;
        // The window is shown in full (bounded by MAX_READ_LINES); if the file is
        // longer, say where to continue.
        const trailer =
          window.total > 0 && window.end < window.total
            ? `\n…[lines ${window.start}–${window.end} of ${window.total}; continue from ${window.end + 1}]`
            : "";
        const shown = `${window.text}${trailer}`;
        events.push({
          type: "add_node",
          node: {
            id: observationId,
            space: "work",
            kind: "observation",
            label: command,
            payload: {
              ref,
              version,
              bytes: window.text.length,
              start: window.start,
              end: window.end,
              total: window.total,
              ...storeOutput(observationId, shown),
            },
            seq: next(),
          },
        });
        addEdge({ kind: "read", ref, version }, actionId, observationId, "produces");
        return { events, turn: proposalTurn(shown), done: false, stopReason: null };
      }

      if (apply.tool === "grep") {
        const matches = workspace.grep(apply.pattern);
        const command = commandOf(apply);
        const actionId = ensureAction(command, command);
        const before = apply.before ?? GREP_BEFORE_DEFAULT;
        const after = apply.after ?? GREP_AFTER_DEFAULT;
        const reader = (path: string): string | undefined => {
          try {
            return workspace.read(path);
          } catch {
            return undefined;
          }
        };
        const rendered =
          matches.length === 0 ? "(no matches)" : renderGrep(matches, reader, before, after);
        const shown = clip(rendered);
        const observationId = `obs:${next()}`;
        events.push({
          type: "add_node",
          node: {
            id: observationId,
            space: "work",
            kind: "observation",
            label: command,
            payload: {
              count: matches.length,
              pattern: apply.pattern,
              before,
              after,
              ...storeOutput(observationId, shown),
            },
            seq: next(),
          },
        });
        addEdge({ kind: "grep", pattern: apply.pattern }, actionId, observationId, "produces");
        return { events, turn: proposalTurn(shown), done: false, stopReason: null };
      }

      if (apply.tool === "edit") {
        const ref = `file:${apply.path}`;
        if (!workspace.exists(apply.path)) return fail(`edit failed: ${apply.path} does not exist`);
        let original: string;
        try {
          original = workspace.read(apply.path);
        } catch {
          return fail(`edit failed: ${apply.path} disappeared`);
        }
        if (!original.includes(apply.find)) {
          return fail(`edit failed: pattern not found in ${apply.path}`);
        }
        const updated = original.replace(apply.find, apply.replace);
        workspace.write(apply.path, updated);
        const version = workspace.version(apply.path);
        ensureFile(apply.path, ref);
        const command = commandOf(apply);
        const actionId = ensureAction(command, command);
        addEdge({ kind: "llm" }, actionId, ref, "mutates");
        events.push({ type: "mutate", ref, version, actionId });
        return { events, turn: proposalTurn(`edited ${apply.path}`), done: false, stopReason: null };
      }

      // apply.tool === "run"
      let target = apply.target;
      if (target === undefined && current !== undefined) {
        const payload = goalPayload(state, current);
        if (
          payload?.done_when.kind === "objective" &&
          payload.done_when.command === apply.command
        ) {
          target = current;
        }
      }
      const targetNode = target !== undefined ? state.nodes.get(target) : undefined;
      if (target !== undefined && (targetNode === undefined || targetNode.kind !== "goal")) {
        return fail(`check failed: no goal ${target}`);
      }
      // An objective goal is checked by its own done_when command from the IR; the
      // doxa only initiates the check and cannot substitute the command.
      let runCommand = apply.command;
      if (target !== undefined && targetNode?.kind === "goal") {
        const payload = targetNode.payload as GoalPayload | undefined;
        if (payload?.done_when.kind !== "objective") {
          return fail(`check failed: goal ${target} is subjective; use complete`);
        }
        runCommand = payload.done_when.command;
      }

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
      const result = workspace.run(runCommand);
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

      const command = runCommand;
      const actionId = ensureAction(command, command, {
        signature: `${runCommand}\u0000${target ?? ""}`,
        ...(target !== undefined ? { target } : {}),
      });
      for (const entry of mutations) {
        const path = entry.ref.slice("file:".length);
        ensureFile(path, entry.ref);
        addEdge({ kind: "llm" }, actionId, entry.ref, "mutates");
        events.push({ type: "mutate", ref: entry.ref, version: entry.version, actionId });
      }

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
        return { events, turn: proposalTurn(label), done: false, stopReason: null };
      }

      const verdict =
        result.timedOut === true ? "inconclusive" : result.code === 0 ? "pass" : "fail";
      const truncated = result.output.length > OUTPUT_LIMIT;
      const outputRef = truncated ? `.skein/logs/run-${turn}.log` : undefined;
      if (outputRef !== undefined) workspace.write(outputRef, result.output);
      const output = outputRef !== undefined ? excerpt(result.output, outputRef) : result.output;
      const text = `$ ${runCommand}\nexit ${result.code}\n${output}`;

      if (target !== undefined && targetNode?.kind === "goal") {
        const checkId = `chk:${next()}`;
        events.push({
          type: "record_check",
          id: checkId,
          command: runCommand,
          verdict,
          output,
          ...(outputRef !== undefined ? { outputRef } : {}),
          actor: "arbiter",
          witness: witnessOfWorkspace(workspace),
          targets: [target],
          ...(apply.under !== undefined ? { under: apply.under } : {}),
        });
        addEdge(
          {
            kind: "check",
            command: runCommand,
            verdict,
            ...(outputRef !== undefined ? { outputRef } : {}),
          },
          actionId,
          checkId,
          "produces",
        );
        return { events, turn: proposalTurn(clip(text)), done: false, stopReason: null };
      }

      const observationId = `obs:${next()}`;
      events.push({
        type: "add_node",
        node: {
          id: observationId,
          space: "work",
          kind: "observation",
          label: command,
          payload: {
            command: runCommand,
            verdict,
            output,
            ...(outputRef !== undefined ? { outputRef } : {}),
          },
          seq: next(),
        },
      });
      addEdge(
        {
          kind: "check",
          command: runCommand,
          verdict,
          ...(outputRef !== undefined ? { outputRef } : {}),
        },
        actionId,
        observationId,
        "produces",
      );
      return { events, turn: proposalTurn(clip(text)), done: false, stopReason: null };
    }
  }
}
