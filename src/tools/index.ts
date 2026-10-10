import { createHash } from "node:crypto";

import { forbiddenConstraints, forbiddenPatterns, matchesPath } from "../ir/constraints";
import type { Event } from "../ir/events";
import {
  actionExecuted,
  actionSucceeded,
  childrenOf,
  currentVersion,
  itemOf,
  planOf,
  type State,
} from "../ir/graph";
import { currentGoalId, firstUnfulfilledItem } from "../ir/traversal";
import type { EdgeKind, Provenance, WitnessEntry } from "../ir/types";
import type { Action, Apply } from "../llm/schemas";
import { crashReport, type CrashReport } from "./crash";
import type { GrepMatch, Workspace } from "./workspace";

export interface ExecOutcome {
  events: Event[];
  turn: {
    seq: number;
    kind: "proposal" | "tool";
    text: string;
    nodeId?: string;
    error?: string;
    // The rendered call of a move that leaves no node (a `recall`/`search`), so the projection shows
    // what was asked rather than a bare operator name (the assistant's own history).
    call?: string;
  };
  done: boolean;
  stopReason: string | null;
  // Result ids the loop must pin into the working set (`shown`) after this turn, so the
  // evidence the next move needs stays in view without a re-read (tools §4.3).
  pin?: string[];
}

// Per-tool inline budgets (docs/ir_semantics.md §7). `read` is the big one: a whole
// file/function comes back in one go, bounded by bytes (no line cap). The rest are small,
// because they are pointers, not content — a `grep`/`list` result names candidates, a `run`
// result is a log tail — and a large inline body only floods the tape (no eviction yet). A
// body still over its cap keeps its head (inspection) or tail (command) and is spilled
// behind `outputRef`/`errorRef`.
export const READ_LIMIT = 65536;
const GREP_LIMIT = 8192;
const LIST_LIMIT = 8192;
const RUN_LIMIT = 8192;
// A `recall` re-reads a stored body (often a `read`), so it shares the read budget.
const QUERY_BODY_LIMIT = READ_LIMIT;
// The read window leaves room for its `continue from` trailer, so window + trailer still
// fit the budget and the shown body is never cut a second time.
const READ_CONTINUE_RESERVE = 96;
const MAX_GREP_MATCHES = 100;
const GREP_COUNT_DEFAULT = 50;
const GREP_BEFORE_DEFAULT = 3;
const GREP_AFTER_DEFAULT = 3;
const MAX_LIST_FILES = 200;
const LIST_LIMIT_DEFAULT = 100;

function clip(text: string, limit = QUERY_BODY_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`;
}

// A read window is bounded by READ_LIMIT bytes (whole lines, no line cap): the window is not
// fragmented by a line count below the byte budget. The tool reports the window it returned
// so the model knows where to continue.
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
  const budget = READ_LIMIT - READ_CONTINUE_RESERVE;
  let last = from;
  let size = 0;
  for (let i = from; i <= to; i += 1) {
    const line = lines[i - 1] ?? "";
    const added = line.length + (i > from ? 1 : 0);
    if (i > from && size + added > budget) break;
    size += added;
    last = i;
  }
  to = last;
  let text = lines.slice(from - 1, to).join("\n");
  if (text.length > budget) text = clip(text, budget);
  return { text, start: from, end: to, total };
}

// A body larger than `limit` is bounded with an omission note and the full body behind a
// ref; the middle is never dropped silently. An inspection result (read/grep/list) is
// consumed from the beginning, so its HEAD is kept; a command's output matters at its end
// (the error and exit), so its TAIL is kept.
function headExcerpt(text: string, ref: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[${text.length - limit} chars omitted; full output: ${ref}]…`;
}

function tailExcerpt(text: string, ref: string, limit: number): string {
  if (text.length <= limit) return text;
  return `…[${text.length - limit} chars omitted; full output: ${ref}]…\n${text.slice(-limit)}`;
}

