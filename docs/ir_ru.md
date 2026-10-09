# Skein — IR: операции, состояние и управление (as-built)

> Английское зеркало — `docs/ir.md`.

Это **as-built**: как IR устроен в текущем коде. Источник истины по семантике —
`docs/ir_semantics_ru.md` (меняется вместе с кодом); план модели request→goal —
`docs/plans/archive/request_goal_plan_ru.md`. Концептуальный обзор — `docs/concepts_ru.md`;
стек обхода — `docs/plans/traversal_stack_spec_ru.md`; сквозной пример —
`docs/walkthrough_ru.md`.

## 1. Четыре уровня

```
                 append-only              pure            pure
  действия ─▶ журнал (Event[]) ──fold──▶ State ──project──▶ Context ──▶ LLM
     ▲                                                             │
     └─────────── предложение: ровно один оператор за ход ◀────────┘
```

1. **Журнал** (`src/ir/events.ts`) — append-only, единственная истина.
2. **State** (`src/ir/graph.ts`) — `fold(events)`: узлы, рёбра, порядок контейнеров,
   производные хелперы, стек обхода, версии файлов.
3. **Context** (`src/ir/project.ts`) — `project(state)`, детерминированный срез.
4. **Лента** — только I/O: системный промпт + текущий `Context`.

Перед `project` движок сверяет активные `ref` с файловой системой
(`src/loop/observe.ts`); замеченный дрейф становится событием `mutate`.

## 2. Узлы и рёбра

**Узлы** (`src/ir/types.ts`). Пространство `work`: `request`, `goal`, `action`,
`plan`, `alternatives`, `observation`, `stop`, `unactionable`, `constraint`.
Пространство `artifact`: `file` (а также зарезервированные `symbol`/`test`, не
производятся).

- `request.payload = { text }` — сырая мотивация, корень. Интерпретируется
  **однажды** как цель (`has_goal`) или отклоняется (`no_goal`); у него нет плана,
  критерия и `stop`;
- `goal.payload = { what, why?, done_when, plan? }`, где `done_when` — **строка**:
  критерий цели, буквальная команда, которую движок выполняет и читает по коду
  возврата. `plan` — начальный план как свободный **строковый набросок**;
- `plan`/`alternatives` — контейнеры; порядок детей **не** хранится полем, а есть
  **порядок добавления рёбер `item`**. **Последний** ребёнок — текущий элемент
  (ребра `chosen` нет);
- `observation.payload` чтения несёт `{ ref, version }`; `observation.payload` запуска
  несёт
  `{ command, target?, exitCode?, witness?, output?, outputRef?, error?, errorRef?, signal?, core?, corePattern?, backtrace? }`
  (`output` — stdout, `error` — stderr, раздельно; `target` помечает запуск-критерий;
  `exitCode` — `0` = успех, ненулевой = провал, отсутствует при таймауте);
- `unactionable.payload = { why? }` — докса отказалась формулировать цель.

**Рёбра** (`src/ir/types.ts`, без поля статуса): `has_goal` (request → goal,
фиксированная интерпретация), `has_plan`, `item`, `has_alternatives`, `produces`,
`has_stopped` (goal → stop), `no_goal` (request → unactionable), `mutates`.

## 3. События (закрытый словарь)

`add_node`, `add_edge`, `descend`, `return`, `mutate`, `record_rejection`. Нет ни
`set_status`, ни `record_check`: смена состояния — новое узел-событие
(`observation`, `mutate`, `stop`, …), а не правка. Результат запуска — обычное
`observation`; успех/провал читается из его `exitCode`, а не хранится вердиктом.

## 4. Производное состояние (`src/ir/graph.ts`, `src/ir/traversal.ts`)

Узлы не меняются; `fold` вычисляет факты, а читает их `src/ir/graph.ts`:

- отображаемое **`stateOf`** — `open | executed | stopped`: **цель** `stopped`,
  когда у неё есть ребро `has_stopped` к узлу `stop`; действие `executed`, когда
  произвело результат (`produces`/`mutates`); иначе `open`;
- **`goalOf(request)`** — цель через `has_goal`; **`unactionableOf(request)`** — узел
  через `no_goal`;
- **`criterionResult/Exit/Pass/Failed`** — последнее `observation`, чей `target` —
  цель (0 = успех, ненулевой = провал, отсутствует = нет вердикта);
- **`lastChild(container)`** — текущий элемент `plan`/`alternatives` (последний
  `item`); **`unselectedVariant`** — узел, не являющийся последним в своём контейнере;
  **`actionSuperseded`** — действие, чей контейнер имеет более новый (последний)
  вариант;
