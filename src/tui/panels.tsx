import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";
import stringWidth from "string-width";

import type { PausedState } from "../session/driver";
import { compactDuration, compactTokens, oneLine, shortId, wrap } from "./format";
import type { TaskState, TaskView } from "./view_model";
import { theme } from "./theme";
import type { Focus, TraceLine } from "./types";
import { traceWindow } from "./trace_lines";
import type { HeaderView } from "./view_model";

function T(props: React.ComponentProps<typeof Text>) {
  return React.createElement(Text, { ...props, color: props.color ?? theme.text });
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function HeaderBar(props: {
  workspace: string;
  model: string;
  mode: "idle" | "working" | "paused";
  totals: HeaderView;
}) {
  const { workspace, model, mode, totals } = props;
  const modeColor = mode === "working" ? theme.warning : mode === "paused" ? theme.error : theme.success;
  const workspaceLabel = workspace.split("/").filter(Boolean).at(-1) ?? workspace;
  const modelLabel = model.split("/").filter(Boolean).at(-1) ?? model;
  return (
    <Box paddingX={1} height={1} width="100%">
      <T wrap="truncate-end">
        <T bold>skein</T>
        <T dimColor> · {oneLine(workspaceLabel, 16)}</T>
        <T dimColor> · {oneLine(modelLabel, 18)}</T>
        <T color={modeColor}> · {mode}</T>
        <T dimColor>
          {" "}
          · ctx {compactTokens(totals.sessionContextTokens)} · Σ{" "}
          {compactTokens(totals.tokensIn)} in · {compactTokens(totals.tokensOut)} out ·{" "}
          {compactTokens(totals.cachedInputTokens)} cache ·{" "}
          {compactTokens(totals.reasoningTokens)} rsn · {totals.totalTasks} tasks ·{" "}
          {totals.totalTurns}t · {totals.modelCalls}c
        </T>
      </T>
    </Box>
  );
}

export function ActivityBar(props: {
  running: boolean;
  paused: boolean;
  text: string;
  color: string;
}) {
  const { running, paused, text, color } = props;
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setFrame((value) => (value + 1) % SPINNER.length), 120);
    return () => clearInterval(timer);
  }, [running]);
  const mark = running ? (SPINNER[frame] ?? SPINNER[0]) : paused ? "Ⅱ" : "○";
  return (
    <Box paddingX={1} height={1}>
      <Text color={color} bold={running}>
        {mark}
      </Text>
      <Text {...(running ? { color: theme.text, bold: true } : { dimColor: true })} wrap="truncate-end">
        {" "}
        {running ? `working · ${text}` : text}
      </Text>
    </Box>
  );
}

