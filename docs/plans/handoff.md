# Handoff — Tier 4: RequestObserver и сессия

> Рабочий документ передачи. Английского зеркала нет.
> Отправная точка — `docs/session_concepts.md`/`_ru.md`, `docs/plans/tui_plan*` и планы
> `docs/plans/session_{agent,driver,interrupt}_plan*`.

## 2026-11-03 — TUI: @-файлы и слэш-команды

- **`@`:** меню файлов над композером (`workspace.listFiles`, `SKIP_DIRS`), фильтр по
  подстроке с приоритетом basename, `↑/↓`, `Enter`/`Tab` вставляют `@path`, `Esc` закрывает.
  Индекс пересобирается при каждом открытии меню. Вставка — только путь, без содержимого;
  dot-файлы и пути с пробелами не поддерживаются.
- **`/`:** меню команд `new`/`help`/`tasks`/`pause`/`resume`/`cancel`/`quit`/`mouse`/
  `verbose`/`status`/`clear`; `//` — литеральный слэш, неизвестная команда не уходит в модель.
  `/new` создаёт новую in-memory сессию, чистит trace/паузу/снапшоты; телеметрия кумулятивна;
  команда запрещена во время run и паузы.
- **Файлы:** `src/tui/completion.ts`, `CompletionPanel` в `src/tui/panels.tsx`,
  `src/tui/app.tsx`; тесты `tests/tui_completion.test.ts`, дополнен `tests/tui_app.test.tsx`;
  `docs/plans/tui_plan*.md`.
- **Проверки:** typecheck чистый; офлайн **579 passed, 40 skipped**.
- **Коммит:** `99ea7fc`.

## 2026-11-03 — Палитра/токены TUI, контракт ответа general

- **Палитра:** `src/tui/theme.ts` переведена на точные роли из темы opencode
  (`packages/tui/src/theme/assets/opencode.json` в апстриме): light/dark, markdown
  (heading/code/link/strong), syntax. Активный блок — белый фон в light и чуть светлее
  в dark; markdown-цвета не перекрашиваются. Activity-индикатор — braille + `working ·`.
- **Markdown:** убран кап 100 колонок и отступ — вывод снова на всю ширину панели
  (`src/tui/trace_lines.ts`). Узкая мера была компенсацией тёмного фона, а не плотности.
- **Токены:** header — `ctx` + Σ `in/out/cache/rsn`; панель задачи — `in` = текущий
  контекст (последний input), `out` = out+reasoning, плюс `cache`; по ходу — только
  `in/out`. `view_model.ts` собирает `cachedInputTokens` и `contextTokens`.
- **Многословность general:** причина — не бриф и не «глубина чтения». Сырой бриф
  «расскажи о проекте» дал 2 хода/2 чтения, но 4083 симв. (контроль с расширенным
  брифом — 4388). В opencode 1.19.5 для DeepSeek выбирается
  `packages/opencode/src/session/prompt/default.txt` с жёстким контрактом краткости,
  которого не было у general. После переноса в `GENERAL_BASE_PROMPT` (без дублей) —
  1694–2010 симв. / 707–871 out на трёх прогонах. Модельно-специфичные промпты
  (gpt/claude/gemini/kimi/trinity) отложены: без live-проверки на этих моделях
  рискованно.
- **Проверки:** typecheck чистый; офлайн **560 passed, 40 skipped**.
- **Коммиты:** `9fa9a5f` (палитра/токены), `d196ea1` (контракт general), `014c726`
  (markdown на всю ширину).

## 2026-11-03 — Session/general prompts, text stop, AGENTS.md

- **Session prompt:** `SESSION_BASE_PROMPT` переписан положительно: маршрут по результату
  (`respond` — ответ из диалога; `general` — ответ требует разведки, ничего не меняется;
  `start` — изменение workspace/команда). Убраны `request`/`plan`, отрицания и дубли;
  форматирование и цитаты относятся только к `respond`. Описания `respond`/`general`/`start`
  приведены в соответствие.