// Bound a body for the projection without a reference (head+tail), so a copy-paste error
// message stays small while the tail (usually what matters) survives.
function bounded(text: string, limit = READ_LIMIT): string {
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

// The body of a stored result. stdout (`output`) and stderr (`error`) are separate
// streams; a small body lives inline in the payload, a large one behind
// `outputRef`/`errorRef` (invariant 11). `preferRef` reads the full file — used by `recall`,
// which windows it; the working set keeps the inline (bounded) body so the projection stays
// small.
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

// Read a stored result by id — the "index" mechanism (tools §4.5): re-see a past step
// without re-running it. The body is fetched from `outputRef` when present (so a large body
// pages by window); the error stream is taken from the bounded inline value (never the full
// stderr). The window is bounded by `QUERY_BODY_LIMIT`, shrunk by whole lines so the result
// stays valid JSON and is never clipped mid-string.
function runRecall(
  state: State,
  action: Extract<Action, { operator: "recall" }>,
  workspace: Workspace,
): string {
  const node = state.nodes.get(action.id);
  if (node === undefined) return `(nothing to recall: ${action.id} is not a node)`;
  const full = resolveBody(state, action.id, workspace, true);
  if (full === undefined) return `(nothing to recall: ${action.id} has no stored body)`;
  const error = resolveBody(state, action.id, workspace, false)?.error ?? "";
  const render = (end: number | undefined): { json: string; view: ReturnType<typeof readWindow> } => {
    const view = readWindow(full.output, action.start, end);
    const trailer =
      view.total > 0 && view.end < view.total
        ? `\n…[lines ${view.start}–${view.end} of ${view.total}; continue from ${view.end + 1}]`
        : "";
    const json = JSON.stringify(
      {
        id: action.id,
        kind: node.kind,
        start: view.start,
        end: view.end,
        total: view.total,
        output: `${view.text}${trailer}`,
        ...(error !== "" ? { error } : {}),
      },
      null,
      2,
    );
    return { json, view };
  };
  let { json, view } = render(action.end);
  for (let guard = 0; guard < 6 && json.length > QUERY_BODY_LIMIT && view.end > view.start; guard += 1) {
    const lines = view.end - view.start + 1;
    const keep = Math.max(1, Math.floor(lines * (QUERY_BODY_LIMIT / json.length)));
    if (keep >= lines) break;
    ({ json, view } = render(view.start + keep - 1));
  }
  return json;
}

interface SearchResultItem {
  stream: "stdout" | "stderr";
  line: number;
  match: string;
  before: string[];
  after: string[];
}

function sliceLines(lines: string[], from: number, to: number): string[] {
  const out: string[] = [];
  for (let i = Math.max(1, from); i <= Math.min(lines.length, to); i += 1) out.push(lines[i - 1] ?? "");
  return out;
}

// Search INSIDE one stored result (stdout and stderr) for a pattern, returned as matching
// line windows (a `grep` scoped to a single id). There is no paging cursor: a broad pattern
// is truncated with a "narrow the pattern" note, never a dangling `next` (the tool has no
// `from`). A single oversized result has its lines clipped as a last resort.
function runSearch(
  state: State,
  action: Extract<Action, { operator: "search" }>,
  workspace: Workspace,
): string {
  const node = state.nodes.get(action.id);
  if (node === undefined) return `(nothing to search: ${action.id} is not a node)`;
  const body = resolveBody(state, action.id, workspace, true);
  if (body === undefined) return `(nothing to search: ${action.id} has no stored body)`;
  let re: RegExp;
  try {
    re = new RegExp(action.pattern);
  } catch {
    return JSON.stringify({ id: action.id, pattern: action.pattern, error: "invalid pattern" }, null, 2);
  }
  const before = action.before ?? GREP_BEFORE_DEFAULT;
  const after = action.after ?? GREP_AFTER_DEFAULT;
  const streams: [SearchResultItem["stream"], string][] = [];
  if (body.output !== "") streams.push(["stdout", body.output]);
  if (body.error !== "") streams.push(["stderr", body.error]);
  const results: SearchResultItem[] = [];
  let total = 0;
  for (const [stream, text] of streams) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (!re.test(lines[i] ?? "")) continue;
      total += 1;
      if (results.length >= MAX_GREP_MATCHES) continue;
      results.push({
        stream,
        line: i + 1,
        match: lines[i] ?? "",
        before: sliceLines(lines, i + 1 - before, i),
        after: sliceLines(lines, i + 2, i + 1 + after),
      });
    }
  }
  const build = (kept: number): string =>
    JSON.stringify(
      {
        id: action.id,
        pattern: action.pattern,
        context: { before, after },
        total,
        returned: kept,
        results: results.slice(0, kept),
        ...(kept < total ? { note: `showing ${kept} of ${total} matches; narrow the pattern` } : {}),
      },
      null,
      2,
    );
  let kept = results.length;
  let json = build(kept);
  while (kept > 1 && json.length > GREP_LIMIT) {
    kept -= 1;
    json = build(kept);
  }
  if (json.length > GREP_LIMIT && kept === 1) {
    const item = results[0] as SearchResultItem;
    const perLine = Math.max(100, Math.floor(GREP_LIMIT / (item.before.length + item.after.length + 2)));
    item.match = clipLine(item.match, perLine);
    item.before = item.before.map((line) => clipLine(line, perLine));
    item.after = item.after.map((line) => clipLine(line, perLine));
    json = build(kept);
  }
  return json;
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