export function TracePanel(props: {
  lines: readonly TraceLine[];
  rows: number;
  width: number;
  scroll: number;
  focused: boolean;
  activeId?: string;
}) {
  const { lines, rows, width, scroll, focused, activeId } = props;
  const view = traceWindow(lines, rows, focused, scroll);
  const { visible, hiddenAbove, hiddenBelow, start } = view;
  return (
    <Box
      flexDirection="column"
      width={width}
      height={rows}
      borderStyle={focused ? "round" : undefined}
      borderColor={focused ? theme.borderFocus : theme.border}
      paddingX={1}
      overflow="hidden"
      backgroundColor={theme.panelBg}
    >
      {visible.length === 0 ? (
        <T dimColor>No messages yet. Type a request below.</T>
      ) : null}
      {hiddenAbove > 0 ? <T dimColor>↑ {hiddenAbove} more · PgUp</T> : null}
      {visible.map((line, index) => {
        const active = activeId !== undefined && line.entryId === activeId;
        const bg = active ? theme.activeBg : line.bg;
        const pad =
          bg !== undefined
            ? " ".repeat(
                Math.max(
                  0,
                  width - 2 - (focused ? 2 : 0) - stringWidth(line.text),
                ),
              )
            : "";
        const base = active ? theme.strong : theme.text;
        return (
          <T
            key={start + index}
            color={line.color ?? base}
            {...(line.dim === true ? { dimColor: true } : {})}
            {...(line.bold === true ? { bold: true } : {})}
            {...(line.underline === true ? { underline: true } : {})}
            {...(bg !== undefined ? { backgroundColor: bg } : {})}
            wrap="truncate-end"
          >
            {line.spans === undefined
              ? `${line.text === "" ? " " : line.text}${pad}`
              : [
                  ...line.spans.map((span, spanIndex) => (
                    <T
                      key={`${start + index}:${spanIndex}`}
                      color={span.color ?? base}
                      {...(span.dim === true ? { dimColor: true } : {})}
                      {...(span.bold === true ? { bold: true } : {})}
                      {...(span.italic === true ? { italic: true } : {})}
                      {...(span.underline === true ? { underline: true } : {})}
                      {...(span.strikethrough === true ? { strikethrough: true } : {})}
                      {...(bg !== undefined ? { backgroundColor: bg } : {})}
                    >
                      {span.text}
                    </T>
                  )),
                  ...(pad !== ""
                    ? [
                        <T
                          key={`${start + index}:pad`}
                          dimColor={true}
                          {...(bg !== undefined ? { backgroundColor: bg } : {})}
                        >
                          {pad}
                        </T>,
                      ]
                    : []),
                ]}
          </T>
        );
      })}
      {hiddenBelow > 0 ? <T dimColor>↓ {hiddenBelow} more · PgDn</T> : null}
    </Box>
  );
}

function stateRow(state: TaskState, selected: boolean, width: number): string {
  const mark = state.current ? (state.closed ? "✓" : "●") : state.closed ? "✓" : "○";
  const island = oneLine(state.island, 12).padEnd(12, " ");
  const range = `t${state.startTurn + 1}–${state.endTurn + 1}`.padEnd(8, " ");
  const turns = `${state.turns}t`.padStart(3, " ");
  const tokens = `${compactTokens(state.contextTokens)}/${compactTokens(state.tokensOut + state.reasoningTokens)}`.padStart(9, " ");
  const time = compactDuration(state.durationMs).padStart(5, " ");
  const text = `${mark} ${island}${range}${turns} ${tokens} ${time}`;
  return oneLine(text, width);
}

