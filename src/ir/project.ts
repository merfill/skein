import {
  alternativesOf,
  childrenOf,
  latestChosen,
  planOf,
  predicateOf,
  type State,
} from "./graph";
import {
  applicable,
  chosenInterpretation,
  currentGoalId,
  cursorOf,
  type Applicable,
} from "./traversal";
import type { DoneWhen, Node, Predicate, Verdict } from "./types";

// The projection is the context for the next operator, not a state dump: the
// traversal branch plus its containers, the global constraints, the full latest
// result, and a summary of previous calls. See docs/projection_ru.md.

export interface Turn {
  seq: number;
  kind: "proposal" | "tool";
  text: string;
  // The result node this tool turn produced, if any: so `lastResult` can name a
  // matching id, and not a stale one (docs/tools_ru.md §4.4).
  nodeId?: string;
}

export interface ProjectionItem {
  id: string;
  kind: "goal" | "action";
  label: string;
  state: Predicate;
  // A goal item's hypothesis (`why`): a refuted item is a previous attempt, and this is
  // what it bet on — so the model does not repeat it (docs/context_design_ru.md §8).
  why?: string;
}

export interface ProjectionAlternative {
  id: string;
  label: string;
  state: Predicate;
  chosen: boolean;
  why?: string;
}

export interface ProjectionPlan {
  cursor?: number;
  items: ProjectionItem[];
}

export interface PathNode {
  id: string;
  kind: "request" | "goal";
  state: Predicate;
  text?: string;
  what?: string;
  why?: string;
  done_when?: DoneWhen;
  plan?: ProjectionPlan;
  alternatives?: { chosen?: string; items: ProjectionAlternative[] };
}

export interface ResultView {
  // Absent when the call produced no result node (query/complete): then the body is
  // shown but is not retrievable by id.
  id?: string;
  kind: "observation" | "check" | "action";
  command?: string;
  ref?: string;
  verdict?: Verdict;
  label?: string;
  output?: string;
}

// A deduplicated summary of a previous call: what was called and its outcome, with
// no result body. This is the model's memory of what was already done (§2.8); the
// latest result itself is shown in `lastResult`.
export interface Call {
  id?: string;
  action: string;
  status: "ok" | "fail" | "refused";
  note?: string;
  count: number;
}

export interface Context {
  path: PathNode[];
  constraints: { id: string; forbid: string[] }[];
  lastResult?: ResultView;
  shown: ResultView[];
  calls: Call[];
  applicable: string[];
  // Whether a `run {target: focus}` CHECK is the expected move now: the focus is an
  // objective goal whose plan is fully carried out. `apply` can still be listed (for a
  // bare exploratory command) while this is false, so the two are not the same thing.
  checkReady: boolean;
  // When the focus plan's cursor points at an action item: its id, to apply verbatim.
  // Absent when the next item is a goal, or the plan is done.
  nextAction?: string;
  budget: { turn: number; maxTurns: number; remaining: number };
}

export interface ProjectOptions {
  budget?: { turn: number; maxTurns: number };
  // The text of the latest tool turn: the one transient result. It is not stored in
  // the IR (invariant 11); the projection renders it in full this once.
  lastOutput?: string;
  // The result node that the latest tool turn produced, if any (so `lastResult.id`
  // addresses the shown body).
  lastOutputId?: string;
  // Results the model asked to see in full this turn (hypothesis + need, §8). Each is
  // addressed by node id; the caller resolves the body (payload or temp file).
  recalled?: { id: string; output: string }[];
}

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

function stripRef(ref: string): string {
  return ref.startsWith("file:") ? ref.slice("file:".length) : ref;
}

function bySeqDesc(a: { seq: number }, b: { seq: number }): number {
  return b.seq - a.seq;
}

function itemView(state: State, id: string): ProjectionItem | undefined {
  const node = state.nodes.get(id);
  if (node === undefined) return undefined;
  if (node.kind !== "goal" && node.kind !== "action") return undefined;
  const payload = node.payload as { why?: unknown } | undefined;
  return {
    id,
    kind: node.kind,
    label: node.label,
    state: predicateOf(state, id),
    ...(typeof payload?.why === "string" ? { why: payload.why } : {}),
  };
}

