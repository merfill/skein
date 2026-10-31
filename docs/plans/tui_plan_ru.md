# Терминальный интерфейс — сессионный TUI на Ink

> Английское зеркало — `docs/plans/tui_plan.md`.
>
> Статус: реализован первый срез. Typecheck чистый; офлайн-набор — **526 passed,
> 40 skipped**. Live-прогоны модели в этот срез не входили.

## 1. Цель

Сессии нужен интерактивный терминальный интерфейс, который показывает работу текущей
задачи по ходу выполнения, а не печатает весь ход после завершения. TUI — основной
интерфейс; старый построчный REPL остаётся запасным режимом `--plain` для скриптов, SSH
и тестов.

UI — слой представления. Он не владеет IR, сессией или циклом задачи.

## 2. Архитектура

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

- `src/session/progress.ts` — контракт прогресса: границы ходов, model/tool calls,
  добавленные события, смены состояний, пауза, report. Это не IR и не телеметрия; на
  выполнение он не влияет.
- `src/loop/graph.ts`, `src/session/session_agent.ts`, `src/session/observer.ts`,
  `src/session/driver.ts` — испускают события прогресса.
- `src/tui/view_model.ts` — чистое представление задачи: состояния, диапазоны ходов,
  токены по состояниям, история задач, исходы, итоги.
- `src/tui/app.tsx` — Ink-приложение, ввод, фокус, оверлеи.
- `src/tui/run.tsx` — вход в alternate screen.
- `src/tui/panels.tsx`, `trace_lines.ts`, `markdown.ts`, `highlight.ts`, `theme.ts` — панели и
  терминальный рендер.

Пока задача выполняется, TUI держит её live-tail в отдельной карте до синхронизации unit'а
драйвером; сами события в журнал сессии он не пишет.

## 3. Панели

| Панель | Где | Что показывает |
|---|---|---|
| header | сверху, всегда | токены (in/out — первыми, потому что узкий терминал режет хвост), задачи, ходы задач, вызовы модели, workspace, модель, режим |
| main trace | центр | ходы пользователя, ответы/report, tool calls/results, маркеры состояний; скролл |
| current task | справа, всегда при ширине >= 72 | request, внимание, wall-clock, состояния с диапазонами ходов/ходами/токенами, детали выбранного состояния (`what`, полный `stop.why`, actions) |
| task history | левый overlay (`Ctrl-T`) | read-only список задач и детали выбранной; перекрывает trace, не сдвигает его |
| activity | над composer | текущий агент/tool/состояние/действие и пауза |
| composer | снизу | многострочный ввод, курсор; `/` пока обычный текст |
| pause / help | overlay | `r`/`c`/`q`, справка по клавишам |

Панели юнитов нет: `reading`, `session` и `observer` — внутренние адреса, а не
навигируемые пользовательские объекты. История показывает только task-юниты.

## 4. Представление задачи

Состояние — это `move`; диапазон ходов начинается с `move.payload.turn`. Конец — начало
следующего состояния минус один; текущее состояние заканчивается последним ходом задачи.
Токены состояния — task-события `model_call` в этом диапазоне; tool calls — task-события
`tool_call`. `stop.why` показывается дословно: это факт, а не вердикт. Rollback
показывается как `cancelled at <state>`.

Детали выбранного состояния переносят длинный итог; `PgUp`/`PgDn` скроллят детали.
Wall-clock считает TUI store от старта задачи до результата (при паузе задача остаётся
открытой).

## 5. Markdown и цвет

- `marked` парсит Markdown в блочные и inline-токены.
- Рендер выдаёт **спаны**, а не один стиль на строку: bold/italic/strikethrough, inline-код,
  ссылки, списки, blockquote, таблицы и fenced code.
- `lowlight` (highlight.js) подсвечивает код; `string-width` переносит по терминальным
  колонкам.
- В `theme.ts` две палитры, тёмная и светлая. Светлый фон определяется через `COLORFGBG`,
  иначе тёмная; `SKEIN_THEME=light|dark` переопределяет.
- Заголовки, inline-код, ссылки и синтаксис используют приглушённые цвета, а не яркие
  ANSI cyan/yellow.

## 6. Управление

- `Enter` — отправить, `Ctrl-J` — новая строка, `Esc` — пауза/закрыть overlay, `Ctrl-C` —
  прервать или выйти, `Ctrl-D` — выйти, `Ctrl-T` — история задач, `Tab` — фокус, `?` — help.
- `Up`/`Down` — скролл trace или выбор состояния; `PgUp`/`PgDn` — страницы.
- Пауза открывает меню `r`/`c`/`q`; повторный `Ctrl-C` выходит без возобновления.

## 7. Тесты

- `tests/tui_progress.test.ts` — события прогресса задачи.
- `tests/tui_view_model.test.ts` — диапазоны состояний, токены, история, usage без задачи.
- `tests/tui_app.test.tsx` — рендер оболочки, ввод, overlay истории.
- `tests/tui_markdown.test.ts` — блоки Markdown, спаны, цвета синтаксиса.

## 8. Отложено

- transcript viewer (`Ctrl-O`) с экспортом в нативный scrollback и поиском;
- OSC 8 ссылки, copy-code, раскрытие tool-результатов;
- потоковый текст модели (цикл пока не потребляет `textStream`);
- mouse, изображения, Mermaid, LSP;
- персистентность сессии и выбор сессии;
- стоимость в телеметрии и панель стоимости;
- тонкий plain-рендерер над тем же view-model (старый REPL пока остаётся).

## 9. Команды

```sh
npm run cli -- --dir <project>            # TUI
npm run cli -- --dir <project> --plain    # line REPL
SKEIN_THEME=light npm run cli -- --dir <project>
npm run typecheck
SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'
```
