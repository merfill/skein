# Handoff — RequestObserver (Tier 4a)

> Единый handoff вместо старых файлов. Не добавлять RU-зеркало и ссылку в README.
> Это рабочий документ передачи; код 4a реализован и проверен.

## Статус

- **4a реализован.** Детерминированные триггеры, минимальная сессия, `RequestObserver`,
  `hint`/`memo`/`halt`, инструменты обзора.
- **4b не реализован:** `SessionAgent`, операции сессии и статусы внимания остаются
  концепцией.
- Typecheck и офлайн-набор: **447 passed, 40 skipped**.
- Синтетические live-сценарии `entry`/`long` прошли.
- Реальные live-прогоны трёх задач прошли; `state_cycle` на реальной задаче пока не
  подтверждён (см. ниже).
- Изменения готовы к коммиту; этот handoff входит в коммит.

## Что реализовано

### Сессия и стек

- `src/session/types.ts`, `src/session/session.ts`:
  - журнал сессии, unit'ы, стек, `pending`, `focus` как вершина стека;
  - типы unit'ов: `task | observer | session`;
  - `observerDepth`, push/pop, append-only журнал.
- `src/session/triggers.ts`:
  - `budget`: остаток ≤ `K`, только для открытого состояния;
  - `state_cycle`: `N`-й вход в тот же остров через `move`;
  - `state_long`: больше `M` ходов в состоянии;
  - дедуп по anchor/эпохе; счётчики — производные поля `State`.
- `src/ir/graph.ts`: `stateEntries` считается в `fold`; `move.turn` пишется при входе.

### Grace на `max_turns`

- Острова `end|patch|recovery|construction`: один раз `+G` ходов.
- Жёсткий потолок `max_turns + G`; остальные состояния завершаются сразу.
- Отдельного observer-триггера на самом `max_turns` нет.

### Observer

- `src/session/observer.ts`: `runRequestObserver`, seed `outline`/`state`, bounded loop,
  survey-лимит, decision.
- `src/llm/observer.ts`: AI SDK adapter, zod-схемы инструментов, `createObserverDeps`.
- Инструменты: `outline`, `state`, `turns`, `attempt`, `body`, `rendered`.
- Реакции: `hint` (state-scoped), `memo` (unit-scoped), `halt`.
- Hint/memo пишутся в журнал задачи как `system`, hint привязан к `move`; `applyReaction`
  проверяет evidence и длину (≤ 800 символов).
- `surveyLimit` (по умолчанию 3): после лимита observer получает «Decide now».
- Вложенность: инфраструктура `ObserverDeps.maxDepth`/`observerDepth`; реальные вложенные
  триггеры — будущее.
- `SKEIN_OBSERVER=false` отключает observer в live/bench; по умолчанию включён.

### Lenta/projection

- `hint`/`memo` рендерятся как `system`; hint исчезает при закрытии состояния, memo живёт
  до конца запроса.
- `nudge` и терминальный `no_progress` удалены; `max_turns` — абсолютный предохранитель.
- `outline`/`state` показывают observer'у `entries`/`turns`; счётчики в агенте задачи пока
  не показываются (это будущий терминал/UI).

## Переменные окружения

- `SKEIN_OBSERVER` — `true` по умолчанию, `false` отключает.
- `SKEIN_STATE_CYCLE_ENTRIES` — по умолчанию `3`.
- `SKEIN_STATE_LONG_TURNS` — по умолчанию `20`.
- `SKEIN_BUDGET_TURNS` — по умолчанию `3`.
- `SKEIN_GRACE_TURNS` — по умолчанию `5`.
- `SKEIN_MAX_TURNS` — общий лимит ходов.

## Live-проверка

### Синтетика

- `tests/sandbox/observer-live.ts entry` — третий `patch`, `state_cycle`; hint применён.
- `tests/sandbox/observer-live.ts long` — 21 ход в `orientation`, `state_long`; hint применён.

### Реальные задачи (низкие пороги)

1. `fix-ocaml-gc`, `SKEIN_STATE_CYCLE_ENTRIES=2`, `--turns 12`:
   - reward 0, `max_turns`, 1 `budget`-триггер, 1 hint, **1.89₽**;
   - `state_cycle` не сработал: повторного входа в остров не было.
2. `regex-log`, `SKEIN_STATE_LONG_TURNS=3`, `--turns 12`:
   - reward 1, `request_addressed`, 2 триггера (`state_long`, затем `budget`), 2 hint,
     **3.51₽**.
3. `password-recovery`, `--turns 3`:
   - reward 0, `max_turns`, 1 `budget`-триггер на первом ходу, 1 hint, **0.224₽**.

Итого ≈ **5.62₽**. Трассы и `session.json` пишутся в
`bench/runs/sandbox-tasks/<timestamp>-<task>/`.

## Найдено и исправлено при проверке

- `budget` срабатывал на закрытом состоянии, hint не попадал на ленту. Теперь бюджетный
  триггер требует открытое состояние.
- `turns` дублировал команду; теперь показывает `-> obs:id: <first line>`.
- `body` принимает observation/action/closure-label; описание уточнено.
- Добавлен лимит длины hint/memo (800) на уровне `applyReaction`.
- Промпт observer переписан: положительная роль советника, три ситуации человеческим
  языком, survey-лимит, hint как «дельта», без «final turn» и `epoch` в промпте.

## Что осталось

- **Реальный `state_cycle`:** нужен прогон более длинный или задача, которая реально
  возвращается в тот же остров. Синтетика уже покрыта.
- **Stage 2:** `repeat`, `reasoning_bloat`; реальные вложенные observer-триггеры поверх
  `maxDepth`; дополнительные инструменты не нужны.
- **Терминал/UI:** показ состояния, числа ходов, графа переходов — позже.
- **Калибровка:** пороги `3/20/K/G`, survey/maxTurns observer и стоимость на реальных
  трассах.
- **Политика `max_turns`:** для дальних состояний observer на самом лимите не запускается
  (решено оставить так).
- **Коммит/пуш** — следующий шаг.

## Команды

```sh
npm run typecheck
SKEIN_LIVE=false npx vitest run --exclude 'tests/sandbox/**'
```

Live (только с go-ahead):

```sh
SKEIN_LIVE=true SKEIN_OBSERVER=true SKEIN_STATE_CYCLE_ENTRIES=2 \
  npx tsx tests/sandbox/sandbox-run.ts fix-ocaml-gc --turns 12
SKEIN_LIVE=true SKEIN_OBSERVER=true SKEIN_STATE_LONG_TURNS=3 \
  npx tsx tests/sandbox/sandbox-run.ts regex-log --turns 12
SKEIN_LIVE=true SKEIN_OBSERVER=true \
  npx tsx tests/sandbox/sandbox-run.ts password-recovery --turns 3
```

## Файлы

- План: `docs/plans/request_observer_plan{,_ru}.md`.
- Код: `src/session/`, `src/llm/observer.ts`, `src/config/settings.ts`,
  `src/ir/graph.ts`, `src/ir/project.ts`, `src/loop/graph.ts`.
- Тесты: `tests/{session,triggers,apply,outline,observer,observer_model,observer_integration,observer_fixtures,budget_grace}.test.ts`,
  `tests/sandbox/observer-{fixtures,live}.ts`.