- **General stop:** `general_stop` убран. `invokeTools` получил `allowText`; general
  принимает текстовый ответ и переводит его в штатный `stop`-узел (`stop` edge, provenance
  llm). Task по-прежнему требует tool call.
- **Reasoning на ленте:** `historyOf` снова кладёт `payload.reasoning` в assistant-сообщение.
  До этого general не видел своих прошлых рассуждений и каждый ход заново интерпретировал
  вопрос.
- **Tool surface:** general получил `grep`/`list`; `general_bash` переименован в `shell` и
  описан как fallback; `read`/`recall` получили узкие general-описания.
- **AGENTS.md:** general получает `AGENTS.md` как engine-recorded project instructions
  (`projectInstructionsText` + `generalContextText`). Это снимает главную причину похода
  в `tests/`: без глоссария «коллекции» читались как test fixtures; с `AGENTS.md`
  («ProofWriter collection notes (eval harness)») general сразу идёт в `docs/`/`evals/`.
- **TUI:** markdown на всю ширину панели (кап 100 и отступ позже убраны); activity-индикатор
  анимируется (теперь braille `⠋⠙⠹…` + `working ·`) только при running.

**Наблюдения live (ankyra, копия в /tmp):**
- text stop сам по себе (run4) и tool surface как в opencode (run5) не уменьшили ходы
  (10 + 10); stop-фраза (run6) сократила ответы, но не ходы.
- после `AGENTS.md` g1 в CLI: первый action — `evals`/`docs`, не `tests`; 9 ходов.
- g2 напрямую с `AGENTS.md`: 7 ходов, 8 tool calls, 3 465 симв. — сопоставимо с траекторией
  opencode (`docs` → `reasoning_roadmap` → collection-доки → ответ).
- `npm run typecheck` чистый; офлайн **560 passed, 40 skipped**.
- Observer для general не добавляли: систематики нет, term-детур снят; вернуться, если
  будет стабильно 9–10 ходов или повторные чтения без новых наблюдений.

## 2026-11-01 — TUI, general, task loop

- **General:** бриф session-агента ограничен глубиной запроса (без инвентаризации и
  аудита, которых не просили); у general свои `general_bash`/`general_stop` (read-only,
  Markdown-отчёт), facts из probe, snapshot при входе и `restoreChanged` при выходе.
  Session-агент больше не получает карту дерева (только root), поэтому бриф не перечисляет
  каталоги и файлы. `read` отдаёт до 32K, и его результат хранится в истории general целиком;
  остальные tool-результаты — 2k (голова + 400 хвоста, `recall obs:…`). После
  `max_turns` — один финальный вызов без инструментов с запретом домысливать. Промпт
  требует общего вывода, ясного академического языка и отсутствия лишних деталей.
- **Task loop:** LangGraph удалён. `src/loop/graph.ts` — обычный `while`, `src/loop/state.ts` —
  типизированная запись. `@langchain/langgraph`/`@langchain/core` убраны из зависимостей.
  У интерактивной task нет дефолтного `maxTurns`; `--max-turns` остаётся явным лимитом
  для bench/headless, `budget`-триггер работает только при нём. `state_cycle`/`state_long`
  observer'а остаются. Два пустых ответа подряд → `no_decision`. Завершённый run без
  терминального `end` помечается `abandoned`, а не `suspended`.
- **Checkpoint:** общий `SKIP_DIRS` (`src/tools/skip_dirs.ts`) для `list`/`grep` и снапшота;
  `restoreChanged` восстанавливает только изменённые пути. На `ankyra` снапшот сканирует
  263 файла / 6 МБ / ~2 мс вместо 492 МБ.
- **TUI:** фоновые панели с зазором; блоки сообщений на всю ширину, collapse/expand
  кликом (при `SKEIN_MOUSE=true`/`Ctrl-G`) или `Tab`+`Space`; Thought-блоки с таймингом;
  цветной diff для `edit`; подсветка кода (авто для fence без языка); композер 5 строк
  с переносом и курсором между символами; история ввода `Up/Down`; правая панель —
  текущее состояние, ходы (`tN · токены · время`), суммы по состоянию и задаче; observer
  кратко показывается в статусе. Mouse capture по умолчанию выключен (нативное выделение),
  alternate-scroll — для колеса; `Ctrl-G` переключает capture.