function planView(state: State, goalId: string, maxItems: number): ProjectionPlan | undefined {
  const planId = planOf(state, goalId);
  if (planId === undefined) return undefined;
  const items = childrenOf(state, planId)
    .map((id) => itemView(state, id))
    .filter((item): item is ProjectionItem => item !== undefined)
    .slice(0, maxItems);
  return { cursor: cursorOf(state, goalId), items };
}

function alternativesView(
  state: State,
  ownerId: string,
  maxItems: number,
): { chosen?: string; items: ProjectionAlternative[] } | undefined {
  const altId = alternativesOf(state, ownerId);
  if (altId === undefined) return undefined;
  const chosen = latestChosen(state, altId);
  const items = childrenOf(state, altId)
    .flatMap((id) => {
      const node = state.nodes.get(id);
      if (node === undefined || node.kind !== "goal") return [];
      const payload = node.payload as { why?: unknown } | undefined;
      return [
        {
          id,
          label: node.label,
          state: predicateOf(state, id),
          chosen: chosen === id,
          ...(typeof payload?.why === "string" ? { why: payload.why } : {}),
        },
      ];
    })
    .slice(0, maxItems);
  return { ...(chosen !== undefined ? { chosen } : {}), items };
}

function pathNode(state: State, id: string, maxItems: number): PathNode | undefined {
  const node = state.nodes.get(id);
  if (node === undefined) return undefined;
  const state_ = predicateOf(state, id);
  if (node.kind === "request") {
    const payload = node.payload as { text?: unknown } | undefined;
    return {
      id,
      kind: "request",
      state: state_,
      ...(typeof payload?.text === "string" ? { text: payload.text } : {}),
      ...((): { alternatives?: PathNode["alternatives"] } => {
        const alternatives = alternativesView(state, id, maxItems);
        return alternatives !== undefined ? { alternatives } : {};
      })(),
    };
  }
  if (node.kind === "goal") {
    const payload = node.payload as { what?: unknown; why?: unknown; done_when?: DoneWhen } | undefined;
    const plan = planView(state, id, maxItems);
    const alternatives = alternativesView(state, id, maxItems);
    return {
      id,
      kind: "goal",
      state: state_,
      ...(typeof payload?.what === "string" ? { what: payload.what } : {}),
      ...(typeof payload?.why === "string" ? { why: payload.why } : {}),
      ...(payload?.done_when !== undefined ? { done_when: payload.done_when } : {}),
      ...(plan !== undefined ? { plan } : {}),
      ...(alternatives !== undefined ? { alternatives } : {}),
    };
  }
  return undefined;
}

function actionRef(state: State, actionId: string): string | undefined {
  for (const edge of state.edges.values()) {
    if (edge.kind === "mutates" && edge.from === actionId) return stripRef(edge.to);
  }
  return undefined;
}

function buildView(state: State, node: Node, output: string | undefined): ResultView {
  const payload = node.payload as Record<string, unknown> | undefined;
  if (node.kind === "check") {
    return {
      id: node.id,
      kind: "check",
      ...(typeof payload?.command === "string" ? { command: payload.command } : {}),
      ...(typeof payload?.verdict === "string" ? { verdict: payload.verdict as Verdict } : {}),
      ...(output !== undefined ? { output } : {}),
    };
  }
  if (node.kind === "observation") {
    const ref = typeof payload?.ref === "string" ? stripRef(payload.ref) : undefined;
    return {
      id: node.id,
      kind: "observation",
      ...(ref !== undefined
        ? { ref }
        : typeof payload?.command === "string"
          ? { command: payload.command }
          : {}),
      ...(typeof payload?.verdict === "string" ? { verdict: payload.verdict as Verdict } : {}),
      ...(output !== undefined ? { output } : {}),
    };
  }
  const ref = actionRef(state, node.id);
  return {
    id: node.id,
    kind: "action",
    label: node.label,
    ...(ref !== undefined ? { ref } : {}),
    ...(output !== undefined ? { output } : {}),
  };
}

function resultView(
  state: State,
  lastOutput: string | undefined,
  lastOutputId: string | undefined,
): ResultView | undefined {
  // The latest tool turn: pair its output with the node it actually produced, so the
  // id addresses that body and not a stale previous node. A turn that produced no node
  // (query/complete) is shown without an id.
  if (lastOutput !== undefined) {
    if (lastOutputId !== undefined) {
      const view = viewOfNode(state, lastOutputId, lastOutput);
      if (view !== undefined) return view;
    }
    return { kind: "action", label: "(latest call)", output: lastOutput };
  }
  const node = [...state.nodes.values()]
    .filter(
      (candidate) =>
        candidate.kind === "observation" ||
        candidate.kind === "check" ||
        candidate.kind === "action",
    )
    .sort(bySeqDesc)[0];
  if (node === undefined) return undefined;
  const payload = node.payload as Record<string, unknown> | undefined;
  const output = typeof payload?.output === "string" ? payload.output : undefined;
  return buildView(state, node, output);
}