function turnDuration(ms: number): string {
  if (ms <= 0) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function detailLines(state: TaskState | undefined, width: number): string[] {
  if (state === undefined) return [];
  const lines: string[] = [
    `${oneLine(state.island, Math.max(8, width - 20))} · ${state.turns}t · ` +
      `${compactDuration(state.durationMs)}`,
    `  in ${compactTokens(state.contextTokens)} · out ${compactTokens(state.tokensOut + state.reasoningTokens)} · ` +
      `cache ${compactTokens(state.cachedInputTokens)}`,
  ];
  for (const turn of state.turnDetails) {
    const number = `t${turn.turn + 1}`.padEnd(4, " ");
    const tokens = `${compactTokens(turn.tokensIn)}/${compactTokens(turn.tokensOut)}`.padStart(11, " ");
    const time = turnDuration(turn.durationMs).padStart(6, " ");
    lines.push(`  ${number}${tokens}  ${time}`);
  }
  return lines;
}

export function TaskPanel(props: {
  task: TaskView | undefined;
  width: number;
  rows: number;
  selected: number;
  detailScroll: number;
  focused: boolean;
  paused?: boolean;
  observer?: string;
}) {
  const { task, width, rows, selected, detailScroll, focused, paused, observer } = props;
  if (task === undefined) {
    return (
      <Box
        flexDirection="column"
        width={width}
        height={rows}
        borderStyle={focused ? "round" : undefined}
        borderColor={focused ? theme.borderFocus : theme.border}
        paddingX={1}
        backgroundColor={theme.panelBg}
      >
        <T bold>Current task</T>
        <T dimColor>no task yet</T>
      </Box>
    );
  }
  const listRows = Math.max(3, Math.min(task.states.length, Math.max(3, Math.floor(rows / 3))));
  const detailHeight = Math.max(4, rows - listRows - (observer !== undefined ? 6 : 5));
  const stateIndex = Math.min(Math.max(0, selected), Math.max(0, task.states.length - 1));
  const current = task.states[stateIndex];
  const allDetail = detailLines(current, Math.max(20, width - 2));
  const maxDetailScroll = Math.max(0, allDetail.length - detailHeight);
  const detailOffset = Math.min(detailScroll, maxDetailScroll);
  const detailIndicator = detailOffset > 0;
  const detailRoom = Math.max(1, detailHeight - (detailIndicator ? 1 : 0));
  const detail = allDetail.slice(detailOffset, detailOffset + detailRoom);
  const stateStart = Math.max(0, Math.min(stateIndex - Math.floor(listRows / 2), task.states.length - listRows));
  const states = task.states.slice(stateStart, stateStart + listRows);
  return (
    <Box
      flexDirection="column"
      width={width}
      height={rows}
      borderStyle={focused ? "round" : undefined}
      borderColor={focused ? theme.borderFocus : theme.border}
      paddingX={1}
      overflow="hidden"
      backgroundColor={theme.panelBg}
    >
      <T bold wrap="truncate-end">
        {shortId(task.unitId, 8)}
      </T>
      {observer !== undefined ? (
        <T dimColor wrap="truncate-end">
          {`observer · ${observer}`}
        </T>
      ) : null}
      <T dimColor wrap="truncate-end">
        {`${paused === true ? "paused" : task.attention} · ${compactDuration(task.elapsedMs)} · ${task.turns}t`}
      </T>
      <T dimColor wrap="truncate-end">
        {`in ${compactTokens(task.contextTokens)} · out ${compactTokens(task.tokensOut + task.reasoningTokens)} · ` +
          `cache ${compactTokens(task.cachedInputTokens)}`}
      </T>
      <T color={theme.state} bold>
        States
      </T>
      {states.map((state) => {
        const index = task.states.indexOf(state);
        return (
          <T
            key={state.id}
            {...(index === stateIndex ? { backgroundColor: theme.selectedBg } : {})}
            wrap="truncate-end"
          >
            {stateRow(state, index === stateIndex, Math.max(16, width - 2))}
          </T>
        );
      })}
      {task.states.length === 0 ? <T dimColor>no states yet</T> : null}
      <T dimColor> </T>
      {detailIndicator ? <T dimColor>↑ {detailOffset} more (PgUp/PgDn)</T> : null}
      {detail.map((line, index) => (
        <T key={`detail-${index}`} wrap="truncate-end" dimColor={line.startsWith("  ")}>
          {line}
        </T>
      ))}
    </Box>
  );
}

function historyRow(task: TaskView, width: number): string {
  const num = `#${task.number}`.padEnd(3, " ");
  const stats =
    `${task.turns}t ${compactTokens(task.contextTokens)}/${compactTokens(task.tokensOut + task.reasoningTokens)} ` +
    `${compactDuration(task.elapsedMs)} ${task.attention}`;
  const room = Math.max(12, width - num.length - stats.length - 2);
  return `${num}${oneLine(task.request, room).padEnd(room, " ")} ${stats}`;
}

export function HistoryOverlay(props: {
  tasks: readonly TaskView[];
  selected: number;
  width: number;
  height: number;
  top: number;
}) {
  const { tasks, selected, width, height, top } = props;
  const index = Math.min(Math.max(0, selected), Math.max(0, tasks.length - 1));
  const task = tasks[index];
  const listRows = Math.min(Math.max(1, tasks.length), Math.max(3, Math.floor(height / 3)));
  const listStart = Math.max(0, Math.min(index - Math.floor(listRows / 2), tasks.length - listRows));
  const visible = tasks.slice(listStart, listStart + listRows);
  const detailRows = Math.max(3, height - listRows - 5);
  const detail: string[] = [];
  if (task !== undefined) {
    detail.push(...wrap(`#${task.number} ${task.request}`, Math.max(20, width - 4)));
    detail.push(`${task.attention} · ${task.outcome}`);
    detail.push(
      `${task.turns} turns · ${compactTokens(task.contextTokens)} in / ` +
        `${compactTokens(task.tokensOut + task.reasoningTokens)} out / ` +
        `${compactTokens(task.cachedInputTokens)} cache · ` +
        `${compactDuration(task.elapsedMs)} · ${task.toolCalls} actions`,
    );
    for (const state of task.states) {
      detail.push(
        `${state.current ? (state.closed ? "✓" : "●") : state.closed ? "✓" : "○"} ` +
          `${oneLine(state.island, 14).padEnd(14, " ")} ` +
          `t${state.startTurn + 1}–${state.endTurn + 1} ${state.turns}t`,
      );
      if (state.stopWhy !== undefined && state.stopWhy !== "") {
        detail.push(...wrap(`  ${state.stopWhy}`, Math.max(20, width - 4)).map((line) => `  ${line}`));
      }
    }
  }
  const shownDetail = detail.slice(0, detailRows);
  return (
    <Box
      position="absolute"
      left={0}
      top={top}
      width={width}
      height={height}
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.warning}
      paddingX={1}
      backgroundColor={theme.panelBg}
      overflow="hidden"
    >
      <T bold color={theme.warning}>
        Task history
      </T>
      {visible.map((item) => {
        const itemIndex = tasks.indexOf(item);
        return (
          <T key={item.unitId} {...(itemIndex === index ? { backgroundColor: theme.selectedBg } : {})} wrap="truncate-end">
            {historyRow(item, Math.max(20, width - 2))}
          </T>
        );
      })}
      {tasks.length === 0 ? <T dimColor>no tasks yet</T> : null}
      <T dimColor> </T>
      {shownDetail.map((line, lineIndex) => (
        <T key={`history-detail-${lineIndex}`} wrap="truncate-end" dimColor={line.startsWith("  ")}>
          {line}
        </T>
      ))}
      <T dimColor>↑/↓ select · Esc close</T>
    </Box>
  );
}