- **Логи:** `SKEIN_LOG` — JSONL, по умолчанию `<project>/.skein/session.log`
  (`off`/свой путь). Пишет реплику, бриф, model calls с usage, tool-таргеты, observer,
  stopReason и ответы; reasoning — до 4k. Полные выводы инструментов остаются в
  `.skein/observations`.
- **Проверки:** typecheck чистый; офлайн **556 passed, 40 skipped**. Live: `general-live`,
  `session-live`, `observer-live` прошли; `fix-ocaml.live` падает на `max_turns` и на чистом
  `HEAD` тоже (существующая проблема, не регрессия).
- **Открыто:** почему простая задача уходит в долгий construction (нужен `session.log`
  следующего прогона); эскалация observer/no-progress guard — после разбора лога;
  `fix-ocaml.live`; персистентность сессии; L0 при переполнении; стоимость.

## TUI (сделано, 2026-10-31)

- **Основной режим:** `npm run cli` открывает Ink-TUI в alternate screen. Старый построчный
  REPL остаётся за `--plain`; `Enter` отправляет, `Ctrl-J` — новая строка, `Ctrl-C` —
  прервать/выйти, `Ctrl-D` — выйти.
- **Живой прогресс:** `src/session/progress.ts` — side-channel `ProgressEvent`; его испускают
  `src/loop/graph.ts`, `src/session/{session_agent,observer,driver}.ts`. События:
  `turn_started`, `model_call_started/finished`, `tool_started/finished`, `events_added`,
  `state_changed`, `turn_finished`, `paused`, `report_started/finished`.
- **Панели:** header (`ctx` — вход последнего model call агента сессии, `Σ in/out` — суммарный расход всех вызовов, задачи, ходы, вызовы, workspace, модель, режим), main trace,
  постоянная панель текущей задачи справа (состояния, диапазоны ходов, токены, действия,
  полный `stop.why`), read-only история задач слева по `Ctrl-T`, activity, composer,
  pause/help overlay. Панели юнитов нет: `reading`/`session`/`observer` — внутренние адреса;
  история показывает только `task`.
- **View-model:** `src/tui/view_model.ts` — состояния из `move`, токены по turn-диапазонам из
  task-телеметрии, wall-clock из TUI store, исходы как факт (`open at`, `stop.why`,
  `cancelled at`). Header считает `Σ` по всем model calls (`usageTotals`), включая
  session-agent, поэтому расход виден и без запуска задачи; `ctx` — вход последнего вызова
  именно агента сессии, а не задачи, и не сумма (сумма больше окна, потому что контекст
  переотправляется каждый ход).
- **Markdown:** `marked` → спаны; `lowlight` подсвечивает код; `string-width` переносит по
  колонкам; таблицы, списки, blockquote, ссылки, inline-код. `theme.ts` — тёмная/светлая
  палитры, автоопределение по `COLORFGBG`, override `SKEIN_THEME=light|dark`. Заголовки и
  синтаксис приглушённые.
- **Файлы:** `src/tui/{app,panels,trace_lines,markdown,highlight,theme,view_model,run,types}`,
  `src/session/progress.ts`, `src/cli.ts`.
- **Тесты:** `tests/tui_app.test.tsx`, `tui_markdown.test.ts`, `tui_progress.test.ts`,
  `tui_view_model.test.ts`.
- **General-юнит:** `UnitType "general"` — один рабочий сегмент с той же IR-формой
  (`request → move(general) → plan → items → actions → observations → stop`), read-only
  инструменты `read`/`grep`/`list`; assistant-ответ хранится на stop-узле, `stop.why` — короткий
  итог. Операция `general` в session-агенте; routing: `respond` / `general` / `start`. Панель и
  история общие, отдельного окна нет. Файлы — `src/session/general.ts`, `src/llm/general.ts`;
  тест — `tests/general_unit.test.ts`. Существующие task/island-промпты не менялись.