function actionCommand(payload: unknown): string | undefined {
  const value = payload as { signature?: unknown; command?: unknown } | undefined;
  if (typeof value?.signature === "string") return value.signature;
  if (typeof value?.command === "string") return value.command;
  return undefined;
}

// The latest executed action with this command signature, if any. A refused attempt (a
// command that did not run: repeat/stale/forbidden/empty) does not become the baseline, so
// repeated refusals keep naming the same original result and read as no new knowledge.
function latestAction(state: State, command: string): { seq: number; id: string } | undefined {
  let best: { seq: number; id: string } | undefined;
  for (const node of state.nodes.values()) {
    if (node.kind !== "action" || !actionExecuted(state, node.id)) continue;
    if (actionCommand(node.payload) !== command) continue;
    const result = state.nodes.get(resultId(state, node.id));
    if ((result?.payload as { refused?: unknown } | undefined)?.refused === true) continue;
    if (best === undefined || node.seq > best.seq) best = { seq: node.seq, id: node.id };
  }
  return best;
}

// The addressable result of an action: its produced child, else the action itself.
function resultId(state: State, actionId: string): string {
  let best: { seq: number; id: string } | undefined;
  for (const edge of state.edges.values()) {
    if (edge.kind !== "result" || edge.from !== actionId) continue;
    const node = state.nodes.get(edge.to);
    if (node === undefined) continue;
    if (best === undefined || node.seq > best.seq) best = { seq: node.seq, id: edge.to };
  }
  return best?.id ?? actionId;
}

// The workspace-relative paths a unified diff would touch, from its `---`/`+++` headers.
function patchTargets(patch: string): string[] {
  const out = new Set<string>();
  for (const line of patch.split("\n")) {
    const match = line.match(/^(?:\+\+\+|---) (?:[ab]\/)?(.+)$/);
    const path = match?.[1]?.trim();
    if (path !== undefined && path !== "" && path !== "/dev/null") out.add(path);
  }
  return [...out];
}

// The extra payload a tool keeps on its action node, so the calls index / repeat guard can
// read it back (docs/ir_revision.md §4).
function actionExtra(apply: Apply): Record<string, unknown> {
  switch (apply.tool) {
    case "edit":
      return { find: apply.find, replace: apply.replace };
    case "write":
      return { path: apply.path, bytes: apply.content.length };
    case "run":
      return { signature: `${apply.command ?? ""}\u0000` };
    case "fetch":
      return { url: apply.url, ...(apply.path !== undefined ? { path: apply.path } : {}) };
    case "apply_patch":
      return { strip: apply.strip ?? 1 };
    default:
      return {};
  }
}

// Non-execution of a command (docs/ir_revision.md §3.3, §4): a repeat, a stale base, a
// forbidden path or an empty command is a reason, returned here so the engine records it as
// an observation rather than refusing without a node. The checks are state-only.
function commandRefusal(state: State, apply: Apply, command: string): string | undefined {
  if (apply.tool === "read" || apply.tool === "grep") {
    const found = latestAction(state, command);
    if (found !== undefined && state.lastMutationSeq < found.seq) {
      return `repeated_action: ${resultId(state, found.id)} already has it; retrieve it by id (recall), do not repeat`;
    }
  }
  if (apply.tool === "run") {
    if (command.trim() === "") return "run needs a command";
    const found = latestAction(state, `${command}\u0000`);
    if (found !== undefined && state.lastMutationSeq < found.seq) {
      const prior = state.nodes.get(resultId(state, found.id));
      const exit = (prior?.payload as { exitCode?: unknown } | undefined)?.exitCode;
      if (typeof exit === "number") {
        return `repeated_action: ${resultId(state, found.id)} already has it; retrieve it by id (recall), do not repeat`;
      }
    }
  }
  if (apply.tool === "edit" || apply.tool === "write") {
    for (const { id, pattern } of forbiddenConstraints(state)) {
      if (matchesPath(pattern, apply.path)) return `constraint_violation:${pattern}:${id}`;
    }
    const ref = `file:${apply.path}`;
    const readVersion = latestReadVersion(state, ref);
    if (readVersion !== undefined && currentVersion(state, ref) !== readVersion) {
      return "stale_base";
    }
  }
  if (apply.tool === "fetch" && apply.path !== undefined) {
    for (const { pattern } of forbiddenConstraints(state)) {
      if (matchesPath(pattern, apply.path)) return `constraint_violation:${pattern}`;
    }
  }
  if (apply.tool === "apply_patch") {
    for (const target of patchTargets(apply.patch)) {
      for (const { pattern } of forbiddenConstraints(state)) {
        if (matchesPath(pattern, target)) return `constraint_violation:${pattern}`;
      }
    }
  }
  return undefined;
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
      return apply.command ?? "";
  }
}

