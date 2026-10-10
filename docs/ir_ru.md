# Skein — IR: операции, состояние и управление (as-built)

> Английское зеркало — `docs/ir.md`.

Это **as-built**: как IR устроен в текущем коде. Источник истины по семантике —
`docs/ir_semantics_ru.md` (меняется вместе с кодом); справочник операторов —
`docs/ir_operations_ru.md`. Концептуальный обзор — `docs/concepts_ru.md`; модель обхода —
`docs/ir_semantics_ru.md` §2; сквозной пример — `docs/walkthrough_ru.md`.

## 1. Четыре уровня

```
                 append-only              pure            pure
  действия ─▶ журнал (Event[]) ──fold──▶ State ──project──▶ Context ──▶ LLM
     ▲                                                             │
     └─────────── предложение: ровно один оператор за ход ◀────────┘
```

1. **Журнал** (`src/ir/events.ts`) — append-only, единственная истина.
2. **State** (`src/ir/graph.ts`) — `fold(events)`: узлы, связи, порядок контейнеров,
   производные хелперы, стек обхода, версии файлов.
3. **Context** (`src/ir/project.ts`) — `project(state)`, детерминированная **лента
   сообщений**.
4. **Лента** — единственная поверхность I/O: системная часть (база + инструкция узла +
   ограничения) и история.

Перед `project` движок сверяет активные `ref` с файловой системой (`src/loop/observe.ts`);
замеченный дрейф становится событием `mutate`.

## 2. Узлы и связи

**Узлы** (`src/ir/types.ts`). Рабочее пространство: `request`, `goal`, `plan`, `item`,
`action`, `observation`, `stop`, `unactionable`, `constraint`. Пространство артефактов:
`file` (а также зарезервированные `symbol`/`test`, не производятся).

- `request.payload = { text }` — сырая мотивация, корень. Интерпретируется **один раз** как
  цель (`goal`) или отклоняется (`unactionable`); ни плана, ни `stop`;
- `goal.payload = { what }` — интерпретация. План — отдельный узел;
- `plan`/`item` — контейнеры; порядок детей — порядок добавления связей, **последний** ребёнок —
  текущий пункт/альтернатива;
- `action.payload` несёт команду (для правки — `find`/`replace`; для запуска — `signature`),
  чтобы повтор был распознан;
- `observation.payload` чтения несёт `{ ref, version, start, end, total, output? }`; запуска —
  `{ command, exitCode?, output?, outputRef?, error?, errorRef?, signal?, core?, … }` (`output` —
  stdout, `error` — stderr, раздельно; `exitCode` `0` = успех, отсутствует при таймауте); провал
  несёт `failed: true`, неисполнение — `refused: true`;
- `stop.payload = { why? }`, `unactionable.payload = { why? }`, `constraint.payload = { forbid }`.

**Связи** (`src/ir/types.ts`, без поля статуса): `goal` (request → goal), `unactionable`
(request → unactionable), `plan` (goal → plan), `stop` (goal → stop), `items` (plan → item),
`alts` (item → action/goal), `result` (action → observation), `mutates` (action → file).

## 3. События (закрытый словарь)

`add_node`, `add_edge`, `descend`, `return`, `mutate`, `record_rejection`. Нет ни `set_status`,
ни `record_check`: смена состояния — новый узел-событие (`observation`, `mutate`, `stop`), а не
правка. Результат запуска — обычное `observation`; успех/провал читается из его исхода, а не
хранится вердиктом. `record_rejection` используется только для отклонённого **структурного**
хода (`create_goal`/`stop`/`decline`); отказная команда — наблюдение с причиной.

## 4. Производное состояние (`src/ir/graph.ts`, `src/ir/traversal.ts`)

Узлы не меняются; `fold` вычисляет факты, а читает их `graph.ts`:

- **`actionExecuted`** — у действия есть произведённый ребёнок (`result`/`mutates`);
- **`actionSucceeded`** — оно изменило файл, либо его наблюдение-результат не провал (`failed`
  или ненулевой `exitCode`; отсутствие `exitCode` — таймаут);
- **`hasStopped`/`stopOf`** — связь `stop` цели; **`goalOf`/`unactionableOf`**;
- **`lastChild`** — текущий пункт/альтернатива; **`itemFulfilled`** — его текущая альтернатива
  исполненное успешное действие или закрытая цель; **`cursorOf`** — первый невыполненный пункт;
  стек — свёртка `descend`/`return`.

**Предикатов истины на узлах нет.** Код возврата запуска — факт, который читает модель; цель
закрывается только `stop` доксы.

## 5. Операторы доксы

`src/llm/schemas.ts`, `src/tools/index.ts`, врата `src/loop/classify.ts`:

- **`create_goal`** `{ what, command }` — на запросе (однажды): интерпретация
  (`goal`; план засевается одним пунктом, и `command` исполняется сразу; отказы `interpreted`,
  пустые поля). На открытой цели: подцель как новейшая альтернатива текущего пункта; без текущего
  пункта — отказ.
- **`apply`** `{ action }` — команда исполняется; размещение по исходу текущего пункта
  (`OP-AP-PLACE`): успех → новый пункт плана, иначе → новая альтернатива; неисполнение
  (повтор/stale/запрет/пусто) — наблюдение с причиной.
- **`stop`** `{ why? }` — узел `stop`, подвешенный к фокусной цели связью `stop`; у запроса
  `stop` нет.
- **`decline`** `{ why? }` — узел `unactionable` под запросом; только на свежем запросе.
- **`recall` / `search`** — read-only адресация сохранённого тела результата (окно / паттерн).

Врата в `classify` обслуживают только структурные ходы (`not_addressed`, `not_request`,
`interpreted`, пустые поля, `no_current_item`); стражи команд (`repeated_action`, `stale_base`,
`constraint_violation`, пустая команда) живут в движке и дают наблюдения (`src/tools/index.ts`).

## 6. Обход (логос)

`src/ir/traversal.ts`: `focusEvents` спускается из запроса в его цель и в подцель-альтернативу
текущего пункта; возвращается, когда цель **завершена** (`stop`) или под закрытым предком.
`applicable` даёт доксе допустимые ходы (`createGoal`/`apply`/`stop`/`decline`) из тех же фактов,
что и врата. Цикл (`src/loop/graph.ts`): `project → propose → classify → execute → progress`;
прогон заканчивается, когда цель запроса остановлена (`request_addressed`), либо по
`no_progress` / бюджету (`maxTurns`).

## 7. Проекция

`Context` (`src/ir/project.ts`) — `{ history, situation, constraints }`: лента ходов
`user`/`assistant`/`tool` (собирается из дерева), текущая ситуация (`request`/`goal`) и
ограничения. `src/loop/propose.ts` собирает сообщения для модели: базовый промпт, инструкция
узла для ситуации, ограничения, затем история. `tool`-сообщения несут ограниченное inline-тело
(голова инспекции, хвост команды, когда оно большое); полное тело адресуется по id через `recall`/`search`. Отклонённый
`classify` структурный ход узла не создаёт, поэтому его причина приходит транзиентным
`tool`-сообщением на следующий ход. Полная спецификация — `docs/projection_ru.md`.

## 8. Честность и границы

- цель закрывается **только `stop`**; движок никогда не помечает цель «achieved»;
- запрос в IR не закрывается: приёмка внешняя; прогон заканчивается, когда цель остановлена или
  при `decline`;
- отложено: переинтерпретация запроса, отрицательный/сдающийся `stop`, `out_of_fragment`,
  точность свидетеля (весь воркспейс, `SKIP_DIRS`), `symbol`/`test` и составной системный промпт
  (граница базы/узла — следующий этап).