- **Осталось:** `probe`/`fetch` в general; transcript
  viewer (`Ctrl-O`) с нативным scrollback/поиском, OSC 8 ссылки,
  copy-code, раскрытие tool-результатов, потоковый текст модели, mouse/изображения/Mermaid,
  персистентность сессии и выбор сессии, стоимость. Детали — `docs/plans/tui_plan.md`.

## Статус

- **4a реализован:** триггеры, минимальная сессия, `RequestObserver`, `hint`/`memo`/`halt`,
  инструменты обзора.
- **4b реализован:** статусы внимания, L0/L1, session-unit, операции `respond`/`start`,
  инструменты `read`/`unit`/`state`/`turns`/`body`/`search`, reading-unit, драйвер
  `runSessionTurn`, REPL, CLI.
- **4c реализован:** прерывание как пауза на границе шага, возобновление с журнала и отмена с
  полным откатом задачи из снапшота входа. Единообразно для агента сессии, задачи и
  наблюдателя; `AbortSignal` протянут через модельные адаптеры, обрыв модели не ретраится и не
  становится `llm_error`. В REPL: `Esc` — пауза, `Ctrl-C` — меню с `c`, повторный `Ctrl-C` на
  паузе — выход; меню `r`/`c`/`q`. Отмена задачи пишет `rollback` в журнал и предупреждает,
  если снапшота нет.
- **Снапшоты:** хранилище перенесено из `tests/sandbox/checkpoint.ts` в
  `src/tools/checkpoint.ts` без переписывания (hardlink-клон, дельта, кэш сигнатур), добавлен
  `restoreTree`; `fsWorkspace` получил опцию `checkpoints`, CLI чистит хранилище на границах
  сессии.
- **L0:** в агенте сессии больше не усекается (`truncate: false`); строки append-only;
  у session-unit фиксируются запрос, переформулировка и возврат.
- **Телеметрия:** `src/session/telemetry.ts` — usage, снимки контекста, model/tool calls,
  pause/resume/cancel, `usageTotals`/`unitStats`/`sessionSummary`/`contextTimeline`; CLI пишет
  в in-memory sink. Панели/UI нет.
- Typecheck чистый; офлайн-набор: **560 passed, 40 skipped**. Live/bench для 4c и TUI не запускались; general-live и session-live пройдены.
- **Синтетический live-сценарий пройден:** `read` — один ход; `body` по `obs:reading:1`;
  `respond`; затем `start` с переформулировкой, включающей правило; задача создала
  `Makefile`/тест и `make test` прошёл. `tasks=1, replies=2`.
- **Разделение инструментов (A, 2026-10-31):** у session-агента больше нет
  `read`/`grep`/`list`/`probe`; остались memory/outline (`unit`/`state`/`turns`/`body`/`search`)
  и операции `respond`/`general`/`start`. Чтение материала — general-unit, изменения — task.
  Старые `session-tools-live` и `session-research-live` удалены; их место заняла
  `general-live`.
- **Live-синта `general-live` пройдена:** анализ → `general`, coding task не открыт,
  general-unit прочитал 6 файлов (`list`/`read`), ответ Markdown с путями, `tasks=0,
  general=1, turns=4`.
- **Live-синта `session-live` пройдена на всех маршрутах:** «прочитай NOTES.md» → `general`
  (4 хода, `list`/`read`/`grep`), «какое там правило?» → `respond`, «создай Makefile/тест» →
  `start`; `routes=["general","respond","start"]`, `tasks=1, general=1, replies=1`.
- **Post-task report:** после `start` драйвер просит агента сессии написать Markdown-report;
  событие `report` пишется в тот же session-unit. Report — отдельная plain-комплита по
  детерминированному следу задачи, без инструментов.
- **View-слой:** `src/session/view.ts` показывает calls/results сессии, ходы задачи, answer и
  report. Результаты инструментов — preview 600 символов с `… [truncated; use --verbose]`;
  `--verbose` раскрывает полный результат и reasoning в блоке `Thought:` (как collapsed
  «Thought» в opencode).