// A view of a specific node, with the body the caller resolved (payload or temp file).
function viewOfNode(state: State, id: string, output: string | undefined): ResultView | undefined {
  const node = state.nodes.get(id);
  if (node === undefined) return undefined;
  if (node.kind !== "observation" && node.kind !== "check" && node.kind !== "action") {
    return undefined;
  }
  return buildView(state, node, output);
}

function applicableNames(value: Applicable): string[] {
  const names: string[] = [];
  if (value.createGoal) names.push("create_goal");
  if (value.apply) names.push("apply");
  if (value.complete) names.push("complete");
  return names;
}

function lastLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length > 0 ? (lines[lines.length - 1] ?? "") : "";
}

// The most informative line of a failure: the first line that looks like an error,
// else the first non-empty line. Avoids tail lines such as "duration_ms" in a test
// report (docs/tools_ru.md §4.4).
const ERROR_HINT = /(error|fail|fatal|assert|exception|expected|cannot|denied|not found|abort|panic|traceback|segmentation)/i;

function errorLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.find((line) => ERROR_HINT.test(line)) ?? lines[0] ?? "";
}

// A compact, informative hint for a call entry, so the model can tell whether the
// stored result is worth fetching by id (docs/tools_ru.md §4.4, context §9). Bodies are
// never inlined here.
function callNote(child: Node | undefined, status: Call["status"]): string | undefined {
  const payload = child?.payload as Record<string, unknown> | undefined;
  if (typeof payload?.summary === "string") return clip(payload.summary, 120);
  if (status === "fail") {
    const output = typeof payload?.output === "string" ? payload.output : "";
    return clip(errorLine(output) || "(no output)", 120);
  }
  if (typeof payload?.verdict === "string") {
    // A piped build (`make … | tail`) exits 0, so its verdict is "pass" while the output
    // still carries the crash; surface the error line, not just the last line.
    const output = typeof payload.output === "string" ? payload.output : "";
    const detail = errorLine(output) || lastLine(output);
    return clip(detail === "" ? payload.verdict : `${payload.verdict}; ${detail}`, 120);
  }
  if (typeof payload?.ref === "string" && typeof payload.total === "number") {
    const start = typeof payload.start === "number" ? payload.start : 1;
    const end = typeof payload.end === "number" ? payload.end : payload.total;
    return clip(`${stripRef(payload.ref)} lines ${start}–${end} of ${payload.total}`, 120);
  }
  return undefined;
}

function producedChild(state: State, actionId: string): Node | undefined {
  let best: Node | undefined;
  for (const edge of state.edges.values()) {
    if (edge.kind !== "produces" || edge.from !== actionId) continue;
    const node = state.nodes.get(edge.to);
    if (node === undefined) continue;
    if (best === undefined || node.seq > best.seq) best = node;
  }
  return best;
}

function producedBy(state: State, observationId: string): boolean {
  for (const edge of state.edges.values()) {
    if (edge.kind === "produces" && edge.to === observationId) return true;
  }
  return false;
}

// The scope of the `calls` index: the subtree of the current chosen interpretation, not
// just the focus path, so evidence gathered in earlier stages stays addressable
// (semantics §2.8). Empty until an interpretation is chosen.
function interpretationScope(state: State, fallback: readonly string[]): Set<string> {
  const scope = new Set<string>();
  const root = state.rootId;
  const start = root === undefined ? undefined : chosenInterpretation(state, root);
  if (start === undefined) return new Set(fallback);
  const stack = [start];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (scope.has(id)) continue;
    scope.add(id);
    const plan = planOf(state, id);
    if (plan !== undefined) stack.push(plan);
    const alt = alternativesOf(state, id);
    if (alt !== undefined) stack.push(alt);
    for (const child of childrenOf(state, id)) stack.push(child);
  }
  return scope;
}

