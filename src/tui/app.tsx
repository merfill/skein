import { Box, Text, useApp, useInput, useStdin, useStdout, useWindowSize } from "ink";
import React, { useEffect, useRef, useState } from "react";

import type { Event } from "../ir/events";
import { fold } from "../ir/graph";
import { currentMove } from "../ir/traversal";
import { createSession } from "../session/session";
import {
  cancelTurn,
  executePlan,
  leaveTurn,
  resumeTurn,
  runSessionTurn,
  type PausedState,
  type PlanExecutionResult,
  type SessionTurnDeps,
  type SessionTurnResult,
} from "../session/driver";
import { renderPlanDraft, renderPlanRun } from "../session/view";
import { planModeOf } from "../session/plan";
import {
  sessionSummary,
  usageTotals,
  type MemoryTelemetry,
} from "../session/telemetry";
import type { ProgressEvent } from "../session/progress";
import { createSessionLog, type SessionLog } from "../session/session_log";
import type { SessionState } from "../session/types";
import { buildTuiView, type TaskTiming } from "./view_model";
import { traceLines, traceWindow } from "./trace_lines";
import { theme } from "./theme";
import {
  COMMANDS,
  detectMention,
  detectSlash,
  rankCommands,
  rankFiles,
  replaceRange,
  type CompletionItem,
  type Mention,
} from "./completion";
import {
  ActivityBar,
  CompletionPanel,
  Composer,
  Footer,
  HeaderBar,
  HelpOverlay,
  HistoryOverlay,
  PauseOverlay,
  TaskPanel,
  TracePanel,
} from "./panels";
import type { Focus, TraceEntry } from "./types";

export interface ModelChange {
  deps: SessionTurnDeps;
  label: string;
}

export interface TuiAppProps {
  deps: SessionTurnDeps;
  telemetry: MemoryTelemetry;
  workspace: string;
  model: string;
  session?: SessionState;
  // Live model switching: the CLI rebuilds the model and every proposer, and returns the new
  // dependencies. Absent when the host does not configure providers.
  onModelChange?: (model: string) => Promise<ModelChange | { error: string }>;
  listModels?: () => Promise<string[]>;
}

interface CompletionView {
  kind: "mention" | "command";
  key: string;
  items: CompletionItem[];
  mention?: Mention;
}

function taskOutcome(events: readonly Event[], stopReason: string | null): string {
  const state = fold(events);
  const move = currentMove(state);
  if (move === undefined) return stopReason ?? "done";
  const payload = state.nodes.get(move)?.payload as { state?: unknown } | undefined;
  const island = typeof payload?.state === "string" ? payload.state : "?";
  for (const event of events) {
    if (event.type === "add_node" && event.node.kind === "stop" && event.node.label !== "") {
      return `${island}: ${event.node.label}`;
    }
  }
  return stopReason ?? `open at ${island}`;
}

function answerOf(events: readonly Event[]): string | undefined {
  let answer: string | undefined;
  for (const event of events) {
    if (event.type !== "add_node" || event.node.kind !== "stop") continue;
    const payload = event.node.payload as { answer?: unknown } | undefined;
    answer = typeof payload?.answer === "string" ? payload.answer : event.node.label;
  }
  return answer;
}

function notice(id: string, text: string): TraceEntry {
  return { id, kind: "notice", text };
}