## Что реализовано

### 4a

- `src/session/{types,session,triggers,observer,outline,apply}.ts`.
- Триггеры `budget`/`state_cycle`/`state_long`; observer-unit; `hint`/`memo`/`halt`.
- `SKEIN_OBSERVER`, пороги в `src/config/settings.ts`.

### 4b — память и сессия

- `src/session/types.ts`: unit-типы `task|general|observer|session|reading`; статусы внимания
  (`active|suspended|abandoned|completed`), `abandoned` зарезервирован и не порождается.
- `src/session/session.ts`: журнал сессии append-only, стек, `pending`, `utteranceSeq`,
  `attentionOf`; события `suspend|resume|abandon|operation|refusal`.
- `src/session/session_outline.ts`: L0/L1; L0 включает ответ/операцию, отказ и reasoning;
  для general — детерминированный trace действий (`read`/`grep`/`list`) и preview answer;
  reading-unit показывает полный размер.
- `src/session/session_memory.ts`: `state` (L2), `turns` (ходы + reasoning), `body` (L4),
  `search` (L4); `body` отклоняет не-наблюдения.
- `src/session/reading.ts`: standalone reading-unit, `read(path)`, preview + полный размер
  (`bytes`/`lines`) + адрес; session-агент его больше не создаёт (материал читает general).
- `src/session/session_agent.ts` + `src/llm/session_agent.ts`: bounded loop (12 ходов),
  reasoning, `surveyLimit`, memory/outline tools only (без workspace), текстовый ответ без tool
  call превращается в `respond`; ответы — GitHub-flavored Markdown до ~350 слов.
- `src/session/operations.ts`: `respond`, `general` и `start` (≤4000); отказ пишется в журнал
  сессии (`refusal`) и виден в L0.
- `src/session/driver.ts`: `runSessionTurn` — `respond`, `general` или `start`; general и task
  изолированы, контекст передаётся только текстом переформулировки.
- `src/session/repl.ts`, `src/cli.ts`, `npm run cli`.
- `src/loop/graph.ts`: `AgentInput.open` для открытия task-unit в существующей сессии.
- `src/session/session_workspace.ts`: read-only `SessionWorkspace` (`read`/`version`/`listFiles`/
  `grep`/`probe`) и форматтеры с окном/курсором. В session-agent не подключён: чтение материала
  делает general-unit через обычные task-инструменты `read`/`grep`/`list`.
- `src/session/general.ts` + `src/llm/general.ts`: general-unit (один `move(general)`, план,
  read-only `read`/`grep`/`list`, `stop`; assistant-ответ на stop-узле).
- `src/session/{types,session,session_outline}.ts`: событие `report` в журнале сессии и его
  след в L0.
- `src/session/driver.ts` + `src/llm/session_agent.ts`: post-task `report` (`SESSION_REPORT_PROMPT`,
  `modelSessionReporter`); trace = состояния задачи, изменённые файлы, исход, число ходов.
- `src/session/view.ts`: терминальный рендер `renderTurn` (calls/results, task/general moves/actions,
  answer/report, `--verbose` для reasoning); `src/session/repl.ts` реэкспортирует.

### 4c — прерывание, откат и телеметрия

- `src/abort.ts`: `isAborted`.
- `src/llm/{structured,session_agent,observer}.ts`: `abortSignal`; `usage`/`model` в
  `Proposals`/`SessionReply`/`ObserverReply`; обрыв не ретраится.
- `src/loop/{graph,state,propose}.ts`: `paused` в состоянии/результате, проверки на границе
  шага, `telemetry` в `AgentDeps`.
- `src/session/{session_agent,observer}.ts`: `signal`, `startTurn`, `paused`, `telemetry`.
- `src/session/driver.ts`: `paused` в `SessionTurnResult`, `resumeTurn`, `cancelTurn`, полный
  откат по снапшоту, событие `rollback`, запись pause/resume/cancel в телеметрию.
