import type { Event } from "../ir/events";
import { observationText } from "../ir/project";
import type {
  CancelResult,
  LeaveResult,
  PausedState,
  PlanExecutionResult,
  SessionTurnResult,
} from "./driver";
import type { PlannerDraft } from "./planner";

// The terminal view is a deterministic projection of a driver turn, not a second store: the
// session-unit journal supplies the tool calls/results, the task events supply the work, and
// the answers stay Markdown. Reasoning is diagnostic only (`verbose`).

export interface RenderOptions {
  verbose?: boolean;
}

const RESULT_LIMIT = 600;
const REASONING_LIMIT = 2000;
const TRUNCATED = "… [truncated; use --verbose]";

function short(text: string, limit = RESULT_LIMIT): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

// Tool results keep their lines: a grep/list preview is read, not retold. `--verbose` expands
// the complete result (already bounded by the tool itself).
function resultText(text: string, options: RenderOptions): string {
  if (options.verbose === true || text.length <= RESULT_LIMIT) return text;
  return text.slice(0, RESULT_LIMIT) + TRUNCATED;
}

// The provider's hidden reasoning, shown like opencode's collapsed "Thought" block: only on
// `--verbose`, since a plain terminal cannot collapse it.
function thoughtLines(reasoning: string | undefined, options: RenderOptions): string[] {
  if (options.verbose !== true || reasoning === undefined) return [];
  const text = reasoning.trim();
  if (text === "") return [];
  const shown = text.length > REASONING_LIMIT ? `${text.slice(0, REASONING_LIMIT)}…` : text;
  return ["  Thought:", ...shown.split("\n").map((line) => `    ${line}`)];
}

function payloadOf(event: Event): Record<string, unknown> | undefined {
  return event.type === "add_node"
    ? (event.node.payload as Record<string, unknown> | undefined)
    : undefined;
}

function reasoningOf(payload: Record<string, unknown> | undefined): string | undefined {
  const reasoning = payload?.reasoning;
  return typeof reasoning === "string" && reasoning.trim() !== "" ? reasoning : undefined;
}

// The session agent's own tool calls and results. The operation tools (`respond`/`task`) are
// the decision line itself, so they are not repeated here.
function sessionLines(journal: readonly Event[], options: RenderOptions): string[] {
  const lines: string[] = [];
  for (const event of journal) {
    if (event.type !== "add_node") continue;
    const node = event.node;
    const payload = payloadOf(event);
    if (node.kind === "action") {
      const tool = String(payload?.tool ?? "");
      if (tool === "respond" || tool === "task" || tool === "plan") continue;
      lines.push(...thoughtLines(reasoningOf(payload), options));
      lines.push(`  call: ${tool}(${JSON.stringify(payload?.args ?? {})})`);
    } else if (node.kind === "observation") {
      const tool = String(payload?.tool ?? "");
      if (tool === "respond" || tool === "task" || tool === "plan") continue;
      lines.push(`  result: ${resultText(String(payload?.result ?? node.label), options)}`);
    }
  }
  return lines;
}

function generalAnswer(events: readonly Event[]): string | undefined {
  let answer: string | undefined;
  for (const event of events) {
    if (event.type !== "add_node" || event.node.kind !== "stop") continue;
    const payload = event.node.payload as { answer?: unknown } | undefined;
    answer = typeof payload?.answer === "string" ? payload.answer : event.node.label;
  }
  return answer;
}

function taskAnswer(events: readonly Event[]): string | undefined {
  let answer: string | undefined;
  for (const event of events) {
    if (event.type === "add_node" && event.node.kind === "stop") answer = event.node.label;
  }
  return answer;
}

function taskLines(events: readonly Event[], options: RenderOptions): string[] {
  const lines: string[] = [];
  for (const event of events) {
    if (event.type === "record_rejection") {
      lines.push(`  rejected: ${event.tool} ${event.target}: ${event.reason}`);
      continue;
    }
    if (event.type !== "add_node") continue;
    const node = event.node;
    const payload = payloadOf(event);
    if (node.kind === "move") {
      lines.push(`  move: ${String(payload?.state)} — ${short(String(payload?.what ?? ""), 120)}`);
    } else if (node.kind === "action") {
      lines.push(...thoughtLines(reasoningOf(payload), options));
      lines.push(`  action: ${node.label}`);
    } else if (node.kind === "observation") {
      lines.push(`  observation ${node.id}: ${resultText(observationText(node), options)}`);
    } else if (node.kind === "stop") {
      lines.push(`  stop: ${short(node.label)}`);
    }
  }
  return lines;
}

