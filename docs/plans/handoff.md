# Handoff — Tier 4: RequestObserver и сессия

> Рабочий документ передачи. Английского зеркала нет.
> Отправная точка — `docs/session_concepts.md`/`_ru.md` и планы
> `docs/plans/session_{agent,driver,interrupt}_plan*`.

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
- Typecheck чистый; офлайн-набор: **517 passed, 40 skipped**. Live/bench для 4c не запускались.
- **Синтетический live-сценарий пройден:** `read` — один ход; `body` по `obs:reading:1`;
  `respond`; затем `start` с переформулировкой, включающей правило; задача создала
  `Makefile`/тест и `make test` прошёл. `tasks=1, replies=2`.
- **Инструменты workspace:** `grep`/`list`/`probe` добавлены как tool-call'ы (не unit'ы);
  результат — наблюдение session-unit'а. `probe` кэшируется на сессию.
- **Live-синта `session-tools-live` пройдена:** `list` (5 файлов), `grep add`, `probe
  interpreters`; все ходы — `respond`; `tasks=0, replies=4`.
- **Live-синта `session-research-live` пройдена:** общий вопрос по коду → Markdown с разделами
  и путями; `tasks=0, replies=1, tools={grep:2,read:4,list:1}`.
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

- `src/session/types.ts`: unit-типы `task|observer|session|reading`; статусы внимания
  (`active|suspended|abandoned|completed`), `abandoned` зарезервирован и не порождается.
- `src/session/session.ts`: журнал сессии append-only, стек, `pending`, `utteranceSeq`,
  `attentionOf`; события `suspend|resume|abandon|operation|refusal`.
- `src/session/session_outline.ts`: L0/L1; L0 включает ответ/операцию, отказ и reasoning;
  reading-unit показывает полный размер.
- `src/session/session_memory.ts`: `state` (L2), `turns` (ходы + reasoning), `body` (L4),
  `search` (L4); `body` отклоняет не-наблюдения.
- `src/session/reading.ts`: reading-unit, `read(path)`, preview + полный размер
  (`bytes`/`lines`) + адрес; полное тело читается по path/version.
- `src/session/session_agent.ts` + `src/llm/session_agent.ts`: bounded loop (12 ходов),
  reasoning, `surveyLimit`, текстовый ответ без tool call превращается в `respond`; ответы —
  GitHub-flavored Markdown до ~350 слов.
- `src/session/operations.ts`: `respond` (≤4000, Markdown) и `start` (≤4000); отказ пишется в журнал
  сессии (`refusal`) и виден в L0.
- `src/session/driver.ts`: `runSessionTurn` — `respond` или `start`; task изолирован, контекст
  передаётся только текстом переформулировки.
- `src/session/repl.ts`, `src/cli.ts`, `npm run cli`.
- `src/loop/graph.ts`: `AgentInput.open` для открытия task-unit в существующей сессии.
- `src/session/session_workspace.ts`: read-only `SessionWorkspace` (`read`/`version`/`listFiles`/
  `grep`/`probe`) и форматтеры с окном/курсором. Инструменты `grep`/`list`/`probe` в
  session-agent; описания — только в tool definitions, не в промпте.
- `src/session/{types,session,session_outline}.ts`: событие `report` в журнале сессии и его
  след в L0.
- `src/session/driver.ts` + `src/llm/session_agent.ts`: post-task `report` (`SESSION_REPORT_PROMPT`,
  `modelSessionReporter`); trace = состояния задачи, изменённые файлы, исход, число ходов.
- `src/session/view.ts`: терминальный рендер `renderTurn` (calls/results, task moves/actions,
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
- `tests/sandbox/session-live.ts` — live-синта с подробным логом (session calls/results,
  reasoning, task turns, `task answer`).
- `tests/sandbox/session-tools-live.ts` — live-синта read-only инструментов: `list`, `grep`,
  `probe`; проверяет, что задача не открывается (`tasks=0`).
- `tests/sandbox/session-research-live.ts` — live-синта общего вопроса по коду: Markdown-ответ
  с путями, `grep`/`read`/`list`, без task.

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
5. Research (`session-research-live`): вопрос «как устроен post-task report» по мини-проекту →
   Markdown с `##`-разделами, `src/driver.py`, `record_report`, `src/view.py`; без task.
6. CLI по копии репозитория: «как устроен post-task report» → `grep`/`list`/`read`, Markdown с
   путями и строками; task не открывался.

## Возможные типы unit'ов

Сейчас есть `task`, `session`, `observer`, `reading`. Новый тип оправдан, если у работы
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
npm run cli -- --dir <project> [--verbose]
```

Live (только с go-ahead):

```sh
SKEIN_LIVE=true npx tsx tests/sandbox/session-live.ts
SKEIN_LIVE=true npx tsx tests/sandbox/session-tools-live.ts
SKEIN_LIVE=true npx tsx tests/sandbox/session-research-live.ts
```