- `src/session/repl.ts`/`src/cli.ts`: режим паузы, меню, `Esc`/`Ctrl-C`, очистка снапшотов.
- `src/tools/{checkpoint,workspace}.ts`: `restoreTree`, опция `checkpoints`,
  `clearCheckpoints`; тестовый путь оставлен shim'ом.
- `src/session/telemetry.ts`: контракт и производные представления; `src/session/session_outline.ts`:
  L0 без усечения для агента сессии.
- `src/ir/{events,graph}.ts`: событие `rollback`.

### Тесты и сценарии

- `tests/session_attention|outline|operations|agent|memory|reading|workspace_tools|view|driver|repl|scenario.test.ts`.
- `tests/session_pause.test.ts`: пауза/возобновление/отмена задачи, сессии и наблюдателя,
  откат по снапшоту, предупреждение без снапшота, REPL-меню, классификация обрыва.
- `tests/telemetry.test.ts`: usage, снимки контекста, производные представления.
- `tests/checkpoint.test.ts`: `restoreTree` и точечное восстановление.
- `tests/sandbox/session-live.ts` — live-синта с подробным логом (general read, session
  calls/results, reasoning, task turns, `task answer`).
- `tests/sandbox/general-live.ts` — live-синта анализа: `general`, read-only инструменты,
  Markdown-ответ с путями, без coding task.

## Результаты live-прогонов

1. Первый: чтение через task (12–15 ходов), ответа на «какое правило» не было; выяснилось, что
   текстовый ответ модели выбрасывался, а `body` принимал неверные id.
2. Второй: лимиты 800 → 2000/4000, отказ и reasoning в L0. Чтение всё ещё через task;
   модель уходила в уточнения, `да` не подходило к вопросу.
3. Третий (после reading-unit и исправлений): `read` — один ход, `body` по `obs:reading:1`,
   `respond`; затем `start` с переформулировкой, включающей правило; задача создала
   `Makefile`/`tests/test_app.py`, `make test` — `exit 0`, `Ran 1 test … OK`. Файл
   `src/app.txt` не менялся (не требовался). `tasks=1, replies=2`.
4. CLI (`tsx src/cli.ts --dir …`): `list`/`grep`/`read` → Markdown-ответы; затем `start` →
   `task r1` и post-task `report` с разделами Changes/Verification/Caveat. Служебные строки
   `[n] move/stop` показываются только с `--verbose`; reasoning — тоже.
5. General (`general-live`): запрос «разбери по шагам, как устроен запуск задачи на
   бенчмарке» по мини-проекту → `general`, 4 хода, `list`/`read`, Markdown с путями; coding
   task не открылся.
6. CLI по копии репозитория: «как устроен post-task report» → `grep`/`list`/`read`, Markdown с
   путями и строками; task не открывался.

## Возможные типы unit'ов

Сейчас есть `task`, `general`, `session`, `observer`, `reading`. Новый тип оправдан, если у работы
свой корень и журнал, нужен отдельный след в L0 и адресуемые наблюдения, и она не сводится
к одному tool-call внутри session-unit'а.

| Кандидат | Зачем | Оценка |
|---|---|---|
| `search` / `list` | «где используется X», «что лежит в каталоге» | **сделано как tools** `grep`/`list`, без unit: один tool-call, снимок мира, тело вне ленты не нужно |
| `fetch` | URL → файл/наблюдение, внешняя документация | следующий кандидат в факт-unit, если нужен адресуемый источник |
| `command` / `check` | один запуск команды: версия, тест, проверка | не нужен: это Verification внутри `task`; сессия read-only |
| `job` | долгий процесс: start/poll/stop, свой журнал | не нужен: background уже в `task` |
| `review` | проверка diff/тестов и замечания | не unit: island внутри `task` |
| `delegate` | подзадача со своим журналом | отклонено: против non-goals «не строить субагентов» |

`probe` (окружение, пакетные менеджеры, интерпретаторы, material) — тоже **tool**, а не unit:
он отдаёт уже записанный `SessionProbe` по `kind` и кэшируется на сессию.