export function renderTurn(result: SessionTurnResult, options: RenderOptions = {}): string[] {
  const lines =
    result.interpretation !== undefined ? sessionLines(result.interpretation.journal, options) : [];

  const operation = result.operation;
  if (operation === undefined) {
    const reason =
      result.noDecision === "max_turns"
        ? "max turns"
        : result.noDecision === "empty_reply"
          ? "empty reply"
          : undefined;
    lines.push(reason !== undefined ? `session: no decision (${reason})` : "session: no action");
  } else if (operation.kind === "respond") {
    lines.push("session: respond");
  } else if (operation.kind === "general") {
    lines.push(`session: general("${operation.text}")`);
  } else if (operation.kind === "plan") {
    lines.push(`session: plan("${operation.text}")`);
  } else if (operation.kind === "document") {
    lines.push(`session: document("${operation.text}")`);
  } else {
    lines.push(`session: task("${operation.text}")`);
  }
  lines.push(...thoughtLines(result.reasoning, options));
  if (result.applied !== undefined && !result.applied.ok) {
    lines.push(`refused: ${result.applied.reason}`);
  }
  if (result.reply !== undefined) {
    lines.push("answer:", result.reply);
  }

  if (result.task !== undefined) {
    const { unitId, result: run } = result.task;
    const outcome = run.done ? (run.stopReason ?? "done") : "still open";
    lines.push(`task ${unitId}: ${outcome} after ${run.turns} turns`);
    lines.push(...taskLines(run.events, options));
    const answer = taskAnswer(run.events);
    if (run.done && answer !== undefined && answer !== "") lines.push(`task answer: ${answer}`);
  }

  if (result.general !== undefined) {
    const { unitId, result: run } = result.general;
    const outcome = run.done ? (run.stopReason ?? "done") : "still open";
    lines.push(`general ${unitId}: ${outcome} after ${run.turns} turns`);
    lines.push(...taskLines(run.events, options));
    const answer = generalAnswer(run.events);
    if (answer !== undefined && answer !== "") lines.push("general answer:", answer);
  }
  if (result.document !== undefined) {
    const { unitId, result: run } = result.document;
    const outcome = run.done ? (run.stopReason ?? "done") : "still open";
    lines.push(`document ${unitId}: ${outcome} after ${run.turns} turns`);
    if (run.outline !== undefined) {
      lines.push(`document: ${run.outline.path} (${run.outline.items.length} sections)`);
    }
    const answer = stopText(run.events);
    if (run.done && answer !== undefined && answer !== "") {
      lines.push("document summary:", answer);
    }
  }
  if (result.plan !== undefined) {
    const { unitId, result: run } = result.plan;
    const outcome =
      run.plan !== undefined ? `${run.plan.items.length} item(s)` : (run.stopReason ?? "no plan");
    lines.push(`plan ${unitId}: ${outcome} after ${run.turns} turns`);
    if (run.plan !== undefined) {
      lines.push("", renderPlanDraft(run.plan), "");
      lines.push("plan ready: [e]xecute  [r]ework  [q]uit");
    } else {
      lines.push("no plan was produced; the plan unit is not completed");
    }
  }
  if (result.paused !== undefined) {
    lines.push(renderPauseMenu(result.paused));
  }
  return lines;
}

export function renderPlanDraft(draft: PlannerDraft): string {
  const lines: string[] = [];
  if (draft.summary !== undefined) lines.push(draft.summary, "");
  for (const [index, item] of draft.items.entries()) {
    const kind = item.kind === "document" ? "document" : item.kind === "general" ? "general" : "coding";
    lines.push(`${index + 1}. **${item.title}** _(${kind})_`);
    if (item.detail !== "") lines.push(`   ${item.detail}`);
    if (item.done !== undefined) lines.push(`   Done when: ${item.done}`);
  }
  return lines.join("\n");
}

function stopText(events: readonly Event[]): string | undefined {
  let text: string | undefined;
  for (const event of events) {
    if (event.type !== "add_node" || event.node.kind !== "stop") continue;
    const payload = event.node.payload as { answer?: unknown } | undefined;
    text = typeof payload?.answer === "string" ? payload.answer : event.node.label;
  }
  return text;
}

// A plan run's outcome: the units opened, their item and result, and the final status. The
// terminal view prints each item's answer inline; the TUI renders those answers as their own
// Markdown blocks (`answers: false` keeps only the summary lines here).
export function renderPlanRun(
  result: PlanExecutionResult,
  options: { answers?: boolean } = {},
): string[] {
  const lines = [
    `plan ${result.planUnitId}: ${result.status} (${result.completed}/${result.total})`,
  ];
  for (const unit of result.units) {
    const outcome = unit.result.done ? (unit.result.stopReason ?? "done") : "still open";
    lines.push(`  item ${unit.itemId}: ${unit.kind} ${unit.unitId} — ${outcome}`);
    const answer = stopText(unit.result.events);
    if (options.answers !== false && answer !== undefined && answer !== "") {
      lines.push(`    ${short(answer, 600)}`);
    }
  }
  if (result.acceptance !== undefined) {
    lines.push(
      `  acceptance ${result.acceptance.unitId}: ${result.acceptance.ok ? "pass" : "fail"}`,
    );
    if (options.answers !== false && !result.acceptance.ok && result.acceptance.answer !== "") {
      lines.push(`    ${short(result.acceptance.answer, 600)}`);
    }
  }
  if (result.reply !== undefined) lines.push("answer:", result.reply);
  if (result.noDecision !== undefined) lines.push(`no decision: ${result.noDecision}`);
  if (result.plan !== undefined) {
    lines.push(...renderPlanDraft(result.plan.result.plan ?? { items: [] }));
    lines.push("new plan ready");
  }
  if (result.paused !== undefined) lines.push(renderPauseMenu(result.paused));
  return lines;
}

// The pause menu is the same fact for both interfaces; the session agent cannot "leave to
// itself", and leaving keeps the work while cancel is the destructive choice.
export function renderPauseMenu(paused: PausedState): string {
  if (paused.budget !== undefined) {
    return `turn limit (${paused.budget}) reached: [c]ontinue +${paused.budgetExtend ?? 10}  [f]inish & report  [s]ession  [q]uit`;
  }
  if (paused.agent === "session") {
    return "paused session: [r]esume  [c]discard  [q]uit";
  }
  return `paused ${paused.agent} ${paused.unitId}: [r]esume  [s]ession  [c]ancel & roll back  [q]uit`;
}

export function renderLeave(result: LeaveResult): string[] {
  return [
    `left ${result.unitId} open (suspended); work kept`,
    "next message goes to the session agent",
  ];
}

export function renderCancel(result: CancelResult): string[] {
  const lines = ["cancelled"];
  if (result.warning !== undefined) lines.push(`warning: ${result.warning}`);
  return lines;
}
