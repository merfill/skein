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
  turn: { seq: number; kind: "proposal" | "tool"; text: string; nodeId?: string; error?: string };
  done: boolean;
  stopReason: string | null;
  // Result ids the loop must pin into the working set (`shown`) after this turn, so the
  // evidence the next move needs stays in view without a re-read (tools §4.3).
  pin?: string[];
}

export const OUTPUT_LIMIT = 8000;
const MAX_READ_LINES = 400;
const MAX_GREP_MATCHES = 200;
const GREP_COUNT_DEFAULT = 100;
const GREP_BEFORE_DEFAULT = 5;
const GREP_AFTER_DEFAULT = 5;
const MAX_LIST_FILES = 500;
const LIST_LIMIT_DEFAULT = 200;
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

// Bound a body for the projection without a reference (head+tail), so a copy-paste error
// message stays small while the tail (usually what matters) survives.
function bounded(text: string, limit = OUTPUT_LIMIT): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit / 2);
  const omitted = text.length - limit;
  return `${text.slice(0, head)}\n…[${omitted} chars omitted]…\n${text.slice(-(limit - head))}`;
}

const QUERY_LIMIT = 50;

// The body of a stored result. stdout (`output`) and stderr (`error`) are separate
// streams; a small body lives inline in the payload, a large one behind
// `outputRef`/`errorRef` (invariant 11). `preferRef` reads the full file — used by
// `query`, which windows it; the working set keeps the inline (bounded) body so the
// projection stays small.
export interface ResultBody {
  output: string;
  error: string;
}

export function resolveBody(
  state: State,
  id: string,
  workspace: Workspace,
  preferRef = false,
): ResultBody | undefined {
  const node = state.nodes.get(id);
  if (node === undefined) return undefined;
  const payload = node.payload as Record<string, unknown> | undefined;
  const stream = (inlineKey: string, refKey: string): string | undefined => {
    const inline = payload?.[inlineKey];
    const ref = payload?.[refKey];
    if (preferRef && typeof ref === "string") {
      try {
        return workspace.read(ref);
      } catch {
        // fall through to the inline body
      }
    }
    if (typeof inline === "string") return inline;
    if (typeof ref === "string") {
      try {
        return workspace.read(ref);
      } catch {
        return undefined;
      }
    }
    return undefined;
  };
  const output = stream("output", "outputRef");
  const error = stream("error", "errorRef");
  if (output === undefined && error === undefined) return undefined;
  return { output: output ?? "", error: error ?? "" };
}

function runQuery(
  state: State,
  action: Extract<Action, { operator: "query" }>,
  resolve: (id: string) => ResultBody | undefined,
): string {
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
    if (node === undefined) return "(nothing matches)";
    // A stored result's body is fetched by id — the "index" mechanism (tools §4.5):
    // re-see a past step without re-running it.
    const body = resolve(action.id);
    if (body !== undefined) {
      const window = readWindow(body.output, action.start, action.end);
      const trailer =
        window.total > 0 && window.end < window.total
          ? `\n…[lines ${window.start}–${window.end} of ${window.total}; continue from ${window.end + 1}]`
          : "";
      return JSON.stringify(
        {
          id: action.id,
          kind: node.kind,
          start: window.start,
          end: window.end,
          total: window.total,
          output: `${window.text}${trailer}`,
          ...(body.error !== "" ? { error: body.error } : {}),
        },
        null,
        2,
      );
    }
    nodes.push(nodeRow(node));
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
      const from = apply.from ?? 1;
      const count = Math.min(apply.count ?? GREP_COUNT_DEFAULT, MAX_GREP_MATCHES);
      const scope = [apply.path, apply.include, apply.exclude]
        .filter((part): part is string => part !== undefined)
        .join(" ");
      return `grep ${apply.pattern}${scope === "" ? "" : ` ${scope}`} ${before}/${after} [${from}+${count}]`;
    }
    case "list": {
      const from = apply.from ?? 1;
      const limit = Math.min(apply.limit ?? LIST_LIMIT_DEFAULT, MAX_LIST_FILES);
      const scope = [apply.path, apply.include, apply.exclude]
        .filter((part): part is string => part !== undefined)
        .join(" ");
      return `list${scope === "" ? "" : ` ${scope}`} [${from}+${limit}]`;
    }
    case "edit":
      return `edit ${apply.path}`;
    case "run":
      return apply.command ?? "";
  }
}