Виды работы внутри `task` (`orientation`, `localization`, `research`, `patch`, `recovery`,
`construction`, `verification`, `end`) — это острова, а не типы unit'ов; новый «тип задачи»
не требует нового unit'а, а другого маршрута по островам.

## Наблюдатель для general — что попробовать

**2026-11-03:** general закрывается текстом; `general_stop` убран. Причина похода в
`tests/` — отсутствие `AGENTS.md` в контексте, а не отсутствие observer'а. Observer отложен
до систематики (стабильно 9–10 ходов / повторные чтения без новых наблюдений).

Сейчас `RequestObserver` подключён только к `task` (`src/loop/graph.ts`): триггеры
`state_cycle`/`state_long`/`budget`, task-лента, решение `hint`/`memo`/`halt`, запись в
журнал task. У general наблюдателя нет — только `generalMaxTurns` и финальный вызов без
инструментов. Идея: тот же механизм раз в N шагов смотрит ленту general и, если нужно,
вставляет system-сообщение; но для general есть отдельные проблемы.

**Что не подходит как есть:**
- `detectTriggers` (`src/session/triggers.ts`) заточен под task: `currentMove`/`moveIsland`/
  `stateEntries`. У general один `move` со state `general`, острова нет: `state_cycle` не
  срабатывает, `state_long` меряет ходы в move (дефолт 20 при `generalMaxTurns=9`), `budget`
  требует явного `maxTurns`.
- `alreadyFired` делает триггер one-shot на anchor. Для «каждые N шагов» нужен интервальный
  триггер (epoch/шаг), а не один раз за состояние.
- `defaultObserverTools` (`outline`/`state`/`turns`/`attempt`/`body`/`rendered`) — task-модель;
  general-лента собирается в `historyOf`/`messagesOf` (`src/session/general.ts`), там нет
  task-`outline`/`state`.
- `applyReaction` кладёт `hint`/`memo` в журнал, и task рендерит их через `advisoriesOf` в
  `project`; `runGeneralAgent.messagesOf` их не рендерит.
- `halt` для task завершает run (`observer_halt`). Для general это нарушило бы инвариант
  «state closed only by the doxa's `stop`»: нужен либо только `hint`/`memo`, либо `halt` →
  финальный вызов без инструментов, после которого doxa сама зовёт `general_stop`.
- Пауза/возобновление: observer-unit живёт в session (стек, `observerDepth`); в
  `resumeTurn` general-ветка observer не умеет. Нужно либо поддержать, либо не давать
  general-observer паузить run.
- Стоимость: observer — отдельный model call. «Каждые N шагов» должны быть ограничены
  (`surveyLimit`, `maxTurns`) и не запускаться на каждом ходу.

**Минимальный срез, который стоит попробовать:**
1. **Триггер `general_steps`.** Каждые N `apply`-действий (или ходов) в открытом general-unit;
   N=3–5, настройка. Детерминированный триггер пишется в session (`recordTrigger`), не зависит
   от модели. Считать действия, а не только ходы: проблема — именно число инспекций.
2. **General-observer tools:** `general_brief` (запрос/бриф), `general_actions`
   (action→observation с id), `general_render` (тот же `messagesOf` без system-хвоста),
   `general_body` (полное тело observation по id). Read-only, `surveyLimit` 2–3.
3. **Решение:** сначала только `continue`/`hint`; `memo`/`halt` — после проверки. `hint`
   обязан ссылаться на id действий/наблюдений, иначе это не факт, а мнение.
4. **Вставка:** `hint` — узел `hint` в журнале general (как task) и transient system-turn в
   `messagesOf` на следующем ходу; `memo` — до конца unit. Task-`project`/`buildMessages` не
   трогать.
5. **Инварианты:** observer не закрывает general; закрытие — только `general_stop`;
   `project` остаётся детерминированным; hint не попадает в task-ленту.