export function TuiApp(props: TuiAppProps) {
  const { deps, telemetry, workspace, model } = props;
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const { stdin, isRawModeSupported } = useStdin();
  const { stdout } = useStdout();
  const sessionRef = useRef(props.session ?? createSession());
  const timingsRef = useRef(new Map<string, TaskTiming>());
  const liveJournals = useRef(new Map<string, Event[]>());
  const traceSeq = useRef(0);
  const runningTools = useRef(new Map<string, string>());
  const abortRef = useRef<AbortController | undefined>(undefined);
  const runningRef = useRef(false);
  const mountedRef = useRef(true);
  const mouseLayout = useRef({ mainWidth: 0, gap: 0, showTask: false, bodyRows: 0 });
  const mouseBlocked = useRef(false);
  const clickRef = useRef<(column: number, row: number) => void>(() => {});
  const toggleTopRef = useRef<() => void>(() => {});
  const modelStarts = useRef(new Map<string, number>());
  const logRef = useRef<SessionLog | null>(null);
  const filesRef = useRef<string[] | null>(null);
  const depsRef = useRef(deps);

  const [tick, setTick] = useState(0);
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const historyDraft = useRef("");
  const [focus, setFocus] = useState<Focus>("composer");
  const [running, setRunning] = useState(false);
  const [activity, setActivity] = useState("idle");
  const [observerNotice, setObserverNotice] = useState<string | undefined>();
  const [mouseCapture, setMouseCapture] = useState(process.env.SKEIN_MOUSE === "true");
  const [paused, setPaused] = useState<PausedState | undefined>();
  const [pendingPlan, setPendingPlan] = useState<string | undefined>();
  const [modelLabel, setModelLabel] = useState(model);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySelected, setHistorySelected] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const [completionSelected, setCompletionSelected] = useState(0);
  const [completionDismissed, setCompletionDismissed] = useState<string | undefined>();
  const [detailScroll, setDetailScroll] = useState(0);
  const [traceScroll, setTraceScroll] = useState(0);

  const view = buildTuiView(sessionRef.current, telemetry.events, {
    now: Date.now(),
    timings: timingsRef.current,
    liveJournals: liveJournals.current,
  });

  const showTask = columns >= 72;
  const panelGap = 2;
  const taskWidth = showTask ? Math.min(44, Math.max(30, Math.floor(columns * 0.32))) : 0;
  const mainWidth = showTask ? Math.max(20, columns - taskWidth - panelGap) : columns;
  const composerRows = 5;
  const composerHeight = composerRows + 2;
  const bodyRows = Math.max(6, rows - 1 - 1 - composerHeight - 1);
  const activeTask = view.current;
  const stateCount = activeTask?.states.length ?? 0;
  const historySelectedIndex = Math.min(
    Math.max(0, historySelected),
    Math.max(0, view.history.length - 1),
  );
  mouseLayout.current = { mainWidth, gap: panelGap, showTask, bodyRows };
  mouseBlocked.current =
    helpOpen || historyOpen || paused !== undefined || pendingPlan !== undefined;

  const workspaceFiles = (): string[] => {
    if (filesRef.current !== null) return filesRef.current;
    let files: string[] = [];
    try {
      const listed = deps.task.workspace?.listFiles;
      if (typeof listed === "function") files = listed.call(deps.task.workspace);
    } catch {
      files = [];
    }
    filesRef.current = files;
    return files;
  };
  const mention = focus === "composer" ? detectMention(input, cursor) : undefined;
  const mentionFiles = mention !== undefined ? rankFiles(workspaceFiles(), mention.query) : [];
  const slash = focus === "composer" && mention === undefined ? detectSlash(input) : undefined;
  const commandMatches = slash !== undefined ? rankCommands(slash.query) : [];
  const completionKey =
    mention !== undefined && mentionFiles.length > 0
      ? `mention:${mention.start}:${mention.query}`
      : slash !== undefined && commandMatches.length > 0
        ? `slash:${slash.query}`
        : undefined;
  let completion: CompletionView | undefined;
  if (completionKey !== undefined && completionKey !== completionDismissed) {
    completion =
      mention !== undefined
        ? {
            kind: "mention",
            key: completionKey,
            mention,
            items: mentionFiles.map((file) => ({ label: file, value: file })),
          }
        : {
            kind: "command",
            key: completionKey,
            items: commandMatches.map((command) => ({
              label: `/${command.name}`,
              detail: command.description,
              value: command.name,
            })),
          };
  }
  const completionIndex =
    completion === undefined
      ? 0
      : Math.max(0, Math.min(completionSelected, completion.items.length - 1));

  const nextId = (): string => {
    traceSeq.current += 1;
    return `trace:${traceSeq.current}`;
  };
  const append = (entry: TraceEntry): void => {
    setTrace((previous) => [...previous, entry]);
  };
  const appendNotice = (text: string): void => append(notice(nextId(), text));
  const toggleEntry = (entryId: string): void => {
    setTrace((previous) =>
      previous.map((entry) =>
        entry.id === entryId ? { ...entry, collapsed: !(entry.collapsed ?? false) } : entry,
      ),
    );
  };

  useEffect(() => {
    const log = createSessionLog(workspace);
    logRef.current = log;
    if (log.path !== "") {
      log.write({ type: "session_start", workspace, model });
      appendNotice(`log: ${log.path}`);
    }
    return () => {
      log.close();
      logRef.current = null;
    };
  }, [workspace, model]);

  useEffect(() => {
    appendNotice(
      process.stdout.isTTY !== true
        ? "mouse: stdout is not a TTY"
        : !isRawModeSupported
          ? "mouse: raw mode unavailable"
          : mouseCapture
            ? "mouse: capture on (Ctrl-G off; Shift+drag still selects)"
            : "mouse: capture off (Ctrl-G on)",
    );
  }, []);

  // Native selection is the default: mouse capture stays off, and the terminal's alternate
  // scroll mode turns the wheel into Up/Down, which the TUI already handles. `SKEIN_MOUSE=true`
  // opts into capture (wheel + click on blocks) at the cost of native selection.
  useEffect(() => {
    if (!isRawModeSupported) return;
    const interactive = process.stdout.isTTY === true;
    if (interactive) stdout.write("\u001b[?1007h");
    if (!mouseCapture) {
      return () => {
        if (interactive) stdout.write("\u001b[?1007l");
      };
    }
    if (interactive) stdout.write("\u001b[?1000h\u001b[?1006h");
    let pending = "";
    const onData = (chunk: Buffer | string): void => {
      let text = pending + String(chunk);
      text = text.replace(
        /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g,
        (_match, rawButton: string, rawX: string, rawY: string) => {
          const button = Number(rawButton);
          const column = Number(rawX);
          const row = Number(rawY);
          if (mouseBlocked.current) return "";
          if (button === 0) {
            if (column <= mouseLayout.current.mainWidth) clickRef.current(column, row);
            return "";
          }
          if (button !== 64 && button !== 65) return "";
          const layout = mouseLayout.current;
          const overTask =
            layout.showTask &&
            column > layout.mainWidth + layout.gap &&
            row >= 2 &&
            row <= 1 + layout.bodyRows;
          const direction = button === 64 ? 1 : -1;
          if (overTask) {
            setDetailScroll((value) => Math.max(0, value - direction * 3));
          } else {
            setTraceScroll((value) => Math.max(0, value + direction * 3));
          }
          return "";
        },
      );
      pending = text.slice(-32);
    };
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
      if (interactive) stdout.write("\u001b[?1000l\u001b[?1006l\u001b[?1007l");
    };
  }, [isRawModeSupported, stdin, stdout, mouseCapture]);

  useEffect(() => {
    if (paused === undefined && !running) return;
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [paused, running]);

  useEffect(() => {
    setDetailScroll(0);
  }, [activeTask?.unitId]);

  useEffect(() => {
    // A new state means a new detail block; never keep the previous state's scroll.
    setDetailScroll(0);
  }, [stateCount]);

  const mentionActive = mention !== undefined;
  useEffect(() => {
    setCompletionSelected(0);
  }, [mention?.query, slash?.query]);

  useEffect(() => {
    // The file index is rebuilt the next time a mention opens, so files created by a
    // finished task show up without keeping a stale tree for the whole session.
    if (!mentionActive) filesRef.current = null;
  }, [mentionActive]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const handleProgress = (event: ProgressEvent): void => {
    if (!mountedRef.current) return;
    const log = logRef.current;
    if (log !== null) {
      if (event.type === "events_added") {
        log.write({ record: "progress", ...event, events: event.events.length });
      } else if (event.type === "tool_finished") {
        const { preview, ...rest } = event;
        log.write({ record: "progress", ...rest, previewChars: preview?.length ?? 0 });
      } else if (event.type === "model_call_finished") {
        const { reasoning, ...rest } = event;
        log.write({
          record: "progress",
          ...rest,
          ...(reasoning !== undefined
            ? { reasoning: reasoning.slice(0, 4000), reasoningChars: reasoning.length }
            : {}),
        });
      } else {
        log.write({ record: "progress", ...event });
      }
    }
    const agent = "agent" in event ? event.agent : undefined;
    if (agent === "observer") {
      if (event.type === "turn_started" || event.type === "model_call_started") {
        setObserverNotice(`t${event.turn + 1}`);
      }
    } else if (agent !== undefined) {
      setObserverNotice(undefined);
    }
    switch (event.type) {
      case "turn_started": {
        const unit = sessionRef.current.units.get(event.unitId);
        if (
          (unit?.type === "task" || unit?.type === "general" || unit?.type === "plan") &&
          timingsRef.current.get(event.unitId)?.startedAt === undefined
        ) {
          timingsRef.current.set(event.unitId, { startedAt: Date.now() });
        }
        setActivity(`${event.agent} · turn ${event.turn + 1}`);
        break;
      }
      case "model_call_started":
        modelStarts.current.set(`${event.agent}|${event.unitId}|${event.turn}`, Date.now());
        setActivity(`${event.agent} · model`);
        break;
      case "model_call_finished": {
        const key = `${event.agent}|${event.unitId}|${event.turn}`;
        const startedAt = modelStarts.current.get(key);
        modelStarts.current.delete(key);
        setActivity(`${event.agent} · model ${event.status}`);
        const reasoning = event.reasoning?.trim();
        if (reasoning !== undefined && reasoning !== "") {
          append({
            id: nextId(),
            kind: "thought",
            agent: event.agent,
            text: "",
            reasoning,
            collapsed: true,
            ...(startedAt !== undefined ? { durationMs: Date.now() - startedAt } : {}),
          });
        }
        break;
      }
      case "tool_started": {
        if (event.tool === "move" || event.tool === "stop") {
          setActivity(`${event.agent} · ${event.tool}`);
          break;
        }
        const id = nextId();
        const key = `${event.agent}|${event.unitId}|${event.turn}|${event.tool}|${event.target}`;
        runningTools.current.set(key, id);
        append({
          id,
          kind: "tool",
          agent: event.agent,
          tool: event.tool,
          target: event.target,
          status: "running",
          text: event.target,
          collapsed: event.edit === undefined,
          ...(event.edit !== undefined ? { edit: event.edit } : {}),
        });
        setActivity(`${event.agent} · ${event.tool} ${event.target}`);
        break;
      }
      case "tool_finished": {
        const key = `${event.agent}|${event.unitId}|${event.turn}|${event.tool}|${event.target}`;
        const id = runningTools.current.get(key);
        runningTools.current.delete(key);
        if (id !== undefined) {
          setTrace((previous) =>
            previous.map((entry) =>
              entry.id === id
                ? {
                    ...entry,
                    status: event.status,
                    ...(event.preview !== undefined
                      ? { preview: event.preview.slice(0, 4000) }
                      : {}),
                  }
                : entry,
            ),
          );
        }
        const unit = sessionRef.current.units.get(event.unitId);
        if (unit?.type === "task" || unit?.type === "general" || unit?.type === "plan") {
          unit.turn = Math.max(unit.turn, event.turn + 1);
        }
        setActivity(`${event.agent} · ${event.tool} ${event.status}`);
        break;
      }
      case "events_added": {
        const unit = sessionRef.current.units.get(event.unitId);
        if (unit?.type === "task" || unit?.type === "general" || unit?.type === "plan") {
          const current = liveJournals.current.get(unit.id) ?? [...unit.journal];
          liveJournals.current.set(unit.id, [...current, ...event.events]);
        }
        setTick((value) => value + 1);
        break;
      }
      case "state_changed": {
        const closed = event.closed === true;
        const what = event.what !== undefined && event.what !== "" ? ` — ${event.what}` : "";
        append({
          id: nextId(),
          kind: "state",
          text: `${event.state ?? "?"}${closed ? " closed" : what}`,
        });
        setActivity(`task · ${event.state ?? "state"}${closed ? " closed" : ""}`);
        break;
      }
      case "turn_finished": {
        const unit = sessionRef.current.units.get(event.unitId);
        if (unit?.type === "task" || unit?.type === "general" || unit?.type === "plan") {
          unit.turn = Math.max(unit.turn, event.turn + 1);
        }
        setActivity(`${event.agent} · turn done`);
        break;
      }
      case "paused":
        setActivity("paused");
        break;
    }
  };

  const runDeps = (): SessionTurnDeps => {
    const current = depsRef.current;
    return {
      ...current,
      onProgress: handleProgress,
      sessionAgent: { ...current.sessionAgent, onProgress: handleProgress },
      task: {
        ...current.task,
        onProgress: handleProgress,
        ...(current.task.observer !== undefined
          ? { observer: { ...current.task.observer, onProgress: handleProgress } }
          : {}),
      },
      ...(current.general !== undefined
        ? { general: { ...current.general, onProgress: handleProgress } }
        : {}),
      ...(current.planner !== undefined
        ? { planner: { ...current.planner, onProgress: handleProgress } }
        : {}),
    };
  };

  const finishTaskTiming = (result: SessionTurnResult): void => {
    const finished = result.task ?? result.general ?? result.plan;
    if (finished === undefined) return;
    const unitId = finished.unitId;
    liveJournals.current.delete(unitId);
    const timing = timingsRef.current.get(unitId);
    if (timing === undefined) return;
    if (result.paused !== undefined) {
      timingsRef.current.set(unitId, { startedAt: timing.startedAt });
      return;
    }
    timingsRef.current.set(unitId, { ...timing, endedAt: Date.now() });
  };

  const renderResult = (result: SessionTurnResult): void => {
    const log = logRef.current;
    log?.write({
      type: "result",
      operation: result.operation ?? null,
      applied:
        result.applied !== undefined
          ? {
              ok: result.applied.ok,
              ...(result.applied.ok === false ? { reason: result.applied.reason } : {}),
            }
          : null,
      noDecision: result.noDecision ?? null,
      reply: result.reply ?? null,
      task:
        result.task !== undefined
          ? {
              unitId: result.task.unitId,
              turns: result.task.result.turns,
              done: result.task.result.done,
              stopReason: result.task.result.stopReason,
              stopText: result.task.result.stopText ?? null,
              paused: result.task.result.paused === true,
            }
          : null,
      general:
        result.general !== undefined
          ? {
              unitId: result.general.unitId,
              turns: result.general.result.turns,
              done: result.general.result.done,
              stopReason: result.general.result.stopReason,
              paused: result.general.result.paused === true,
              answer: answerOf(result.general.result.events) ?? null,
            }
          : null,
      plan:
        result.plan !== undefined
          ? {
              unitId: result.plan.unitId,
              turns: result.plan.result.turns,
              done: result.plan.result.done,
              stopReason: result.plan.result.stopReason,
              items: result.plan.result.plan?.items.length ?? 0,
            }
          : null,
    });
    setObserverNotice(undefined);
    finishTaskTiming(result);
    if (result.noDecision !== undefined) {
      appendNotice(`session: no decision (${result.noDecision})`);
    }
    if (result.applied !== undefined && !result.applied.ok) {
      appendNotice(`refused: ${result.applied.reason}`);
    }
    if (result.operation?.kind === "task") {
      appendNotice(`task: ${result.operation.text}`);
    }
    if (result.reply !== undefined) {
      append({ id: nextId(), kind: "assistant", text: result.reply });
    }
    if (result.task !== undefined) {
      const outcome = taskOutcome(result.task.result.events, result.task.result.stopReason);
      appendNotice(
        `task ${result.task.unitId} · ${outcome} · ${result.task.result.turns} turns`,
      );
      const report = result.task.result.done ? answerOf(result.task.result.events) : undefined;
      if (report !== undefined && report.trim() !== "") {
        append({ id: nextId(), kind: "report", text: report });
      }
    }
    if (result.general !== undefined) {
      const outcome = result.general.result.done
        ? (result.general.result.stopReason ?? "answered")
        : "open";
      const answer = answerOf(result.general.result.events);
      appendNotice(
        `general ${result.general.unitId} · ${outcome} · ${result.general.result.turns} turns`,
      );
      if (answer !== undefined && answer !== "") {
        append({ id: nextId(), kind: "assistant", text: answer });
      }
    }
    if (result.plan !== undefined) {
      const run = result.plan.result;
      if (run.plan !== undefined) {
        appendNotice(`plan ${result.plan.unitId} · ${run.plan.items.length} item(s)`);
        append({ id: nextId(), kind: "assistant", text: renderPlanDraft(run.plan) });
        if (result.paused === undefined) {
          setPendingPlan(result.plan.unitId);
          appendNotice("plan ready: [e]xecute  [r]ework  [q]uit");
        }
      } else {
        appendNotice(`plan ${result.plan.unitId} · no plan`);
      }
    }
    if (result.paused !== undefined) {
      setPaused(result.paused);
      setActivity("paused");
    }
  };

  const runModelCommand = async (args: readonly string[]): Promise<void> => {
    if (runningRef.current || paused !== undefined) {
      appendNotice("model: finish or resolve the current turn first");
      return;
    }
    if (args.length === 0) {
      if (props.listModels === undefined) {
        appendNotice("model: listing is not configured");
        return;
      }
      try {
        const models = await props.listModels();
        if (models.length === 0) {
          appendNotice("model: the provider returned no models");
          return;
        }
        const shown = models.slice(0, 20).join(", ");
        appendNotice(`models (${models.length}): ${shown}${models.length > 20 ? ", …" : ""}`);
      } catch (error) {
        appendNotice(`model: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (args.length > 1) {
      appendNotice("usage: /model [model-id]");
      return;
    }
    const id = args[0];
    if (id === undefined) return;
    if (props.onModelChange === undefined) {
      appendNotice("model: switching is not configured");
      return;
    }
    const result = await props.onModelChange(id);
    if ("error" in result) {
      appendNotice(`model: ${result.error}`);
      return;
    }
    depsRef.current = result.deps;
    setModelLabel(result.label);
    logRef.current?.write({ type: "model_changed", model: result.label });
    appendNotice(`model: ${result.label}`);
  };

  const submit = async (): Promise<void> => {
    const trimmed = input.trim();
    if (trimmed === "") return;
    if (!trimmed.startsWith("//") && trimmed.startsWith("/")) {
      const [name, ...args] = trimmed.slice(1).split(/\s+/);
      const spec = COMMANDS.find((command) => command.name === name);
      if (spec === undefined) {
        appendNotice(`unknown command: /${name || "?"} · type ? for help`);
        return;
      }
      if (spec.name === "model") {
        void runModelCommand(args);
        return;
      }
      if (args.length > 0) {
        appendNotice(`/${spec.name}: no arguments`);
        return;
      }
      runCommand(spec.name);
      return;
    }
    if (runningRef.current) return;
    const text = trimmed.startsWith("//") ? trimmed.slice(1) : trimmed;
    logRef.current?.write({ type: "user", text });
    setInputHistory((previous) => [...previous, text].slice(-100));
    setHistoryIndex(null);
    historyDraft.current = "";
    setInput("");
    setCursor(0);
    runningRef.current = true;
    setRunning(true);
    setActivity("session · interpreting");
    const controller = new AbortController();
    abortRef.current = controller;
    append({ id: nextId(), kind: "user", text });
    let pausedResult = false;
    try {
      const result = await runSessionTurn(runDeps(), sessionRef.current, text, {
        signal: controller.signal,
      });
      pausedResult = result.paused !== undefined;
      renderResult(result);
    } catch (error) {
      appendNotice(`error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      runningRef.current = false;
      setRunning(false);
      abortRef.current = undefined;
      setActivity(pausedResult ? "paused" : "idle");
      setTick((value) => value + 1);
    }
  };

  const resume = async (): Promise<void> => {
    const current = paused;
    if (current === undefined || runningRef.current) return;
    setPaused(undefined);
    runningRef.current = true;
    setRunning(true);
    setActivity("resume");
    const controller = new AbortController();
    abortRef.current = controller;
    let pausedResult = false;
    let continuePlan: string | undefined;
    try {
      const result = await resumeTurn(runDeps(), sessionRef.current, current, {
        signal: controller.signal,
      });
      pausedResult = result.paused !== undefined;
      renderResult(result);
      if (result.paused === undefined) {
        const unit = sessionRef.current.units.get(current.unitId);
        continuePlan =
          current.planUnitId ??
          (unit?.planItem !== undefined ? planModeOf(sessionRef.current) : undefined);
      }
    } catch (error) {
      appendNotice(`error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      runningRef.current = false;
      setRunning(false);
      abortRef.current = undefined;
      setActivity(pausedResult ? "paused" : "idle");
      setTick((value) => value + 1);
    }
    if (continuePlan !== undefined) void runPlan(continuePlan);
  };

  const cancel = (): void => {
    const current = paused;
    if (current === undefined) return;
    const workspace =
      current.agent === "general"
        ? (deps.general?.workspace ?? deps.task.workspace)
        : current.agent === "plan"
          ? (deps.planner?.workspace ?? deps.task.workspace)
          : deps.task.workspace;
    const result = cancelTurn(workspace, sessionRef.current, current, deps.telemetry);
    setPaused(undefined);
    appendNotice("cancelled");
    if (result.warning !== undefined) appendNotice(result.warning);
    setTick((value) => value + 1);
  };

  const leave = (): void => {
    const current = paused;
    if (current === undefined) return;
    const workspace =
      current.agent === "general"
        ? (deps.general?.workspace ?? deps.task.workspace)
        : current.agent === "plan"
          ? (deps.planner?.workspace ?? deps.task.workspace)
          : deps.task.workspace;
    const result = leaveTurn(workspace, sessionRef.current, current, deps.telemetry);
    setPaused(undefined);
    appendNotice(`left ${result.unitId} open (suspended); work kept`);
    appendNotice("next message goes to the session agent");
    setTick((value) => value + 1);
  };

  const resetInput = (): void => {
    setInput("");
    setCursor(0);
    setHistoryIndex(null);
    setCompletionDismissed(undefined);
    setCompletionSelected(0);
  };

  const runCommand = (name: string): void => {
    resetInput();
    logRef.current?.write({ type: "command", command: name });
    switch (name) {
      case "new":
        if (runningRef.current) {
          appendNotice("new: a turn is still running");
          return;
        }
        if (paused !== undefined) {
          appendNotice("new: cancel or resume the paused turn first");
          return;
        }
        sessionRef.current = createSession();
        timingsRef.current.clear();
        liveJournals.current.clear();
        runningTools.current.clear();
        modelStarts.current.clear();
        filesRef.current = null;
        setTrace([]);
        setPaused(undefined);
        setPendingPlan(undefined);
        setObserverNotice(undefined);
        setActivity("idle");
        setHistoryOpen(false);
        setTraceScroll(0);
        setDetailScroll(0);
        deps.task.workspace.clearCheckpoints?.();
        appendNotice("session reset");
        setTick((value) => value + 1);
        return;
      case "help":
        setHelpOpen(true);
        return;
      case "tasks":
        setHistoryOpen(true);
        setHistorySelected(0);
        return;
      case "pause":
        if (!runningRef.current) {
          appendNotice("pause: nothing is running");
          return;
        }
        abortRef.current?.abort();
        return;
      case "resume":
        if (paused === undefined) {
          appendNotice("resume: nothing is paused");
          return;
        }
        void resume();
        return;
      case "cancel":
        if (paused === undefined) {
          appendNotice("cancel: nothing is paused");
          return;
        }
        cancel();
        return;
      case "quit":
        exit();
        return;
      case "mouse": {
        const next = !mouseCapture;
        setMouseCapture(next);
        appendNotice(next ? "mouse: capture on (Ctrl-G off)" : "mouse: capture off (Ctrl-G on)");
        return;
      }
      case "verbose": {
        const collapsible = trace.filter(
          (entry) => entry.kind === "thought" || entry.kind === "tool",
        );
        if (collapsible.length === 0) {
          appendNotice("verbose: no collapsible blocks");
          return;
        }
        const expand = collapsible.every((entry) => entry.collapsed === true);
        setTrace((previous) =>
          previous.map((entry) =>
            entry.kind === "thought" || entry.kind === "tool"
              ? { ...entry, collapsed: !expand }
              : entry,
          ),
        );
        appendNotice(expand ? "blocks expanded" : "blocks collapsed");
        return;
      }
      case "status": {
        const summary = sessionSummary(telemetry.events);
        const totals = usageTotals(telemetry.events);
        const types = Object.entries(summary.unitsByType)
          .map(([type, count]) => `${type} ${count}`)
          .join(", ");
        appendNotice(
          `session: ${summary.units} units (${types || "none"}) · ` +
            `${summary.modelCalls} model · ${summary.toolCalls} tool · ` +
            `${totals.inputTokens} in / ${totals.outputTokens} out`,
        );
        return;
      }
      case "clear":
        setTrace([]);
        setTraceScroll(0);
        return;
      default:
        appendNotice(`unknown command: /${name}`);
    }
  };

  const runPlan = async (planUnitId: string): Promise<void> => {
    if (runningRef.current) return;
    setPendingPlan(undefined);
    runningRef.current = true;
    setRunning(true);
    setActivity("plan · executing");
    const controller = new AbortController();
    abortRef.current = controller;
    let pausedResult = false;
    try {
      const result: PlanExecutionResult = await executePlan(
        runDeps(),
        sessionRef.current,
        planUnitId,
        { signal: controller.signal },
      );
      logRef.current?.write({
        type: "plan_run",
        planUnitId,
        status: result.status,
        completed: result.completed,
        total: result.total,
        units: result.units.map((unit) => ({
          unitId: unit.unitId,
          itemId: unit.itemId,
          kind: unit.kind,
          done: unit.result.done,
          stopReason: unit.result.stopReason,
        })),
        reply: result.reply ?? null,
      });
      appendNotice(renderPlanRun(result).join("\n"));
      if (
        result.plan !== undefined &&
        result.plan.result.plan !== undefined &&
        result.plan.result.plan.items.length > 0
      ) {
        setPendingPlan(result.plan.unitId);
      } else if (
        result.status === "blocked" &&
        planModeOf(sessionRef.current) === planUnitId
      ) {
        setPendingPlan(planUnitId);
        appendNotice("plan is still active: [e]xecute to continue  [r]ework  [q]uit");
      }
      if (result.paused !== undefined) {
        pausedResult = true;
        setPaused(result.paused);
        setActivity("paused");
      }
    } catch (error) {
      appendNotice(`error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      runningRef.current = false;
      setRunning(false);
      abortRef.current = undefined;
      if (!pausedResult) setActivity("idle");
      setTick((value) => value + 1);
    }
  };

  const acceptCompletion = (): void => {
    if (completion === undefined) return;
    const item = completion.items[completionIndex];
    if (item === undefined) return;
    if (completion.kind === "mention" && completion.mention !== undefined) {
      const next = replaceRange(
        input,
        completion.mention.start,
        completion.mention.end,
        `@${item.value} `,
      );
      setInput(next.input);
      setCursor(next.cursor);
      setCompletionDismissed(undefined);
      setCompletionSelected(0);
      return;
    }
    if (input.trim() === `/${item.value}`) {
      runCommand(item.value);
      return;
    }
    const next = replaceRange(input, 0, input.length, `/${item.value} `);
    setInput(next.input);
    setCursor(next.cursor);
    setCompletionDismissed(undefined);
    setCompletionSelected(0);
  };

  const insert = (text: string): void => {
    setInput((previous) => `${previous.slice(0, cursor)}${text}${previous.slice(cursor)}`);
    setCursor((value) => value + text.length);
  };

  const backspace = (): void => {
    if (cursor === 0) return;
    setInput((previous) => `${previous.slice(0, cursor - 1)}${previous.slice(cursor)}`);
    setCursor((value) => Math.max(0, value - 1));
  };

  const deleteForward = (): void => {
    setInput((previous) => `${previous.slice(0, cursor)}${previous.slice(cursor + 1)}`);
  };

  const cycleFocus = (): void => {
    if (focus === "composer") {
      setFocus("trace");
    } else if (focus === "trace") {
      setFocus(showTask ? "task" : "composer");
    } else {
      setFocus("composer");
    }
  };

  useInput((value, key) => {
    if (key.ctrl && value === "d") {
      abortRef.current?.abort();
      exit();
      return;
    }
    if (key.ctrl && value === "c") {
      if (runningRef.current) {
        abortRef.current?.abort();
      } else {
        exit();
      }
      return;
    }
    if (key.ctrl && value === "g") {
      const next = !mouseCapture;
      setMouseCapture(next);
      appendNotice(next ? "mouse capture on (Ctrl-G off)" : "mouse capture off (Ctrl-G on)");
      return;
    }
    if (helpOpen) {
      if (key.escape || value === "?") setHelpOpen(false);
      return;
    }
    if (paused !== undefined) {
      if (value === "r") {
        void resume();
      } else if (value === "s" && paused.agent !== "session") {
        leave();
      } else if (value === "c") {
        cancel();
      } else if (value === "q") {
        exit();
      }
      return;
    }
    if (pendingPlan !== undefined) {
      if (value === "e") {
        void runPlan(pendingPlan);
      } else if (value === "r") {
        setPendingPlan(undefined);
        appendNotice("plan kept; describe the changes and send them as the next message");
      } else if (value === "q") {
        exit();
      }
      return;
    }
    if (key.ctrl && value === "t") {
      setHistoryOpen((open) => !open);
      setHistorySelected(0);
      return;
    }
    if (historyOpen) {
      if (key.escape) {
        setHistoryOpen(false);
      } else if (key.upArrow) {
        setHistorySelected((index) => Math.max(0, index - 1));
      } else if (key.downArrow) {
        setHistorySelected((index) => Math.min(view.history.length - 1, index + 1));
      }
      return;
    }
    if (completion !== undefined) {
      if (key.escape) {
        setCompletionDismissed(completion.key);
        return;
      }
      if (key.upArrow) {
        setCompletionSelected((index) => Math.max(0, index - 1));
        return;
      }
      if (key.downArrow) {
        setCompletionSelected((index) => Math.min(completion.items.length - 1, index + 1));
        return;
      }
      if (key.pageUp) {
        setCompletionSelected((index) => Math.max(0, index - 5));
        return;
      }
      if (key.pageDown) {
        setCompletionSelected((index) => Math.min(completion.items.length - 1, index + 5));
        return;
      }
      if (key.tab || key.return) {
        acceptCompletion();
        return;
      }
    }
    if (key.escape) {
      if (runningRef.current) {
        abortRef.current?.abort();
      } else if (focus !== "composer") {
        setFocus("composer");
      }
      return;
    }
    if (value === "?" && (input === "" || focus !== "composer")) {
      setHelpOpen(true);
      return;
    }
    if (key.tab) {
      cycleFocus();
      return;
    }
    if (focus === "task") {
      if (key.upArrow) {
        setDetailScroll((value2) => Math.max(0, value2 - 1));
      } else if (key.downArrow) {
        setDetailScroll((value2) => value2 + 1);
      } else if (key.pageUp) {
        setDetailScroll((value2) => Math.max(0, value2 - Math.max(1, bodyRows - 8)));
      } else if (key.pageDown) {
        setDetailScroll((value2) => value2 + Math.max(1, bodyRows - 8));
      } else if (key.return) {
        setFocus("composer");
      }
      return;
    }
    // In the composer Up/Down recall submitted messages; PgUp/PgDn keep scrolling the trace.
    if (focus === "composer" && (key.upArrow || key.downArrow)) {
      if (inputHistory.length === 0) return;
      if (key.upArrow) {
        const next =
          historyIndex === null ? inputHistory.length - 1 : Math.max(0, historyIndex - 1);
        if (historyIndex === null) historyDraft.current = input;
        setHistoryIndex(next);
        const recalled = inputHistory[next] ?? "";
        setInput(recalled);
        setCursor(recalled.length);
      } else if (historyIndex !== null) {
        if (historyIndex < inputHistory.length - 1) {
          const next = historyIndex + 1;
          setHistoryIndex(next);
          const recalled = inputHistory[next] ?? "";
          setInput(recalled);
          setCursor(recalled.length);
        } else {
          setHistoryIndex(null);
          setInput(historyDraft.current);
          setCursor(historyDraft.current.length);
        }
      }
      return;
    }
    if (key.pageUp) {
      setTraceScroll((value2) => value2 + bodyRows);
      return;
    }
    if (key.pageDown) {
      setTraceScroll((value2) => Math.max(0, value2 - bodyRows));
      return;
    }
    if (focus === "trace") {
      if (key.return) setFocus("composer");
      else if (value === " ") toggleTopRef.current();
      else if (key.upArrow) setTraceScroll((value2) => value2 + 1);
      else if (key.downArrow) setTraceScroll((value2) => Math.max(0, value2 - 1));
      return;
    }
    if ((key.ctrl && (value === "j" || value === "\n")) || (key.shift && key.return)) {
      insert("\n");
      return;
    }
    if (key.return) {
      void submit();
      return;
    }
    if (key.backspace) {
      backspace();
      return;
    }
    if (key.delete) {
      deleteForward();
      return;
    }
    if (key.leftArrow) {
      setCursor((position) => Math.max(0, position - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor((position) => Math.min(input.length, position + 1));
      return;
    }
    if (key.home) {
      setCursor(0);
      return;
    }
    if (key.end) {
      setCursor(input.length);
      return;
    }
    if (key.ctrl || key.meta) return;
    if (value !== "") insert(value);
  });

  const lines = traceLines(trace, Math.max(20, mainWidth - (focus === "trace" ? 4 : 2)));
  const activeEntryId =
    [...trace].reverse().find((entry) => entry.status === "running")?.id ?? trace.at(-1)?.id;
  clickRef.current = (column, row) => {
    if (column > mainWidth) return;
    const view = traceWindow(lines, bodyRows, focus === "trace", traceScroll);
    // The header is one row; a focused trace panel spends one more row on its top border and
    // one on the "↑ more" indicator.
    const contentTop = 2 + (focus === "trace" ? 1 : 0) + (view.hiddenAbove > 0 ? 1 : 0);
    const index = row - contentTop;
    if (index < 0 || index >= view.visible.length) return;
    const entryId = view.visible[index]?.entryId;
    if (entryId === undefined) return;
    toggleEntry(entryId);
  };
  toggleTopRef.current = () => {
    const view = traceWindow(lines, bodyRows, focus === "trace", traceScroll);
    const entryId = view.visible.find((line) => line.entryId !== undefined)?.entryId;
    if (entryId !== undefined) toggleEntry(entryId);
  };
  const mode = running ? "working" : paused !== undefined ? "paused" : "idle";
  const activityColor = running ? theme.warning : paused !== undefined ? theme.error : theme.success;

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <HeaderBar workspace={workspace} model={modelLabel} mode={mode} totals={view.header} />
      <Box flexDirection="row" flexGrow={1} height={bodyRows}>
        <TracePanel
          lines={lines}
          rows={bodyRows}
          width={mainWidth}
          scroll={traceScroll}
          focused={focus === "trace"}
          {...(activeEntryId !== undefined ? { activeId: activeEntryId } : {})}
        />
        {showTask ? <Box width={panelGap} /> : null}
        {showTask ? (
          <TaskPanel
            task={activeTask}
            width={taskWidth}
            rows={bodyRows}
            selected={Math.max(0, stateCount - 1)}
            detailScroll={detailScroll}
            focused={focus === "task"}
            paused={paused !== undefined}
            {...(observerNotice !== undefined ? { observer: observerNotice } : {})}
          />
        ) : null}
      </Box>
      <ActivityBar
        running={running}
        paused={paused !== undefined}
        text={activity}
        color={activityColor}
      />
      <Composer
        input={input}
        cursor={cursor}
        width={columns}
        rows={composerRows}
        focused={focus === "composer"}
      />
      <Footer paused={paused !== undefined} historyOpen={historyOpen} />
      {completion !== undefined && !helpOpen && !historyOpen && paused === undefined ? (
        <CompletionPanel
          kind={completion.kind}
          items={completion.items}
          selected={completionIndex}
          width={columns}
          bottom={1 + composerHeight}
        />
      ) : null}
      {historyOpen ? (
        <HistoryOverlay
          tasks={view.history}
          selected={historySelectedIndex}
          width={Math.max(20, Math.min(Math.max(42, Math.floor(columns * 0.55)), columns - 2))}
          height={bodyRows}
          top={1}
        />
      ) : null}
      {paused !== undefined ? <PauseOverlay paused={paused} width={columns} height={rows} /> : null}
      {helpOpen ? <HelpOverlay width={columns} height={rows} /> : null}
    </Box>
  );
}