- **`requestSettled(request)`** — цель запроса (через её текущий вариант) прошла
  свой критерий.

Прочее тоже производно: `currentVersion(ref)` = последняя `mutate`-версия, иначе
версия первого чтения; `cursor(G)` = первый невыполненный пункт плана; стек —
свёртка `descend`/`return`.

**Предикатов истины на узлах нет** (никаких `achieved`/`refuted`/`abandoned`).
Запуск-критерий сам по себе ничего не разрешает: цель закрывается только `stop`
доксы, а код возврата запуска — факт, который читают врата.

## 5. Операторы доксы

`src/llm/schemas.ts`, `src/tools/index.ts`, врата в `src/loop/classify.ts`:

- **`create_goal`** `{ what, why?, done_when, plan, step, revises? }` — на запросе
  (однажды): интерпретация (`has_goal`; отказ `interpreted`, если у запроса уже есть
  цель). На открытой цели: подцель, раскладывающая текущий шаг (его новейший вариант
  `alternatives`). На цели, чей критерий провален: вариант (ревизия `revises`). `plan`
  — строковый набросок; материализуется только первый конкретный `step` как пункт
  плана (действие).
- **`apply`** `{ action }` — `read`/`grep`/`list` → `action`+`observation`; `edit`/
  `write` → `action`+`mutate`+`mutates`, на устаревшем базисе отклоняется; `run` с
  `target` (критерий цели) → `observation`, несущий `target`+`exitCode`, команда
  берётся из `target.done_when`; `run` без `target` → обычное `observation`.
- **`decline`** `{ why? }` — намерение запроса недейственно: пишет узел `unactionable`
  (ребро `no_goal`) и заканчивает прогон. Только на свежем запросе.
- **`stop`** `{ why? }` — завершает фокусную **цель**: добавляет узел `stop` как
  **последний пункт плана** цели и ребро `has_stopped` `goal → stop`. Принимается
  (пока) только когда критерий цели прошёл (иначе `check_not_run`); на запросе `stop`
  нет.
- **`query`** — read-only адресация (узлы/рёбра, тело сохранённого результата).

Врата в `classify`: ограничения; `stale_base`; `repeated_action` (снимается для
пере-проверки после таймаута); строгий `revises`; `repeat_hypothesis`; `run {target}`
только для фокуса (`invalid_target`, `not_current_goal`); `interpreted`; `addressed`;
`not_addressed` (a `stop`/`decline` на запросе); `check_not_run`.

## 6. Обход (логос)

`src/ir/traversal.ts`: `focusEvents` спускается из запроса в его цель (`has_goal`), а
внутри цели — в последний вариант `alternatives` шага; возвращается, когда цель
**завершена** (`has_stopped` или исполненное действие). Проход критерия сам ничего не
закрывает, поэтому после прохода докса всё ещё должна вызвать `stop`. `applicable`
даёт доксе допустимые ходы (`createGoal`/`apply`/`stop`/`decline`, `checkReady`) из
тех же фактов, что и врата. Цикл (`src/loop/graph.ts`): `project → propose →
classify → execute → progress`; прогон заканчивается, когда цель запроса остановлена
(`request_addressed`), либо по `no_progress` / бюджету (`maxTurns`).

## 7. Проекция

`Context` (`src/ir/project.ts`) — **ветка обхода**, а не дамп: `path` (стек
`request → … → focus`; цель несёт свои `plan`/`alternatives`, а пункт плана — свои
`alternatives`), `constraints`, `lastResult` (**полный** результат последнего вызова),
`shown` (рабочее множество), `calls` (дедуплицированная сводка), `applicable`,
`checkReady`/`nextAction`, `budget`. Узел запроса несёт только `text` (его цель —
следующий узел на пути). `state` узла — `open | executed | stopped`; представление
результата несёт `exitCode`, а не `verdict`. Всё прочее достаётся через `query`.
Полная спецификация — `docs/projection_ru.md`, контракт инструментов —
`docs/tools_ru.md`.

## 8. Честность и границы

- Цель закрывается **только `stop`**, и (пока) только когда её критерий прошёл;
  `stop` записывает закрытие и его причину в план цели. Движок никогда не помечает
  цель «achieved».
- Запрос в IR не закрывается: приёмка внешняя и неявная (молчание/харнес); внутри
  `requestSettled` вычисляется из критерия цели. LLM-вердикта нет.
- Отложено: переинтерпретация запроса (интерпретация пока фиксирована),
  отрицательные/сдающиеся `stop`, `out_of_fragment`, точность свидетеля (весь
  воркспейс, `SKIP_DIRS`), `symbol`/`test`.