6. **Тесты:** фейковый observer — (a) `continue` → новых system-сообщений нет; (b) `hint` →
   следующий turn видит `Tape-agent hint: …`; (c) триггер ровно каждые N действий;
   (d) если включаем `halt` — финальный turn без инструментов, затем `general_stop`.
   Offline; live — только с go-ahead.

**Открытые вопросы:**
- Что считать шагом: ход general, `apply`-действие или новый observation? «Каждые 5 шагов» —
  от чего?
- Наблюдатель видит только бриф или и исходную реплику пользователя? Сейчас general-unit
  знает только бриф; исходная реплика есть у session/driver.
- Нужен ли `halt` для general, или достаточно `hint` «достаточно, отвечай»?
- Держать observer-журнал в session (как task) или это side-channel без unit? В TUI observer
  показывается кратко в статусе.
- Как observer понимает «надо поправить» без task-specific эвристик: повторные чтения,
  отсутствие нового знания, выход за бриф, преждевременная глубина? Промпт observer должен
  быть общим, решение — по ленте, не по имени задачи.
- Стоимость: один observer call каждые N шагов; сравнить на live с текущим `maxTurns` +
  финальным вызовом.

## Оставшиеся вопросы

- **`no_decision`.** Реализован: `empty_reply`/`max_turns` пишется в журнал сессии, виден в L0
  и в view (`session: no decision (…)`); unit остаётся `suspended`. Следующий шаг — отличать
  «модель ничего не сказала» от «упёрлись в cap» в политике (сейчас только reason).
- **Лимит исследования.** Вопрос по репозиторию упёрся в старый `maxTurns=6` и дал
  `session: no action`; поднято до 12, после чего тот же вопрос ответил за 6 ходов. Esc/Ctrl-C
  теперь реализованы, но cap остаётся предохранителем для headless/явного лимита; политика
  `empty_reply` vs `max_turns` — открыта.
- **Навигация по id.** Live показал ошибки `body(unit="reading")` и `body(id="reading:1")`.
  Описания и `body` уже исправлены; нужен повторный live-прогон, чтобы убедиться.
- **Подтверждение.** Заложено промптом (`respond` с формулировкой → `start`), но live-синта
  его не проверяет. Нужен сценарий с веткой подтверждения.
- **Ctrl-C/Esc.** Реализованы: `Esc` — пауза, `Ctrl-C` — меню с `c`, повторный `Ctrl-C` на
  паузе — выход. Меню текстовое, визуального выделения `c` нет. Live-прогон паузы,
  возобновления и отмены ещё не делался — нужен go-ahead.
- **Персистентность.** Сессия живёт в памяти процесса; `.skein/session.json` не реализован.
  Снапшоты чистятся на границах сессии; политика хранения/очистки внутри сессии — отдельно.
- **Стратегии возобновления.** Пауза/возобновление текущего unit'а работает; возобновление
  уже пройденного unit'а — новая задача с новой формулировкой, без копирования IR, отдельный
  срез. `revise` отложен.
- **`attempt` (L3), пины, `abandoned`, reading island.** Отложены.
- **L0 при переполнении.** L0 не усекается; если полный L0 превысит контекстное окно, нужен
  явный warning/error, а не усечение — пока не реализовано.
- **Стоимость.** Телеметрия собирает usage; счётчика стоимости, панели и live-meter ещё нет.
- **Снапшоты.** Включают `.git` и тяжёлые каталоги (кроме `.skein`/секретов); производительность
  приемлема, но политика хранения и стоимость на больших деревьях — открытый вопрос.
- **TaskAgent на первом ходу** видит только `move`/`decline` и каждый раз это осмысляет; это
  нормальное поведение state machine, но стоит проверить, не тратит ли оно ходы.

## Команды

```sh
npm run typecheck
SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'
npm run cli -- --dir <project>            # TUI
npm run cli -- --dir <project> --plain    # old REPL
SKEIN_THEME=light npm run cli -- --dir <project>
```

Live (только с go-ahead):

```sh
SKEIN_LIVE=true npx tsx tests/sandbox/session-live.ts
SKEIN_LIVE=true npx tsx tests/sandbox/general-live.ts
```