interface GrepResultItem {
  path: string;
  line: number;
  match: string;
  before: string[];
  after: string[];
}

interface GrepWindow {
  json: string;
  total: number;
  returned: number;
}

function clipLine(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function grepItem(
  match: GrepMatch,
  reader: (path: string) => string | undefined,
  before: number,
  after: number,
): GrepResultItem | undefined {
  const content = reader(match.path);
  if (content === undefined) return undefined;
  const lines = content.split("\n");
  const beforeLines: string[] = [];
  for (let i = Math.max(1, match.line - before); i < match.line; i += 1) {
    beforeLines.push(lines[i - 1] ?? "");
  }
  const afterLines: string[] = [];
  for (let i = match.line + 1; i <= Math.min(lines.length, match.line + after); i += 1) {
    afterLines.push(lines[i - 1] ?? "");
  }
  return {
    path: match.path,
    line: match.line,
    match: lines[match.line - 1] ?? match.text,
    before: beforeLines,
    after: afterLines,
  };
}

// Build one window of grep results as JSON. The window is a range of matches (1-based
// `from`, `count`); the byte limit drops whole trailing results so the JSON stays
// valid. A single oversized result has its lines clipped as a last resort.
function buildGrepWindow(
  matches: GrepMatch[],
  reader: (path: string) => string | undefined,
  options: {
    pattern: string;
    scope: { path?: string; include?: string; exclude?: string };
    before: number;
    after: number;
    from: number;
    count: number;
  },
): GrepWindow {
  const total = matches.length;
  const start = Math.min(Math.max(options.from - 1, 0), total);
  const window = matches.slice(start, start + Math.min(options.count, MAX_GREP_MATCHES));
  const results: GrepResultItem[] = [];
  for (const match of window) {
    const item = grepItem(match, reader, options.before, options.after);
    if (item !== undefined) results.push(item);
  }
  const build = (kept: number): string => {
    const payload: Record<string, unknown> = {
      pattern: options.pattern,
      scope: options.scope,
      context: { before: options.before, after: options.after },
      total,
      from: total === 0 ? 0 : start + 1,
      returned: kept,
      results: results.slice(0, kept),
    };
    if (start + kept < total) payload.next = start + kept + 1;
    return JSON.stringify(payload, null, 2);
  };
  let kept = results.length;
  let json = build(kept);
  while (kept > 1 && json.length > OUTPUT_LIMIT) {
    kept -= 1;
    json = build(kept);
  }
  if (json.length > OUTPUT_LIMIT && kept === 1) {
    const item = results[0] as GrepResultItem;
    const perLine = Math.max(
      100,
      Math.floor(OUTPUT_LIMIT / (item.before.length + item.after.length + 2)),
    );
    item.match = clipLine(item.match, perLine);
    item.before = item.before.map((line) => clipLine(line, perLine));
    item.after = item.after.map((line) => clipLine(line, perLine));
    json = build(kept);
  }
  return { json, total, returned: kept };
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
  const proposalTurn = (text: string, nodeId?: string, error?: string): ExecOutcome["turn"] => ({
    seq: turn,
    kind: "tool",
    text,
    ...(nodeId !== undefined ? { nodeId } : {}),
    ...(error !== undefined && error !== "" ? { error } : {}),
  });
  const fail = (text: string): ExecOutcome => {
    // A failure is knowledge too: materialize it as an observation with
    // verdict=fail so it enters the negative history (§2.8) and is never shadowed
    // by an accepted-looking turn.
    const seq = next();
    const id = `obs:${seq}`;
    events.push({
      type: "add_node",
      node: {
        id,
        space: "work",
        kind: "observation",
        label: text,
        payload: { verdict: "fail", output: text },
        seq,
      },
    });
    return { events, turn: proposalTurn(text, id), done: false, stopReason: null };
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

  // A run result body: stdout (`output`) and stderr (`error`) are stored as separate
  // streams. The inline value is the shown body (head+tail when long); when it exceeds
  // OUTPUT_LIMIT the full stream is also written behind `outputRef`/`errorRef`, so it is
  // retrievable by id. The error stream is never dropped.
  const storeStream = (
    id: string,
    kind: "output" | "error",
    text: string,
  ): Record<string, string> => {
    if (text === "") return {};
    const refKey = kind === "output" ? "outputRef" : "errorRef";
    if (text.length <= OUTPUT_LIMIT) return { [kind]: text };
    const ref = `.skein/observations/${id}.${kind === "output" ? "out" : "err"}.txt`;
    workspace.write(ref, text);
    return { [kind]: excerpt(text, ref), [refKey]: ref };
  };

  const ensurePlan = (goalId: string): string => {
    const existing = planOf(state, goalId);
    if (existing !== undefined) return existing;
    const planSeq = next();
    const planId = `w:plan:${planSeq}`;
    events.push({
      type: "add_node",
      node: { id: planId, space: "work", kind: "plan", label: `plan for ${goalId}`, seq: planSeq },
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
    const altSeq = next();
    const altId = `w:alt:${altSeq}`;
    events.push({
      type: "add_node",
      node: {
        id: altId,
        space: "work",
        kind: "alternatives",
        label: `alternatives for ${owner}`,
        seq: altSeq,
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
    const goalSeq = next();
    const id = `w:goal:${goalSeq}`;
    events.push({
      type: "add_node",
      node: {
        id,
        space: "work",
        kind: "goal",
        label: item.what,
        payload: { what: item.what, why: item.why, done_when: item.done_when },
        seq: goalSeq,
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
    const actionSeq = next();
    const id = `w:action:${actionSeq}`;
    events.push({
      type: "add_node",
      node: {
        id,
        space: "work",
        kind: "action",
        label: label ?? command,
        payload: { command, ...(extra ?? {}) },
        seq: actionSeq,
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
      const text = runQuery(state, action, (id) => resolveBody(state, id, workspace, true));
      return { events, turn: proposalTurn(clip(text)), done: false, stopReason: null };
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
      const completeSeq = next();
      const id = `w:complete:${completeSeq}`;
      events.push({
        type: "add_node",
        node: {
          id,
          space: "work",
          kind: "complete",
          label: `complete ${goalId}`,
          payload: action.note !== undefined ? { note: action.note } : {},
          seq: completeSeq,
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
        const observationSeq = next();
        const observationId = `obs:${observationSeq}`;
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
            seq: observationSeq,
          },
        });
        addEdge({ kind: "read", ref, version }, actionId, observationId, "produces");
        return { events, turn: proposalTurn(shown, observationId), done: false, stopReason: null };
      }

      if (apply.tool === "grep") {
        const before = apply.before ?? GREP_BEFORE_DEFAULT;
        const after = apply.after ?? GREP_AFTER_DEFAULT;
        const from = apply.from ?? 1;
        const count = apply.count ?? GREP_COUNT_DEFAULT;
        const scope = { path: apply.path, include: apply.include, exclude: apply.exclude };
        let matches: GrepMatch[];
        try {
          matches = workspace.grep(apply.pattern, scope);
        } catch (error) {
          return fail(`grep failed: ${(error as Error).message}`);
        }
        const command = commandOf(apply);
        const actionId = ensureAction(command, command);
        // Files are read once per call even when many matches share one.
        const cache = new Map<string, string | undefined>();
        const reader = (path: string): string | undefined => {
          if (cache.has(path)) return cache.get(path);
          let content: string | undefined;
          try {
            content = workspace.read(path);
          } catch {
            content = undefined;
          }
          cache.set(path, content);
          return content;
        };
        const window = buildGrepWindow(matches, reader, {
          pattern: apply.pattern,
          scope,
          before,
          after,
          from,
          count,
        });
        const shown = window.json;
        const observationSeq = next();
        const observationId = `obs:${observationSeq}`;
        const more = window.returned > 0 && from - 1 + window.returned < window.total;
        const summary =
          window.total === 0
            ? "no matches"
            : `${window.returned}/${window.total} matches${more ? `; continue from ${from + window.returned}` : ""}`;
        events.push({
          type: "add_node",
          node: {
            id: observationId,
            space: "work",
            kind: "observation",
            label: command,
            payload: {
              pattern: apply.pattern,
              path: apply.path,
              include: apply.include,
              exclude: apply.exclude,
              before,
              after,
              total: window.total,
              from,
              returned: window.returned,
              summary,
              ...storeOutput(observationId, shown),
            },
            seq: observationSeq,
          },
        });
        addEdge(
          {
            kind: "grep",
            pattern: apply.pattern,
            path: apply.path,
            include: apply.include,
            exclude: apply.exclude,
            from,
            count,
          },
          actionId,
          observationId,
          "produces",
        );
        return { events, turn: proposalTurn(shown, observationId), done: false, stopReason: null };
      }

      if (apply.tool === "list") {
        const from = apply.from ?? 1;
        const limit = Math.min(apply.limit ?? LIST_LIMIT_DEFAULT, MAX_LIST_FILES);
        const scope = { path: apply.path, include: apply.include, exclude: apply.exclude };
        let files: string[];
        try {
          files = workspace.listFiles(scope);
        } catch (error) {
          return fail(`list failed: ${(error as Error).message}`);
        }
        const total = files.length;
        const start = Math.min(Math.max(from - 1, 0), total);
        const page = files.slice(start, start + limit);
        const returned = page.length;
        const result: Record<string, unknown> = {
          root: apply.path ?? ".",
          total,
          from: total === 0 ? 0 : start + 1,
          returned,
          files: page,
        };
        if (start + returned < total) result.next = start + returned + 1;
        const shown = JSON.stringify(result, null, 2);
        const command = commandOf(apply);
        const actionId = ensureAction(command, command);
        const observationSeq = next();
        const observationId = `obs:${observationSeq}`;
        const more = start + returned < total;
        const summary =
          total === 0
            ? "no files"
            : `${returned}/${total} files${more ? `; continue from ${start + returned + 1}` : ""}`;
        events.push({
          type: "add_node",
          node: {
            id: observationId,
            space: "work",
            kind: "observation",
            label: command,
            payload: {
              path: apply.path,
              include: apply.include,
              exclude: apply.exclude,
              total,
              from: total === 0 ? 0 : start + 1,
              returned,
              summary,
              ...storeOutput(observationId, shown),
            },
            seq: observationSeq,
          },
        });
        addEdge(
          {
            kind: "list",
            path: apply.path,
            include: apply.include,
            exclude: apply.exclude,
          },
          actionId,
          observationId,
          "produces",
        );
        return { events, turn: proposalTurn(shown, observationId), done: false, stopReason: null };
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
          // Materialize the current content so the model can copy `find` verbatim from it
          // instead of re-reading a file it already read (which the repeat guard refuses):
          // the failed edit is the exact moment the content is needed (tools §4.3).
          const label = `edit failed: find not found in ${apply.path}`;
          const full = `${label}\n--- current content of ${apply.path} (copy "find" verbatim) ---\n${original}\n--- end ---`;
          const observationSeq = next();
          const observationId = `obs:${observationSeq}`;
          events.push({
            type: "add_node",
            node: {
              id: observationId,
              space: "work",
              kind: "observation",
              label,
              payload: { verdict: "fail", ...storeOutput(observationId, full) },
              seq: observationSeq,
            },
          });
          return {
            events,
            turn: proposalTurn(bounded(full), observationId),
            done: false,
            stopReason: null,
            pin: [observationId],
          };
        }
        const updated = original.replace(apply.find, apply.replace);
        workspace.write(apply.path, updated);
        const version = workspace.version(apply.path);
        ensureFile(apply.path, ref);
        const command = commandOf(apply);
        const actionId = ensureAction(command, command);
        addEdge({ kind: "llm" }, actionId, ref, "mutates");
        events.push({ type: "mutate", ref, version, actionId });
        return { events, turn: proposalTurn(`edited ${apply.path}`, actionId), done: false, stopReason: null };
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
      if (runCommand === undefined) {
        return fail("run failed: no command");
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
        const observationSeq = next();
        const observationId = `obs:${observationSeq}`;
        events.push({
          type: "add_node",
          node: {
            id: observationId,
            space: "work",
            kind: "observation",
            label,
            payload: { pattern, paths: violated.map(([path]) => path), reverted: true },
            seq: observationSeq,
          },
        });
        return { events, turn: proposalTurn(label, observationId), done: false, stopReason: null };
      }

      const verdict =
        result.timedOut === true ? "inconclusive" : result.code === 0 ? "pass" : "fail";
      const isCheck = target !== undefined && targetNode?.kind === "goal";
      const resultSeq = next();
      const resultId = isCheck ? `chk:${resultSeq}` : `obs:${resultSeq}`;
      // stdout and stderr are stored separately and never concatenated: a failed run's
      // error is the primary signal, and a merged log hides which stream carried it.
      const outputBody = storeStream(resultId, "output", result.stdout);
      const errorBody = storeStream(resultId, "error", result.stderr);
      const outputShown = typeof outputBody.output === "string" ? outputBody.output : "";
      const errorShown = typeof errorBody.error === "string" ? errorBody.error : "";
      const header = `$ ${runCommand}\nexit ${result.code}`;
      const text = result.stdout === "" ? header : `${header}\n${outputShown}`;

      if (isCheck) {
        events.push({
          type: "record_check",
          id: resultId,
          command: runCommand,
          verdict,
          output: outputShown,
          ...(outputBody.outputRef !== undefined ? { outputRef: outputBody.outputRef } : {}),
          ...(errorShown !== "" ? { error: errorShown } : {}),
          ...(errorBody.errorRef !== undefined ? { errorRef: errorBody.errorRef } : {}),
          actor: "arbiter",
          witness: witnessOfWorkspace(workspace),
          targets: [target as string],
          ...(apply.under !== undefined ? { under: apply.under } : {}),
        });
        addEdge(
          {
            kind: "check",
            command: runCommand,
            verdict,
            ...(outputBody.outputRef !== undefined ? { outputRef: outputBody.outputRef } : {}),
          },
          actionId,
          resultId,
          "produces",
        );
        return {
          events,
          turn: proposalTurn(text, resultId, errorShown),
          done: false,
          stopReason: null,
        };
      }

      events.push({
        type: "add_node",
        node: {
          id: resultId,
          space: "work",
          kind: "observation",
          label: command,
          payload: {
            command: runCommand,
            verdict,
            ...(result.stdout !== "" ? { output: outputShown } : {}),
            ...(outputBody.outputRef !== undefined ? { outputRef: outputBody.outputRef } : {}),
            ...(errorShown !== "" ? { error: errorShown } : {}),
            ...(errorBody.errorRef !== undefined ? { errorRef: errorBody.errorRef } : {}),
          },
          seq: resultSeq,
        },
      });
      addEdge(
        {
          kind: "check",
          command: runCommand,
          verdict,
          ...(outputBody.outputRef !== undefined ? { outputRef: outputBody.outputRef } : {}),
        },
        actionId,
        resultId,
        "produces",
      );
      return { events, turn: proposalTurn(text, resultId, errorShown), done: false, stopReason: null };
    }
  }
}