// The rendered `recall`/`search` call (a move with no node), so the assistant's own history
// shows what was asked rather than a bare operator name (the projection re-inserts it).
function recallCall(action: Extract<Action, { operator: "recall" }>): string {
  const parts = [`id: ${action.id}`];
  if (action.start !== undefined) parts.push(`start: ${action.start}`);
  if (action.end !== undefined) parts.push(`end: ${action.end}`);
  return `recall { ${parts.join(", ")} }`;
}

function searchCall(action: Extract<Action, { operator: "search" }>): string {
  const parts = [`id: ${action.id}`, `pattern: ${action.pattern}`];
  if (action.before !== undefined) parts.push(`before: ${action.before}`);
  if (action.after !== undefined) parts.push(`after: ${action.after}`);
  return `search { ${parts.join(", ")} }`;
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
  while (kept > 1 && json.length > GREP_LIMIT) {
    kept -= 1;
    json = build(kept);
  }
  if (json.length > GREP_LIMIT && kept === 1) {
    const item = results[0] as GrepResultItem;
    const perLine = Math.max(
      100,
      Math.floor(GREP_LIMIT / (item.before.length + item.after.length + 2)),
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
    // A failure is knowledge too: materialize it as an observation flagged `failed`, so it
    // enters the negative history (§2.8) and is never shadowed by an accepted-looking turn.
    const seq = next();
    const id = `obs:${seq}`;
    events.push({
      type: "add_node",
      node: {
        id,
        space: "work",
        kind: "observation",
        label: text,
        payload: { failed: true, output: text },
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

  // Keep an inspection body (read/grep/list): the tool's own window is honored whole when
  // it fits its per-tool limit; otherwise its head is shown (with an omission note) and the
  // full body is written to a file behind `outputRef`, recalled by id via `recall` (§8). The
  // middle is never dropped silently.
  const storeOutput = (
    id: string,
    text: string,
    limit: number,
  ): { output?: string; outputRef?: string } => {
    if (text.length <= limit) return { output: text };
    const ref = `.skein/observations/${id}.txt`;
    workspace.write(ref, text);
    return { output: headExcerpt(text, ref, limit), outputRef: ref };
  };

  // A run result body: stdout (`output`) and stderr (`error`) are stored as separate
  // streams. The inline value is the TAIL of the stream (the error and exit sit at the
  // end); when it exceeds RUN_LIMIT the full stream is also written behind
  // `outputRef`/`errorRef`, so the earlier part is retrievable by id. The error stream is
  // never dropped.
  const storeStream = (
    id: string,
    kind: "output" | "error",
    text: string,
  ): Record<string, string> => {
    if (text === "") return {};
    const refKey = kind === "output" ? "outputRef" : "errorRef";
    if (text.length <= RUN_LIMIT) return { [kind]: text };
    const ref = `.skein/observations/${id}.${kind === "output" ? "out" : "err"}.txt`;
    workspace.write(ref, text);
    return { [kind]: tailExcerpt(text, ref, RUN_LIMIT), [refKey]: ref };
  };

  const addEdge = (provenance: Provenance, from: string, to: string, kind: EdgeKind): void => {
    events.push({
      type: "add_edge",
      edge: { id: `e:${next()}`, from, to, kind, provenance },
    });
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
    addEdge({ kind: "llm" }, goalId, planId, "plan");
    return planId;
  };

  const buildItem = (goalId: string): string => {
    const itemSeq = next();
    const itemId = `w:item:${itemSeq}`;
    events.push({
      type: "add_node",
      node: { id: itemId, space: "work", kind: "item", label: `item for ${goalId}`, seq: itemSeq },
    });
    return itemId;
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

  // A goal is born with its plan: one item, seeded with the first command by the caller
  // (docs/ir_revision.md §2.3, §3.1).
  const buildGoal = (spec: { what: string }): {
    goalId: string;
    itemId: string;
  } => {
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
        },
        seq: goalSeq,
      },
    });
    const planId = ensurePlan(id);
    const itemId = buildItem(id);
    addEdge({ kind: "llm" }, planId, itemId, "items");
    return { goalId: id, itemId };
  };

  // Place a new action under the goal (docs/ir_revision.md §4): as a new alternative of the
  // current (first unfulfilled) item, or as a new plan item when the plan is exhausted.
  const placeAction = (goalId: string, actionId: string): void => {
    const item = firstUnfulfilledItem(state, goalId);
    if (item !== undefined) {
      addEdge({ kind: "llm" }, item, actionId, "alts");
      return;
    }
    const planId = ensurePlan(goalId);
    const itemId = buildItem(goalId);
    addEdge({ kind: "llm" }, planId, itemId, "items");
    addEdge({ kind: "llm" }, itemId, actionId, "alts");
  };

  // One plain foreground shell command: recorded as an observation with its exit code,
  // stdout and stderr (docs/ir_revision.md §3.3, §4). A command that changes a forbidden
  // file is reverted and recorded as a violation.
  const runShell = (command: string, actionId: string): ExecOutcome => {
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
    const result = workspace.run(command);
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
          payload: { failed: true, refused: true, pattern, paths: violated.map(([path]) => path), reverted: true },
          seq: observationSeq,
        },
      });
      addEdge({ kind: "llm" }, actionId, observationId, "result");
      return { events, turn: proposalTurn(label, observationId), done: false, stopReason: null };
    }

    const resultSeq = next();
    const resultId = `obs:${resultSeq}`;
    const outputBody = storeStream(resultId, "output", result.stdout);
    const errorBody = storeStream(resultId, "error", result.stderr);
    const outputShown = typeof outputBody.output === "string" ? outputBody.output : "";
    const errorShown = typeof errorBody.error === "string" ? errorBody.error : "";
    const crashSummary = crash === undefined ? `exit ${result.code}` : crashLine(crash);
    const header = `$ ${command}\n${crashSummary}`;
    const diagnostic = crash?.backtrace !== undefined ? `\n${bounded(crash.backtrace, 2000)}` : "";
    const text = `${result.stdout === "" ? header : `${header}\n${outputShown}`}${diagnostic}`;
    const exitCode =
      result.timedOut === true || typeof result.code !== "number" ? undefined : result.code;
    events.push({
      type: "add_node",
      node: {
        id: resultId,
        space: "work",
        kind: "observation",
        label: command,
        payload: {
          command,
          ...(exitCode !== undefined ? { exitCode } : {}),
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
                  ? { backtrace: bounded(crash.backtrace, RUN_LIMIT) }
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
    addEdge({ kind: "llm" }, actionId, resultId, "result");
    return { events, turn: proposalTurn(text, resultId, errorShown), done: false, stopReason: null };
  };

  switch (action.operator) {
    case "recall": {
      const text = runRecall(state, action, workspace);
      const turn = proposalTurn(clip(text));
      return { events, turn: { ...turn, call: recallCall(action) }, done: false, stopReason: null };
    }

    case "search": {
      const text = runSearch(state, action, workspace);
      const turn = proposalTurn(clip(text));
      return { events, turn: { ...turn, call: searchCall(action) }, done: false, stopReason: null };
    }

    case "create_goal": {
      const current = currentGoalId(state);
      if (current === undefined) return fail("create goal failed: no current goal");
      const currentNode = state.nodes.get(current);
      const atRequest = currentNode?.kind === "request";
      // Decomposing an open goal (I6): the sub-goal becomes the current item's newest
      // alternative, so there must be an item to decompose.
      const step = atRequest ? undefined : firstUnfulfilledItem(state, current);
      if (!atRequest && step === undefined) {
        return fail(
          "create goal failed: no current plan item to decompose — a sub-goal can only replace an existing item; apply an action to add the next one",
        );
      }
      const { goalId, itemId } = buildGoal({
        what: action.what,
      });
      if (atRequest) {
        // The request is interpreted as this goal (`goal` relation); the interpretation is fixed.
        addEdge({ kind: "llm" }, current, goalId, "goal");
      } else {
        addEdge({ kind: "llm" }, step as string, goalId, "alts");
      }
      events.push(...descendTo(state, current, goalId));
      // The logos runs the first command at once (docs/ir_revision.md §3.1): the goal is born
      // with its first item executed. Messages: assistant(goal) + assistant(call) + tool(obs).
      const firstCommand = action.command;
      const actionId = buildActionItem(firstCommand, firstCommand, {
        signature: `${firstCommand}\u0000`,
      });
      addEdge({ kind: "llm" }, itemId, actionId, "alts");
      return runShell(firstCommand, actionId);
    }

    case "decline": {
      // Decline to formulate a goal: the request's intent is not actionable. Records an
      // `unactionable` node under the request (edge `no_goal`) and ends the run — no goal,
      // no fake criterion (docs/plans/request_goal_plan.md).
      const seq = next();
      const id = `w:unactionable:${seq}`;
      events.push({
        type: "add_node",
        node: {
          id,
          space: "work",
          kind: "unactionable",
          label: action.why ?? "not actionable",
          ...(action.why !== undefined ? { payload: { why: action.why } } : {}),
          seq,
        },
      });
      const focus = currentGoalId(state);
      if (focus !== undefined) addEdge({ kind: "llm" }, focus, id, "unactionable");
      return {
        events,
        turn: proposalTurn(`declined: ${action.why ?? "not actionable"}`, id),
        done: true,
        stopReason: "request_unactionable",
      };
    }

    case "stop": {
      // The doxa's terminal move, on a goal: a `stop` node hung off the goal via the `stop`
      // relation records the closure and its reason. The engine returns to the request on
      // the next projection and the run ends there. There is no `stop` on the request
      // (docs/ir_revision.md §3.4).
      const focus = currentGoalId(state);
      const focusNode = focus !== undefined ? state.nodes.get(focus) : undefined;
      if (focusNode?.kind !== "goal" || focus === undefined) {
        return fail("stop applies to a goal; the request ends when its goal is stopped");
      }
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
      addEdge({ kind: "llm" }, focus, stopId, "stop");
      return {
        events,
        turn: proposalTurn(`stopped goal: ${focus}`, stopId),
        done: false,
        stopReason: null,
      };
    }

    case "apply": {
      const apply = action.action;
      const focus = currentGoalId(state);
      if (focus === undefined) return fail("apply failed: no current goal");
      const command = commandOf(apply);
      // Every attempt leaves an action node (docs/ir_revision.md §4); it is placed by the
      // outcome of the current item (new alternative, or a new plan item when exhausted).
      const actionId = buildActionItem(command, command, actionExtra(apply));
      placeAction(focus, actionId);
      const failed = (text: string): ExecOutcome => {
        const seq = next();
        const id = `obs:${seq}`;
        events.push({
          type: "add_node",
          node: {
            id,
            space: "work",
            kind: "observation",
            label: text,
            payload: { failed: true, refused: true, output: text },
            seq,
          },
        });
        addEdge({ kind: "llm" }, actionId, id, "result");
        return { events, turn: proposalTurn(text, id), done: false, stopReason: null };
      };
      // Non-execution of a command is an observation with a reason, not a refusal without a
      // node (docs/ir_revision.md §3.3, §4).
      const refusal = commandRefusal(state, apply, command);
      if (refusal !== undefined) return failed(refusal);

      if (apply.tool === "read") {
        // A path outside the workspace is a recorded refusal, not a crash: `exists`
        // throws `path escapes workspace`, and the loop must turn that into a fail
        // observation like `grep`/`list` do (docs/benches/bench_report.md §4.4, problem 5).
        let present: boolean;
        try {
          present = workspace.exists(apply.path);
        } catch (error) {
          return failed(`read failed: ${(error as Error).message}`);
        }
        if (!present) return failed(`read failed: ${apply.path} does not exist`);
        const ref = `file:${apply.path}`;
        let version: string;
        let raw: string;
        try {
          version = workspace.version(apply.path);
          raw = workspace.read(apply.path);
        } catch {
          return failed(`read failed: ${apply.path} disappeared`);
        }
        const window = readWindow(raw, apply.start, apply.end);
        ensureFile(apply.path, ref);
        const observationSeq = next();
        const observationId = `obs:${observationSeq}`;
        // The requested window is shown whole (bounded by the byte budget); if the file is
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
              ...storeOutput(observationId, shown, READ_LIMIT),
            },
            seq: observationSeq,
          },
        });
        addEdge({ kind: "read", ref, version }, actionId, observationId, "result");
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
          return failed(`grep failed: ${(error as Error).message}`);
        }
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
              ...storeOutput(observationId, shown, GREP_LIMIT),
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
          "result",
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
          return failed(`list failed: ${(error as Error).message}`);
        }
        const total = files.length;
        const start = Math.min(Math.max(from - 1, 0), total);
        const page = files.slice(start, start + limit);
        // The window is bounded by dropping whole trailing files (never mid-JSON), so the
        // listing the model asked for is shown whole (docs/ir_semantics.md §7).
        const build = (kept: number): string => {
          const result: Record<string, unknown> = {
            root: apply.path ?? ".",
            total,
            from: total === 0 ? 0 : start + 1,
            returned: kept,
            files: page.slice(0, kept),
          };
          if (start + kept < total) result.next = start + kept + 1;
          return JSON.stringify(result, null, 2);
        };
        let returned = page.length;
        let shown = build(returned);
        while (returned > 1 && shown.length > LIST_LIMIT) {
          returned -= 1;
          shown = build(returned);
        }
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
              ...storeOutput(observationId, shown, LIST_LIMIT),
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
          "result",
        );
        return { events, turn: proposalTurn(shown, observationId), done: false, stopReason: null };
      }

      if (apply.tool === "edit") {
        const ref = `file:${apply.path}`;
        let present: boolean;
        try {
          present = workspace.exists(apply.path);
        } catch (error) {
          return failed(`edit failed: ${(error as Error).message}`);
        }
        if (!present) return failed(`edit failed: ${apply.path} does not exist`);
        let original: string;
        try {
          original = workspace.read(apply.path);
        } catch {
          return failed(`edit failed: ${apply.path} disappeared`);
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
              payload: { failed: true, ...storeOutput(observationId, full, READ_LIMIT) },
              seq: observationSeq,
            },
          });
          addEdge({ kind: "llm" }, actionId, observationId, "result");
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
          return failed(`write failed: ${(error as Error).message}`);
        }
        if (present) {
          const readVersion = latestReadVersion(state, ref);
          if (readVersion === undefined) {
            return failed(
              `write failed: ${apply.path} exists; read it before overwriting (use edit for a small change)`,
            );
          }
          if (currentVersion(state, ref) !== readVersion) {
            return failed(`write failed: stale base: ${apply.path} changed since it was read; re-read first`);
          }
        }
        try {
          workspace.write(apply.path, apply.content);
        } catch (error) {
          return failed(`write failed: ${(error as Error).message}`);
        }
        const version = workspace.version(apply.path);
        ensureFile(apply.path, ref);
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
          return failed(`fetch failed: ${(error as Error).message}`);
        }
        if (present) return failed(`fetch failed: ${path} already exists; choose another path`);
        let fetched: { path: string; bytes: number };
        try {
          fetched = workspace.fetchTo(apply.url, path);
        } catch (error) {
          return failed(`fetch failed: ${(error as Error).message}`);
        }
        const ref = `file:${fetched.path}`;
        ensureFile(fetched.path, ref);
        const version = workspace.version(fetched.path);
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
        addEdge({ kind: "llm" }, actionId, observationId, "result");
        return { events, turn: proposalTurn(text, observationId), done: false, stopReason: null };
      }

      if (apply.tool === "apply_patch") {
        const before = signatureMap(workspace);
        try {
          workspace.applyPatch(apply.patch, apply.strip);
        } catch (error) {
          return failed(`apply_patch failed: ${(error as Error).message}`);
        }
        const after = signatureMap(workspace);
        const mutations = changedMutations(workspace, before, after, new Set());
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
        addEdge({ kind: "llm" }, actionId, observationId, "result");
        return { events, turn: proposalTurn(text, observationId), done: false, stopReason: null };
      }

      // apply.tool === "run": one plain foreground command (docs/ir_revision.md §3.3).
      const runCommand = apply.command;
      if (runCommand === undefined || runCommand.trim() === "") {
        return failed("run failed: no command");
      }
      return runShell(runCommand, actionId);
    }
  }
}
