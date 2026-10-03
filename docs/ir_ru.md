# Skein — IR: операции, состояние и управление (as-built)

> Английское зеркало — `docs/ir.md`.

Это **as-built**: как IR устроен в текущем коде. Источник истины по семантике —
`docs/ir_semantics_ru.md`; код следует за ним. Концептуальный обзор —
`docs/concepts_ru.md`; основание — `docs/logos_ir_ru.md`; приведение к семантике —
`docs/plans/ir_semantics_migration_plan_ru.md`.

## 1. Четыре уровня

```
                 append-only              pure            pure
  действия ─▶ журнал (Event[]) ──fold──▶ State ──project──▶ Context ──▶ LLM
     ▲                                                             │
     └─────────── предложение: ровно один оператор за ход ◀────────┘
```

1. **Журнал** (`src/ir/events.ts`) — append-only, единственная истина.
2. **State** (`src/ir/graph.ts`) — `fold(events)`: узлы, рёбра, порядок пунктов
   плана, производные предикаты, стек обхода, версии файлов.
3. **Context** (`src/ir/project.ts`) — `project(state)`, детерминированный срез.
4. **Лента** — только I/O: системный промпт + текущий `Context`.

Перед `project` движок сверяет активные `ref` с файловой системой
(`src/loop/observe.ts`); замеченный дрейф становится событием `mutate`.

## 2. Узлы и рёбра

**Узлы** (`src/ir/types.ts`). Пространство `work`: `request`, `goal`, `action`,
`plan`, `alternatives`, `observation`, `check`, `complete`, `constraint`.
Пространство `artifact`: `file` (а также зарезервированные `symbol`/`test`, не
производятся).

- `request.payload = { text }` — сырая мотивация Арбитра, корень леса; не
  закрывается в IR (приёмка внешняя);
- `goal.payload = { what, why?, done_when }`, где `done_when` —
  `{kind:"objective", command}` или `{kind:"subjective", text}`;
- `plan`/`alternatives` — контейнеры; порядок детей **не** хранится полем, а
  выводится из порядка событий `add_edge item` (поле `State.children`);
- `observation.payload` чтения несёт `{ ref, version }`; `check.payload` —
  `{ command, verdict, output, actor, witness?, outputRef? }`.

**Рёбра** (`Edge.provenance`, без поля статуса): `has_plan`, `item`,
`has_alternatives`, `chosen`, `under`, `produces`, `verifies`, `closes`,
`mutates`.

## 3. События (закрытый словарь)

`add_node`, `add_edge`, `descend`, `return`, `mutate`, `record_rejection`,
`record_check`. `set_status` нет: смена состояния — новый узел-событие, а не
правка. `record_check` несёт `targets` (id целей), `under` (id допущений),
`verdict` (`pass`/`fail`/`inconclusive`); `fold` материализует узел `check`,
рёбра `verifies` и `under`.

## 4. Производное состояние (§2.5 семантики)

Узлы не меняются; `fold` вычисляет предикаты (`src/ir/graph.ts`):

- действие `executed` ⇔ есть произведённый ребёнок (`produces`/`mutates`);
- цель `achieved` ⇔ последнее закрытие — `check` `pass` **без** `under`;
- цель `achieved_under` ⇔ `check` `pass` с `under` либо узел `complete`;
- цель `refuted` ⇔ закрывающий `check` `fail`; `inconclusive` оставляет `open`;
- цель `abandoned` ⇔ вариант `alternatives`, не равный текущему `chosen`
  (последнее ребро `chosen` контейнера);
- запрос `addressed` ⇔ текущая выбранная интерпретация `achieved`/`achieved_under`;
- иначе `open`.

Прочее производно: `currentVersion(ref)` = последняя `mutate`-версия, иначе
версия первого чтения; `cursor(G)` = индекс первого невыполненного пункта плана;
стек — свёртка `descend`/`return`.

## 5. Операторы доксы

`src/llm/schemas.ts`, `src/tools/index.ts`, проверка допустимости `src/loop/classify.ts`:

- **`create_goal`** `{ what, why?, done_when, plan?, revises? }` — если текущий
  узел — запрос, цель входит интерпретацией в его `alternatives` (`item`+`chosen`);
  если цель `refuted` — вариантом в её `alternatives`; иначе — пунктом (`item`) в
  план текущей цели. При провале `revises` **обязан** перечислить все
  `refuted`/`abandoned` варианты контейнера, иначе отказ `missing_revision`; повтор
  `what` проваленного — `repeat_hypothesis`.
- **`apply`** `{ action }` — `read`/`grep` → `action`+`observation`; `edit` →
  `action`+`mutate`+`mutates`, на устаревшем базисе отклоняется; `run` с `target`
  (объективная цель) → `check`+`verifies` (+`under`), причём **команда берётся из
  `target.done_when`**, а не из предложения доксы; `run` без `target` → `observation`.
- **`complete`** `{ goal?, note?, under? }` — только субъективная, не корень.
- **`query`** — read-only адресация (не оператор доксы): достаёт узлы/рёбра.

Врата `classify`: ограничения на `edit`; `stale_base`; `repeated_action`; строгий
`revises`; `repeat_hypothesis`; `apply run { target }` только для объективной цели
(`subjective_goal_needs_complete`); `complete` только для субъективной не-корневой.

## 6. Обход (логос)

`src/ir/traversal.ts`: `focusEvents` спускается из запроса в выбранную
интерпретацию, затем в первую невыполненную подцель, и возвращается при закрытии;
`applicable` даёт доксе фронтир (`createGoal`/`apply`/`complete`/`checkReady`/
`chooseVariant`). Цикл (`src/loop/graph.ts`): `project → propose → classify →
execute → progress`; остановка — `request_addressed` (запрос `addressed`),
`no_progress` (семантический ключ не менялся N ходов), бюджет (`maxTurns`).

## 7. Проекция

`Context` (`src/ir/project.ts`) — **ветка обхода**, а не дамп: `path` (стек
`request → … → фокус`; узел несёт свои `plan`/`alternatives`), `constraints`,
`lastResult` (**полный** результат последнего вызова), `shown` (результаты,
удержанные по `need` — рабочее множество гипотезы), `calls` (дедуплицированная
сводка предыдущих вызовов: `id`, `action`, `status ok/fail/refused`, `note`,
`count`), `applicable`, `budget` (ходы). Никаких `artifacts`, версий, `index`, `recent` и
сырых payload — всё прочее достаётся по `query`. Общего бюджета символов нет; форму
списка ограничивает `SKEIN_CTX_ITEMS`. Полная спецификация — `docs/projection_ru.md`,
контракт инструментов — `docs/tools_ru.md`. Содержимое файлов и сырой вывод в IR не
хранятся; `lastResult` показывает полный результат последнего вызова, а сбои действий
материализуются наблюдением с `verdict=fail` и попадают в `calls`.

## 8. Честность и границы

- `achieved` — только `check` `pass` без `under`; докса не выносит вердикт;
  `achieved_under` — `under` либо `complete`.
- Запрос в IR не закрывается: приёмка внешняя и неявная (молчание/харнес); внутри
  вычисляется только `addressed`. LLM-вердикта нет; `userAcceptance`
  (`src/ir/approval.ts`) даёт субъективную проверку цели.
- Отложено: `out_of_fragment` (нужен дизайн «объявленного фрагмента», §10.1
  семантики), точность свидетеля (сейчас весь воркспейс, `SKIP_DIRS`),
  `symbol`/`test`, полная точность устаревания.
