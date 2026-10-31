import { Box, Text } from "ink";
import React from "react";

import type { PausedState } from "../session/driver";
import { compactDuration, compactTokens, oneLine, shortId, wrap } from "./format";
import type { TaskState, TaskView } from "./view_model";
import { theme } from "./theme";
import type { Focus, TraceLine } from "./types";
import type { HeaderView } from "./view_model";

function T(props: React.ComponentProps<typeof Text>) {
  return React.createElement(Text, { ...props, color: props.color ?? theme.text });
}

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
          · {compactTokens(totals.tokensIn)}/{compactTokens(totals.tokensOut)} tok ·{" "}
          {totals.totalTasks} tasks · {totals.totalTurns}t · {totals.modelCalls}c
        </T>
      </T>
    </Box>
  );
}

export function TracePanel(props: {
  lines: readonly TraceLine[];
  rows: number;
  width: number;
  scroll: number;
  focused: boolean;
}) {
  const { lines, rows, width, scroll, focused } = props;
  const maxScroll = Math.max(0, lines.length - Math.max(1, rows));
  const offset = Math.min(scroll, maxScroll);
  const indicator = offset > 0;
  const viewport = Math.max(1, rows - (indicator ? 1 : 0));
  const start = Math.max(0, lines.length - viewport - offset);
  const end = Math.max(0, lines.length - offset);
  const visible = lines.slice(start, end);
  return (
    <Box
      flexDirection="column"
      width={width}
      height={rows}
      borderStyle={focused ? "round" : undefined}
      borderColor={focused ? theme.borderFocus : theme.border}
      paddingX={1}
      overflow="hidden"
    >
      {indicator ? <T dimColor>↑ {offset} more (down to follow)</T> : null}
      {visible.length === 0 ? (
        <T dimColor>No messages yet. Type a request below.</T>
      ) : null}
      {visible.map((line, index) => (
        <T
          key={`${start + index}`}
          {...(line.color !== undefined ? { color: line.color } : {})}
          {...(line.dim === true ? { dimColor: true } : {})}
          {...(line.bold === true ? { bold: true } : {})}
          {...(line.underline === true ? { underline: true } : {})}
          wrap="truncate-end"
        >
          {line.spans === undefined
            ? line.text
            : line.spans.map((span, spanIndex) => (
                <T
                  key={`${start + index}:${spanIndex}`}
                  {...(span.color !== undefined ? { color: span.color } : {})}
                  {...(span.dim === true ? { dimColor: true } : {})}
                  {...(span.bold === true ? { bold: true } : {})}
                  {...(span.italic === true ? { italic: true } : {})}
                  {...(span.underline === true ? { underline: true } : {})}
                  {...(span.strikethrough === true ? { strikethrough: true } : {})}
                >
                  {span.text}
                </T>
              ))}
        </T>
      ))}
    </Box>
  );
}

function stateRow(state: TaskState, selected: boolean, width: number): string {
  const mark = state.current ? (state.closed ? "✓" : "●") : state.closed ? "✓" : "○";
  const island = oneLine(state.island, 13).padEnd(13, " ");
  const range = `t${state.startTurn + 1}–${state.endTurn + 1}`.padEnd(9, " ");
  const turns = `${state.turns}t`.padStart(3, " ");
  const tokens = compactTokens(state.tokensIn + state.tokensOut).padStart(5, " ");
  const text = `${mark} ${island}${range}${turns} ${tokens}`;
  return oneLine(text, width);
}

function detailLines(state: TaskState | undefined, width: number): string[] {
  if (state === undefined) return [];
  const lines: string[] = [];
  lines.push(`Selected: ${state.island}`);
  if (state.what !== "") lines.push(...wrap(`what: ${state.what}`, width));
  if (state.stopWhy !== undefined && state.stopWhy !== "") {
    lines.push(...wrap(`outcome: ${state.stopWhy}`, width));
  } else if (state.current) {
    lines.push("outcome: open");
  }
  lines.push(`turns ${state.startTurn + 1}–${state.endTurn + 1} · ${state.turns}t`);
  lines.push(
    `tokens ${compactTokens(state.tokensIn)} in / ${compactTokens(state.tokensOut)} out · ${state.toolCalls} acts`,
  );
  const actions = state.actions.slice(-6);
  if (actions.length > 0) {
    lines.push("actions:");
    for (const action of actions) {
      lines.push(`  t${action.turn + 1}  ${action.label}`);
    }
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
}) {
  const { task, width, rows, selected, detailScroll, focused, paused } = props;
  if (task === undefined) {
    return (
      <Box
        flexDirection="column"
        width={width}
        height={rows}
        borderStyle={focused ? "round" : undefined}
        borderColor={focused ? theme.borderFocus : theme.border}
        paddingX={1}
      >
        <T bold>Current task</T>
        <T dimColor>no task yet</T>
      </Box>
    );
  }
  const listRows = Math.max(3, Math.min(task.states.length, Math.max(3, Math.floor(rows / 3))));
  const detailHeight = Math.max(4, rows - listRows - 4);
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
    >
      <T bold wrap="truncate-end">
        {shortId(task.unitId, 8)} {oneLine(task.request, Math.max(10, width - 12))}
      </T>
      <T dimColor wrap="truncate-end">
        {paused === true ? "paused" : task.attention} · {compactDuration(task.elapsedMs)} ·{" "}
        {task.toolCalls} calls
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
    `${task.turns}t ${compactTokens(task.tokensIn + task.tokensOut)} ` +
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
    detail.push(`#${task.number} ${task.request}`);
    detail.push(`${task.attention} · ${task.outcome}`);
    detail.push(
      `${task.turns} turns · ${compactTokens(task.tokensIn)} in / ${compactTokens(task.tokensOut)} out · ` +
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

export function Composer(props: {
  input: string;
  cursor: number;
  width: number;
  focused: boolean;
}) {
  const { input, cursor, width, focused } = props;
  const text = input === "" ? "" : input;
  const marker = "\u0000";
  const before = text.slice(0, cursor);
  const after = text.slice(cursor);
  const at = after.charAt(0);
  const rest = after.slice(1);
  const shown = `${before}${marker}${at}${rest}`;
  const lines = shown.split("\n");
  const visible = lines.slice(Math.max(0, lines.length - 4));
  return (
    <Box
      flexDirection="column"
      borderStyle={focused ? "round" : undefined}
      borderColor={focused ? theme.borderFocus : theme.border}
      paddingX={1}
      width={width}
    >
      {visible.map((line, index) => {
        const markerAt = line.indexOf(marker);
        if (markerAt === -1) {
          return (
            <T key={`composer-${index}`} wrap="truncate-end">
              {index === 0 ? "> " : "  "}
              {line}
            </T>
          );
        }
        const left = line.slice(0, markerAt);
        const char = line.slice(markerAt + 1, markerAt + 2) || " ";
        const right = line.slice(markerAt + 2);
        return (
          <T key={`composer-${index}`} wrap="truncate-end">
            {index === 0 ? "> " : "  "}
            {left}
            <T inverse>{char}</T>
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
    "  Up/Down      scroll trace, select a state",
    "  PgUp/PgDn    scroll trace / state detail",
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