function wrapComposerLine(line: string, width: number, marker: string): string[] {
  const out: string[] = [];
  let current = "";
  let size = 0;
  for (const char of Array.from(line)) {
    // The cursor marker is a one-column block between characters, not a property of the
    // character after it, so wrapping must account for that column.
    const charWidth = char === marker ? 1 : stringWidth(char);
    if (size + charWidth > width && current !== "") {
      const space = current.lastIndexOf(" ");
      if (space > 0) {
        out.push(current.slice(0, space));
        current = current.slice(space + 1);
        size = stringWidth(current.replaceAll(marker, " "));
      } else {
        out.push(current);
        current = "";
        size = 0;
      }
    }
    current += char;
    size += charWidth;
  }
  out.push(current);
  return out;
}

export function Composer(props: {
  input: string;
  cursor: number;
  width: number;
  rows: number;
  focused: boolean;
}) {
  const { input, cursor, width, rows, focused } = props;
  const text = input === "" ? "" : input;
  const marker = "\u0000";
  const before = text.slice(0, cursor);
  const after = text.slice(cursor);
  const shown = `${before}${marker}${after}`;
  const textWidth = Math.max(10, width - 6);
  const lines = shown
    .split("\n")
    .flatMap((line) => wrapComposerLine(line, textWidth, marker));
  const markerLine = lines.findIndex((line) => line.includes(marker));
  const cursorLine = markerLine >= 0 ? markerLine : Math.max(0, lines.length - 1);
  const height = Math.max(1, rows);
  const start =
    lines.length <= height
      ? 0
      : Math.max(0, Math.min(cursorLine - (height - 1), lines.length - height));
  const visible = lines.slice(start, start + height);
  while (visible.length < height) visible.push("");
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? theme.borderFocus : theme.border}
      paddingX={1}
      width={width}
      backgroundColor={theme.panelBg}
    >
      {visible.map((line, index) => {
        const absolute = start + index;
        const prompt = absolute === 0 ? "> " : "  ";
        const markerAt = line.indexOf(marker);
        if (markerAt === -1) {
          return (
            <T key={`composer-${index}`} wrap="truncate-end">
              {prompt}
              {line}
            </T>
          );
        }
        const left = line.slice(0, markerAt);
        const right = line.slice(markerAt + 1);
        return (
          <T key={`composer-${index}`} wrap="truncate-end">
            {prompt}
            {left}
            <T inverse> </T>
            {right}
          </T>
        );
      })}
    </Box>
  );
}