// Summarize previous calls (§2.8): refusals (logos decisions) and executed actions
// with their outcome (`ok`/`fail`), deduplicated by `(status, action)`, scoped to the
// current interpretation's subtree. Both failures and successes are kept as a running
// log — a failed attempt and its error line stay visible after later edits, so the model
// sees what it tried and how it failed, like a person would. Newest first, no result
// bodies.
function callsView(state: State, branch: ReadonlySet<string>): Call[] {
  const byKey = new Map<string, { call: Call; seq: number }>();
  const put = (
    action: string,
    status: Call["status"],
    note: string | undefined,
    seq: number,
    id?: string,
  ): void => {
    const key = `${status}\u0000${action}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        call: { ...(id !== undefined ? { id } : {}), action, status, ...(note !== undefined ? { note } : {}), count: 1 },
        seq,
      });
      return;
    }
    existing.call.count += 1;
    if (seq > existing.seq) {
      existing.seq = seq;
      if (id !== undefined) existing.call.id = id;
    }
  };

  for (const rejection of state.rejections) {
    if (rejection.focus !== "" && !branch.has(rejection.focus)) continue;
    if (rejection.constraintId === undefined && rejection.seq < state.lastMutationSeq) continue;
    put(`${rejection.tool} ${rejection.target}`.trim(), "refused", rejection.reason, rejection.seq);
  }

  for (const node of state.nodes.values()) {
    if (node.kind !== "action" || predicateOf(state, node.id) !== "executed") continue;
    const focus = state.focusOf.get(node.id);
    if (focus !== undefined && !branch.has(focus)) continue;
    const payload = node.payload as { command?: unknown } | undefined;
    const action = typeof payload?.command === "string" ? payload.command : node.label;
    const child = producedChild(state, node.id);
    const verdict = (child?.payload as { verdict?: unknown } | undefined)?.verdict;
    const status: Call["status"] = verdict === "fail" ? "fail" : "ok";
    let note = callNote(child, status);
    if (note === undefined && action.startsWith("edit ")) note = "applied";
    // The address of the result is the produced child when there is one, else the
    // action itself (so the model can recall the body).
    put(action, status, note, node.seq, child?.id ?? node.id);
  }

  for (const node of state.nodes.values()) {
    if (node.kind !== "observation" || producedBy(state, node.id)) continue;
    const payload = node.payload as Record<string, unknown> | undefined;
    if (payload?.verdict !== "fail") continue;
    const focus = state.focusOf.get(node.id);
    if (focus !== undefined && !branch.has(focus)) continue;
    const output = typeof payload.output === "string" ? payload.output : node.label;
    put(node.label, "fail", clip(lastLine(output) || "(no output)", 120), node.seq, node.id);
  }

  return [...byKey.values()]
    .sort((a, b) => b.seq - a.seq)
    .map((entry) => entry.call);
}

export function project(state: State, options: ProjectOptions = {}): Context {
  const maxItems = envInt("SKEIN_CTX_ITEMS", 20);

  const focusId = currentGoalId(state);
  const branch = state.branch.length > 0 ? state.branch : state.rootId !== undefined ? [state.rootId] : [];
  const path = branch
    .map((id) => pathNode(state, id, maxItems))
    .filter((node): node is PathNode => node !== undefined);

  const constraints = [...state.nodes.values()]
    .filter((node) => node.kind === "constraint")
    .map((node) => {
      const payload = node.payload as { forbid?: unknown } | undefined;
      const forbid = Array.isArray(payload?.forbid)
        ? payload.forbid.filter((pattern): pattern is string => typeof pattern === "string")
        : [];
      return { id: node.id, forbid };
    });

  const lastResult = resultView(state, options.lastOutput, options.lastOutputId);
  const calls = callsView(state, interpretationScope(state, branch));
  const shown = (options.recalled ?? [])
    .map((entry) => viewOfNode(state, entry.id, entry.output))
    .filter((view): view is ResultView => view !== undefined);
  const budget = options.budget;
  const frontier = applicable(state, focusId);

  return {
    path,
    constraints,
    ...(lastResult !== undefined ? { lastResult } : {}),
    shown,
    calls,
    applicable: applicableNames(frontier),
    checkReady: frontier.checkReady,
    ...(frontier.nextAction !== undefined ? { nextAction: frontier.nextAction } : {}),
    budget: budget === undefined
      ? { turn: 0, maxTurns: 0, remaining: 0 }
      : {
          turn: budget.turn,
          maxTurns: budget.maxTurns,
          remaining: Math.max(0, budget.maxTurns - budget.turn),
        },
  };
}
