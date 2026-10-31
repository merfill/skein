import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import React, { useEffect, useRef, useState } from "react";

import type { Event } from "../ir/events";
import { fold } from "../ir/graph";
import { currentMove } from "../ir/traversal";
import { createSession } from "../session/session";
import {
  cancelTurn,
  resumeTurn,
  runSessionTurn,
  type PausedState,
  type SessionTurnDeps,
  type SessionTurnResult,
} from "../session/driver";
import type { MemoryTelemetry } from "../session/telemetry";
import type { ProgressEvent } from "../session/progress";
import type { SessionState } from "../session/types";
import { buildTuiView, type TaskTiming } from "./view_model";
import { traceLines } from "./trace_lines";
import { theme } from "./theme";
import {
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

export interface TuiAppProps {
  deps: SessionTurnDeps;
  telemetry: MemoryTelemetry;
  workspace: string;
  model: string;
  session?: SessionState;
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
  const sessionRef = useRef(props.session ?? createSession());
  const timingsRef = useRef(new Map<string, TaskTiming>());
  const liveJournals = useRef(new Map<string, Event[]>());
  const traceSeq = useRef(0);
  const runningTools = useRef(new Map<string, string>());
  const abortRef = useRef<AbortController | undefined>(undefined);
  const runningRef = useRef(false);
  const mountedRef = useRef(true);
  const previousStateCount = useRef(0);

  const [tick, setTick] = useState(0);
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const [focus, setFocus] = useState<Focus>("composer");
  const [running, setRunning] = useState(false);
  const [activity, setActivity] = useState("idle");
  const [paused, setPaused] = useState<PausedState | undefined>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySelected, setHistorySelected] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const [selectedState, setSelectedState] = useState(0);
  const [detailScroll, setDetailScroll] = useState(0);
  const [traceScroll, setTraceScroll] = useState(0);

  const view = buildTuiView(sessionRef.current, telemetry.events, {
    now: Date.now(),
    timings: timingsRef.current,
    liveJournals: liveJournals.current,
  });

  const showTask = columns >= 72;
  const taskWidth = showTask ? Math.min(44, Math.max(30, Math.floor(columns * 0.32))) : 0;
  const mainWidth = Math.max(20, columns - taskWidth - 2);
  const composerLines = Math.min(4, input.split("\n").length);
  const composerHeight = composerLines + 2;
  const bodyRows = Math.max(6, rows - 1 - 1 - composerHeight - 1);
  const activeTask = view.current;
  const stateCount = activeTask?.states.length ?? 0;
  const selectedStateIndex = Math.min(Math.max(0, selectedState), Math.max(0, stateCount - 1));
  const historySelectedIndex = Math.min(
    Math.max(0, historySelected),
    Math.max(0, view.history.length - 1),
  );

  const nextId = (): string => {
    traceSeq.current += 1;
    return `trace:${traceSeq.current}`;
  };
  const append = (entry: TraceEntry): void => {
    setTrace((previous) => [...previous, entry]);
  };
  const appendNotice = (text: string): void => append(notice(nextId(), text));

  useEffect(() => {
    if (paused === undefined && !running) return;
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [paused, running]);

  useEffect(() => {
    setSelectedState(Math.max(0, stateCount - 1));
    previousStateCount.current = stateCount;
    setDetailScroll(0);
  }, [activeTask?.unitId]);

  useEffect(() => {
    setSelectedState((selected) => {
      const followed = selected >= Math.max(0, previousStateCount.current - 1);
      return followed ? Math.max(0, stateCount - 1) : selected;
    });
    previousStateCount.current = stateCount;
  }, [stateCount]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const handleProgress = (event: ProgressEvent): void => {
    if (!mountedRef.current) return;
    switch (event.type) {
      case "turn_started": {
        const unit = sessionRef.current.units.get(event.unitId);
        if (
          (unit?.type === "task" || unit?.type === "general") &&
          timingsRef.current.get(event.unitId)?.startedAt === undefined
        ) {
          timingsRef.current.set(event.unitId, { startedAt: Date.now() });
        }
        setActivity(`${event.agent} · turn ${event.turn + 1}`);
        break;
      }
      case "model_call_started":
        setActivity(`${event.agent} · model`);
        break;
      case "model_call_finished":
        setActivity(`${event.agent} · model ${event.status}`);
        break;
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
        if (unit?.type === "task" || unit?.type === "general") {
          unit.turn = Math.max(unit.turn, event.turn + 1);
        }
        setActivity(`${event.agent} · ${event.tool} ${event.status}`);
        break;
      }
      case "events_added": {
        const unit = sessionRef.current.units.get(event.unitId);
        if (unit?.type === "task" || unit?.type === "general") {
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
        if (unit?.type === "task" || unit?.type === "general") {
          unit.turn = Math.max(unit.turn, event.turn + 1);
        }
        setActivity(`${event.agent} · turn done`);
        break;
      }
      case "paused":
        setActivity("paused");
        break;
      case "report_started":
        setActivity("session · report");
        break;
      case "report_finished":
        setActivity("session · report done");
        break;
    }
  };

  const runDeps = (): SessionTurnDeps => ({
    ...deps,
    onProgress: handleProgress,
    sessionAgent: { ...deps.sessionAgent, onProgress: handleProgress },
    task: {
      ...deps.task,
      onProgress: handleProgress,
      ...(deps.task.observer !== undefined
        ? { observer: { ...deps.task.observer, onProgress: handleProgress } }
        : {}),
    },
    ...(deps.general !== undefined
      ? { general: { ...deps.general, onProgress: handleProgress } }
      : {}),
  });

  const finishTaskTiming = (result: SessionTurnResult): void => {
    const finished = result.task ?? result.general;
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
    finishTaskTiming(result);
    if (result.noDecision !== undefined) {
      appendNotice(`session: no decision (${result.noDecision})`);
    }
    if (result.applied !== undefined && !result.applied.ok) {
      appendNotice(`refused: ${result.applied.reason}`);
    }
    if (result.operation?.kind === "start") {
      appendNotice(`start: ${result.operation.text}`);
    }
    if (result.reply !== undefined) {
      append({ id: nextId(), kind: "assistant", text: result.reply });
    }
    if (result.task !== undefined) {
      const outcome = taskOutcome(result.task.result.events, result.task.result.stopReason);
      appendNotice(
        `task ${result.task.unitId} · ${outcome} · ${result.task.result.turns} turns`,
      );
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
    if (result.report !== undefined) {
      append({ id: nextId(), kind: "report", text: result.report });
    }
    if (result.paused !== undefined) {
      setPaused(result.paused);
      setActivity("paused");
    }
  };

  const submit = async (): Promise<void> => {
    const text = input.trim();
    if (text === "" || runningRef.current) return;
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
    try {
      const result = await resumeTurn(runDeps(), sessionRef.current, current, {
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

  const cancel = (): void => {
    const current = paused;
    if (current === undefined) return;
    const result = cancelTurn(deps.task.workspace, sessionRef.current, current, deps.telemetry);
    setPaused(undefined);
    appendNotice("cancelled");
    if (result.warning !== undefined) appendNotice(result.warning);
    setTick((value) => value + 1);
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
    if (helpOpen) {
      if (key.escape || value === "?") setHelpOpen(false);
      return;
    }
    if (paused !== undefined) {
      if (value === "r") {
        void resume();
      } else if (value === "c") {
        cancel();
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
        setSelectedState((index) => Math.max(0, index - 1));
        setDetailScroll(0);
      } else if (key.downArrow) {
        setSelectedState((index) => Math.min(Math.max(0, stateCount - 1), index + 1));
        setDetailScroll(0);
      } else if (key.pageUp) {
        setDetailScroll((value2) => Math.max(0, value2 - Math.max(1, bodyRows - 8)));
      } else if (key.pageDown) {
        setDetailScroll((value2) => value2 + Math.max(1, bodyRows - 8));
      } else if (key.return) {
        setFocus("composer");
      }
      return;
    }
    if (focus === "trace") {
      if (key.upArrow) {
        setTraceScroll((value2) => value2 + 1);
      } else if (key.downArrow) {
        setTraceScroll((value2) => Math.max(0, value2 - 1));
      } else if (key.pageUp) {
        setTraceScroll((value2) => value2 + bodyRows);
      } else if (key.pageDown) {
        setTraceScroll((value2) => Math.max(0, value2 - bodyRows));
      } else if (key.return) {
        setFocus("composer");
      }
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
  const mode = running ? "working" : paused !== undefined ? "paused" : "idle";
  const activityColor = running ? theme.warning : paused !== undefined ? theme.error : theme.success;

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <HeaderBar workspace={workspace} model={model} mode={mode} totals={view.header} />
      <Box flexDirection="row" flexGrow={1} height={bodyRows}>
        <TracePanel
          lines={lines}
          rows={bodyRows}
          width={mainWidth}
          scroll={traceScroll}
          focused={focus === "trace"}
        />
        {showTask ? (
          <TaskPanel
            task={activeTask}
            width={taskWidth}
            rows={bodyRows}
            selected={selectedStateIndex}
            detailScroll={detailScroll}
            focused={focus === "task"}
            paused={paused !== undefined}
          />
        ) : null}
      </Box>
      <Box paddingX={1} height={1}>
        <Text color={activityColor}>{running ? "●" : paused !== undefined ? "Ⅱ" : "○"}</Text>
        <Text dimColor wrap="truncate-end"> {activity}</Text>
      </Box>
      <Composer
        input={input}
        cursor={cursor}
        width={columns}
        focused={focus === "composer"}
      />
      <Footer paused={paused !== undefined} historyOpen={historyOpen} />
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