export function Footer(props: { paused: boolean; historyOpen: boolean }) {
  if (props.historyOpen) {
    return (
      <Box paddingX={1}>
        <T dimColor>history · ↑/↓ select · Esc close</T>
      </Box>
    );
  }
  if (props.paused) {
    return (
      <Box paddingX={1}>
        <T color={theme.error}>paused · r resume · c cancel · q quit</T>
      </Box>
    );
  }
  return (
    <Box paddingX={1}>
      <T dimColor wrap="truncate-end">
        Enter send · Ctrl-J newline · Esc pause · Ctrl-C abort/exit · Ctrl-T history · Tab focus · Ctrl-D exit · ? help
      </T>
    </Box>
  );
}

export function PauseOverlay(props: { paused: PausedState; width: number; height: number }) {
  const { paused, width, height } = props;
  const boxWidth = Math.max(30, Math.min(64, width - 8));
  const boxHeight = 7;
  return (
    <Box
      position="absolute"
      left={Math.max(0, Math.floor((width - boxWidth) / 2))}
      top={Math.max(0, Math.floor((height - boxHeight) / 2))}
      width={boxWidth}
      height={boxHeight}
      flexDirection="column"
      borderStyle="double"
      borderColor={theme.error}
      paddingX={1}
      backgroundColor={theme.panelBg}
    >
      <T bold color={theme.error}>
        Paused
      </T>
      <T>
        {paused.agent} · {shortId(paused.unitId, boxWidth - 10)}
      </T>
      <T dimColor wrap="truncate-end">
        {oneLine(paused.utterance, boxWidth - 4)}
      </T>
      <T> </T>
      <T>[r] resume · [c] cancel · [q] quit</T>
    </Box>
  );
}

export function HelpOverlay(props: { width: number; height: number }) {
  const { width, height } = props;
  const boxWidth = Math.max(36, Math.min(72, width - 8));
  const boxHeight = Math.max(6, Math.min(18, height - 4));
  const lines = [
    "Keys",
    "  Enter        send the utterance",
    "  Ctrl-J       newline",
    "  Esc          pause / close overlay",
    "  Ctrl-C       abort the running turn",
    "  Ctrl-T       task history",
    "  Tab          cycle focus (composer / trace / task)",
    "  Up/Down      composer history / scroll trace / task turns",
    "  Space        toggle the visible block in the trace",
    "  PgUp/PgDn    scroll trace / task detail",
    "  Ctrl-G       toggle mouse capture (click blocks)",
    "  ?            toggle help",
  ];
  return (
    <Box
      position="absolute"
      left={Math.max(0, Math.floor((width - boxWidth) / 2))}
      top={Math.max(0, Math.floor((height - boxHeight) / 2))}
      width={boxWidth}
      height={boxHeight}
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.borderFocus}
      paddingX={1}
      backgroundColor={theme.panelBg}
    >
      {lines.map((line) => (
        <T key={line} bold={line === "Keys"} wrap="truncate-end">
          {line}
        </T>
      ))}
    </Box>
  );
}
