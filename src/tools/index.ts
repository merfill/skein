import { createHash } from "node:crypto";

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
import { currentGoalId, firstUnfulfilledItem } from "../ir/traversal";
import type { DoneWhen, EdgeKind, GoalPayload, Node, Provenance, Verdict, WitnessEntry } from "../ir/types";
import type { Action, ActionStep, Apply } from "../llm/schemas";
import { crashReport, type CrashReport } from "./crash";
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

// The one-line crash summary for a run/poll header: the signal, the core if one was
// written, else why there is none (core_pattern), and whether a backtrace is attached.
function crashLine(crash: CrashReport): string {
  const core =
    crash.core !== undefined
      ? ` (core: ${crash.core})`
      : crash.corePattern !== undefined
        ? ` (no core: core_pattern ${crash.corePattern})`
        : "";
  const backtrace = crash.backtrace !== undefined ? "; backtrace attached" : "";
  return `killed by ${crash.signal}${core}${backtrace}`;
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

// The version of the last read of `ref` (an observation carries it). Used to refuse a
// `write` over content the model never read or that changed since (mirrors classify).
function latestReadVersion(state: State, ref: string): string | undefined {
  let best: { seq: number; version: string } | undefined;
  for (const node of state.nodes.values()) {
    if (node.kind !== "observation") continue;
    const payload = node.payload as { ref?: unknown; version?: unknown } | undefined;
    if (payload?.ref !== ref || typeof payload.version !== "string") continue;
    if (best === undefined || node.seq > best.seq) best = { seq: node.seq, version: payload.version };
  }
  return best?.version;
}

function descendTo(state: State, parent: string, node: string): Event[] {
  const stack = state.branch.length > 0 ? state.branch : state.rootId ? [state.rootId] : [];
  const index = stack.lastIndexOf(parent);
  const events: Event[] = [];
  for (let i = stack.length - 1; i > index; i--) events.push({ type: "return" });
  events.push({ type: "descend", node });
  return events;
}

// The default workspace path for a fetched reference: engine-owned, under `.skein/ref/`
// (excluded from listings), namespaced by a short URL hash so two references with the same
// basename do not collide.
function refPathFor(url: string): string {
  const clean = url.split(/[?#]/)[0] ?? url;
  const base = clean.split("/").filter((part) => part !== "").pop() ?? "reference";
  const slug = base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60) || "reference";
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 8);
  return `.skein/ref/${hash}-${slug}`;
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
    case "write":
      return `write ${apply.path}`;
    case "fetch":
      return `fetch ${apply.url}${apply.path !== undefined ? ` ${apply.path}` : ""}`;
    case "apply_patch":
      return `apply_patch -p${apply.strip ?? 1}`;
    case "run":
      // A poll of a background job is addressed by the job id, not by a shell command;
      // this is only used for display/dedup, the run branch builds its own signature.
      if (apply.job !== undefined) return `poll ${apply.job}`;
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

  const buildGoal = (spec: {
    what: string;
    why?: string;
    done_when: DoneWhen;
    plan?: string;
    step?: ActionStep;
  }): string => {
    const goalSeq = next();
    const id = `w:goal:${goalSeq}`;
    events.push({
      type: "add_node",
      node: {
        id,
        space: "work",
        kind: "goal",
        label: spec.what,
        payload: {
          what: spec.what,
          why: spec.why,
          done_when: spec.done_when,
          ...(spec.plan !== undefined ? { plan: spec.plan } : {}),
        },
        seq: goalSeq,
      },
    });
    if (spec.step !== undefined) {
      const planId = ensurePlan(id);
      const stepId = buildActionItem(spec.step.command, spec.step.label);
      events.push({
        type: "add_edge",
        edge: {
          id: `e:${next()}`,
          from: planId,
          to: stepId,
          kind: "item",
          provenance: { kind: "llm" },
        },
      });
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
      const atRequest = currentNode?.kind === "request";
      const refuted = predicateOf(state, current) === "refuted";
      // Decomposing an open goal (I6): the sub-goal replaces the current step as its
      // chosen alternative, so there must be a concrete step to decompose.
      let step: string | undefined;
      if (!atRequest && !refuted) {
        step = firstUnfulfilledItem(state, current);
        const stepNode = step !== undefined ? state.nodes.get(step) : undefined;
        if (step === undefined || stepNode?.kind !== "action") {
          const doneWhen = (currentNode?.payload as { done_when?: { kind?: string } } | undefined)
            ?.done_when;
          const hint =
            doneWhen?.kind === "arbiter"
              ? `${current} is an arbiter goal: it is settled only by the arbiter's acceptance — it cannot be checked or grown`
              : `if ${current} is objective and its plan is done, check it (run {target: "${current}"}); to add a step, apply an action`;
          return fail(
            `create goal failed: no current step to decompose — a sub-goal can only replace an existing step, and ${hint}`,
          );
        }
      }
      const id = buildGoal({
        what: action.what,
        ...(action.why !== undefined ? { why: action.why } : {}),
        done_when: action.done_when,
        plan: action.plan,
        step: action.step,
      });
      if (atRequest) {
        const alt = ensureAlternatives(current);
        addEdge({ kind: "llm" }, alt, id, "item");
        addEdge({ kind: "llm" }, alt, id, "chosen");
      } else if (refuted) {
        const container = variantContainer(current);
        addEdge({ kind: "llm" }, container, id, "item");
        addEdge({ kind: "llm" }, container, id, "chosen");
      } else {
        const alt = ensureAlternatives(step as string);
        addEdge({ kind: "llm" }, alt, id, "item");
        addEdge({ kind: "llm" }, alt, id, "chosen");
      }
      events.push(...descendTo(state, current, id));
      return { events, turn: proposalTurn(`created goal: ${action.what}`), done: false, stopReason: null };
    }

    case "stop": {
      // The doxa's terminal move: record a stop node and end the run. The request itself
      // is not closed (acceptance stays external); `addressed` remains derived.
      const seq = next();
      const stopId = `w:stop:${seq}`;
      events.push({
        type: "add_node",
        node: {
          id: stopId,
          space: "work",
          kind: "stop",
          label: action.why ?? "stop",
          ...(action.why !== undefined ? { payload: { why: action.why } } : {}),
          seq,
        },
      });
      return {
        events,
        turn: proposalTurn("stopped: the request is addressed", stopId),
        done: true,
        stopReason: "request_addressed",
      };
    }

    case "apply": {
      const apply = action.action;

      if (apply.tool === "read") {
        // A path outside the workspace is a recorded refusal, not a crash: `exists`
        // throws `path escapes workspace`, and the loop must turn that into a fail
        // observation like `grep`/`list` do (docs/benches/bench_report.md §4.4, problem 5).
        let present: boolean;
        try {
          present = workspace.exists(apply.path);
        } catch (error) {
          return fail(`read failed: ${(error as Error).message}`);
        }
        if (!present) return fail(`read failed: ${apply.path} does not exist`);
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
        let present: boolean;
        try {
          present = workspace.exists(apply.path);
        } catch (error) {
          return fail(`edit failed: ${(error as Error).message}`);
        }
        if (!present) return fail(`edit failed: ${apply.path} does not exist`);
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
          // Record the attempt too, with the `find`/`replace` that failed, so `calls`
          // shows what was already tried instead of only the file content (docs §4.4).
          const command = commandOf(apply);
          const actionId = ensureAction(command, command, {
            find: apply.find,
            replace: apply.replace,
          });
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
          addEdge({ kind: "llm" }, actionId, observationId, "produces");
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
        // Keep `find`/`replace` in the action payload: a short diff in `calls` is what
        // lets the model learn from its edits (docs §4.4).
        const actionId = ensureAction(command, command, {
          find: apply.find,
          replace: apply.replace,
        });
        addEdge({ kind: "llm" }, actionId, ref, "mutates");
        events.push({ type: "mutate", ref, version, actionId });
        return { events, turn: proposalTurn(`edited ${apply.path}`, actionId), done: false, stopReason: null };
      }

      if (apply.tool === "write") {
        const ref = `file:${apply.path}`;
        // Overwriting unseen or changed content is refused: the model must have read the
        // file (a new file has no version, so creation is allowed) and it must be fresh.
        let present: boolean;
        try {
          present = workspace.exists(apply.path);
        } catch (error) {
          return fail(`write failed: ${(error as Error).message}`);
        }
        if (present) {
          const readVersion = latestReadVersion(state, ref);
          if (readVersion === undefined) {
            return fail(
              `write failed: ${apply.path} exists; read it before overwriting (use edit for a small change)`,
            );
          }
          if (currentVersion(state, ref) !== readVersion) {
            return fail(`write failed: stale base: ${apply.path} changed since it was read; re-read first`);
          }
        }
        try {
          workspace.write(apply.path, apply.content);
        } catch (error) {
          return fail(`write failed: ${(error as Error).message}`);
        }
        const version = workspace.version(apply.path);
        ensureFile(apply.path, ref);
        const command = commandOf(apply);
        const actionId = ensureAction(command, command, { path: apply.path, bytes: apply.content.length });
        addEdge({ kind: "llm" }, actionId, ref, "mutates");
        events.push({ type: "mutate", ref, version, actionId });
        return { events, turn: proposalTurn(`wrote ${apply.path}`, actionId), done: false, stopReason: null };
      }

      if (apply.tool === "fetch") {
        const path = apply.path ?? refPathFor(apply.url);
        // An explicit target must be a fresh path: refuse to clobber anything (a source
        // file, or a prior reference). `exists` throws on a path outside the workspace.
        let present: boolean;
        try {
          present = workspace.exists(path);
        } catch (error) {
          return fail(`fetch failed: ${(error as Error).message}`);
        }
        if (present) return fail(`fetch failed: ${path} already exists; choose another path`);
        let fetched: { path: string; bytes: number };
        try {
          fetched = workspace.fetchTo(apply.url, path);
        } catch (error) {
          return fail(`fetch failed: ${(error as Error).message}`);
        }
        const ref = `file:${fetched.path}`;
        ensureFile(fetched.path, ref);
        const version = workspace.version(fetched.path);
        const command = commandOf(apply);
        const actionId = ensureAction(command, command, {
          signature: `${apply.url}\u0000${fetched.path}`,
          url: apply.url,
          path: fetched.path,
        });
        addEdge({ kind: "llm" }, actionId, ref, "mutates");
        events.push({ type: "mutate", ref, version, actionId });
        const observationSeq = next();
        const observationId = `obs:${observationSeq}`;
        const text = `fetched ${apply.url} -> ${fetched.path} (${fetched.bytes} bytes)`;
        events.push({
          type: "add_node",
          node: {
            id: observationId,
            space: "work",
            kind: "observation",
            label: text,
            payload: { url: apply.url, path: fetched.path, bytes: fetched.bytes, ref, version },
            seq: observationSeq,
          },
        });
        addEdge({ kind: "llm" }, actionId, observationId, "produces");
        return { events, turn: proposalTurn(text, observationId), done: false, stopReason: null };
      }

      if (apply.tool === "apply_patch") {
        const before = signatureMap(workspace);
        try {
          workspace.applyPatch(apply.patch, apply.strip);
        } catch (error) {
          return fail(`apply_patch failed: ${(error as Error).message}`);
        }
        const after = signatureMap(workspace);
        const mutations = changedMutations(workspace, before, after, new Set());
        const command = commandOf(apply);
        const actionId = ensureAction(command, command, { strip: apply.strip ?? 1 });
        for (const entry of mutations) {
          const path = entry.ref.slice("file:".length);
          ensureFile(path, entry.ref);
          addEdge({ kind: "llm" }, actionId, entry.ref, "mutates");
          events.push({ type: "mutate", ref: entry.ref, version: entry.version, actionId });
        }
        const observationSeq = next();
        const observationId = `obs:${observationSeq}`;
        const paths = mutations.map((entry) => entry.ref.slice("file:".length));
        const text =
          paths.length === 0 ? "apply_patch: no files changed" : `applied patch: ${paths.join(", ")}`;
        events.push({
          type: "add_node",
          node: {
            id: observationId,
            space: "work",
            kind: "observation",
            label: text,
            payload: { paths, applied: mutations.length > 0 },
            seq: observationSeq,
          },
        });
        addEdge({ kind: "llm" }, actionId, observationId, "produces");
        return { events, turn: proposalTurn(text, observationId), done: false, stopReason: null };
      }

      // apply.tool === "run"
      // A run produces a goal verdict only when it explicitly names that goal as its
      // target. A bare run (no target) is an observation even when its command equals a
      // goal's `done_when.command`: a reproduce step must never be read as a check, or it
      // would refute the goal before the fix (docs/plans/traversal_stack_spec.md §9).
      const target = apply.target;
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
          return fail(`check failed: goal ${target} is arbiter; it is settled by external acceptance, not by a run`);
        }
        runCommand = payload.done_when.command;
      }
      // A poll of a background job: it has no shell of its own, is never a check, and is
      // never a repeat — each poll reads new state (docs/tools.md §4.7).
      if (apply.job !== undefined) {
        const job = workspace.pollJob(apply.job);
        if (job === undefined) return fail(`no such job: ${apply.job}`);
        const actionCommand = `poll ${job.id}`;
        const actionId = ensureAction(actionCommand, actionCommand, {
          signature: `${actionCommand}\u0000`,
        });
        const observationSeq = next();
        const observationId = `obs:${observationSeq}`;
        const done = job.state === "done";
        const verdict: Verdict | undefined = done ? (job.exitCode === 0 ? "pass" : "fail") : undefined;
        // A job killed by a signal crashed: read the core and a backtrace, as for a
        // foreground run (docs/tools.md §4.3).
        const crash =
          done && job.signal !== null
            ? crashReport(workspace, job.signal, job.startedAt)
            : undefined;
        const outputBody = storeStream(observationId, "output", job.stdout);
        const errorBody = storeStream(observationId, "error", job.stderr);
        const outputShown = typeof outputBody.output === "string" ? outputBody.output : "";
        const errorShown = typeof errorBody.error === "string" ? errorBody.error : "";
        const crashSummary =
          crash !== undefined ? crashLine(crash) : `exit ${job.exitCode ?? "?"}`;
        const header = done
          ? `$ ${job.command}\njob ${job.id} ${crashSummary}`
          : `job ${job.id} running (poll again with run {job: "${job.id}"})`;
        const diagnostic =
          crash?.backtrace !== undefined ? `\n${bounded(crash.backtrace, 2000)}` : "";
        const text = `${job.stdout === "" ? header : `${header}\n${outputShown}`}${diagnostic}`;
        events.push({
          type: "add_node",
          node: {
            id: observationId,
            space: "work",
            kind: "observation",
            label: actionCommand,
            payload: {
              command: actionCommand,
              job: job.id,
              state: job.state,
              ...(verdict !== undefined ? { verdict } : {}),
              ...(job.exitCode !== null ? { exitCode: job.exitCode } : {}),
              ...(job.signal !== null ? { signal: job.signal } : {}),
              ...(crash?.core !== undefined ? { core: crash.core } : {}),
              ...(crash?.corePattern !== undefined ? { corePattern: crash.corePattern } : {}),
              ...(crash?.backtrace !== undefined
                ? { backtrace: bounded(crash.backtrace, OUTPUT_LIMIT) }
                : {}),
              ...(crash?.backtraceError !== undefined
                ? { backtraceError: bounded(crash.backtraceError, 2000) }
                : {}),
              ...(!done ? { summary: `job ${job.id} running` } : {}),
              ...(job.stdout !== "" ? { output: outputShown } : {}),
              ...(outputBody.outputRef !== undefined ? { outputRef: outputBody.outputRef } : {}),
              ...(errorShown !== "" ? { error: errorShown } : {}),
              ...(errorBody.errorRef !== undefined ? { errorRef: errorBody.errorRef } : {}),
            },
            seq: observationSeq,
          },
        });
        addEdge(
          verdict !== undefined
            ? { kind: "check", command: actionCommand, verdict }
            : { kind: "llm" },
          actionId,
          observationId,
          "produces",
        );
        return {
          events,
          turn: proposalTurn(text, observationId, errorShown),
          done: false,
          stopReason: null,
        };
      }

      if (runCommand === undefined) {
        return fail("run failed: no command");
      }

      // Start a long command in the background: this turn returns at once and the model
      // polls the job by id. A background command cannot be guarded (its mutations land
      // after this turn), so it is refused while a constraint forbids a file.
      if (apply.background === true) {
        if (forbiddenPatterns(state).length > 0) {
          return fail(
            "background run unavailable while a constraint forbids files; run it in the foreground",
          );
        }
        const started = workspace.startJob(runCommand);
        const actionId = ensureAction(runCommand, runCommand, {
          signature: `${runCommand}\u0000`,
          background: true,
        });
        const observationSeq = next();
        const observationId = `obs:${observationSeq}`;
        const text = `started job ${started.id} (pid ${started.pid}): ${runCommand}\npoll with run {job: "${started.id}"}`;
        events.push({
          type: "add_node",
          node: {
            id: observationId,
            space: "work",
            kind: "observation",
            label: `started ${started.id}`,
            payload: {
              command: runCommand,
              job: started.id,
              state: "running",
              summary: `job ${started.id} running`,
              output: text,
            },
            seq: observationSeq,
          },
        });
        addEdge({ kind: "llm" }, actionId, observationId, "produces");
        return { events, turn: proposalTurn(text, observationId), done: false, stopReason: null };
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
      const runStartedAt = Date.now();
      const result = workspace.run(runCommand);
      // A crash (a signal, not a controlled exit) is knowledge: read the core and, when
      // gdb is present, a backtrace (docs/tools.md §4.3). A timeout is a SIGTERM we sent
      // ourselves, not a crash, so it is excluded.
      const crash =
        result.signal !== undefined && result.timedOut !== true
          ? crashReport(workspace, result.signal, runStartedAt)
          : undefined;
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
      const crashSummary =
        crash === undefined ? `exit ${result.code}` : crashLine(crash);
      const header = `$ ${runCommand}\n${crashSummary}`;
      const diagnostic =
        crash?.backtrace !== undefined ? `\n${bounded(crash.backtrace, 2000)}` : "";
      const text = `${result.stdout === "" ? header : `${header}\n${outputShown}`}${diagnostic}`;

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
          ...(crash !== undefined
              ? {
                  signal: crash.signal,
                  ...(crash.core !== undefined ? { core: crash.core } : {}),
                  ...(crash.corePattern !== undefined ? { corePattern: crash.corePattern } : {}),
                  ...(crash.backtrace !== undefined
                    ? { backtrace: bounded(crash.backtrace, OUTPUT_LIMIT) }
                    : {}),
                  ...(crash.backtraceError !== undefined
                    ? { backtraceError: bounded(crash.backtraceError, 2000) }
                    : {}),
                }
              : {}),
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
            ...(crash !== undefined
              ? {
                  signal: crash.signal,
                  ...(crash.core !== undefined ? { core: crash.core } : {}),
                  ...(crash.corePattern !== undefined ? { corePattern: crash.corePattern } : {}),
                  ...(crash.backtrace !== undefined
                    ? { backtrace: bounded(crash.backtrace, OUTPUT_LIMIT) }
                    : {}),
                  ...(crash.backtraceError !== undefined
                    ? { backtraceError: bounded(crash.backtraceError, 2000) }
                    : {}),
                }
              : {}),
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
