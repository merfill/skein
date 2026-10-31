# Terminal UI — the Ink session interface

> Russian mirror — `docs/plans/tui_plan_ru.md`.
>
> Status: implemented (first slice). Typecheck clean; offline suite — **526 passed,
> 40 skipped**. Live model runs were not part of this slice.

## 1. Goal

The session needs an interactive terminal surface that shows the current task's work as it
happens, not a transcript printed after the turn. The TUI is the main interface; the old
line REPL remains as a `--plain` fallback for scripts, SSH and tests.

The UI is a presentation layer. It does not own the IR, the session or the task loop.

## 2. Architecture

```text
loop / session agent / observer
        │  ProgressEvent (side channel)
        ▼
driver ───────────────► TUI store (session + live journals + timings)
                              │
                              ▼
                       view-model (pure)
                              │
                              ▼
                     Ink panels / composer
```

- `src/session/progress.ts` — the progress contract: turn/model/tool boundaries, added
  events, state changes, pause, report. It is not IR and not telemetry; it never influences
  a run.
- `src/loop/graph.ts`, `src/session/session_agent.ts`, `src/session/observer.ts`,
  `src/session/driver.ts` — emit the progress events.
- `src/tui/view_model.ts` — pure task view: states, turn ranges, tokens per state, task
  history, outcomes, totals.
- `src/tui/app.tsx` — Ink application, input, focus, overlays.
- `src/tui/run.tsx` — alternate-screen entry point.
- `src/tui/panels.tsx`, `trace_lines.ts`, `markdown.ts`, `highlight.ts`, `theme.ts` — panels and
  terminal rendering.

The TUI keeps the live tail of a running task in a side map until the driver syncs the unit;
it never writes those events into the session journal itself.

## 3. Panels

| Panel | Place | Contents |
|---|---|---|
| header | top, always | current context tokens and cumulative in/out (`Σ`), tasks, task turns, model calls, workspace, model, mode |
| main trace | centre | user turns, answers/reports, tool calls/results, state markers; scrollable |
| current task | right, always when width >= 72 | request, attention, wall-clock, states with turn ranges/turns/tokens, selected-state details (`what`, full `stop.why`, actions) |
| task history | left overlay (`Ctrl-T`) | read-only task list, selected task details; covers the trace, does not resize it |
| activity | above composer | the current agent/tool/state/action and whether the run is paused |
| composer | bottom | multiline input, cursor, `/` text is ordinary content for now |
| pause / help | overlays | `r`/`c`/`q`, key reference |

There is no unit panel: `reading`, `session` and `observer` units are internal addresses, not
navigable user objects. History shows task units only.

## 4. Task view

A state is a `move`; its turn range starts at `move.payload.turn`. The next state's start
minus one is the end; the current state ends at the task's last turn. Tokens per state come
from task `model_call` telemetry in that turn range; tool calls come from task `tool_call`
telemetry. `stop.why` is shown literally — it is a fact, not a verdict. A rollback is shown as
`cancelled at <state>`.

The selected state's detail block wraps long outcomes; `PgUp`/`PgDn` scroll the detail.
Wall-clock is tracked by the TUI store from task start to result (paused tasks remain open).

The header keeps two token numbers apart: `ctx` is the input size of the last model call (the
current context window), `Σ in/out` is the cumulative usage of every model call in the session.
The cumulative figure is naturally larger than the window because the context is resent on every
turn; it is not a context-usage meter.

## 5. Markdown and colour

- `marked` parses Markdown into block/inline tokens.
- The renderer emits **spans**, not one style per line: bold/italic/strikethrough, inline code,
  links, lists, blockquotes, tables and fenced code.
- `lowlight` (highlight.js) highlights code blocks; `string-width` wraps by terminal columns.
- `theme.ts` has dark and light palettes. It auto-detects light backgrounds through
  `COLORFGBG` and falls back to dark; `SKEIN_THEME=light|dark` overrides it.
- Headings, inline code, links and syntax use muted colours rather than bright ANSI cyan/yellow.

## 6. Interaction

- `Enter` send, `Ctrl-J` newline, `Esc` pause/close overlay, `Ctrl-C` abort or exit,
  `Ctrl-D` exit, `Ctrl-T` task history, `Tab` focus, `?` help.
- `Up`/`Down` scroll the trace or select a state; `PgUp`/`PgDn` page.
- A pause opens the `r`/`c`/`q` menu; a second `Ctrl-C` exits without resuming.

## 7. Tests

- `tests/tui_progress.test.ts` — task progress events.
- `tests/tui_view_model.test.ts` — state ranges, tokens, history, session-only usage.
- `tests/tui_app.test.tsx` — shell rendering, typing, history overlay.
- `tests/tui_markdown.test.ts` — Markdown blocks, spans, syntax colours.

## 8. Deferred

- transcript viewer (`Ctrl-O`) with native-scrollback export and search;
- OSC 8 links, copy-code, expandable tool results;
- streaming model text (the loop does not consume `textStream` yet);
- mouse, images, Mermaid, LSP;
- session persistence and a session picker;
- cost in telemetry and a cost panel;
- a thin plain renderer over the same view-model (the old REPL remains for now).

## 9. Commands

```sh
npm run cli -- --dir <project>            # TUI
npm run cli -- --dir <project> --plain    # line REPL
SKEIN_THEME=light npm run cli -- --dir <project>
npm run typecheck
SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'
```
